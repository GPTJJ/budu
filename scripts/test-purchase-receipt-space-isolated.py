#!/usr/bin/env python3
"""Non-production storage experiment. Never imports on a production host.

No release-controller behavior is changed. CI owns an ephemeral loop filesystem,
containerd and Docker daemon. E/R come from the existing exact official artifact.
The sender is outside that filesystem; the original Mac archives remain intact.
Observed peaks are sampled lower bounds, combined with unchanged conservative
limits. A storage sentinel is explicitly not a business application health test.
"""
import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
import zipfile

GIB = 1024 ** 3
MIB = 1024 ** 2
E = 'e762afce3053cd7ab0a7ebe9f36976ec80d3b64e'
R = 'e3ecebcb94c4b058f10ad05e69a078bbc45b0d8e'
BRANCH = 'codex/purchase-receipt-space-diagnostic-20261005'
DIND = 'docker.io/library/docker@sha256:64d6ee47ea821c986467199baa162f5ac8cde3f57b719f18e23f3ed7a7444131'
CONTAINERD_BYTES = 33645699
CONTAINERD_SHA = 'af3e82bac6abed58d45956c653244aa2be583359a9753614278ef652012f2883'
ZIP_BYTES = 1133625596
ZIP_SHA = 'ddc6c1b9f95a701d23a9729b47d2e4baf2f30effb86fd9f9ceba0e5cfcf3be41'
EXPECTED = {
    E: dict(name='image.tar', size=566876672,
            sha='ae712b77aad83513cb7cb42c47ace90491ee7930bfcc0d353bc5d5e99290e425',
            config='aa8f4b6ba6d1049e830c71d7c48bd7a64f728d13a1500e6f060da3ac5f2d512c',
            blobs=566856143, expanded=2096529408, largest=1155686400),
    R: dict(name='compatible.tar', size=566748672,
            sha='52e07d645d382a4f5c8e1b62962c7c16024ba2a738012bc5af38801c8a3ab39e',
            config='f9a6586dfce52ae3f00766af434ad244b9c164cdb33a401437f6592c8c55603a',
            blobs=566728715, expanded=2095456256, largest=1155686400),
}
# Historical read-only baseline, NOT a current production admission.
BASE = dict(db=163191831, used=64863019008, available=16001069056,
            verifiedAtUTC='2026-10-05T07:42:48.821766+00:00')
RESERVE = 512 * MIB
MAX_ARCHIVE = 768 * MIB
CAP = 6 * GIB
MIN_AVAILABLE = 10 * GIB
MAX_USAGE = 90
CTR_SNAPSHOTS = ['/opt/proof-containerd/bin/ctr', '--address', '/run/containerd/containerd.sock',
                 '--namespace', 'moby', 'snapshots', '--snapshotter', 'overlayfs']
DOCKERD_COMMAND = ('dockerd --host unix:///var/run/docker.sock --data-root /var/lib/docker '
                  '--containerd /run/containerd/containerd.sock --containerd-namespace moby '
                  '--feature containerd-snapshotter --iptables=false --ip6tables=false --bridge=none '
                  '--live-restore --pidfile /run/proof-dockerd-managed.pid')


class Reject(RuntimeError):
    pass


def require(condition, reason):
    if not condition:
        raise Reject(reason)


def run(args, timeout=60, check=True):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    if check:
        require(result.returncode == 0, 'COMMAND_FAILED:' + args[0] + ':' + result.stderr.decode(errors='replace')[-1500:])
    return result.stdout.decode(errors='replace')


def digest_file(path, limit):
    require(path.is_file() and not path.is_symlink(), 'REGULAR_SOURCE_REQUIRED')
    h, total = hashlib.sha256(), 0
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(MIB), b''):
            total += len(chunk)
            require(total <= limit, 'SOURCE_SIZE_CAP')
            h.update(chunk)
    return total, h.hexdigest()


def inspect_archive(path, release):
    expected = EXPECTED[release]
    require(digest_file(path, MAX_ARCHIVE) == (expected['size'], expected['sha']), 'SOURCE_IDENTITY_MISMATCH')
    with tarfile.open(path, 'r:') as archive:
        members = archive.getmembers()
        require(len(members) <= 200000, 'ARCHIVE_MEMBER_LIMIT')
        names = {m.name for m in members}
        require(len(names) == len(members), 'DUPLICATE_ARCHIVE_MEMBER')
        require(all(not m.name.startswith('/') and '..' not in Path(m.name).parts and
                    (m.isfile() or m.isdir()) for m in members), 'UNSAFE_ARCHIVE_MEMBER')
        def read(name, cap):
            m = archive.getmember(name)
            require(m.isfile() and m.size <= cap, 'METADATA_BOUND')
            return archive.extractfile(m).read()
        manifest = json.loads(read('manifest.json', 65536))
        require(len(manifest) == 1, 'SINGLE_IMAGE_REQUIRED')
        item = manifest[0]
        tag = 'budu-api:post-transfer-' + release[:12]
        require(item['RepoTags'] in ([tag], ['docker.io/library/' + tag]), 'TAG_MISMATCH')
        config_bytes = read(item['Config'], 4 * MIB)
        require(hashlib.sha256(config_bytes).hexdigest() == expected['config'], 'CONFIG_DIGEST_MISMATCH')
        config = json.loads(config_bytes)
        require(config['os'] == 'linux' and config['architecture'] == 'amd64' and
                config['config']['Labels']['org.opencontainers.image.revision'] == release, 'IMAGE_IDENTITY_MISMATCH')
        diffs = config['rootfs']['diff_ids']
        require(len(diffs) == len(item['Layers']) and 0 < len(diffs) <= 64, 'LAYER_COUNT')
        layers, chain, total = [], None, 0
        for name, diff in zip(item['Layers'], diffs):
            require(re.fullmatch('sha256:[0-9a-f]{64}', diff) is not None, 'DIFF_ID_FORMAT')
            m = archive.getmember(name)
            require(m.isfile(), 'REGULAR_LAYER_REQUIRED')
            h = hashlib.sha256()
            with archive.extractfile(m) as source:
                for chunk in iter(lambda: source.read(MIB), b''):
                    h.update(chunk)
            chain = diff if chain is None else 'sha256:' + hashlib.sha256((chain + ' ' + diff).encode()).hexdigest()
            layers.append(dict(blob='sha256:' + h.hexdigest(), bytes=m.size, diff=diff, chain=chain,
                               archiveMember=name, archiveDataOffset=m.offset_data))
            total += m.size
        # Original Model A counts every regular archive payload, including the
        # small JSON manifests; layer hashes are the separate reuse relation.
        content_bytes = sum(m.size for m in members if m.isfile())
        require(content_bytes == expected['blobs'] and total <= content_bytes, 'COMPRESSED_BYTES_MISMATCH')
    return dict(release=release, tag=tag, diffs=diffs, layers=layers,
                archiveBytes=expected['size'], archiveSHA256=expected['sha'],
                metricOrigin='FIXED_ORIGINAL_OFFHOST_FULL_LAYER_VALIDATION')


def shared_layers(e, r):
    rb = {x['blob']: x for x in r['layers']}
    shared = [x for x in e['layers'] if x['blob'] in rb and x['chain'] == rb[x['blob']]['chain']]
    require(len(shared) == 9 and len({x['chain'] for x in shared}) == 9, 'NINE_SHARED_LAYERS_REQUIRED')
    return shared


def admission(used, available, increment):
    require(min(used, available, increment) >= 0 and used + available > 0, 'INVALID_DISK_INPUT')
    require(increment <= CAP, 'COMBINED_6GIB_CAP')
    usage = math.ceil(100 * (used + increment) / (used + available))
    remaining = available - increment
    require(usage <= MAX_USAGE and remaining >= MIN_AVAILABLE, 'DYNAMIC_HEADROOM')
    return dict(incrementBytes=increment, projectedAvailableBytes=remaining, projectedUsagePercent=usage)


def budgets(db=None):
    db = BASE['db'] if db is None else db
    require(isinstance(db, int) and db >= 0, 'DB_BYTES_INVALID')
    limits = dict(D=2 * db + 64 * MIB, Q=3 * db + 256 * MIB,
                  W=db + 64 * MIB, M=128 * MIB, Z=RESERVE)
    a = EXPECTED[E]
    full = a['size'] + a['blobs'] + a['expanded'] + a['largest'] + RESERVE
    total = sum(limits[k] for k in ('D', 'Q', 'W', 'M'))
    require(full + total <= CAP, 'ORIGINAL_COMBINED_MODEL_FAIL')
    return limits, dict(fullEModelA=full, allResourceLimits=total,
                        combinedBytes=full + total, capBytes=CAP, marginBytes=CAP - full - total)


class ImportLock:
    """Diagnostic lock, not a production release-controller implementation."""
    def __init__(self, path):
        self.path = path

    def begin(self):
        try:
            with self.path.open('x') as f:
                json.dump(dict(state='IMPORTING', secondImportAllowed=False), f)
        except FileExistsError:
            raise Reject('IMPORT_LOCK_HELD') from None

    def finish(self, state):
        require(self.path.exists(), 'LOCK_ABSENT')
        self.path.write_text(json.dumps(dict(state=state, secondImportAllowed=False)) + '\n')


def stream_to_process(path, expected_size, expected_sha, command, log, deadline_seconds=120,
                      cut_after=None, pause_after=None, on_pause=None, truncate_after=None,
                      fault_hook=None, fault_deadline_seconds=None, evidence=None):
    require(0 < expected_size <= MAX_ARCHIVE, 'STREAM_SIZE_CAP')
    require(digest_file(path, MAX_ARCHIVE) == (expected_size, expected_sha), 'STREAM_PREFLIGHT_IDENTITY')
    original = path.stat()
    deadline, total, h = time.monotonic() + deadline_seconds, 0, hashlib.sha256()
    paused = False
    require(truncate_after is None or 0 < truncate_after < expected_size, 'TRUNCATION_BOUND')
    evidence = {} if evidence is None else evidence
    evidence.update(sourceBytes=expected_size, sourceSHA256=expected_sha, sentBytes=0, clientExitCode=None)
    with log.open('wb') as output, path.open('rb') as source:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=output, stderr=subprocess.STDOUT,
                                start_new_session=True)
        os.set_blocking(proc.stdin.fileno(), False)
        selector = selectors.DefaultSelector()
        selector.register(proc.stdin, selectors.EVENT_WRITE)
        hook_triggered = False
        def observe_fault():
            nonlocal deadline, hook_triggered
            if fault_hook is not None and not hook_triggered:
                require(proc.poll() is None, 'LATE_FAULT_WINDOW_MISSED')
                if fault_hook(total):
                    hook_triggered = True
                    evidence['faultTriggered'] = True
                    if fault_deadline_seconds is not None:
                        deadline = time.monotonic() + fault_deadline_seconds
        try:
            while True:
                observe_fault()
                if truncate_after is not None and total >= truncate_after:
                    break
                if cut_after is not None and total >= cut_after:
                    raise Reject('INJECTED_INTERRUPT_UNKNOWN')
                if pause_after is not None and total >= pause_after and not paused:
                    on_pause()
                    paused = True
                remaining = MIB
                if cut_after is not None:
                    remaining = min(remaining, cut_after - total)
                if truncate_after is not None:
                    remaining = min(remaining, truncate_after - total)
                chunk = source.read(remaining)
                if not chunk:
                    break
                offset = 0
                while offset < len(chunk):
                    observe_fault()
                    require(time.monotonic() < deadline, 'IMPORT_TIMEOUT_UNKNOWN')
                    if not selector.select(min(.1, max(0, deadline - time.monotonic()))):
                        continue
                    try:
                        written = os.write(proc.stdin.fileno(), chunk[offset:])
                    except BlockingIOError:
                        continue
                    h.update(chunk[offset:offset + written])
                    total += written
                    evidence['sentBytes'] = total
                    offset += written
                    require(total <= expected_size and total <= MAX_ARCHIVE, 'STREAM_BYTE_BOUND')
            proc.stdin.close()
            while proc.poll() is None:
                observe_fault()
                require(time.monotonic() < deadline, 'IMPORT_TIMEOUT_UNKNOWN')
                time.sleep(.01)
            evidence['clientExitCode'] = proc.returncode
            if truncate_after is not None:
                require(proc.returncode != 0, 'TRUNCATED_ARCHIVE_WAS_ACCEPTED')
                raise Reject('TRUNCATED_E_DAEMON_REJECTED')
            require(fault_hook is None or hook_triggered, 'LATE_FAULT_WINDOW_MISSED')
            after = path.stat()
            require((original.st_dev, original.st_ino, original.st_size, original.st_mtime_ns) ==
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'SOURCE_CHANGED_DURING_STREAM')
            require(total == expected_size and h.hexdigest() == expected_sha, 'STREAM_FINAL_IDENTITY')
            require(proc.returncode == 0, 'IMPORT_REJECTED')
            return dict(bytes=total, sha256=h.hexdigest(), returncode=proc.returncode,
                        sourceOutsideTargetStore=True, bufferMaximumBytes=MIB)
        except (Reject, OSError, subprocess.TimeoutExpired) as error:
            # Killing the client does not prove the daemon import has finished.
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=3)
            evidence['clientExitCode'] = proc.returncode
            evidence['sentSHA256'] = h.hexdigest()
            evidence['state'] = 'UNKNOWN'
            raise Reject('UNKNOWN:' + str(error)) from None
        finally:
            selector.close()
            if not proc.stdin.closed:
                proc.stdin.close()


class Sampler:
    def __init__(self, root):
        self.root, self.stop = root, threading.Event()
        self.baseline = self.used()
        self.peak, self.samples, self.max_gap = self.baseline, 0, 0.0
        self.thread = threading.Thread(target=self._sample, daemon=True)

    def used(self):
        v = os.statvfs(self.root)
        return (v.f_blocks - v.f_bfree) * v.f_frsize

    def _sample(self):
        previous = time.monotonic()
        while not self.stop.is_set():
            now = time.monotonic()
            self.max_gap = max(self.max_gap, now - previous)
            previous = now
            self.peak = max(self.peak, self.used())
            self.samples += 1
            self.stop.wait(.02)

    @contextlib.contextmanager
    def phase(self, name, output):
        self.peak, self.samples, self.max_gap = self.used(), 0, 0.0
        self.stop.clear()
        self.thread = threading.Thread(target=self._sample, daemon=True)
        self.thread.start()
        try:
            yield
        finally:
            os.sync()
            self.peak = max(self.peak, self.used())
            self.stop.set()
            self.thread.join(timeout=2)
            output[name] = dict(observedPeakBytes=self.peak - self.baseline,
                                retainedBytes=self.used() - self.baseline,
                                samplePeriodSeconds=.02, maximumSamplingGapSeconds=self.max_gap,
                                samples=self.samples, observedPeakIsLowerBound=True)


def validate_stack(info, containerd_version, filesystem, same_device):
    require(info.get('ServerVersion') == '29.1.3' and info.get('Driver') == 'overlayfs'
            and info.get('DockerRootDir') == '/var/lib/docker'
            and ['driver-type', 'io.containerd.snapshotter.v1'] in info.get('DriverStatus', []), 'STORAGE_STACK_MISMATCH')
    require(re.search(r'\bv?2\.2\.1\b', containerd_version) is not None, 'CONTAINERD_VERSION_MISMATCH')
    require(filesystem == 'ext4' and same_device, 'STORAGE_FILESYSTEM_MISMATCH')


def committed_parent_path(mount_json):
    """Decode v2.2.1 view --mounts JSON, never printed mount shell commands.

    overlay.go returns the committed parent Source for a one-parent View and
    ordered ParentIDs as lowerdir for a multi-parent View. No view upper inode.
    """
    require(len(mount_json.encode()) <= 65536, 'VIEW_MOUNT_JSON_BOUND')
    try:
        mounts = json.loads(mount_json)
    except ValueError:
        raise Reject('VIEW_MOUNT_JSON_REQUIRED') from None
    require(isinstance(mounts, list) and len(mounts) == 1 and isinstance(mounts[0], dict), 'VIEW_MOUNT_SHAPE')
    m = mounts[0]
    options = m.get('Options')
    require(m.get('Target') == '' and isinstance(options, list) and
            all(isinstance(x, str) for x in options), 'VIEW_MOUNT_FIELDS')
    require(not any(x == 'rw' or x.startswith(('upperdir=', 'workdir=')) for x in options), 'WRITABLE_OR_ACTIVE_MOUNT')
    if m.get('Type') == 'bind':
        require('ro' in options and 'rbind' in options, 'READONLY_BIND_REQUIRED')
        paths = [m.get('Source')]
    elif m.get('Type') == 'overlay':
        lower = [x.removeprefix('lowerdir=') for x in options if x.startswith('lowerdir=')]
        require(m.get('Source') == 'overlay' and len(lower) == 1, 'READONLY_OVERLAY_REQUIRED')
        paths = lower[0].split(':')
        require(len(paths) >= 2, 'OVERLAY_PARENT_COUNT')
    else:
        raise Reject('VIEW_MOUNT_TYPE')
    require(all(isinstance(p, str) and re.fullmatch(
        r'/var/lib/containerd/io\.containerd\.snapshotter\.v1\.overlayfs/snapshots/[1-9][0-9]*/fs', p)
        for p in paths), 'COMMITTED_PARENT_PATH_INVALID')
    return paths[0], json.dumps(mounts, sort_keys=True, separators=(',', ':'))


def read_owned_view(docker, token, committed_chain, owned_views):
    require(re.fullmatch('[a-z0-9]+', token) and re.fullmatch('sha256:[0-9a-f]{64}', committed_chain), 'VIEW_OWNER_OR_CHAIN')
    key = 'proof-view-' + token + '-' + uuid.uuid4().hex[:12]
    owned_views.append(key)
    # v2.2.1 Mounts rejects committed keys; View accepts a committed parent and
    # --mounts prints structured mount specs without MountManager activation.
    raw = docker(CTR_SNAPSHOTS + ['view', '--mounts', key, committed_chain])
    docker(CTR_SNAPSHOTS + ['label', key, 'containerd.io/gc.root=' + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())])
    info = json.loads(docker(CTR_SNAPSHOTS + ['info', key]))
    require(info.get('Kind') == 'View' and info.get('Name') == key and
            info.get('Parent') == committed_chain, 'OWN_VIEW_PARENT_IDENTITY')
    path, specification = committed_parent_path(raw)
    # Keep all views until whole owned-stack teardown. Deleting a view could
    # invoke overlay cleanup of unrelated UNKNOWN leftovers in this test stack.
    return path, specification, dict(key=key, parent=committed_chain, kind='View', retained=True)


class Stack:
    def __init__(self, root, token, containerd_bin):
        self.root, self.token, self.containerd_bin = root, token, containerd_bin
        self.name = 'procurement-space-' + token
        self.volume, self.loop, self.created, self.mounted = root / 'store', None, False, False
        self.owned_views = []

    def docker(self, args, timeout=90, check=True):
        return run(['docker', 'exec', self.name, *args], timeout, check)

    def __enter__(self):
        self.root.mkdir()
        self.volume.mkdir()
        image = self.root / 'store.ext4'
        with image.open('xb') as f:
            f.truncate(16 * GIB)
        run(['mkfs.ext4', '-q', '-m', '0', str(image)])
        self.loop = run(['losetup', '--find', '--show', str(image)]).strip()
        require(re.fullmatch('/dev/loop[0-9]+', self.loop) is not None, 'LOOP_IDENTITY')
        try:
            run(['mount', '-o', 'nodev,nosuid', self.loop, str(self.volume)])
            self.mounted = True
            for name in ('docker', 'containerd'):
                (self.volume / name).mkdir()
            self.sampler = Sampler(self.volume)
            boot = ('set -eu; export PATH=/opt/proof-containerd/bin:$PATH; '
                    'containerd --root /var/lib/containerd --state /run/containerd '
                    '--address /run/containerd/containerd.sock >/tmp/containerd.log 2>&1 & '
                    'for i in $(seq 1 100); do test -S /run/containerd/containerd.sock && break; sleep .1; done; '
                    + DOCKERD_COMMAND + ' >/tmp/dockerd.log 2>&1 & '
                    'echo $! >/run/proof-dockerd.pid; '
                    'trap "exit 0" TERM INT; while :; do sleep 1; done')
            run(['docker', 'run', '-d', '--privileged', '--network', 'none', '--name', self.name,
                 '--label', 'budu.isolated-proof-owner=' + self.token,
                 '--mount', 'type=bind,src=' + str(self.volume / 'docker') + ',dst=/var/lib/docker',
                 '--mount', 'type=bind,src=' + str(self.volume / 'containerd') + ',dst=/var/lib/containerd',
                 '--mount', 'type=bind,src=' + str(self.containerd_bin) + ',dst=/opt/proof-containerd/bin,readonly',
                 '--mount', 'type=tmpfs,dst=/run', '--entrypoint', 'sh', DIND, '-c', boot])
            self.created = True
            deadline = time.monotonic() + 60
            info = None
            while time.monotonic() < deadline:
                try:
                    info = json.loads(self.docker(['docker', 'info', '--format', '{{json .}}'], timeout=3))
                    break
                except (Reject, ValueError, subprocess.TimeoutExpired):
                    time.sleep(.25)
            require(info is not None, 'DOCKER_DAEMON_NOT_READY')
            self.info = {k: info[k] for k in ('ServerVersion', 'Driver', 'DriverStatus', 'DockerRootDir')}
            self.info['containerdVersion'] = self.docker(['/opt/proof-containerd/bin/containerd', '--version']).strip()
            self.info['filesystem'] = run(['findmnt', '-n', '-o', 'FSTYPE', str(self.volume)]).strip()
            validate_stack(info, self.info['containerdVersion'], self.info['filesystem'],
                           (self.volume / 'docker').stat().st_dev == (self.volume / 'containerd').stat().st_dev)
            self.info['engineContainerdBackendFilesystemVersionParity'] = 'PASS'
            self.info['isolatedKernel'] = os.uname().release
            self.info['productionKernelReadOnlyAt0830UTC'] = '6.8.0-124-generic'
            self.info['exactProductionKernelParity'] = os.uname().release == '6.8.0-124-generic'
            self.info['actualCLIRegression'] = self.cli_regression()
            return self
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def __exit__(self, *unused):
        if self.created:
            owner = run(['docker', 'inspect', '--format', '{{index .Config.Labels "budu.isolated-proof-owner"}}', self.name]).strip()
            require(owner == self.token, 'CLEANUP_OWNER_MISMATCH')
            run(['docker', 'unpause', self.name], check=False)
            run(['docker', 'rm', '--force', self.name])
        if self.mounted:
            require(run(['findmnt', '-n', '-o', 'SOURCE', str(self.volume)]).strip() == self.loop, 'MOUNT_OWNER_MISMATCH')
            run(['umount', str(self.volume)])
        if self.loop:
            run(['losetup', '--detach', self.loop])
        # No image, volume, or builder prune; only this exact owned loop file.
        image = self.root / 'store.ext4'
        if image.is_file():
            image.unlink()

    def inspect(self, meta):
        images = json.loads(self.docker(['docker', 'image', 'inspect', meta['tag']]))
        require(len(images) == 1, 'IMAGE_AMBIGUOUS')
        image = images[0]
        require(image['Os'] == 'linux' and image['Architecture'] == 'amd64'
                and image['Config']['Labels']['org.opencontainers.image.revision'] == meta['release']
                and image['RootFS']['Layers'] == meta['diffs'], 'LOADED_IMAGE_IDENTITY')
        return image['Id']

    def objects(self, shared, all_layers):
        result = {}
        parents = {x['chain']: None if i == 0 else all_layers[i - 1]['chain'] for i, x in enumerate(all_layers)}
        for layer in shared:
            blob = '/var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/' + layer['blob'].split(':')[1]
            values = self.docker(['stat', '-c', '%d %i %s %b', blob]).strip().split()
            require(len(values) == 4 and int(values[2]) == layer['bytes'], 'BLOB_STAT_MISMATCH')
            digest = self.docker(['sha256sum', blob]).split()[0]
            require('sha256:' + digest == layer['blob'], 'STORE_BLOB_HASH_MISMATCH')
            info = json.loads(self.docker(CTR_SNAPSHOTS + ['info', layer['chain']]))
            require(info.get('Kind') == 'Committed' and info.get('Name') == layer['chain'] and
                    info.get('Parent', '') == (parents[layer['chain']] or ''), 'COMMITTED_CHAIN_MISMATCH')
            path, specification, view = read_owned_view(self.docker, self.token, layer['chain'], self.owned_views)
            folder = self.docker(['stat', '-c', '%d %i', path]).strip()
            result[layer['chain']] = dict(blob=layer['blob'], blobStat=values, sha256=digest,
                snapshot=info, mountSpecification=specification, topSnapshotPath=path, directoryStat=folder,
                ownedReadOnlyView=view, inodeScope='COMMITTED_PARENT_NOT_TEMP_VIEW')
        return result

    def cli_regression(self):
        def cli(args):
            return subprocess.run(['docker', 'exec', self.name, *CTR_SNAPSHOTS, *args],
                                  capture_output=True, timeout=15)
        help_result = cli(['mounts', 'proof-missing-' + self.token])
        require(b'<target> <key>' in help_result.stdout and b'mount -t ' not in help_result.stdout,
                'ACTUAL_CLI_ONE_ARG_HELP_CONTRACT')
        active = 'proof-cli-active-' + self.token
        committed = 'sha256:' + hashlib.sha256(('proof-cli-' + self.token).encode()).hexdigest()
        self.docker(CTR_SNAPSHOTS + ['prepare', active])
        self.docker(CTR_SNAPSHOTS + ['commit', committed, active])
        rejected = cli(['mounts', '/tmp/proof-print-only-' + self.token, committed])
        require(rejected.returncode != 0 and b'not active or view' in rejected.stderr,
                'ACTUAL_CLI_COMMITTED_MOUNTS_MUST_REJECT')
        path, specification, view = read_owned_view(self.docker, self.token, committed, self.owned_views)
        require(json.loads(specification)[0]['Type'] == 'bind', 'ACTUAL_CLI_ROOT_VIEW_BIND')
        original_stat = self.docker(['stat', '-c', '%d %i', path]).strip()
        other_path, _, other_view = read_owned_view(self.docker, self.token, committed, self.owned_views)
        require(view['key'] != other_view['key'] and path == other_path and
                original_stat == self.docker(['stat', '-c', '%d %i', other_path]).strip(),
                'ACTUAL_CLI_COMMITTED_INODE_NOT_VIEW_INODE')
        return dict(result='PASS', oneArgumentExitCode=help_result.returncode,
                    committedMountsExitCode=rejected.returncode, rootViewJSON=json.loads(specification),
                    twoDifferentViewsSameCommittedParentInode=True, ownedViewsRetained=True)

    def kill_dockerd(self):
        pid = self.docker(['cat', '/run/proof-dockerd.pid']).strip()
        require(pid.isdigit() and int(pid) > 1 and
                self.docker(['cat', '/proc/' + pid + '/comm']).strip() == 'dockerd', 'OWN_DOCKERD_PID_IDENTITY')
        self.docker(['sh', '-c', 'kill -KILL "$1"', 'proof-kill', pid])
        return dict(kind='DOCKERD_PID_SIGKILL', pid=int(pid), wholeDindContainerPaused=False,
                    containerdWasNotSignalled=True)

    def recover_dockerd(self, old_pid):
        # Only the just-killed owned daemon is restarted; no new image import.
        stopped = False
        until = time.monotonic() + 3
        while time.monotonic() < until:
            status = self.docker(['cat', '/proc/' + str(old_pid) + '/stat'], check=False).strip()
            if not status or re.match(r'^[0-9]+ \(dockerd\) [ZX] ', status):
                stopped = True
                break
            time.sleep(.1)
        require(stopped, 'OLD_OWN_DOCKERD_NOT_STOPPED')
        managed = self.docker(['cat', '/run/proof-dockerd-managed.pid'], check=False).strip()
        require(managed in ('', str(old_pid)), 'RECOVERY_PIDFILE_OWNER')
        self.docker(['sh', '-c', 'rm -f /run/proof-dockerd-managed.pid; export PATH=/opt/proof-containerd/bin:$PATH; '
                     + DOCKERD_COMMAND + ' >/tmp/dockerd-recovery.log 2>&1 & echo $! >/run/proof-dockerd.pid'])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                info = json.loads(self.docker(['docker', 'info', '--format', '{{json .}}'], timeout=2))
                validate_stack(info, self.info['containerdVersion'], self.info['filesystem'], True)
                return
            except (Reject, ValueError, subprocess.TimeoutExpired):
                time.sleep(.1)
        raise Reject('OWN_DOCKERD_RECOVERY_TIMEOUT')

    def unique_blob_witness(self, candidates):
        base = self.volume / 'containerd/io.containerd.content.v1.content/blobs/sha256'
        for layer in candidates:
            path = base / layer['blob'].split(':')[1]
            if path.is_file() and path.stat().st_size == layer['bytes']:
                count, sha = digest_file(path, MAX_ARCHIVE)
                require(count == layer['bytes'] and 'sha256:' + sha == layer['blob'], 'E_UNIQUE_STORE_HASH')
                snapshot_text = self.docker(CTR_SNAPSHOTS + ['info', layer['chain']], timeout=3, check=False)
                try:
                    snapshot = json.loads(snapshot_text)
                except ValueError:
                    snapshot = None
                return dict(blob=layer['blob'], bytes=count, sha256=sha,
                            contentIsCommitted=True, blobPhysicalBytes=path.stat().st_blocks * 512,
                            uniqueSnapshotCommitted=bool(snapshot and snapshot.get('Kind') == 'Committed'
                                                        and snapshot.get('Name') == layer['chain']))
        return None


def late_e_candidates(e, r):
    rblobs = {x['blob'] for x in r['layers']}
    cutoff = e['archiveBytes'] - 65536
    unique = [x for x in e['layers'] if x['blob'] not in rblobs and
              x['archiveDataOffset'] + x['bytes'] <= cutoff]
    require(unique and cutoff > e['archiveBytes'] * .9, 'LATE_E_BOUNDARY_UNAVAILABLE')
    return unique, cutoff


def late_fault_eligible(sent, full_size, witness):
    return sent >= full_size // 2 and bool(witness and witness.get('contentIsCommitted'))


def verify_reuse(before, after):
    require(len(before) == len(after) == 9 and set(before) == set(after), 'SHARED_OBJECT_COUNT')
    for chain, original in before.items():
        current = after[chain]
        for key in ('blob', 'blobStat', 'sha256', 'topSnapshotPath', 'directoryStat', 'mountSpecification'):
            require(current[key] == original[key], 'SHARED_PHYSICAL_OBJECT_CHANGED:' + key)
        require(current['snapshot']['Parent'] == original['snapshot']['Parent']
                if 'Parent' in original['snapshot'] else current['snapshot'].get('Parent', '') == '', 'SHARED_PARENT_CHANGED')


def allocate(root, name, count):
    path = root / name
    require(not path.exists() and count > 0, 'ALLOCATION_OWNER_OR_SIZE')
    run(['fallocate', '-l', str(count), str(path)])
    require(path.stat().st_size == count and path.stat().st_blocks * 512 >= count, 'PHYSICAL_ALLOCATION_FAILED')


def r_sentinel(stack, meta):
    name = 'storage-sentinel-' + stack.token
    stack.docker(['docker', 'run', '-d', '--name', name, '--network', 'none', '--read-only',
                  '--no-healthcheck', '--entrypoint', 'node', meta['tag'], '-e', 'setInterval(()=>{},1000)'])
    return name


def assert_sentinel(stack, name, image):
    container = json.loads(stack.docker(['docker', 'container', 'inspect', name]))[0]
    require(container['State']['Running'] and container['Image'] == image, 'R_STORAGE_SENTINEL_NOT_RUNNING')
    return dict(id=container['Id'], image=container['Image'], running=True,
                scope='STORAGE_SENTINEL_NOT_BUSINESS_APP_HEALTH')


def load_r(stack, archive, meta, limits, peaks):
    with stack.sampler.phase('R_full_staged_import_with_W_and_reserve', peaks):
        for key in ('W', 'Z'):
            allocate(stack.volume, 'resource-' + key, limits[key])
        staged = stack.volume / 'owned-compatible.tar'
        shutil.copyfile(archive, staged)
        require(digest_file(staged, MAX_ARCHIVE) == (EXPECTED[R]['size'], EXPECTED[R]['sha']), 'R_STAGE_IDENTITY')
        # Feed the staged R archive through stdin; its full physical file remains
        # counted during the import, unlike E's off-store bounded stream.
        stream_to_process(staged, EXPECTED[R]['size'], EXPECTED[R]['sha'],
                          ['docker', 'exec', '-i', stack.name, 'docker', 'load'], stack.root / 'R-load.log', 300)
        image = stack.inspect(meta)
        require(digest_file(staged, MAX_ARCHIVE) == (EXPECTED[R]['size'], EXPECTED[R]['sha']), 'R_UNLINK_IDENTITY')
        staged.unlink()
    return image


def live(e_path, r_path, proof, containerd_bin):
    require(sys.platform == 'linux' and os.uname().machine == 'x86_64' and os.geteuid() == 0, 'OFFICIAL_LINUX_AMD64_ROOT_ONLY')
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == 'GPTJJ/budu'
            and os.environ.get('GITHUB_REF') == 'refs/heads/' + BRANCH, 'OFFICIAL_DIAGNOSTIC_BRANCH_ONLY')
    temp = Path(os.environ['RUNNER_TEMP']).resolve()
    require(temp == Path('/home/runner/work/_temp')
            and os.environ.get('GITHUB_WORKSPACE') == '/home/runner/work/budu/budu'
            and Path(__file__).resolve() == Path('/home/runner/work/budu/budu/scripts/test-purchase-receipt-space-isolated.py'),
            'STANDARD_EPHEMERAL_GITHUB_RUNNER_PATHS_ONLY')
    require(proof.resolve().is_relative_to(temp) and not proof.exists(), 'PROOF_OUTPUT_SCOPE')
    require(shutil.disk_usage(temp).free >= 20 * GIB, 'RUNNER_AVAILABLE_SPACE')
    token = uuid.uuid4().hex[:16]
    root = temp / ('procurement-space-proof-' + token)
    root.mkdir(mode=0o700)
    require(e_path.resolve().is_relative_to(temp) and r_path.resolve().is_relative_to(temp), 'INPUT_SCOPE')
    require(containerd_bin.resolve().is_relative_to(temp), 'CONTAINERD_INPUT_SCOPE')
    identity = json.loads((containerd_bin / '.identity.json').read_text())
    require(identity['archiveSHA256'] == CONTAINERD_SHA, 'CONTAINERD_ARCHIVE_IDENTITY')
    for name, sha in identity['binaries'].items():
        require(name in ('containerd', 'ctr', 'containerd-shim-runc-v2') and
                digest_file(containerd_bin / name, 96 * MIB)[1] == sha, 'CONTAINERD_BINARY_CHANGED')
    require(set(identity['binaries']) == {'containerd', 'ctr', 'containerd-shim-runc-v2'}, 'CONTAINERD_BINARY_SET')
    records = dict(exactE=E, fixedR=R, diagnosticSHA=os.environ['GITHUB_SHA'], productionActions=False,
                   businessCodeChanged=False, noArtifactOrCacheUploads=True,
                   physicalTests='RUNNING', projectionIsHistoricalNotProductionAdmission=True,
                   sourceArchivesKeptOnMac=True, actualCISender='RUNNER_OUTSIDE_ISOLATED_STORE',
                   actualMacToTargetNetworkTransfer='NOT RUN', actualBusinessRollback='NOT RUN_IN_THIS_DIAGNOSTIC',
                   businessRollbackEvidence='EXISTING_OFFICIAL_RUN_37262379341_14_PLUS_4_NOT_RERUN',
                   phases={}, failures={}, cleanup='PENDING')
    def deadline_unknown(signum, frame):
        raise Reject('DIAGNOSTIC_TERMINATED_UNKNOWN')
    previous_term = signal.signal(signal.SIGTERM, deadline_unknown)
    try:
        em, rm = inspect_archive(e_path, E), inspect_archive(r_path, R)
        shared = shared_layers(em, rm)
        limits, absolute = budgets()
        records.update(resourceLimitsBytes=limits, unchangedCombinedModel=absolute, historicalBaseline=BASE)
        run(['docker', 'pull', '--platform', 'linux/amd64', DIND], timeout=300)
        with Stack(root / 'normal', token + 'n', containerd_bin) as stack:
            records['stack'] = stack.info
            rid = load_r(stack, r_path, rm, limits, records['phases'])
            sentinel = r_sentinel(stack, rm)
            before_sentinel = assert_sentinel(stack, sentinel, rid)
            before = stack.objects(shared, rm['layers'])
            lock = ImportLock(root / 'normal.lock')
            lock.begin()
            with stack.sampler.phase('E_bounded_stream_R_retained_W_and_reserve', records['phases']):
                records['stream'] = stream_to_process(e_path, EXPECTED[E]['size'], EXPECTED[E]['sha'],
                    ['docker', 'exec', '-i', stack.name, 'docker', 'load'], root / 'E-load.log', 300)
                eid = stack.inspect(em)
                after = stack.objects(shared, em['layers'])
                verify_reuse(before, after)
                require(assert_sentinel(stack, sentinel, rid)['id'] == before_sentinel['id'], 'R_SENTINEL_REPLACED')
                lock.finish('IMPORTED_VERIFIED_HELD')
            records['sharedPhysicalReuse'] = dict(result='PASS', count=9, before=before, after=after)
            with stack.sampler.phase('both_images_all_resource_limits_retained', records['phases']):
                for key in ('D', 'Q', 'M'):
                    allocate(stack.volume, 'resource-' + key, limits[key])
                records['resourceAllocationScope'] = 'PHYSICAL_LIMIT_FIXTURES_NOT_DATABASE_COPY_OR_MIGRATION'
                candidate = 'e-storage-sentinel-' + stack.token
                stack.docker(['docker', 'run', '-d', '--name', candidate, '--network', 'none', '--read-only',
                              '--no-healthcheck', '--entrypoint', 'node', em['tag'], '-e', 'setInterval(()=>{},1000)'])
                assert_sentinel(stack, candidate, eid)
                stack.docker(['docker', 'stop', candidate])
                records['storageRollback'] = assert_sentinel(stack, sentinel, rid)
                require(stack.inspect(em) == eid and stack.inspect(rm) == rid, 'RETAINED_IMAGE_CHANGED')
                require(not (stack.volume / 'owned-compatible.tar').exists(), 'OWN_R_ARCHIVE_NOT_RELEASED')
                records['EArchiveManuallyStagedOnTargetStore'] = False
        # Each failed/UNKNOWN case has a fresh owned storage stack. In particular
        # an UNKNOWN lock is never bypassed by starting another import there.
        records['failureFixturePeaks'] = {}
        unique, truncate_at = late_e_candidates(em, rm)
        records['lateFaultBoundary'] = dict(truncatedPrefixBytes=truncate_at,
            fullArchiveBytes=EXPECTED[E]['size'], prefixFraction=truncate_at / EXPECTED[E]['size'],
            uniqueCandidates=[{k: x[k] for k in ('blob', 'bytes', 'chain', 'archiveDataOffset')} for x in unique])
        for index, case in enumerate(('invalidFormatOnly', 'truncatedEAfterUnique',
                                      'lateDaemonKillAfterUnique', 'wholeDindPauseTimeoutAfterUnique')):
            with Stack(root / case, token + 'f' + str(index), containerd_bin) as stack:
                failure_peaks = {}
                rid = load_r(stack, r_path, rm, limits, failure_peaks)
                records['failureFixturePeaks'][case] = failure_peaks
                sentinel = r_sentinel(stack, rm)
                before = stack.objects(shared, rm['layers'])
                with stack.sampler.phase('E_' + case + '_fault_exit_residual_and_R_recovery', failure_peaks):
                    initial_used = stack.sampler.used() - stack.sampler.baseline
                    if case == 'invalidFormatOnly':
                        result = subprocess.run(['docker', 'exec', '-i', stack.name, 'docker', 'load'],
                                                input=b'THIS IS NOT A DOCKER ARCHIVE\n', capture_output=True, timeout=30)
                        require(result.returncode != 0 and stack.inspect(rm) == rid, 'INVALID_IMPORT_ACCEPTED_OR_R_CHANGED')
                        verify_reuse(before, stack.objects(shared, rm['layers']))
                        records['failures'][case] = dict(result='PASS', returncode=result.returncode,
                            fixedR=assert_sentinel(stack, sentinel, rid), scope='FORMAT_ONLY_NOT_E_TRUNCATION_PROOF')
                        continue
                    require(stack.unique_blob_witness(unique) is None, 'E_UNIQUE_CONTENT_ALREADY_PRESENT')
                    lock = ImportLock(root / (case + '.lock'))
                    lock.begin()
                    event, transport = {}, {}
                    def inject_after_unique(sent):
                        if sent < EXPECTED[E]['size'] // 2:
                            return False
                        witness = stack.unique_blob_witness(unique)
                        if not late_fault_eligible(sent, EXPECTED[E]['size'], witness):
                            return False
                        event.update(uniqueWitness=witness, sentBytesAtFault=sent)
                        if case == 'lateDaemonKillAfterUnique':
                            event.update(stack.kill_dockerd())
                        else:
                            run(['docker', 'pause', stack.name])
                            event.update(kind='WHOLE_DIND_CONTAINER_PAUSE', wholeDindContainerPaused=True,
                                         isDaemonTermination=False)
                        return True
                    try:
                        stream_to_process(e_path, EXPECTED[E]['size'], EXPECTED[E]['sha'],
                            ['docker', 'exec', '-i', stack.name, 'docker', 'load'], root / (case + '.log'),
                            deadline_seconds=180, truncate_after=truncate_at if case == 'truncatedEAfterUnique' else None,
                            fault_hook=None if case == 'truncatedEAfterUnique' else inject_after_unique,
                            fault_deadline_seconds=8, evidence=transport)
                        raise Reject('FAULT_INJECTION_DID_NOT_INTERRUPT')
                    except Reject as error:
                        require(str(error).startswith('UNKNOWN:'), 'UNKNOWN_NOT_RECORDED')
                        lock.finish('UNKNOWN_RECOVERY_HELD')
                        reason = str(error)
                    finally:
                        after_exit_used = stack.sampler.used() - stack.sampler.baseline
                        if event.get('kind') == 'WHOLE_DIND_CONTAINER_PAUSE':
                            run(['docker', 'unpause', stack.name])
                        elif event.get('kind') == 'DOCKERD_PID_SIGKILL':
                            stack.recover_dockerd(event['pid'])
                    if case == 'truncatedEAfterUnique':
                        require('TRUNCATED_E_DAEMON_REJECTED' in reason, 'REAL_TRUNCATED_E_NOT_REJECTED')
                        event.update(kind='REAL_E_PREFIX_EOF', uniqueWitness=stack.unique_blob_witness(unique))
                    require(event.get('uniqueWitness') and event['uniqueWitness']['contentIsCommitted'], 'E_UNIQUE_PROCESSING_NOT_PROVEN')
                    try:
                        lock.begin()
                        raise Reject('SECOND_IMPORT_WAS_ALLOWED')
                    except Reject as error:
                        require(str(error) == 'IMPORT_LOCK_HELD', 'SECOND_IMPORT_NOT_BLOCKED')
                    restored = assert_sentinel(stack, sentinel, rid)
                    require(stack.inspect(rm) == rid, 'FIXED_R_CHANGED_AFTER_UNKNOWN')
                    verify_reuse(before, stack.objects(shared, rm['layers']))
                    ingests = stack.docker(['/opt/proof-containerd/bin/ctr', '--address', '/run/containerd/containerd.sock', '--namespace', 'moby',
                                           'content', 'active'], check=False).strip()
                    records['failures'][case] = dict(result='PASS', reason=reason, faultEvent=event, transport=transport,
                        retainedBeforeEFaultBytes=initial_used, retainedAfterClientExitBytes=after_exit_used,
                        retainedAfterRecoveryBytes=stack.sampler.used() - stack.sampler.baseline,
                        lockState='UNKNOWN_RECOVERY_HELD', secondImportBlocked=True, rStorageRecovered=restored,
                        daemonImportTermination='NOT_INFERRED_FROM_CLIENT_EXIT', activeIngestEvidence=ingests,
                        automaticLockRelease=False, resumedImport=False, ownedReadOnlyViewsRetained=len(stack.owned_views))
        # No production decision: retain all theoretical allowances even if
        # the observed sampled peak is smaller. No GC or old-image credit.
        union = 2858400432
        conservative = dict(R_full_staged_import_with_W_and_reserve=4921490955 + limits['W'],
            E_bounded_stream_R_retained_W_and_reserve=union + EXPECTED[E]['largest'] + limits['W'] + RESERVE,
            both_images_all_resource_limits_retained=union + sum(limits.values()))
        for name, measured in records['phases'].items():
            charged = max(conservative[name], measured['observedPeakBytes'])
            measured['conservativeGuardBytes'] = conservative[name]
            measured['historicalProjection'] = admission(BASE['used'], BASE['available'], charged)
        for case, phases in records['failureFixturePeaks'].items():
            for name, measured in phases.items():
                guard = (conservative['R_full_staged_import_with_W_and_reserve'] if name.startswith('R_')
                         else conservative['E_bounded_stream_R_retained_W_and_reserve'])
                measured['conservativeGuardBytes'] = guard
                measured['historicalProjection'] = admission(BASE['used'], BASE['available'],
                    max(guard, measured['observedPeakBytes']))
        records['physicalTests'] = 'PASS'
        records['result'] = 'ISOLATED_STORAGE_PROOF_ONLY_REQUIRES_ENGINEERING_REVIEW'
    except BaseException as error:
        records['physicalTests'] = 'FAIL'
        records['result'] = 'BLOCKED'
        records['error'] = type(error).__name__ + ':' + str(error)
        raise
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        records['cleanup'] = 'OWNED_STACK_TEARDOWN_COMPLETED' if not list(root.glob('*/store.ext4')) else 'OWNED_STACK_TEARDOWN_INCOMPLETE'
        records['cleanupCreditInProjectionBytes'] = 0
        if records['physicalTests'] != 'PASS':
            for path in root.glob('*.lock'):
                if json.loads(path.read_text()).get('state') == 'IMPORTING':
                    ImportLock(path).finish('UNKNOWN_RECOVERY_HELD')
        records['locksRetained'] = {p.name: json.loads(p.read_text()) for p in root.glob('*.lock')}
        text = json.dumps(records, indent=2, ensure_ascii=False) + '\n'
        require(len(text.encode()) <= 256 * 1024, 'PROOF_LOG_SIZE_BOUND')
        proof.write_text(text)


def unpack(bundle, destination):
    require(digest_file(bundle, ZIP_BYTES) == (ZIP_BYTES, ZIP_SHA), 'OFFICIAL_ZIP_IDENTITY')
    destination.mkdir()
    expected = {v['name']: v for v in EXPECTED.values()}
    with zipfile.ZipFile(bundle) as source:
        entries = source.infolist()
        require(len(entries) == 2 and {x.filename for x in entries} == set(expected), 'OFFICIAL_ZIP_MEMBERS')
        for entry in entries:
            meta = expected[entry.filename]
            require(entry.file_size == meta['size'] and not stat.S_ISLNK(entry.external_attr >> 16), 'ZIP_MEMBER_SIZE_OR_TYPE')
            path = destination / entry.filename
            h, count = hashlib.sha256(), 0
            with source.open(entry) as reader, path.open('xb') as target:
                for chunk in iter(lambda: reader.read(MIB), b''):
                    count += len(chunk)
                    require(count <= meta['size'], 'ZIP_EXPANSION_BOUND')
                    h.update(chunk)
                    target.write(chunk)
            require(count == meta['size'] and h.hexdigest() == meta['sha'], 'ZIP_MEMBER_SHA256')
    return dict(result='PASS', bytes=ZIP_BYTES, sha256=ZIP_SHA)


def unpack_containerd(bundle, destination):
    require(digest_file(bundle, CONTAINERD_BYTES) == (CONTAINERD_BYTES, CONTAINERD_SHA), 'CONTAINERD_OFFICIAL_ARCHIVE')
    destination.mkdir()
    expected = {'bin/containerd', 'bin/ctr', 'bin/containerd-shim-runc-v2'}
    identity = dict(archiveSHA256=CONTAINERD_SHA, version='2.2.1', binaries={})
    with tarfile.open(bundle, 'r:gz') as source:
        members = source.getmembers()
        require(len(members) <= 32 and len({x.name for x in members}) == len(members), 'CONTAINERD_MEMBER_COUNT')
        require(expected <= {x.name for x in members}, 'CONTAINERD_BINARY_MISSING')
        for entry in members:
            require(not entry.name.startswith('/') and '..' not in Path(entry.name).parts
                    and (entry.isdir() or entry.isfile()), 'CONTAINERD_UNSAFE_MEMBER')
            if entry.name not in expected:
                continue
            require(entry.isfile() and 0 < entry.size <= 96 * MIB, 'CONTAINERD_BINARY_SIZE')
            path = destination / Path(entry.name).name
            h, count = hashlib.sha256(), 0
            with source.extractfile(entry) as reader, path.open('xb') as target:
                for chunk in iter(lambda: reader.read(MIB), b''):
                    count += len(chunk)
                    require(count <= entry.size, 'CONTAINERD_EXPANSION_BOUND')
                    h.update(chunk)
                    target.write(chunk)
            require(count == entry.size, 'CONTAINERD_TRUNCATED')
            path.chmod(0o755)
            identity['binaries'][path.name] = h.hexdigest()
    (destination / '.identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    return identity


def selftest():
    passed = []
    def rejects(name, operation, reason):
        try:
            operation()
        except Reject as error:
            require(reason in str(error), 'UNEXPECTED_REJECTION:' + name)
            passed.append(name)
        else:
            raise Reject('NEGATIVE_ACCEPTED:' + name)
    limits, absolute = budgets()
    require(absolute['marginBytes'] == 3609511 and sum(limits[k] for k in ('D', 'Q', 'W', 'M')) == 1516021898, 'RESOURCE_LIMIT_DRIFT')
    passed.append('original_combined_model_and_all_independent_limits')
    require((MAX_ARCHIVE, CAP, RESERVE, MIN_AVAILABLE, MAX_USAGE) ==
            (768 * MIB, 6 * GIB, 512 * MIB, 10 * GIB, 90), 'GLOBAL_THRESHOLD_DRIFT')
    passed.append('all_original_global_thresholds_unchanged')
    budgets(BASE['db'] + 601585)
    passed.append('combined_DB_growth_last_permitted_byte')
    rejects('combined_DB_growth_first_failing_byte', lambda: budgets(BASE['db'] + 601586), 'COMBINED')
    info = dict(ServerVersion='29.1.3', Driver='overlayfs', DockerRootDir='/var/lib/docker',
                DriverStatus=[['driver-type', 'io.containerd.snapshotter.v1']])
    validate_stack(info, 'containerd v2.2.1', 'ext4', True)
    passed.append('exact_engine_containerd_backend_filesystem_accepted')
    rejects('different_Docker_version', lambda: validate_stack(dict(info, ServerVersion='28.0.4'), 'v2.2.1', 'ext4', True), 'STACK')
    rejects('overlay2_no_reuse_credit', lambda: validate_stack(dict(info, Driver='overlay2'), 'v2.2.1', 'ext4', True), 'STACK')
    rejects('missing_containerd_backend', lambda: validate_stack(dict(info, DriverStatus=[]), 'v2.2.1', 'ext4', True), 'STACK')
    rejects('different_containerd_version', lambda: validate_stack(info, 'v2.2.0', 'ext4', True), 'VERSION')
    rejects('different_filesystem', lambda: validate_stack(info, 'v2.2.1', 'xfs', True), 'FILESYSTEM')
    rejects('storage_on_different_devices', lambda: validate_stack(info, 'v2.2.1', 'ext4', False), 'FILESYSTEM')
    parent_path = '/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/42/fs'
    lower_path = '/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/17/fs'
    bind = dict(Type='bind', Source=parent_path, Target='', Options=['ro', 'rbind'])
    require(committed_parent_path(json.dumps([bind]))[0] == parent_path, 'BIND_PARENT_INODE_SELECTION')
    passed.append('v221_View_single_parent_JSON_selects_committed_Source')
    overlay = dict(Type='overlay', Source='overlay', Target='', Options=['lowerdir=' + parent_path + ':' + lower_path, 'index=off'])
    require(committed_parent_path(json.dumps([overlay]))[0] == parent_path, 'OVERLAY_PARENT_ORDER')
    passed.append('v221_View_multi_parent_JSON_selects_first_ParentID')
    rejects('v221_one_arg_help_even_exit_zero_is_not_mount_proof',
            lambda: committed_parent_path('USAGE: ctr snapshots mounts <target> <key>\n'), 'JSON_REQUIRED')
    rejects('printed_shell_mount_not_structured_View_result',
            lambda: committed_parent_path('mount -t bind ' + parent_path + ' /tmp/view -o ro,rbind\n'), 'JSON_REQUIRED')
    rejects('active_upperdir_not_committed_parent',
            lambda: committed_parent_path(json.dumps([dict(overlay, Options=overlay['Options'] + ['upperdir=' + lower_path])])), 'WRITABLE')
    rejects('rw_bind_not_readonly_view', lambda: committed_parent_path(json.dumps([dict(bind, Options=['rw', 'rbind'])])), 'WRITABLE')
    rejects('temporary_view_target_cannot_be_selected_as_layer_inode',
            lambda: committed_parent_path(json.dumps([dict(bind, Target=lower_path)])), 'FIELDS')
    rejects('unknown_mount_type_no_fallback', lambda: committed_parent_path(json.dumps([dict(bind, Type='tmpfs')])), 'TYPE')
    rejects('escaped_lowerdir_path_rejected',
            lambda: committed_parent_path(json.dumps([dict(overlay, Options=['lowerdir=/tmp/42/fs:' + lower_path])])), 'PATH')
    rejects('lowercase_JSON_fields_not_v221_contract',
            lambda: committed_parent_path('[{"type":"bind","source":"/tmp","target":"","options":["ro"]}]'), 'FIELDS')
    calls, view_key = [], ['']
    chain = 'sha256:' + '1' * 64
    blob = 'sha256:' + hashlib.sha256(b'hello').hexdigest()
    def contract_docker(args, **unused):
        calls.append(args)
        if args[:len(CTR_SNAPSHOTS)] == CTR_SNAPSHOTS:
            tail = args[len(CTR_SNAPSHOTS):]
            if tail[0] == 'view':
                require(len(tail) == 4 and tail[1] == '--mounts' and tail[3] == chain
                        and tail[2].startswith('proof-view-testtoken-'), 'V221_VIEW_ARGUMENT_ORDER')
                view_key[0] = tail[2]
                return json.dumps([bind])
            if tail[0] == 'label':
                require(len(tail) == 3 and tail[1] == view_key[0] and tail[2].startswith('containerd.io/gc.root='), 'VIEW_LABEL_OWNER')
                return tail[2]
            if tail == ['info', chain]:
                return json.dumps(dict(Kind='Committed', Name=chain))
            if tail == ['info', view_key[0]]:
                return json.dumps(dict(Kind='View', Name=view_key[0], Parent=chain))
            raise Reject('OLD_MOUNTS_CALL_OR_UNOWNED_CLI')
        if args[:3] == ['stat', '-c', '%d %i %s %b']:
            return '7 7001 5 8\n'
        if args[:1] == ['sha256sum']:
            return blob.split(':')[1] + '  ownedblob\n'
        if args == ['stat', '-c', '%d %i', parent_path]:
            return '7 7042\n'
        raise Reject('UNEXPECTED_FIXTURE_COMMAND')
    fixture = Stack(Path('/unused-owned-fixture'), 'testtoken', Path('/unused-bin'))
    fixture.docker = contract_docker
    layer = dict(blob=blob, bytes=5, chain=chain)
    objects = fixture.objects([layer], [layer])
    require(objects[chain]['topSnapshotPath'] == parent_path and objects[chain]['directoryStat'] == '7 7042'
            and objects[chain]['inodeScope'] == 'COMMITTED_PARENT_NOT_TEMP_VIEW' and len(fixture.owned_views) == 1,
            'COMMITTED_OBJECT_GETTER_REGRESSION')
    passed.append('object_getter_uses_actual_v221_View_argument_shape_and_parent_inode')
    require(not any('mounts' in args[len(CTR_SNAPSHOTS):] or 'remove' in args for args in calls), 'VIEW_EXPLICIT_REMOVE_OR_MOUNTS')
    passed.append('owned_View_retained_no_MountManager_activation_or_cleanup')
    def wrong_parent(args):
        raw = contract_docker(args)
        if args[len(CTR_SNAPSHOTS):] == ['info', view_key[0]]:
            return json.dumps(dict(Kind='View', Name=view_key[0], Parent='sha256:' + '2' * 64))
        return raw
    rejects('View_parent_must_equal_requested_committed_chain',
            lambda: read_owned_view(wrong_parent, 'testtoken', chain, []), 'PARENT_IDENTITY')
    require(not late_fault_eligible(2 * MIB, EXPECTED[E]['size'], {'contentIsCommitted':True}), 'EARLY_FAULT_ACCEPTED')
    passed.append('2MiB_fault_is_not_late_E_import_proof')
    require(not late_fault_eligible(EXPECTED[E]['size'], EXPECTED[E]['size'], None), 'UNIQUE_WITNESS_MISSING')
    passed.append('late_bytes_without_unique_content_cannot_trigger_fault')
    require(late_fault_eligible(EXPECTED[E]['size'] // 2, EXPECTED[E]['size'], {'contentIsCommitted':True}), 'LATE_WITNESS_NOT_ACCEPTED')
    passed.append('late_bytes_and_verified_unique_content_gate')
    if sys.platform != 'linux' or os.geteuid() != 0:
        rejects('local_host_cannot_enter_live_Docker_path',
                lambda: live(Path('/tmp/no-source'), Path('/tmp/no-source'), Path('/tmp/no-proof'), Path('/tmp/no-bin')),
                'OFFICIAL_LINUX_AMD64_ROOT_ONLY')
    admission(10 * GIB, 20 * GIB, CAP)
    passed.append('exact_6GiB_boundary_accepted')
    rejects('6GiB_plus_one_rejected', lambda: admission(10 * GIB, 20 * GIB, CAP + 1), 'COMBINED')
    admission(10 * GIB, 10 * GIB + CAP, CAP)
    passed.append('exact_10GiB_remaining_accepted')
    rejects('10GiB_minus_one_rejected', lambda: admission(10 * GIB, 10 * GIB + CAP - 1, CAP), 'HEADROOM')
    admission(90 * GIB, 10 * GIB, 0)
    passed.append('exact_90_percent_accepted')
    rejects('above_90_percent_rejected', lambda: admission(90 * GIB, 10 * GIB, 1), 'HEADROOM')
    rejects('negative_disk_rejected', lambda: admission(-1, 20 * GIB, 1), 'INVALID')
    rejects('zero_filesystem_rejected', lambda: admission(0, 0, 0), 'INVALID')
    with tempfile.TemporaryDirectory(prefix='procurement-space-selftest-') as temporary:
        root = Path(temporary)
        path = root / 'fixture'
        path.write_bytes(bytes(range(256)) * 8192)
        size, sha = digest_file(path, MAX_ARCHIVE)
        sink = [sys.executable, '-c', 'import hashlib,sys,json;h=hashlib.sha256();n=0\nfor b in iter(lambda:sys.stdin.buffer.read(65536),b" ".strip()):h.update(b);n+=len(b)\nprint(json.dumps({"bytes":n,"sha256":h.hexdigest()}))']
        result = stream_to_process(path, size, sha, sink, root / 'valid.log')
        require(json.loads((root / 'valid.log').read_text()) == {'bytes': size, 'sha256': sha} and result['bytes'] == size, 'PIPE_SINK_MISMATCH')
        passed.append('real_bounded_pipe_byte_count_and_hash')
        rejects('size_mismatch_before_spawn', lambda: stream_to_process(path, size - 1, sha, sink, root / 'bad.log'), 'PREFLIGHT')
        rejects('hash_mismatch_before_spawn', lambda: stream_to_process(path, size, '0' * 64, sink, root / 'bad.log'), 'PREFLIGHT')
        rejects('768MiB_plus_one_before_spawn', lambda: stream_to_process(path, MAX_ARCHIVE + 1, sha, sink, root / 'bad.log'), 'CAP')
        rejects('interrupted_pipe_UNKNOWN', lambda: stream_to_process(path, size, sha, sink, root / 'cut.log', cut_after=MIB), 'UNKNOWN')
        sleeper = [sys.executable, '-c', 'import time;time.sleep(10)']
        rejects('blocked_pipe_deadline_UNKNOWN', lambda: stream_to_process(path, size, sha, sleeper, root / 'timeout.log', deadline_seconds=.15), 'UNKNOWN')
        rejects('closed_pipe_UNKNOWN', lambda: stream_to_process(path, size, sha, [sys.executable, '-c', 'pass'], root / 'closed.log'), 'UNKNOWN')
        archive = root / 'real-fixture.tar'
        with tarfile.open(archive, 'w') as writer:
            writer.add(path, arcname='real-fixture-data')
        archive_size, archive_sha = digest_file(archive, MAX_ARCHIVE)
        tar_sink = [sys.executable, '-c', 'import tarfile,sys\nwith tarfile.open(fileobj=sys.stdin.buffer,mode="r|") as t:\n for m in t:\n  if m.isfile():\n   s=t.extractfile(m)\n   while s.read(65536):pass']
        transport = {}
        rejects('real_tar_truncated_prefix_eof_rejected_by_receiver', lambda: stream_to_process(
            archive, archive_size, archive_sha, tar_sink, root / 'truncated-tar.log',
            truncate_after=archive_size - 65536, evidence=transport), 'TRUNCATED_E_DAEMON_REJECTED')
        require(transport['sentBytes'] == archive_size - 65536 and transport['clientExitCode'] != 0,
                'TRUNCATED_PREFIX_TRANSPORT_EVIDENCE')
        passed.append('truncated_prefix_actual_sent_count_and_receiver_exit_retained')
        lock = ImportLock(root / 'lock')
        lock.begin()
        lock.finish('UNKNOWN_RECOVERY_HELD')
        rejects('UNKNOWN_blocks_second_import', lock.begin, 'LOCK_HELD')
        require(json.loads(lock.path.read_text())['state'] == 'UNKNOWN_RECOVERY_HELD', 'UNKNOWN_LOCK_LOST')
        passed.append('UNKNOWN_lock_and_evidence_preserved')
        p = root / 'symlink'
        p.symlink_to(path)
        rejects('symlink_source_rejected', lambda: digest_file(p, MAX_ARCHIVE), 'REGULAR')
        rejects('bounded_hash_overflow', lambda: digest_file(path, size - 1), 'SIZE_CAP')
        rejects('missing_nine_object_proof', lambda: verify_reuse({}, {}), 'COUNT')
        object_proof = {str(i): dict(blob='b', blobStat=['1','2','3','4'], sha256='h', topSnapshotPath='p',
                        directoryStat='1 2', mountSpecification='m', snapshot=dict(Parent='p')) for i in range(9)}
        verify_reuse(object_proof, object_proof)
        passed.append('complete_nine_object_identity_accepted')
        changed = json.loads(json.dumps(object_proof))
        changed['0']['blobStat'][1] = '99'
        rejects('different_blob_inode_rejected', lambda: verify_reuse(object_proof, changed), 'CHANGED')
        changed = json.loads(json.dumps(object_proof))
        changed['0']['directoryStat'] = '1 99'
        rejects('different_snapshot_inode_rejected', lambda: verify_reuse(object_proof, changed), 'CHANGED')
        changed = json.loads(json.dumps(object_proof))
        changed['0']['snapshot']['Parent'] = 'wrong'
        rejects('different_snapshot_parent_rejected', lambda: verify_reuse(object_proof, changed), 'PARENT')
    return dict(result='PASS', count=len(passed), cases=passed, dockerPhysicalTests='NOT RUN',
                realContainerdCLIRegression='NOT RUN (official isolated runner pending publication)',
                nativeCLICases='SOURCE_BACKED_ARGUMENT_AND_JSON_FIXTURES_NOT_RPC_EXECUTION', productionActions=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--unpack-zip', type=Path)
    parser.add_argument('--unpack-containerd', type=Path)
    parser.add_argument('--containerd-bin', type=Path)
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--inspect-local', action='store_true')
    parser.add_argument('--e-archive', type=Path)
    parser.add_argument('--r-archive', type=Path)
    parser.add_argument('--proof', type=Path)
    args = parser.parse_args()
    if args.self_test:
        print(json.dumps(selftest(), indent=2))
    elif args.unpack_zip:
        require(args.destination is not None, 'DESTINATION_REQUIRED')
        print(json.dumps(unpack(args.unpack_zip, args.destination)))
    elif args.unpack_containerd:
        require(args.destination is not None, 'DESTINATION_REQUIRED')
        print(json.dumps(unpack_containerd(args.unpack_containerd, args.destination)))
    elif args.inspect_local:
        e, r = inspect_archive(args.e_archive, E), inspect_archive(args.r_archive, R)
        unique, cutoff = late_e_candidates(e, r)
        with tempfile.TemporaryDirectory(prefix='procurement-mac-stream-') as temporary:
            log = Path(temporary) / 'stream.log'
            sink = [sys.executable, '-c', 'import hashlib,sys,json;h=hashlib.sha256();n=0\nfor b in iter(lambda:sys.stdin.buffer.read(1048576),b""):h.update(b);n+=len(b)\nprint(json.dumps({"bytes":n,"sha256":h.hexdigest()}))']
            result = stream_to_process(args.e_archive, EXPECTED[E]['size'], EXPECTED[E]['sha'], sink, log)
            require(json.loads(log.read_text()) == {'bytes': result['bytes'], 'sha256': result['sha256']}, 'LOCAL_FULL_STREAM_SINK')
        print(json.dumps(dict(result='PASS', sharedLayers=shared_layers(e, r), macSourceStream=result,
                             lateFaultPlan=dict(truncatedPrefixBytes=cutoff, fullBytes=e['archiveBytes'],
                                prefixFraction=cutoff / e['archiveBytes'],
                                verifiedUniqueCandidates=unique, liveLateFaultTests='NOT RUN'),
                             dockerPhysicalTests='NOT RUN', productionActions=False), indent=2))
    else:
        require(all((args.e_archive, args.r_archive, args.proof, args.containerd_bin)), 'LIVE_ARGUMENTS_REQUIRED')
        live(args.e_archive, args.r_archive, args.proof, args.containerd_bin)


if __name__ == '__main__':
    main()
