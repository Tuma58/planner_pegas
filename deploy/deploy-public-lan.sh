#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

if [[ "${EUID}" -ne 0 ]]; then
  echo "Скрипт необходимо запускать на VPS от root" >&2
  exit 1
fi

required=(LAN_HOST LAN_CIDR)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Не задана переменная %s\n' "$name" >&2
    exit 2
  fi
done

REPO_URL="${REPO_URL:-https://github.com/Tuma58/planner_pegas.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
SSH_PORT="${SSH_PORT:-22}"
LAN_TLS="${LAN_TLS:-true}"

[[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] || { echo "Некорректный SSH_PORT" >&2; exit 2; }
(( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || { echo "SSH_PORT вне диапазона 1–65535" >&2; exit 2; }
[[ "$REPO_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Некорректная ветка" >&2; exit 2; }
[[ "$REPO_URL" == https://* ]] || { echo "REPO_URL должен быть публичным HTTPS URL" >&2; exit 2; }
[[ "$LAN_CIDR" =~ ^[0-9A-Fa-f:./]+$ ]] || { echo "Некорректный LAN_CIDR" >&2; exit 2; }
[[ "$LAN_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Некорректный LAN_HOST" >&2; exit 2; }
[[ "$LAN_TLS" == "true" || "$LAN_TLS" == "false" ]] || { echo "LAN_TLS должен быть true или false" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || {
  echo "Не найден curl. Выполните: apt-get update && apt-get install -y ca-certificates curl" >&2
  exit 2
}

temporary_dir="$(mktemp -d /tmp/pegas-public-bootstrap.XXXXXX)"
cleanup() {
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT

bootstrap_url="https://raw.githubusercontent.com/Tuma58/planner_pegas/$REPO_BRANCH/deploy/bootstrap-debian.sh"
curl --proto '=https' --tlsv1.2 -fsSL "$bootstrap_url" -o "$temporary_dir/bootstrap-debian.sh"
chmod 0700 "$temporary_dir/bootstrap-debian.sh"

env \
  DEPLOY_MODE=lan \
  REPO_ACCESS=public \
  REPO_URL="$REPO_URL" \
  REPO_BRANCH="$REPO_BRANCH" \
  DEPLOY_SSH_PORT="$SSH_PORT" \
  LAN_CIDR="$LAN_CIDR" \
  LAN_HOST="$LAN_HOST" \
  LAN_TLS="$LAN_TLS" \
  bash "$temporary_dir/bootstrap-debian.sh"
