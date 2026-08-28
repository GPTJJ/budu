#!/usr/bin/env python3
"""Create an unrouted production candidate from an existing API container.

The script preserves the authoritative runtime environment and mounts without
printing their values. Only the release SHA, fixed CustomerRequest binding,
payment-worker mode, name, image, and network are changed.
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile


if len(sys.argv) not in {8, 9}:
    raise SystemExit(
        "usage: clone-production-container.py CURRENT CANDIDATE IMAGE SHA BINDING_FILE NETWORK PAYMENT_MODE [RUNTIME_MODE]"
    )

current, candidate, image, release_sha, binding_path, network, payment_mode = sys.argv[1:8]
runtime_mode = sys.argv[8] if len(sys.argv) == 9 else "writer"
if payment_mode not in {"disabled", "preserve"}:
    raise SystemExit("PAYMENT_MODE_INVALID")
if runtime_mode not in {"writer", "readonly", "migration"}:
    raise SystemExit("RUNTIME_MODE_INVALID")
binding = json.loads(pathlib.Path(binding_path).read_text(encoding="utf-8"))
username = binding.get("username")
user_id = binding.get("userId")
if username != "budu" or user_id != "dh":
    raise SystemExit("RECIPIENT_BINDING_INVALID")

raw = subprocess.check_output(["docker", "inspect", current], text=True)
source = json.loads(raw)[0]
env = {}
for item in source["Config"].get("Env") or []:
    key, separator, value = item.partition("=")
    if separator:
        env[key] = value
env["GIT_SHA"] = release_sha
env["CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME"] = username
env["CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID"] = user_id
if payment_mode == "disabled":
    env["WECHAT_PAY_ENABLED"] = "0"
if runtime_mode == "readonly":
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        raise SystemExit("DATABASE_URL_MISSING")
    separator = "&" if "?" in database_url else "?"
    env["DATABASE_URL"] = f"{database_url}{separator}options=-c%20default_transaction_read_only%3Don"

args = [
    "docker", "create", "--name", candidate,
    "--network", network,
    "--restart", "no",
    "--label", "budu.production-role=candidate",
    "--label", f"org.opencontainers.image.revision={release_sha}",
]

for mount in source.get("Mounts") or []:
    mount_type = mount.get("Type")
    destination = mount.get("Destination")
    if mount_type not in {"bind", "volume"} or not destination:
        raise SystemExit(f"UNSUPPORTED_RUNTIME_MOUNT_{mount_type or 'unknown'}")
    source_path = mount.get("Name") if mount_type == "volume" else mount.get("Source")
    if not source_path:
        raise SystemExit("RUNTIME_MOUNT_SOURCE_MISSING")
    spec = f"type={mount_type},source={source_path},target={destination}"
    if not mount.get("RW", True):
        spec += ",readonly"
    args.extend(["--mount", spec])

for key, value in sorted(env.items()):
    if "\n" in key or "\n" in value or "\r" in key or "\r" in value:
        raise SystemExit("RUNTIME_ENV_LINE_BREAK_INVALID")
env_dir = "/dev/shm" if pathlib.Path("/dev/shm").is_dir() else None
env_fd, env_path = tempfile.mkstemp(prefix=".budu-candidate-env-", dir=env_dir, text=True)
with os.fdopen(env_fd, "w", encoding="utf-8") as env_file:
    for key, value in sorted(env.items()):
        env_file.write(f"{key}={value}\n")
os.chmod(env_path, 0o600)
args.extend(["--env-file", env_path])

args.append(image)
if runtime_mode == "readonly":
    args.extend(["node", "server/index.js"])
elif runtime_mode == "migration":
    args.extend(["npx", "prisma", "migrate", "deploy"])
try:
    result = subprocess.run(args, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
finally:
    pathlib.Path(env_path).unlink(missing_ok=True)
if result.returncode != 0:
    raise SystemExit(f"DOCKER_CREATE_FAILED_{result.returncode}")
container_id = result.stdout.strip()

source_networks = sorted((source.get("NetworkSettings") or {}).get("Networks") or {})
if network not in source_networks:
    raise SystemExit("PRIMARY_NETWORK_NOT_PRESENT_ON_SOURCE")
for extra_network in source_networks:
    if extra_network == network:
        continue
    connect = subprocess.run(
        ["docker", "network", "connect", extra_network, candidate],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if connect.returncode != 0:
        raise SystemExit(f"DOCKER_NETWORK_CONNECT_FAILED_{connect.returncode}")

start = subprocess.run(
    ["docker", "start", candidate],
    check=False,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)
if start.returncode != 0:
    raise SystemExit(f"DOCKER_START_FAILED_{start.returncode}")

print(json.dumps({
    "created": True,
    "containerIdPrefix": container_id[:12],
    "networkCount": len(source_networks),
    "paymentMode": payment_mode,
    "runtimeMode": runtime_mode,
}))
