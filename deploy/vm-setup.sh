#!/usr/bin/env bash
# Runs once on the VM, as root (remote.sh setup copies it there): Node 22 and pnpm, Caddy, sqlite3; a `likeness`
# system user; the data disk at /srv/likeness (formatted only if it's blank); journald capped at 500 MB / 14 days; the
# systemd units for the backend, the web and the nightly SQLite backup; Caddy for the domain. Safe to run again.
set -euo pipefail
DOMAIN="${1:?usage: vm-setup.sh <domain> [redirect names, comma-separated]}"
REDIRECTS="${2:-www.$DOMAIN}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q ca-certificates curl gnupg rsync sqlite3 debian-keyring debian-archive-keyring apt-transport-https

# Node 22 (NodeSource) and pnpm through corepack (the version in package.json's packageManager).
if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
corepack enable

# Caddy (its own apt repository): HTTPS from Let's Encrypt for the domain.
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

# The app's own user: owns the data, runs the services; no login shell.
id likeness >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/likeness --shell /usr/sbin/nologin likeness

# The data disk (survives a rebuilt VM): formatted only when blank.
DEV=/dev/disk/by-id/google-likeness-data
if ! blkid "$DEV" >/dev/null 2>&1; then mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$DEV"; fi
mkdir -p /srv/likeness
grep -q "$DEV" /etc/fstab || echo "$DEV /srv/likeness ext4 discard,defaults,nofail 0 2" >> /etc/fstab
mountpoint -q /srv/likeness || mount /srv/likeness
mkdir -p /srv/likeness/{accounts,renders,models,secrets,keystores/testnet,backups,logs} /opt/likeness/releases
chown -R likeness:likeness /srv/likeness /opt/likeness
chmod 700 /srv/likeness/secrets /srv/likeness/keystores /srv/likeness/backups

# Logs: journald, capped.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\nMaxRetentionSec=14day\n' > /etc/systemd/journald.conf.d/likeness.conf
systemctl restart systemd-journald

install -m 644 /tmp/facevisa-deploy/likeness-backend.service /tmp/facevisa-deploy/likeness-web.service /tmp/facevisa-deploy/likeness-backup.service /tmp/facevisa-deploy/likeness-backup.timer /etc/systemd/system/
sed -e "s/{{DOMAIN}}/$DOMAIN/g" -e "s/{{REDIRECTS}}/$REDIRECTS/g" /tmp/facevisa-deploy/Caddyfile > /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
systemctl daemon-reload
systemctl enable likeness-backend.service likeness-web.service likeness-backup.timer caddy.service
systemctl start likeness-backup.timer
systemctl reload caddy || systemctl restart caddy
echo "setup done: node $(node -v), caddy $(caddy version | cut -d' ' -f1), data on $(findmnt -no SOURCE /srv/likeness)"
