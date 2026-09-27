#!/usr/bin/env python3
"""Gate 8R read-only production incident audit.

Evidence-only. No production file/container/image/lock/route/database mutation.
"""
import json
import os
import re
import shlex
import subprocess
from pathlib import Path

HOST = os.environ.get("BJ_HOST", "")
USER = os.environ.get("BJ_USER", "")
KEY = os.path.expanduser("~/.ssh/id_ed25519")
BASELINE_SHA = "5ad27a06d731fbc94de5ae3776060b4350b886e8"
RELEASE_SHA = "e9d6101b78160742b50d8d7ecd2f20e00d660979"
DB = "budu_bj006"
PG = "budu-bj-006-final-restore-20260822-055653z-pg"
TEMPLATE = "/opt/budu/deploy/nginx/conf.d/budu.conf.template"
ACTIVE = "/etc/nginx/conf.d/budu.conf"
CURRENT = "/opt/budu/.current-sha"
LOCK = "/run/lock/budu-transfer-cas-release"
ROLLBACK_ROOT = f"/opt/budu/.rollback-assets/sku-authority-{RELEASE_SHA}"

if HOST != "154.8.195.42" or USER != "ubuntu":
    raise SystemExit("AUDIT_TARGET_IDENTITY_INVALID")

ssh = [
    "ssh", "-i", KEY, "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no", "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=12", f"{USER}@{HOST}",
]

def remote(args, *, data=None, timeout=90, sudo=False):
    cmd = (["sudo", "-n"] if sudo else []) + args
    proc = subprocess.run(
        ssh + [shlex.join(cmd)], input=data, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=timeout, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError(f"REMOTE_READ_FAILED:{args[0]}")
    return proc.stdout.decode(errors="replace").strip()

def emit(key, value):
    print(json.dumps({key: value}, ensure_ascii=False, sort_keys=True))

template = remote(["cat", TEMPLATE], sudo=True)
active = remote(["docker", "exec", "budu-nginx-1", "cat", ACTIVE], sudo=True)
targets = re.findall(r"proxy_pass http://([A-Za-z0-9_.-]+):3000;", template)
if len(targets) != 3 or len(set(targets)) != 1:
    raise SystemExit("ROUTE_AUTHORITY_INVALID")
old = targets[0]
emit("route", {"target": old, "templateEqualsActive": template == active})

running = remote(["docker", "inspect", "-f", "{{.State.Running}}", old], sudo=True)
health = remote(["docker", "inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", old], sudo=True)
label_sha = remote(["docker", "inspect", "-f", "{{index .Config.Labels \"org.opencontainers.image.revision\"}}", old], sudo=True)
git_sha = remote(["sh", "-lc", f"docker inspect -f '{{{{range .Config.Env}}}}{{{{println .}}}}{{{{end}}}}' {shlex.quote(old)} | sed -n 's/^GIT_SHA=//p'"], sudo=True)
current_sha = remote(["cat", CURRENT], sudo=True)
emit("runtime", {
    "container": old, "running": running == "true", "health": health,
    "labelSha": label_sha, "gitSha": git_sha, "currentShaPointer": current_sha,
    "baselineExact": label_sha == BASELINE_SHA and git_sha == BASELINE_SHA and current_sha == BASELINE_SHA,
})

containers = remote(["docker", "ps", "-a", "--format", "{{.Names}}|{{.Image}}|{{.Status}}"], sudo=True).splitlines()
interesting = [x for x in containers if RELEASE_SHA[:12] in x or "sku-authority" in x or "sku-worker" in x]
emit("releaseContainers", interesting)

images = remote(["docker", "images", "--no-trunc", "--format", "{{.Repository}}:{{.Tag}}|{{.ID}}"], sudo=True).splitlines()
interesting_images = [x for x in images if f"sku-authority-{RELEASE_SHA[:12]}" in x or f"sku-migration-{RELEASE_SHA[:12]}" in x]
emit("releaseImages", interesting_images)

lock_state = remote(["sh", "-lc", f"if test -e {shlex.quote(LOCK)}; then stat -c '%F|%s|%Y' {shlex.quote(LOCK)}; else printf ABSENT; fi"], sudo=True)
emit("releaseLock", lock_state)

rollback_state = remote(["sh", "-lc", (
    f"if test -d {shlex.quote(ROLLBACK_ROOT)}; then "
    f"printf 'PRESENT\\n'; "
    f"for f in phase.json pre-migration.dump pre-migration.sha256 sku-plan.json migration-started route-template route-active; do "
    f"p={shlex.quote(ROLLBACK_ROOT)}/$f; "
    f"if test -e \"$p\"; then stat -c \"$f|%F|%s|%Y\" \"$p\"; else printf \"$f|ABSENT\\n\"; fi; "
    f"done; "
    f"if test -f {shlex.quote(ROLLBACK_ROOT)}/phase.json; then printf 'PHASE|'; cat {shlex.quote(ROLLBACK_ROOT)}/phase.json; fi; "
    f"if test -f {shlex.quote(ROLLBACK_ROOT)}/pre-migration.sha256; then printf '\\nBACKUP_SHA256|'; cat {shlex.quote(ROLLBACK_ROOT)}/pre-migration.sha256; fi; "
    f"else printf ABSENT; fi"
)], sudo=True)
emit("rollbackRoot", rollback_state.splitlines())

probe = (
    "import { prisma } from './server/pg.js'; "
    "try { const rows = await prisma.$queryRawUnsafe('SELECT 1 AS ok'); "
    "if (rows.length !== 1 || rows[0].ok !== 1) throw Error('BAD_RESULT'); "
    "process.stdout.write('DB_READ_OK\\n'); } catch { process.exitCode=1; } "
    "finally { try { await prisma.$disconnect(); } catch { process.exitCode=1; } }"
)
prisma_probe = remote(
    ["docker", "exec", "-w", "/app", "-e",
     "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0",
     old, "node", "--input-type=module", "-e", probe],
    sudo=True, timeout=30
)
emit("oldAppPrismaProbe", prisma_probe)

db_sql = r"""BEGIN READ ONLY;
SELECT json_build_object(
  'database', current_database(),
  'applied', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
  'failed', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),
  'clients', (SELECT coalesce(json_agg(distinct coalesce(host(client_addr),'LOCAL_SOCKET')),'[]'::json)
              FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()),
  'products', (SELECT count(*) FROM "InventoryItem" WHERE category='product'),
  'assignments', (SELECT CASE WHEN to_regclass('public.product_sku_assignments') IS NULL THEN NULL
                             ELSE (SELECT count(*) FROM product_sku_assignments) END),
  'aliases', (SELECT CASE WHEN to_regclass('public.product_sku_aliases') IS NULL THEN NULL
                         ELSE (SELECT count(*) FROM product_sku_aliases) END),
  'orphanProducts', (SELECT CASE WHEN to_regclass('public.product_sku_assignments') IS NULL THEN NULL ELSE
      (SELECT count(*) FROM "InventoryItem" i WHERE i.category='product'
       AND NOT EXISTS (SELECT 1 FROM product_sku_assignments a WHERE a.item_id=i.id)) END),
  'online', (SELECT count(*) FROM "OnlineProductPolicy")
);
COMMIT;"""
db_out = remote(["sh", "-lc", (
    f"u=$(docker inspect -f '{{{{range .Config.Env}}}}{{{{println .}}}}{{{{end}}}}' {shlex.quote(PG)} | sed -n 's/^POSTGRES_USER=//p' | head -n1); "
    f"docker exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0' "
    f"{shlex.quote(PG)} psql -X -qAt -v ON_ERROR_STOP=1 -U \"\${{u:-postgres}}\" -d {DB}"
)], data=db_sql.encode(), sudo=True, timeout=45)
db_state = json.loads(db_out)
emit("database", db_state)

writer_scan = remote(["python3", "-c", r'''
import json,subprocess
from urllib.parse import urlsplit,unquote
ids=subprocess.check_output(["docker","ps","-q"]).decode().split()
out=[]
for i in ids:
    c=json.loads(subprocess.check_output(["docker","inspect",i]))[0]
    env={}
    for x in c.get("Config",{}).get("Env",[]) or []:
        if "=" in x:
            k,v=x.split("=",1); env[k]=v
    url=env.get("DATABASE_URL","")
    try: db=unquote(urlsplit(url).path).strip("/")
    except Exception: db=""
    if db=="budu_bj006":
        ips=[v.get("IPAddress") for v in c.get("NetworkSettings",{}).get("Networks",{}).values() if v.get("IPAddress")]
        out.append({"name":c["Name"].lstrip("/"),"ips":ips})
print(json.dumps(out,sort_keys=True))
'''], sudo=True)
emit("dbContainers", json.loads(writer_scan))

snapshot_script = Path("scripts/sku-release-snapshot-probe.mjs").read_bytes()
snapshot_cmd = [
    "docker", "exec", "-i", "-w", "/app",
    "-e", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000 -c temp_file_limit=0",
    old, "node", "--input-type=module"
]
snapshot_raw = remote(snapshot_cmd, data=snapshot_script, sudo=True, timeout=150)
checked = subprocess.run(
    ["node", "scripts/sku-release-readiness-plan.mjs"],
    input=snapshot_raw.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    check=False, timeout=30
)
if checked.returncode != 0:
    emit("snapshotAuthority", {"result": "DRIFT_OR_INVALID"})
else:
    emit("snapshotAuthority", {"result": "PASS", **json.loads(checked.stdout)})

print(json.dumps({"RESULT":"GATE_8R_READ_ONLY_EVIDENCE_READY","PRODUCTION_MUTATION":"NONE"},sort_keys=True))
