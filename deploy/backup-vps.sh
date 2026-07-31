#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ "${EUID}" -eq 0 ]] || { echo "Резервное копирование необходимо запускать через sudo" >&2; exit 1; }
source /etc/pegas-planner/deploy.env

database="$APP_DIR/data/planner.db"
backup_dir="$APP_DIR/data/backups"
[[ -f "$database" ]] || { echo "БД еще не создана: $database"; exit 0; }
install -m 0700 -d "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/planner-$timestamp.db"
sqlite3 "$database" ".timeout 10000" ".backup '$target'"
gzip -9 "$target"
find "$backup_dir" -type f -name 'planner-*.db.gz' -mtime +14 -delete
echo "Резервная копия: $target.gz"
