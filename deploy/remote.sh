#!/usr/bin/env bash
# The public demo's server, from Rohit's laptop (no GitHub: tar over SSH through Google's IAP tunnel).
#   deploy/remote.sh setup     once: Node, Caddy, the data disk, the services (vm-setup.sh)
#   deploy/remote.sh caddy     the Caddyfile only: the domain and the names that redirect to it (validated, then reloaded)
#   deploy/remote.sh secrets   once (or after a key changes): key files, the keystore, the face models, the env file
#   deploy/remote.sh deploy    a new release: copy, install, build, switch, restart, health check (rolls back if bad)
#   deploy/remote.sh health    the backend's health, asked on the VM itself
#   deploy/remote.sh logs      the last backend and web log lines
#   deploy/remote.sh backup    a fresh SQLite backup, copied to accounts/remote-backups/ (git-ignored)
#   deploy/remote.sh seed      the public demo's data (agents/scripts/public-seed.ts, on the VM)
# Secrets are copied as files (600, owned by the app's user), never printed, never on a command line.
set -euo pipefail
cd "$(dirname "$0")"
. ./config.sh
ROOT=$(cd .. && pwd)
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

# Files go as a tar stream over SSH (macOS's rsync can't set owners), then get their owner and modes on the server.
export COPYFILE_DISABLE=1
# send <local dir> <remote dir> <file mode> <dir mode> [tar options and paths]: owned by the app's user.
send() {
  local from="$1" to="$2" fmode="$3" dmode="$4"
  shift 4
  [ $# -gt 0 ] || set -- .
  tar --no-xattrs --no-mac-metadata -C "$from" -czf - "$@" | vm_ssh --command="sudo mkdir -p $to && sudo tar -xzf - -C $to --no-same-owner && sudo chown -R likeness:likeness $to && sudo find $to -path '*/node_modules' -prune -o -type f -exec chmod $fmode {} + && sudo find $to -path '*/node_modules' -prune -o -type d -exec chmod $dmode {} +"
}
as_app() { vm_ssh --command="sudo -u likeness bash -lc $(printf '%q' "$1")"; }

case "${1:-}" in
setup)
  tar -czf - vm-setup.sh likeness-backend.service likeness-web.service likeness-backup.service likeness-backup.timer Caddyfile | vm_ssh --command="rm -rf /tmp/facevisa-deploy && mkdir -p /tmp/facevisa-deploy && tar -xzf - -C /tmp/facevisa-deploy"
  vm_ssh --command="sudo bash /tmp/facevisa-deploy/vm-setup.sh $DOMAIN '$(echo $REDIRECT_DOMAINS | tr ' ' ',')'"
  ;;

caddy)
  # Validated before it replaces the live Caddyfile; a bad one leaves the old one in place.
  sed -e "s/{{DOMAIN}}/$DOMAIN/g" -e "s/{{REDIRECTS}}/$(echo $REDIRECT_DOMAINS | sed 's/ /, /g')/g" Caddyfile > "$SCRATCH/Caddyfile"
  vm_ssh --command="cat > /tmp/Caddyfile.new && sudo caddy validate --adapter caddyfile --config /tmp/Caddyfile.new && sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev && sudo install -m 644 /tmp/Caddyfile.new /etc/caddy/Caddyfile && sudo systemctl reload caddy && echo 'caddy reloaded'" < "$SCRATCH/Caddyfile"
  ;;

secrets)
  # The env file: built here from fixed server settings plus the few values copied from .env.local, written to a
  # private temp file, sent, deleted. SESSION_SECRET is made on the server once, in its own file that systemd loads
  # (secrets/session.env), so sending the env file again never rotates it.
  python3 - "$ROOT/.env.local" "$SCRATCH/env" "$DOMAIN" <<'PY'
import os, sys
src, out, domain = sys.argv[1], sys.argv[2], sys.argv[3]
local = {}
for line in open(src):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        local[k] = v
copied = ["WORLDID_ISSUER", "WORLDID_CLIENT_ID", "ARKIV_ACCESS_KEY", "HEDERA_OPERATOR_ID", "WORLD_APP_ID", "WORLD_RP_ID", "VERTEX_PROJECT"]
missing = [k for k in copied if not local.get(k)]
if missing:
    sys.exit(f"missing in .env.local: {', '.join(missing)}")
base = f"https://{domain}"
fixed = {
    "PUBLIC_URL": base, "NEXT_PUBLIC_APP_URL": base, "FACEVISA_BACKEND": "http://127.0.0.1:8788", "PORT": "8788",
    "FACEVISA_PUBLIC": "1", "FACEVISA_PUBLIC_DEMO": "1",
    # New accounts per network per day: 50, since judges share the venue Wi-Fi (Rohit, 5 Nov; was 3).
    "FACEVISA_DEMO_IP_IDENTITIES": "50",
    "WORLDID_PRIVATE_KEY_FILE": "/srv/likeness/secrets/world-client.pem",
    "WORLDID_SIGNIN_REDIRECT_URI": f"{base}/api/auth/callback", "WORLDID_AGENT_PASS_REDIRECT_URI": f"{base}/api/agent-pass/callback",
    "FACEVISA_AI_IMAGE": "0g", "FACEVISA_AI_VIDEO": "vertex",
    # Site caps raised for judging (Rohit, 5 Nov): 30 images and 6 videos a day, about $2.25 at most. Back to 10/2 after.
    # Per brand workspace (Rohit, 6 Nov): 10 images and 3 videos a day, within the site caps (a video's still is an image).
    "FACEVISA_SITE_IMAGES": "30", "FACEVISA_SITE_VIDEOS": "6", "FACEVISA_BRAND_IMAGES": "10", "FACEVISA_BRAND_VIDEOS": "3",
    "ARKIV_ENABLED": "1", "ARKIV_SCHEMA_PREFIX": "facevisa-public",
    "FACEVISA_KEYSTORE_PASSWORD_FILE": "/srv/likeness/secrets/keystore-password",
    # Payments: USDT on Whitechain testnet through FaceVisaSettlement (Hedera x402 stays behind PAYMENTS=hedera).
    "PAYMENTS": "whitechain", "WHITECHAIN_SETTLEMENT": "0x8fbbca9e637c6261386e38dfef016a7dd90fc65b",
    "WHITECHAIN_RELAYER_KEY_FILE": "/srv/likeness/secrets/whitechain-relayer-key", "WHITECHAIN_OPERATOR_KEY_FILE": "/srv/likeness/secrets/whitechain-operator-key",
    # Swarm (Rohit, 6 Nov): our Bee node on this VM, the 7-day batch, and Rohit's own account as the showcase creator.
    "SWARM_BEE_URL": "http://127.0.0.1:1633", "SWARM_BATCH_ID": "78f615454a8ead07873a5d603c7b59e002a75a31b95b8bb6990907ab6496f794",
    "SWARM_SHOWCASE_CREATORS": "wid_51aa06745c2f2cd1c589803a50ab4982",
    "BRAND_STEPUP_USDC": "0.10",
    "WORLD_RP_SIGNING_KEY_FILE": "/srv/likeness/secrets/world-rp-signing-key", "HEDERA_OPERATOR_KEY_FILE": "/srv/likeness/secrets/hedera-operator-key", "ZEROG_API_KEY_FILE": "/srv/likeness/secrets/zerog-api-key", "WORLD_IDKIT_ENVIRONMENT": "sandbox", "WORLD_IDKIT_ACTION": "list-likeness-dev",
}
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("# The public demo's settings (deploy/remote.sh secrets). SECRET values: never print this file.\n")
    for k, v in fixed.items():
        f.write(f"{k}={v}\n")
    for k in copied:
        f.write(f"{k}={local[k]}\n")
    # Sign in with Google, when its OAuth client is in .env.local (it replaces the demo identities on the site).
    if local.get("GOOGLE_SIGNIN_CLIENT_ID") and local.get("GOOGLE_SIGNIN_CLIENT_SECRET"):
        f.write("GOOGLE_SIGNIN=1\n")
        for k in ["GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"]:
            f.write(f"{k}={local[k]}\n")
print(f"env file: {len(fixed) + len(copied)} settings ({len(copied)} copied from .env.local); values not shown")
PY
  mkdir -p "$SCRATCH/secrets" "$SCRATCH/keystore" "$SCRATCH/envdir"
  for f in hedera-operator-key whitechain-relayer-key whitechain-operator-key zerog-api-key world-rp-signing-key world-client.pem keystore-password; do cp "$ROOT/.secrets/$f" "$SCRATCH/secrets/$f"; done
  cp "$ROOT/keystores/local/keystore.json" "$SCRATCH/keystore/keystore.json"
  mv "$SCRATCH/env" "$SCRATCH/envdir/env"
  send "$SCRATCH/secrets" /srv/likeness/secrets 600 700
  send "$SCRATCH/keystore" /srv/likeness/keystores/testnet 600 700
  # The env file alone, into the data root (whose own mode stays as it is).
  tar --no-xattrs --no-mac-metadata -C "$SCRATCH/envdir" -czf - env | vm_ssh --command="sudo tar -xzf - -C /srv/likeness --no-same-owner && sudo chown likeness:likeness /srv/likeness/env && sudo chmod 600 /srv/likeness/env"
  send "$ROOT/.models" /srv/likeness/models 644 755
  # SESSION_SECRET: made on the server, once.
  as_app 'umask 077; [ -f /srv/likeness/secrets/session.env ] || echo "SESSION_SECRET=$(openssl rand -base64 48 | tr -d "\n")" > /srv/likeness/secrets/session.env; stat -c "%a %U %n" /srv/likeness/env /srv/likeness/secrets/* /srv/likeness/keystores/testnet/keystore.json'
  ;;

deploy)
  TS=$(date -u +%Y%m%d-%H%M%S)
  R=/opt/likeness/releases/$TS
  echo "release $TS"
  send "$ROOT" "$R" 644 755 --exclude=node_modules --exclude=.next --exclude='.env*' --exclude=.DS_Store --exclude='*.tsbuildinfo' agents web
  as_app "set -e
    cd $R
    for d in accounts renders keystores; do ln -sfn /srv/likeness/\$d \$d; done
    ln -sfn /srv/likeness/models .models
    ln -sfn /srv/likeness/secrets .secrets
    ln -sfn /srv/likeness/env .env.local
    cd agents && pnpm install --frozen-lockfile --reporter=silent
    cd ../web && pnpm install --frozen-lockfile --reporter=silent
    NEXT_PUBLIC_APP_URL=https://$DOMAIN pnpm build > /tmp/facevisa-build.log 2>&1 || (tail -40 /tmp/facevisa-build.log; exit 1)
    cp -r .next/static .next/standalone/.next/static
    cp -r public .next/standalone/public
    echo 'window.FACEVISA_VERIFIER_DEFAULTS = { namespace: \"facevisa-public\" };' > .next/standalone/public/verifier/config.js
    # Each release's verifier scripts and styles get its own URL, so a browser never runs an older copy.
    sed -i 's/\\(verify\\.js\\|config\\.js\\|style\\.css\\)\"/\\1?v=$TS\"/g' .next/standalone/public/verifier/index.html .next/standalone/public/verifier/creator.html"
  PREV=$(vm_ssh --command="readlink /opt/likeness/current || true" | tr -d '\r')
  # Never restart while an ad is being made (the restart would fail its request): wait up to 5 minutes for them.
  for i in $(seq 1 60); do
    n=$(vm_ssh --command="sudo -u likeness sqlite3 /srv/likeness/accounts/testnet/accounts.sqlite \"select count(*) from pending_actions where status = 'generating'\"" 2>/dev/null | tr -dc '0-9')
    [ "${n:-0}" = "0" ] && break
    echo "waiting: ${n} ad(s) being made"
    sleep 5
  done
  # Optional, once: a root script run on the VM after the build and before the switch (e.g. a data migration).
  # If it fails, the backend it may have stopped is started again on the current release before giving up.
  if [ -n "${PRE_SWITCH:-}" ]; then
    echo "pre-switch: $PRE_SWITCH"
    vm_ssh --command="sudo bash -s" < "$PRE_SWITCH" || { echo "pre-switch failed: restarting the current release" >&2; vm_ssh --command="sudo systemctl start likeness-backend"; exit 1; }
  fi
  vm_ssh --command="sudo ln -sfn $R /opt/likeness/current && sudo systemctl restart likeness-backend likeness-web"
  ok=""
  for i in $(seq 1 40); do
    if vm_ssh --command="curl -sf -o /dev/null http://127.0.0.1:8788/api/status && curl -sf -o /dev/null http://127.0.0.1:3000/" >/dev/null 2>&1; then ok=1; break; fi
    sleep 3
  done
  if [ -z "$ok" ]; then
    echo "the new release didn't come up: rolling back to ${PREV:-nothing}" >&2
    vm_ssh --command="sudo journalctl -u likeness-backend -u likeness-web -n 40 --no-pager"
    [ -n "$PREV" ] && vm_ssh --command="sudo ln -sfn $PREV /opt/likeness/current && sudo systemctl restart likeness-backend likeness-web"
    exit 1
  fi
  # Keep the last three releases.
  vm_ssh --command="cd /opt/likeness/releases && ls -1d */ | sort | head -n -3 | xargs -r sudo rm -rf"
  echo "live: $TS"
  ;;

health)
  vm_ssh --command="curl -s http://127.0.0.1:8788/api/health" | python3 -c '
import json, sys
h = json.load(sys.stdin)
print("READY" if h["ok"] else "NOT READY", "·", h["mode"], "·", h["at"])
for k, c in h["checks"].items(): print("  %-5s %-8s %s" % (c["level"], k, c["summary"]))
for w in h["warnings"]: print("  warning:", w)'
  ;;

logs)
  vm_ssh --command="sudo journalctl -u likeness-backend -u likeness-web -n ${2:-60} --no-pager"
  ;;

backup)
  vm_ssh --command="sudo systemctl start likeness-backup.service && ls -1t /srv/likeness/backups | head -1" | tr -d '\r' | tail -1 > "$SCRATCH/latest"
  mkdir -p "$ROOT/accounts/remote-backups"
  vm_ssh --command="sudo cat /srv/likeness/backups/$(cat "$SCRATCH/latest")" > "$ROOT/accounts/remote-backups/$(cat "$SCRATCH/latest")"
  echo "copied to accounts/remote-backups/$(cat "$SCRATCH/latest")"
  ;;

seed)
  # Rohit's capture frames (his consent: the public demo during the hackathon), sent for the seed, then deleted.
  mkdir -p "$SCRATCH/seed"
  cp "$ROOT"/accounts/local-dev-backup-20261104/photos/wid_ec41c1b924f3b918c61dd5d24cca0e4c-capture-{0,1,2}.jpg "$SCRATCH/seed/"
  send "$SCRATCH/seed" /srv/likeness/seed-capture 600 700
  as_app "cd /opt/likeness/current/agents && NODE_ENV=production FACEVISA_MODE=testnet SEED_CAPTURE_DIR=/srv/likeness/seed-capture ./node_modules/.bin/tsx --env-file=../.env.local scripts/public-seed.ts; rm -rf /srv/likeness/seed-capture"
  ;;

*)
  sed -n '2,10p' "$0"
  exit 1
  ;;
esac
