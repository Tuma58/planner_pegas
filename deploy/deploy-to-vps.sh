#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${LOCAL_ONLY:-false}" == "true" ]]; then
  exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local-start.sh"
fi

deploy_mode="public"
if [[ "${LAN_ONLY:-false}" == "true" ]]; then
  deploy_mode="lan"
fi

required=(VPS_HOST REPO_URL DEPLOY_KEY KNOWN_HOSTS_FILE)
if [[ "$deploy_mode" == "public" ]]; then
  required+=(DOMAIN ADMIN_EMAIL)
else
  required+=(LAN_CIDR)
fi
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Не задана переменная %s\n' "$name" >&2
    exit 2
  fi
done

VPS_USER="${VPS_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
REPO_BRANCH="${REPO_BRANCH:-main}"
LAN_HOST="${LAN_HOST:-$VPS_HOST}"
LAN_TLS="${LAN_TLS:-true}"

[[ -f "$DEPLOY_KEY" ]] || { echo "Deploy key не найден: $DEPLOY_KEY" >&2; exit 2; }
[[ -f "$KNOWN_HOSTS_FILE" ]] || { echo "known_hosts не найден: $KNOWN_HOSTS_FILE" >&2; exit 2; }
[[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] || { echo "Некорректный SSH_PORT" >&2; exit 2; }
[[ "$REPO_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Некорректная ветка" >&2; exit 2; }
[[ "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "Некорректный VPS_USER" >&2; exit 2; }
if [[ "$deploy_mode" == "lan" ]]; then
  [[ "$LAN_CIDR" =~ ^[0-9A-Fa-f:./]+$ ]] || { echo "Некорректный LAN_CIDR" >&2; exit 2; }
  [[ "$LAN_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Некорректный LAN_HOST" >&2; exit 2; }
  [[ "$LAN_TLS" == "true" || "$LAN_TLS" == "false" ]] || { echo "LAN_TLS должен быть true или false" >&2; exit 2; }
fi

remote="${VPS_USER}@${VPS_HOST}"
remote_dir="/tmp/pegas-bootstrap-$$"
ssh_args=(-p "$SSH_PORT" -o StrictHostKeyChecking=yes)
scp_args=(-P "$SSH_PORT" -o StrictHostKeyChecking=yes)

cleanup() {
  ssh "${ssh_args[@]}" "$remote" "rm -rf '$remote_dir'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ssh "${ssh_args[@]}" "$remote" "umask 077; mkdir -p '$remote_dir'"
scp "${scp_args[@]}" deploy/bootstrap-debian.sh "$remote:$remote_dir/bootstrap-debian.sh"
scp "${scp_args[@]}" "$DEPLOY_KEY" "$remote:$remote_dir/deploy_key"
scp "${scp_args[@]}" "$KNOWN_HOSTS_FILE" "$remote:$remote_dir/git_known_hosts"

q() { printf '%q' "$1"; }
bootstrap="$remote_dir/bootstrap-debian.sh"
key="$remote_dir/deploy_key"
known_hosts="$remote_dir/git_known_hosts"
environment="DEPLOY_MODE=$(q "$deploy_mode") REPO_URL=$(q "$REPO_URL") REPO_BRANCH=$(q "$REPO_BRANCH") DEPLOY_SSH_PORT=$(q "$SSH_PORT") STAGED_DEPLOY_KEY=$(q "$key") STAGED_KNOWN_HOSTS=$(q "$known_hosts")"
if [[ "$deploy_mode" == "public" ]]; then
  environment+=" APP_DOMAIN=$(q "$DOMAIN") ADMIN_EMAIL=$(q "$ADMIN_EMAIL")"
else
  environment+=" LAN_CIDR=$(q "$LAN_CIDR") LAN_HOST=$(q "$LAN_HOST") LAN_TLS=$(q "$LAN_TLS")"
fi

if [[ "$VPS_USER" == "root" ]]; then
  ssh -t "${ssh_args[@]}" "$remote" "$environment bash $(q "$bootstrap")"
else
  ssh -t "${ssh_args[@]}" "$remote" "sudo -n env $environment bash $(q "$bootstrap")"
fi
