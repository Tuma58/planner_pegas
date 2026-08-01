#!/usr/bin/env bash
# Идемпотентный установщик PegasLogistic для чистого VPS / Proxmox LXC.
# Клонирует репозиторий (или обновляет существующий каталог) и запускает интерактивный мастер.
# Повторный запуск безопасен: существующий каталог не вызывает ошибку, а обновляется fast-forward.
#
# Запуск на целевом VPS от root:
#   curl --proto '=https' --tlsv1.2 -fsSL \
#     https://raw.githubusercontent.com/Tuma58/planner_pegas/main/deploy/install.sh | bash
# либо (сохраняет stdin как терминал сам по себе):
#   bash <(curl --proto '=https' --tlsv1.2 -fsSL \
#     https://raw.githubusercontent.com/Tuma58/planner_pegas/main/deploy/install.sh)
set -Eeuo pipefail
umask 027

REPO_URL="${REPO_URL:-https://github.com/Tuma58/planner_pegas.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/pegas-planner}"

[[ "${EUID}" -eq 0 ]] || { echo "Установщик нужно запускать от root на целевом VPS" >&2; exit 1; }
[[ "$REPO_URL" == https://* ]] || { echo "REPO_URL должен быть публичным HTTPS URL" >&2; exit 2; }
[[ "$REPO_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Некорректная ветка REPO_BRANCH" >&2; exit 2; }
[[ "$APP_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "Некорректный APP_DIR" >&2; exit 2; }

export DEBIAN_FRONTEND=noninteractive
if ! command -v git >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates git
fi

if [[ -e "$APP_DIR/.git" ]]; then
  current_remote="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
  [[ "$current_remote" == "$REPO_URL" ]] || {
    echo "$APP_DIR уже связан с другим репозиторием: ${current_remote:-неизвестно}" >&2
    echo "Задайте другой APP_DIR или удалите каталог вручную (в нём могут быть данные и секреты)." >&2
    exit 2
  }
  echo "Каталог $APP_DIR уже существует — обновляю до origin/$REPO_BRANCH"
  git -C "$APP_DIR" fetch --prune origin "$REPO_BRANCH"
  git -C "$APP_DIR" checkout "$REPO_BRANCH"
  git -C "$APP_DIR" merge --ff-only "origin/$REPO_BRANCH" || {
    echo "Не удалось обновить $APP_DIR fast-forward: есть локальные изменения или расхождение веток." >&2
    echo "Разрешите вручную (git -C $APP_DIR status) и повторите." >&2
    exit 2
  }
elif [[ -e "$APP_DIR" ]]; then
  echo "$APP_DIR существует, но не является Git-репозиторием. Удалите его или задайте другой APP_DIR." >&2
  exit 2
else
  install -m 0755 -d "$(dirname "$APP_DIR")"
  git clone --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
fi

# Запускаем мастер, сохраняя реальный терминал на stdin даже при запуске через `curl ... | bash`.
if [[ -e /dev/tty ]]; then
  exec bash "$APP_DIR/deploy/interactive-deploy.sh" </dev/tty
else
  exec bash "$APP_DIR/deploy/interactive-deploy.sh"
fi
