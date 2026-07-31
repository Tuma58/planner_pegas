#!/usr/bin/env bash
set -Eeuo pipefail

required=(VPS_HOST LAN_CIDR)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Не задана переменная %s\n' "$name" >&2
    exit 2
  fi
done

VPS_USER="${VPS_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
REPO_URL="${REPO_URL:-https://github.com/Tuma58/planner_pegas.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
LAN_HOST="${LAN_HOST:-$VPS_HOST}"
LAN_TLS="${LAN_TLS:-true}"

[[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] || { echo "Некорректный SSH_PORT" >&2; exit 2; }
(( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || { echo "SSH_PORT вне диапазона 1–65535" >&2; exit 2; }
[[ "$REPO_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Некорректная ветка" >&2; exit 2; }
[[ "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "Некорректный VPS_USER" >&2; exit 2; }
[[ "$REPO_URL" == https://* ]] || { echo "REPO_URL должен быть публичным HTTPS URL" >&2; exit 2; }
[[ "$LAN_CIDR" =~ ^[0-9A-Fa-f:./]+$ ]] || { echo "Некорректный LAN_CIDR" >&2; exit 2; }
[[ "$LAN_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Некорректный LAN_HOST" >&2; exit 2; }
[[ "$LAN_TLS" == "true" || "$LAN_TLS" == "false" ]] || { echo "LAN_TLS должен быть true или false" >&2; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bootstrap_source="$script_dir/bootstrap-debian.sh"
[[ -f "$bootstrap_source" ]] || {
  echo "Не найден bootstrap-скрипт: $bootstrap_source" >&2
  exit 2
}

remote="${VPS_USER}@${VPS_HOST}"
remote_dir="/tmp/pegas-public-bootstrap-$$"
ssh_args=(-p "$SSH_PORT" -o StrictHostKeyChecking=yes)
scp_args=(-P "$SSH_PORT" -o StrictHostKeyChecking=yes)

cleanup() {
  ssh "${ssh_args[@]}" "$remote" "rm -rf '$remote_dir'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ssh "${ssh_args[@]}" "$remote" "umask 077; mkdir -p '$remote_dir'"
scp "${scp_args[@]}" "$bootstrap_source" "$remote:$remote_dir/bootstrap-debian.sh"

q() { printf '%q' "$1"; }
bootstrap="$remote_dir/bootstrap-debian.sh"
environment="DEPLOY_MODE=lan REPO_ACCESS=public REPO_URL=$(q "$REPO_URL") REPO_BRANCH=$(q "$REPO_BRANCH") DEPLOY_SSH_PORT=$(q "$SSH_PORT") LAN_CIDR=$(q "$LAN_CIDR") LAN_HOST=$(q "$LAN_HOST") LAN_TLS=$(q "$LAN_TLS")"

if [[ "$VPS_USER" == "root" ]]; then
  ssh -t "${ssh_args[@]}" "$remote" "$environment bash $(q "$bootstrap")"
else
  ssh -t "${ssh_args[@]}" "$remote" "sudo -n env $environment bash $(q "$bootstrap")"
fi
