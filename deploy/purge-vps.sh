#!/usr/bin/env bash
# Полная очистка VPS от PegasLogistic для чистого деплоя.
# Перед удалением автоматически выгружает учётные записи пользователей в
# USERS_EXPORT_FILE (по умолчанию /root/pegas-users.json) — следующий деплой
# импортирует их автоматически.
#
# Уровни очистки:
#   по умолчанию      — контейнеры, образы, каталоги проекта, nginx/systemd/hardening-конфиги;
#   PURGE_PACKAGES=true — дополнительно удаляет пакеты (Docker, nginx, fail2ban, ufw, certbot).
# FORCE=1 пропускает интерактивные подтверждения.
set -Eeuo pipefail
umask 077

[[ "${EUID}" -eq 0 ]] || { echo "Очистку необходимо запускать от root" >&2; exit 1; }

DEPLOY_CONFIG_DIR="/etc/pegas-planner"
if [[ -f "$DEPLOY_CONFIG_DIR/deploy.env" ]]; then
  # shellcheck disable=SC1091
  source "$DEPLOY_CONFIG_DIR/deploy.env"
fi
APP_DIR="${APP_DIR:-/opt/pegas-planner}"
PURGE_PACKAGES="${PURGE_PACKAGES:-false}"
USERS_EXPORT_FILE="${USERS_EXPORT_FILE:-/root/pegas-users.json}"
[[ "$PURGE_PACKAGES" == "true" || "$PURGE_PACKAGES" == "false" ]] || {
  echo "PURGE_PACKAGES должен быть true или false" >&2; exit 2; }

confirm() {
  if [[ "${FORCE:-0}" == "1" || ! -t 0 ]]; then return 0; fi
  local a; read -r -p "$1 [y/N]: " a || a=""
  [[ "$a" =~ ^[YyДд]$ ]]
}

echo "Очистка PegasLogistic на этом VPS:"
echo "  Каталог приложения: $APP_DIR"
echo "  Экспорт пользователей: $USERS_EXPORT_FILE"
echo "  Удаление пакетов: $PURGE_PACKAGES"
confirm "Продолжить очистку?" || { echo "Отменено."; exit 0; }

# ── Экспорт учётных записей до любого удаления ────────────────────────────────
exported=0
if [[ -d "$APP_DIR" ]] && command -v docker >/dev/null 2>&1; then
  if docker compose -f "$APP_DIR/compose.yaml" ps -q planner 2>/dev/null | grep -q .; then
    if docker compose -f "$APP_DIR/compose.yaml" exec -T planner \
        node scripts/export-users.mjs > "$USERS_EXPORT_FILE.tmp" 2>/dev/null; then
      mv "$USERS_EXPORT_FILE.tmp" "$USERS_EXPORT_FILE"
      exported=1
    fi
  fi
fi
if [[ "$exported" -eq 0 && -f "$APP_DIR/data/planner.db" ]] && command -v sqlite3 >/dev/null 2>&1; then
  # Контейнер не запущен — читаем БД напрямую с хоста.
  if sqlite3 "$APP_DIR/data/planner.db" -json \
      'SELECT id,username,full_name,email,password_hash,role,active FROM users ORDER BY created_at;' \
      > "$USERS_EXPORT_FILE.tmp" 2>/dev/null; then
    mv "$USERS_EXPORT_FILE.tmp" "$USERS_EXPORT_FILE"
    exported=1
  fi
fi
rm -f "$USERS_EXPORT_FILE.tmp"
if [[ "$exported" -eq 1 ]]; then
  chmod 0600 "$USERS_EXPORT_FILE"
  echo "Пользователи выгружены в $USERS_EXPORT_FILE (будут импортированы при следующем деплое)."
else
  echo "ВНИМАНИЕ: пользователей выгрузить не удалось (нет БД или контейнера)." >&2
  if [[ -f "$APP_DIR/data/planner.db" ]]; then
    confirm "БД существует, но экспорт не удался. Продолжить БЕЗ переноса пользователей?" || {
      echo "Отменено."; exit 1; }
  fi
fi

# ── Уровень 1: следы проекта ─────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && [[ -f "$APP_DIR/compose.yaml" ]]; then
  docker compose -f "$APP_DIR/compose.yaml" down -v --remove-orphans --rmi local || true
fi

systemctl disable --now pegas-planner-backup.timer 2>/dev/null || true
rm -f /etc/systemd/system/pegas-planner-backup.timer /etc/systemd/system/pegas-planner-backup.service
rm -rf /etc/systemd/system/pegas-planner-backup.timer.d
systemctl daemon-reload

rm -f /usr/local/sbin/pegas-planner-update /usr/local/sbin/pegas-planner-backup

rm -f /etc/nginx/sites-enabled/pegas-planner.conf /etc/nginx/sites-available/pegas-planner.conf
rm -f /etc/nginx/snippets/pegas-planner-proxy.conf /etc/nginx/conf.d/pegas-rate-limit.conf
if command -v nginx >/dev/null 2>&1; then
  if [[ -f /etc/nginx/sites-available/default && ! -e /etc/nginx/sites-enabled/default ]]; then
    ln -sfn /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
  fi
  nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
fi

if [[ -f /etc/fail2ban/jail.d/pegas-sshd.local ]]; then
  rm -f /etc/fail2ban/jail.d/pegas-sshd.local
  systemctl restart fail2ban 2>/dev/null || true
fi
if [[ -f /etc/ssh/sshd_config.d/90-pegas-hardening.conf ]]; then
  rm -f /etc/ssh/sshd_config.d/90-pegas-hardening.conf
  sshd -t 2>/dev/null && systemctl reload ssh 2>/dev/null || true
fi

rm -rf "$APP_DIR" "$DEPLOY_CONFIG_DIR"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "ВНИМАНИЕ: UFW остаётся активным и НЕ сбрасывается автоматически (риск потерять SSH)." >&2
  echo "Для полного сброса выполните вручную: ufw --force reset && ufw disable" >&2
fi

# ── Уровень 2: пакеты ────────────────────────────────────────────────────────
if [[ "$PURGE_PACKAGES" == "true" ]]; then
  confirm "Удалить пакеты Docker, nginx, fail2ban, ufw, certbot?" || {
    echo "Пакеты оставлены. Очистка следов проекта завершена."; exit 0; }
  export DEBIAN_FRONTEND=noninteractive
  apt-get purge -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin \
    nginx nginx-common fail2ban ufw \
    certbot python3-certbot-nginx 2>/dev/null || true
  apt-get autoremove --purge -y || true
  rm -rf /var/lib/docker /etc/docker /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc
  echo "Пакеты удалены."
fi

echo
echo "Очистка завершена."
if [[ "$exported" -eq 1 ]]; then
  echo "Файл пользователей: $USERS_EXPORT_FILE — следующий деплой импортирует его автоматически."
fi
echo "Чистый деплой: bash deploy/install.sh (или curl-однострочник из README)."
