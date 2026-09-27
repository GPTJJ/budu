#!/usr/bin/env python3
"""CI-only Prisma DB probe against local disposable PostgreSQL containers."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import time

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('release', Path(__file__).with_name('deploy-prod-transfer-cas.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def docker(*args, timeout=30):
    result = subprocess.run(['docker', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError('ISOLATED_DOCKER_COMMAND_FAILED')
    return result.stdout.decode().strip()


class LocalDocker:
    def run(self, args, data=None, timeout=60):
        if args[0] != 'docker' or data is not None:
            raise RuntimeError('ISOLATED_PROBE_COMMAND_INVALID')
        try:
            result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise release.GateError('COMMAND_UNAVAILABLE_OR_TIMEOUT') from None
        if result.returncode:
            raise release.GateError('COMMAND_FAILED')
        return result.stdout


def main(image):
    if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_OS') != 'Linux'
            or os.environ.get('DOCKER_HOST') not in (None, 'unix:///var/run/docker.sock')
            or os.environ.get('DOCKER_CONTEXT')):
        raise RuntimeError('ISOLATED_RUNNER_REQUIRED')
    suffix = os.environ['GITHUB_RUN_ID'] + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
    network = 'probe-net-' + suffix
    pg = 'probe-pg-' + suffix
    old = 'probe-old-' + suffix
    candidate = 'probe-candidate-' + suffix
    bad = 'probe-bad-' + suffix
    names = (old, candidate, bad)
    fixture_url = 'postgresql://postgres:fixture_only@' + pg + ':5432/probe_fixture'
    bad_url = 'postgresql://postgres:fixture_only@no-such-pg:5432/probe_fixture'

    def writers(expected):
        running = set(docker('ps', '--format', '{{.Names}}').splitlines())
        if set(names) & running != set(expected):
            raise RuntimeError('ISOLATED_WRITER_COUNT_INVALID')

    try:
        docker('network', 'create', network)
        docker('run', '-d', '--name', pg, '--network', network,
               '-e', 'POSTGRES_PASSWORD=fixture_only', '-e', 'POSTGRES_DB=probe_fixture',
               'postgres:16.14', timeout=180)
        for _ in range(30):
            ready = subprocess.run(['docker', 'exec', pg, 'pg_isready', '-U', 'postgres', '-d', 'probe_fixture'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('ISOLATED_POSTGRES_NOT_READY')
        for name, url in ((old, fixture_url), (candidate, fixture_url), (bad, bad_url)):
            docker('create', '--name', name, '--network', network,
                   '-e', 'DATABASE_URL=' + url, '--entrypoint', 'sleep', image, '600')
        remote = LocalDocker()
        docker('start', old)
        writers([old])
        docker('stop', old)
        writers([])
        docker('start', candidate)
        writers([candidate])
        release.application_db_probe(remote, candidate, 'CANDIDATE_APPLICATION_DB_PROBE_FAILED')
        switch_point_reached = True
        docker('stop', candidate)
        writers([])
        docker('start', old)
        release.application_db_probe(remote, old, 'ROLLBACK_APPLICATION_DB_PROBE_FAILED')
        writers([old])

        docker('stop', old)
        writers([])
        docker('start', bad)
        writers([bad])
        switch_point_reached_after_failure = False
        try:
            release.application_db_probe(remote, bad, 'CANDIDATE_APPLICATION_DB_PROBE_FAILED')
        except release.GateError as error:
            if str(error) != 'CANDIDATE_APPLICATION_DB_PROBE_FAILED':
                raise RuntimeError('ISOLATED_FAILURE_CODE_INVALID') from None
        else:
            switch_point_reached_after_failure = True
        if not switch_point_reached or switch_point_reached_after_failure:
            raise RuntimeError('ISOLATED_SWITCH_GATE_INVALID')
        docker('stop', bad)
        writers([])
        docker('start', old)
        release.application_db_probe(remote, old, 'ROLLBACK_APPLICATION_DB_PROBE_FAILED')
        writers([old])
        print('REAL_CANDIDATE_DB_PROBE=PASS REAL_PROBE_FAILURE_ROLLBACK=PASS SINGLE_WRITER=PASS')
    finally:
        for name in (*names, pg):
            subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=False)
        subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False)


if __name__ == '__main__':
    try:
        main(sys.argv[1])
    except BaseException:
        print('CANDIDATE_DB_PROBE_INTEGRATION_FAILED', file=sys.stderr)
        raise SystemExit(1) from None
