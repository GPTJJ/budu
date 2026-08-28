#!/usr/bin/env python3
"""Create an unrouted production candidate from an existing API container.

The script preserves the authoritative runtime environment and mounts without
printing their values. Only the release SHA, fixed CustomerRequest recipient,
payment-worker mode, name, image, and network are changed.
"""
import json
import pathlib
import re
import subprocess
import sys


if len(sys.argv) != 8:
    raise SystemExit(
        "usage: clone-production-container.py CURRENT CANDIDATE IMAGE SHA RECIPIENT_FILE NETWORK PAYMENT_MODE"
    )

current, candidate, image, release_sha, recipient_path, network, payment_mode = sys.argv[1:]
if payment_mode not in {"disabled", "preserve"}:
    raise SystemExit("PAYMENT_MODE_INVALID")
recipient = pathlib.Path(recipient_path).read_text(encoding="utf-8").strip()
if not re.fullmatch(r"[A-Za-z0-9._@-]{1,64}", recipient):
    raise SystemExit("RECIPIENT_USER_ID_INVALID")

raw = subprocess.check_output(["docker", "inspect", current], text=True)
source = json.loads(raw)[0]
env = {}
for item in source["Config"].get("Env") or []:
    key, separator, value = item.partition("=")
    if separator:
        env[key] = value
env["GIT_SHA"] = release_sha
env["CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID"] = recipient
if payment_mode == "disabled":
    env["WECHAT_PAY_ENABLED"] = "0"

args = [
    "docker", "run", "-d", "--name", candidate,
    "--network", network,
    "--restart", "no",
    "--label", "budu.production-role=candidate",
    "--label", f"org.opencontainers.image.revision={release_sha}",
]
for key, value in sorted(env.items()):
    args.extend(["--env", f"{key}={value}"])

for mount in source.get("Mounts") or []:
    mount_type = mount.get("Type")
    destination = mount.get("Destination")
    if mount_type not in {"bind", "volume"} or not destination:
        raise SystemExit(f"UNSUPPORTED_RUNTIME_MOUNT_{mount_type or 'unknown'}")
    source_path = mount.get("Source") or mount.get("Name")
    if not source_path:
        raise SystemExit("RUNTIME_MOUNT_SOURCE_MISSING")
    spec = f"type={mount_type},source={source_path},target={destination}"
    if not mount.get("RW", True):
        spec += ",readonly"
    args.extend(["--mount", spec])

args.append(image)
result = subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
container_id = result.stdout.strip()
print(json.dumps({"created": True, "containerIdPrefix": container_id[:12], "paymentMode": payment_mode}))
