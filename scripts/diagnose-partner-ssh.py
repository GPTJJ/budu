"""One bounded SSH throughput measurement; production writes only /dev/null."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import time

RELEASE = "682234baf03f2b4934a5a913843e4b55542184b4"
PRODUCTION = "5ad27a06d731fbc94de5ae3776060b4350b886e8"
BYTES = 256 * 1024 * 1024
PIN = "154.8.195.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJJGZ1Kape1om+8xOhoI7IsgvKN1tw6sh8l7PGisgtb"
SINK = """import json,sys
n=0
with open('/dev/null','wb',buffering=0) as sink:
    while True:
        block=sys.stdin.buffer.read(1024*1024)
        if not block: break
        sink.write(block)
        n+=len(block)
print(json.dumps({'received_bytes':n}))
"""
STATE = """import json,pathlib
print(json.dumps({'production_sha':pathlib.Path('/opt/budu/.current-sha').read_text().strip(),
                  'release_lock_present':pathlib.Path('/run/lock/budu-transfer-cas-release').is_dir()}))
"""


def main():
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("GITHUB_REPOSITORY") == "GPTJJ/budu"
    assert os.environ.get("GITHUB_REF") == "refs/heads/codex/partner-import-diagnosis"
    assert os.environ.get("GITHUB_RUN_ATTEMPT") == "1"
    assert os.environ.get("RUNNER_OS") == "Linux"
    assert os.environ.get("RUNNER_ARCH") == "X64"
    root = Path(os.environ["RUNNER_TEMP"]) / "partner-ssh-diagnosis"
    root.mkdir(mode=0o700)
    controller = subprocess.check_output(["git", "show", RELEASE + ":scripts/deploy-prod-transfer-cas.py"])
    (root / "controller.py").write_bytes(controller)
    adapter = subprocess.check_output(["git", "show", RELEASE + ":scripts/release-prod-post-transfer-ci.sh"])
    assert PIN.encode() in adapter
    known = root / "known_hosts"
    known.write_text(PIN + "\n")
    known.chmod(0o600)
    os.environ["TRANSFER_CAS_KNOWN_HOSTS"] = str(known)
    spec = importlib.util.spec_from_file_location("release_controller", root / "controller.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    remote = module.Remote(Path.home() / ".ssh/id_ed25519")
    before = json.loads(remote.run(["python3", "-c", STATE]))
    assert before == {"production_sha": PRODUCTION, "release_lock_present": True}, before
    payload = root / "payload.bin"
    with payload.open("xb") as out:
        for _ in range(256):
            out.write(os.urandom(1024 * 1024))
    assert payload.stat().st_size == BYTES
    result = {"release_sha": RELEASE, "bytes": BYTES, "state_before": before,
              "destination": "/dev/null", "runner": os.environ.get("ImageOS")}
    started = time.monotonic()
    print(json.dumps({"stage": "SSH_THROUGHPUT_STARTED", "bytes": BYTES}), flush=True)
    try:
        with payload.open("rb") as stream:
            proc = subprocess.Popen(remote.ssh + [shlex.join(["python3", "-c", SINK])],
                                    stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            while True:
                try:
                    stdout, stderr = proc.communicate(timeout=60)
                    break
                except subprocess.TimeoutExpired:
                    elapsed = time.monotonic() - started
                    print(json.dumps({"stage": "SSH_THROUGHPUT_RUNNING", "elapsed_seconds": round(elapsed, 2)}), flush=True)
                    if elapsed >= 6900:
                        proc.kill()
                        proc.communicate()
                        raise TimeoutError("SSH_THROUGHPUT_TIMEOUT")
        elapsed = time.monotonic() - started
        assert proc.returncode == 0, "SSH_TRANSFER_FAILED"
        assert json.loads(stdout) == {"received_bytes": BYTES}, "RECEIVED_BYTES_MISMATCH"
        after = json.loads(remote.run(["python3", "-c", STATE]))
        assert after == before, "PRODUCTION_STATE_CHANGED"
        result.update(result="PASS", received_bytes=BYTES, elapsed_seconds=elapsed,
                      mib_per_second=256 / elapsed, mbps=BYTES * 8 / elapsed / 1e6,
                      estimated_566_6_mib_seconds=elapsed * 566.6 / 256,
                      estimated_actual_566601216_bytes_seconds=elapsed * 566601216 / BYTES,
                      state_after=after)
    except Exception as error:
        result.update(result="BLOCKED", error_type=type(error).__name__, elapsed_seconds=time.monotonic() - started)
        raise
    finally:
        payload.unlink(missing_ok=True)
        (root / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result), flush=True)
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write("```json\n" + json.dumps(result, indent=2) + "\n```\n")


if __name__ == "__main__":
    main()
