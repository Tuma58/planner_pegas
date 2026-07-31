#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
local_port="${LOCAL_PORT:-3000}"
local_data_dir="$project_root/data/local"
local_secret_dir="$project_root/.secrets"
local_database="${LOCAL_DATABASE_PATH:-$local_data_dir/planner.db}"
local_app_secret="$local_secret_dir/local_app_secret"
local_admin_password="$local_secret_dir/local_admin_password"

[[ "$local_port" =~ ^[0-9]{1,5}$ ]] && ((local_port >= 1024 && local_port <= 65535)) || {
  echo "LOCAL_PORT должен быть в диапазоне 1024–65535" >&2
  exit 2
}
command -v node >/dev/null 2>&1 || {
  echo "Для локального запуска требуется Node.js 22.13 или новее" >&2
  exit 2
}

node_version="$(node -p 'process.versions.node')"
IFS=. read -r node_major node_minor _ <<< "$node_version"
if ((node_major < 22 || (node_major == 22 && node_minor < 13))); then
  echo "Текущий Node.js $node_version; требуется версия 22.13 или новее" >&2
  exit 2
fi

install -m 0700 -d "$local_data_dir" "$local_secret_dir"
if [[ ! -s "$local_app_secret" ]]; then
  node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))" > "$local_app_secret"
fi
if [[ ! -s "$local_admin_password" ]]; then
  node -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))" > "$local_admin_password"
fi
chmod 0600 "$local_app_secret" "$local_admin_password"

echo "Локальный режим: http://127.0.0.1:$local_port"
echo "Логин первого запуска: admin"
echo "Начальный пароль: $(<"$local_admin_password")"
echo "После смены пароля в интерфейсе значение в файле является только первоначальным."
echo "Остановка: Ctrl+C"
echo

cd "$project_root"
export HOST="127.0.0.1"
export PORT="$local_port"
export DATABASE_PATH="$local_database"
export APP_SECRET_FILE="$local_app_secret"
export ADMIN_PASSWORD_FILE="$local_admin_password"
export ADMIN_USERNAME="admin"
export ADMIN_NAME="Администратор"
export NODE_ENV="development"
export SYNC_WORKER_EMBEDDED="true"
exec node src/server.mjs
