#!/usr/bin/env bash
# MahanAsterisk Monitoring — install / update / backup helper (Docker).
#
#   sudo ./mahan-panel.sh install [--dir /opt/mahanasterisk] [--port 3400] [--tz Asia/Tehran] [--repo URL] [--key ~/.ssh/key] [--branch main] [-y]
#   sudo ./mahan-panel.sh update  [--dir …]          pull, back up the DB, rebuild, health-check, roll back on failure
#   sudo ./mahan-panel.sh backup  [--dir …]          database dump into <dir>/backups (keeps the newest 14)
#   sudo ./mahan-panel.sh restore <file.dump> [--dir …]
#   sudo ./mahan-panel.sh status | logs | restart | admin-password [--dir …]
#
# Root is only needed to install Docker; a user in the "docker" group can run everything else.
# --tz should match the PBX's time zone (it decides "today" in reports and the dashboard).
#
# Settings for later runs (repo key, branch) are kept in <dir>/.mahan-panel.conf.
set -euo pipefail

DIR="/opt/mahanasterisk"
PORT="3400"
REPO="git@github.com:ashayesteh86/Asterisk-Monitoring.git"
KEY=""
BRANCH="main"
TZ_NAME=""
YES=0
COMPOSE_FILE="compose.production.yml"
IMAGE="asterisk-panel:production"
DB_CONTAINER="asterisk-panel-db"
HEALTH_URL="${MAHAN_HEALTH_URL:-}"   # override for testing

c_red=$'\e[31m'; c_grn=$'\e[32m'; c_yel=$'\e[33m'; c_bld=$'\e[1m'; c_off=$'\e[0m'
info() { echo "${c_bld}==>${c_off} $*"; }
ok()   { echo "${c_grn}✔${c_off} $*"; }
warn() { echo "${c_yel}!${c_off} $*" >&2; }
die()  { echo "${c_red}✘ $*${c_off}" >&2; exit 1; }

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

CMD="${1:-}"; [ -n "$CMD" ] || usage 1; shift || true
ARG=""
DIR_SET=0
parse() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) DIR="$2"; DIR_SET=1; shift 2 ;;
      --port) PORT="$2"; shift 2 ;;
      --repo) REPO="$2"; shift 2 ;;
      --key) KEY="$2"; shift 2 ;;
      --branch) BRANCH="$2"; shift 2 ;;
      --tz) TZ_NAME="$2"; shift 2 ;;
      -y|--yes) YES=1; shift ;;
      -h|--help) usage 0 ;;
      -*) die "unknown option: $1" ;;
      *) ARG="$1"; shift ;;
    esac
  done
}
parse "$@"
# Run from a cloned copy without --dir: that copy is the installation.
HERE="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$DIR_SET" -eq 0 ] && [ -f "$HERE/$COMPOSE_FILE" ]; then DIR="$HERE"; fi

if [ "$(id -u)" -ne 0 ] && ! docker info >/dev/null 2>&1; then
  die "run as root (sudo $0 $CMD …) or as a user in the docker group"
fi
CONF="$DIR/.mahan-panel.conf"
# saved settings first, then this command line wins again
# shellcheck disable=SC1090
if [ -f "$CONF" ]; then . "$CONF"; parse "$@"; fi
if [ -z "$HEALTH_URL" ]; then HEALTH_URL="http://127.0.0.1:${PORT}/healthz"; fi

confirm() {
  [ "$YES" -eq 1 ] && return 0
  read -r -p "$1 [y/N] " a
  [[ "$a" =~ ^[Yy]$ ]]
}

git_cmd() {
  if [ -n "$KEY" ]; then GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git "$@"
  else git "$@"; fi
}

compose() { (cd "$DIR" && docker compose -f "$COMPOSE_FILE" "$@"); }

need_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then return; fi
  [ "$(id -u)" -eq 0 ] || die "Docker with the compose plugin is not installed — run this once as root to install it"
  warn "Docker with the compose plugin is not installed."
  confirm "Install Docker now from get.docker.com?" || die "install Docker first: https://docs.docker.com/engine/install/"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "docker compose plugin is still missing"
  ok "Docker installed"
}

rand() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

wait_healthy() {
  info "waiting for the panel to answer on $HEALTH_URL …"
  for _ in $(seq 1 60); do
    if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then ok "panel is up"; return 0; fi
    sleep 2
  done
  return 1
}

save_conf() {
  cat > "$CONF" <<EOF
# written by mahan-panel.sh
PORT="$PORT"
REPO="$REPO"
KEY="$KEY"
BRANCH="$BRANCH"
EOF
  chmod 600 "$CONF"
}

do_backup() {
  mkdir -p "$DIR/backups"; chmod 700 "$DIR/backups"
  docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER" || die "database container $DB_CONTAINER is not running"
  local f
  f="$DIR/backups/asterisk-panel-$(date +%Y%m%d-%H%M%S).dump"
  docker exec "$DB_CONTAINER" pg_dump -U asterisk_panel -Fc asterisk_panel > "$f"
  [ -s "$f" ] || { rm -f "$f"; die "backup failed (empty dump)"; }
  ls -1t "$DIR"/backups/asterisk-panel-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
  ok "database backup: $f ($(du -h "$f" | cut -f1))"
  LAST_BACKUP="$f"
}

cmd_install() {
  command -v git >/dev/null || die "git is required (apt install git / dnf install git)"
  command -v curl >/dev/null || die "curl is required"
  need_docker

  if [ -f "$DIR/$COMPOSE_FILE" ]; then
    info "using the code in $DIR"
  else
    info "cloning $REPO ($BRANCH) into $DIR"
    if [ -n "$KEY" ] && [ ! -f "$KEY" ]; then die "SSH key not found: $KEY"; fi
    git_cmd clone --branch "$BRANCH" "$REPO" "$DIR" || die "clone failed — add this server's deploy key on GitHub, or pass --key"
  fi

  local first=0 pass=""
  if [ ! -f "$DIR/panel.env" ]; then
    first=1
    pass="$(rand 6)"
    cat > "$DIR/panel.env" <<EOF
APP_SECRET=$(rand 32)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$pass
TZ=${TZ_NAME:-$(timedatectl show -p Timezone --value 2>/dev/null || echo Asia/Tehran)}
EOF
    ok "created panel.env (keep APP_SECRET safe: stored PBX passwords are encrypted with it)"
  fi
  if [ ! -f "$DIR/.env" ]; then
    cat > "$DIR/.env" <<EOF
POSTGRES_PASSWORD=$(rand 16)
PANEL_PORT=$PORT
EOF
  else
    PORT="$(grep -E '^PANEL_PORT=' "$DIR/.env" | cut -d= -f2 || echo "$PORT")"
    HEALTH_URL="${MAHAN_HEALTH_URL:-http://127.0.0.1:${PORT}/healthz}"
  fi
  chmod 600 "$DIR/panel.env" "$DIR/.env"
  save_conf

  info "building and starting containers (first build takes a few minutes) …"
  compose up -d --build
  wait_healthy || { compose logs --tail 60 app; die "the panel did not become healthy — see the log above"; }

  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  ok "${c_bld}MahanAsterisk Monitoring is running${c_off}"
  echo "   URL:      http://${ip:-SERVER-IP}:${PORT}"
  if [ "$first" -eq 1 ]; then
    echo "   login:    admin / $pass   (change it after the first login)"
  fi
  echo "   update:   $DIR/scripts/mahan-panel.sh update --dir $DIR"
  echo "   backup:   $DIR/scripts/mahan-panel.sh backup --dir $DIR"
  echo
  echo "Next: Settings › Asterisk servers › New server, then allow this server's IP in the PBX's AMI 'permit' line."
}

cmd_update() {
  [ -f "$DIR/$COMPOSE_FILE" ] || die "no installation found in $DIR (use --dir)"
  need_docker
  local prev
  if [ -d "$DIR/.git" ]; then
    [ -z "$(git -C "$DIR" status --porcelain --untracked-files=no)" ] || die "local changes in $DIR — commit or discard them first"
    prev="$(git -C "$DIR" rev-parse HEAD)"
    info "fetching $BRANCH …"
    (cd "$DIR" && git_cmd pull --ff-only origin "$BRANCH") || die "git pull failed (check the deploy key / network)"
    if [ "$(git -C "$DIR" rev-parse HEAD)" = "$prev" ] && [ "$YES" -ne 1 ]; then
      ok "already up to date ($(git -C "$DIR" log -1 --format='%h %s'))"
      confirm "Rebuild anyway?" || exit 0
    fi
  else
    warn "$DIR is not a git checkout — rebuilding the code that is there"
  fi

  do_backup
  docker image inspect "$IMAGE" >/dev/null 2>&1 && docker tag "$IMAGE" asterisk-panel:rollback && ok "current image kept as asterisk-panel:rollback"

  info "rebuilding …"
  if compose build app && compose up -d --no-build && wait_healthy; then
    ok "updated to $( [ -d "$DIR/.git" ] && git -C "$DIR" log -1 --format='%h %s' || echo 'local code')"
    return
  fi

  warn "update failed — rolling back to the previous image"
  compose logs --tail 40 app || true
  if docker image inspect asterisk-panel:rollback >/dev/null 2>&1; then
    docker tag asterisk-panel:rollback "$IMAGE"
    [ -n "${prev:-}" ] && git -C "$DIR" reset -q --hard "$prev"
    compose up -d --no-build && wait_healthy && warn "rolled back; the database backup from before the update is $LAST_BACKUP"
  fi
  die "update failed"
}

cmd_restore() {
  local f="$ARG"
  [ -f "$f" ] || die "usage: $0 restore <file.dump> [--dir …]"
  confirm "This replaces ALL panel data with $f. Continue?" || exit 1
  do_backup
  compose stop app
  docker exec -i "$DB_CONTAINER" pg_restore -U asterisk_panel -d asterisk_panel --clean --if-exists --no-owner < "$f"
  compose start app
  wait_healthy && ok "restored from $f"
}

cmd_admin_password() {
  local pass
  pass="$(rand 6)"
  compose exec -T app node --input-type=module -e '
    const { pool } = await import("/app/server/db.js");
    const { hashPassword } = await import("/app/server/auth.js");
    const r = await pool.query("UPDATE users SET password_hash = $1, active = true WHERE username = $2", [hashPassword(process.argv[1]), process.argv[2]]);
    console.log(r.rowCount ? "ok" : "no such user"); await pool.end();' "$pass" "${ARG:-admin}"
  ok "new password for ${ARG:-admin}: $pass"
}

case "$CMD" in
  install) cmd_install ;;
  update) cmd_update ;;
  backup) [ -f "$DIR/$COMPOSE_FILE" ] || die "no installation in $DIR"; do_backup ;;
  restore) cmd_restore ;;
  status) compose ps; curl -fsS -m 3 "$HEALTH_URL" && echo || warn "health check failed: $HEALTH_URL" ;;
  logs) compose logs -f --tail 200 app ;;
  restart) compose restart app && wait_healthy ;;
  admin-password) cmd_admin_password ;;
  *) usage 1 ;;
esac
