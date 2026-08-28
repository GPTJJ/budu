#!/usr/bin/env python3
"""Create an unrouted production candidate from an existing API container.

The script preserves the authoritative runtime environment and mounts without
printing their values. Only the release SHA, fixed CustomerRequest binding,
payment-worker mode, name, image, and network are changed.
"""
import json
import pathlib
import subprocess
import sys


if len(sys.argv) != 8:
    raise SystemExit(
        "usage: clone-production-container.py CURRENT CANDIDATE IMAGE SHA BINDING_FILE NETWORK PAYMENT_MODE"
    )

current, candidate, image, release_sha, binding_path, network, payment_mode = sys.argv[1:]
if payment_mode not in {"disabled", "preserve"}:
    raise SystemExit("PAYMENT_MODE_INVALID")
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
