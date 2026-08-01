#!/usr/bin/env bash
# Интерактивный мастер деплоя PegasLogistic. Запускается НА целевом VPS от root.
# Собирает параметры (с дефолтами и валидацией), показывает сводку и запускает bootstrap-debian.sh.
# Любую переменную можно задать заранее в окружении — тогда мастер её не переспрашивает.
# DRY_RUN=1 — показать сводку без запуска деплоя (безопасный предпросмотр и способ проверки).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN="${DRY_RUN:-0}"

bold=""; dim=""; reset=""
if [[ -t 1 ]]; then bold="$(printf '\033[1m')"; dim="$(printf '\033[2m')"; reset="$(printf '\033[0m')"; fi

if [[ "$DRY_RUN" != "1" ]]; then
  [[ "${EUID}" -eq 0 ]] || { echo "Мастер нужно запускать от root на целевом VPS" >&2; exit 1; }
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "debian" ]] || { echo "Поддерживается только Debian" >&2; exit 2; }
  [[ "${VERSION_ID:-}" == "12" || "${VERSION_ID:-}" == "13" ]] || {
    echo "Поддерживаются Debian 12 и 13 stable" >&2; exit 2; }
fi

# ask VAR "Вопрос" "дефолт" [regex]
# Если $VAR уже задана в окружении — берёт её (с валидацией). Иначе спрашивает (или дефолт в неинтерактиве).
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __regex="${4:-}"
  local __preset="${!__var:-}" __value
  while true; do
    if [[ -n "$__preset" ]]; then
      __value="$__preset"
    elif [[ -t 0 ]]; then
      if [[ -n "$__default" ]]; then
        read -r -p "  $__prompt [${__default}]: " __value || __value=""
      else
        read -r -p "  $__prompt: " __value || __value=""
      fi
      [[ -z "$__value" ]] && __value="$__default"
    else
      __value="$__default"
    fi
    if [[ -z "$__value" ]]; then
      echo "  ! Значение обязательно." >&2
      if [[ -n "$__preset" || ! -t 0 ]]; then exit 2; fi
      continue
    fi
    if [[ -n "$__regex" && ! "$__value" =~ $__regex ]]; then
      echo "  ! Некорректное значение: $__value" >&2
      if [[ -n "$__preset" || ! -t 0 ]]; then exit 2; fi
      continue
    fi
    break
  done
  printf -v "$__var" '%s' "$__value"
  export "${__var?}"
}

# Пароль администратора: пусто → автогенерация в bootstrap; иначе валидируем длину.
admin_password_source="будет сгенерирован при деплое"
ask_admin_password() {
  if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
    if (( ${#ADMIN_PASSWORD} < 12 )); then
      echo "  ! ADMIN_PASSWORD должен быть не короче 12 символов" >&2; exit 2
    fi
    admin_password_source="задан через окружение"
    export ADMIN_PASSWORD
    return
  fi
  if [[ ! -t 0 ]]; then return; fi
  local p1 p2
  read -r -s -p "  Пароль администратора (Enter — сгенерировать): " p1; echo
  if [[ -z "$p1" ]]; then return; fi
  read -r -s -p "  Повторите пароль: " p2; echo
  if [[ "$p1" != "$p2" ]]; then echo "  ! Пароли не совпадают, повторите." >&2; ask_admin_password; return; fi
  if (( ${#p1} < 12 )); then echo "  ! Пароль не короче 12 символов." >&2; ask_admin_password; return; fi
  ADMIN_PASSWORD="$p1"; export ADMIN_PASSWORD; admin_password_source="задан вручную"
}

confirm() {
  if [[ "${ASSUME_YES:-0}" == "1" || ! -t 0 ]]; then return 0; fi
  local a; read -r -p "$1 [y/N]: " a || a=""
  [[ "$a" =~ ^[YyДд]$ ]]
}

section() { printf '\n%s— %s —%s\n' "$bold" "$1" "$reset"; }
kv() { printf '  %-28s %s\n' "$1" "$2"; }

echo "${bold}Мастер деплоя PegasLogistic${reset}"
echo "${dim}Пустой ответ — значение по умолчанию в скобках. Ctrl+C — выход.${reset}"

section "Режим и репозиторий"
ask DEPLOY_MODE "Режим деплоя (lan/public)" "lan" '^(lan|public)$'
ask REPO_ACCESS "Доступ к репозиторию (public/private)" "public" '^(public|private)$'
ask REPO_URL "URL репозитория" "https://github.com/Tuma58/planner_pegas.git" '^[A-Za-z0-9@:/._-]+$'
ask REPO_BRANCH "Ветка" "main" '^[A-Za-z0-9._/-]+$'
if [[ "$REPO_ACCESS" == "private" ]]; then
  ask STAGED_DEPLOY_KEY "Путь к deploy key (на этом VPS)" "" '^/.+$'
  ask STAGED_KNOWN_HOSTS "Путь к known_hosts (на этом VPS)" "" '^/.+$'
fi

section "Сеть и подсети"
if [[ "$DEPLOY_MODE" == "lan" ]]; then
  ask LAN_HOST "LAN хост (IP или внутреннее DNS-имя)" "" '^[A-Za-z0-9.-]+$'
  ask LAN_CIDR "LAN подсеть (CIDR: ограничение SSH в UFW)" "" '^[0-9A-Fa-f:./]+$'
  ask LAN_TLS "Включить локальный TLS (true/false)" "true" '^(true|false)$'
else
  ask APP_DOMAIN "Публичный домен" "" '^[A-Za-z0-9.-]+$'
  ask ADMIN_EMAIL "Email для Let's Encrypt" "" '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
fi
# При первом запуске веб-доступ открыт со всех подсетей — ограничивается после первого входа.
initial_subnets="${INITIAL_ALLOWED_SUBNETS:-0.0.0.0/0,::/0}"
ask DEPLOY_SSH_PORT "SSH-порт" "22" '^[0-9]{1,5}$'

section "Учётные данные администратора"
kv "Логин" "admin"
ask_admin_password

section "Каталог и бэкапы"
ask APP_DIR "Каталог приложения" "/opt/pegas-planner" '^/[A-Za-z0-9._/-]+$'
ask BACKUP_ONCALENDAR "Расписание бэкапа (systemd OnCalendar)" "*-*-* 02:30:00" '^[0-9A-Za-z:*/,. -]+$'
ask BACKUP_RETENTION_DAYS "Хранить бэкапы, дней" "14" '^[0-9]{1,4}$'

section "Защита"
ask RATE_LIMIT_RATE "nginx лимит логина (напр. 10r/m)" "10r/m" '^[0-9]{1,5}r/[sm]$'
ask RATE_LIMIT_BURST "nginx всплеск логина (burst)" "5" '^[0-9]{1,4}$'
ask F2B_MAXRETRY "Fail2ban: попыток до бана" "5" '^[0-9]{1,3}$'
ask F2B_FINDTIME "Fail2ban: окно поиска" "10m" '^[0-9]{1,7}[smhdw]?$'
ask F2B_BANTIME "Fail2ban: время бана" "1h" '^[0-9]{1,7}[smhdw]?$'

# Что произойдёт с сертификатами и cookie
if [[ "$DEPLOY_MODE" == "public" ]]; then
  cert_desc="Let's Encrypt (certbot) для $APP_DOMAIN, автопродление через certbot.timer"
  cookie_secure="true"
  url="https://$APP_DOMAIN"
elif [[ "$LAN_TLS" == "true" ]]; then
  cert_desc="Самоподписанный TLS RSA-3072; файл /etc/pegas-planner/lan-tls.crt установить в доверенные на клиентах"
  cookie_secure="true"
  url="https://$LAN_HOST"
else
  cert_desc="БЕЗ TLS — логин и пароль передаются по HTTP (не рекомендуется)"
  cookie_secure="false"
  url="http://$LAN_HOST"
fi

echo
echo "${bold}════════ Сводка деплоя ════════${reset}"
section "Режим и репозиторий"
kv "Режим" "$DEPLOY_MODE"
kv "Репозиторий" "$REPO_URL ($REPO_ACCESS)"
kv "Ветка" "$REPO_BRANCH"
[[ "$REPO_ACCESS" == "private" ]] && { kv "Deploy key" "${STAGED_DEPLOY_KEY}"; kv "known_hosts" "${STAGED_KNOWN_HOSTS}"; }
section "Сеть и подсети"
if [[ "$DEPLOY_MODE" == "lan" ]]; then
  kv "LAN хост" "$LAN_HOST"
  kv "LAN подсеть" "$LAN_CIDR"
  kv "Локальный TLS" "$LAN_TLS"
else
  kv "Домен" "$APP_DOMAIN"
  kv "Email ACME" "$ADMIN_EMAIL"
fi
kv "SSH-порт" "$DEPLOY_SSH_PORT"
kv "Стартовый web-allowlist" "$initial_subnets"
if [[ "$initial_subnets" == "0.0.0.0/0,::/0" ]]; then
  kv "" "(открыт для всех — ограничьте после первого входа)"
fi
section "Сертификаты и TLS"
kv "Сертификат" "$cert_desc"
kv "Secure cookie" "$cookie_secure"
section "Учётные данные администратора"
kv "URL входа" "$url"
kv "Логин" "admin"
kv "Пароль" "$admin_password_source"
section "Безопасность и обслуживание"
kv "nginx rate-limit" "$RATE_LIMIT_RATE (burst $RATE_LIMIT_BURST)"
kv "Fail2ban" "maxretry=$F2B_MAXRETRY findtime=$F2B_FINDTIME bantime=$F2B_BANTIME"
kv "UFW / hardening SSH" "включаются автоматически"
kv "Каталог приложения" "$APP_DIR"
kv "Бэкап" "$BACKUP_ONCALENDAR, хранить $BACKUP_RETENTION_DAYS дн."
echo "${bold}═══════════════════════════════${reset}"

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "${dim}DRY_RUN=1 — предпросмотр. Деплой НЕ запускается.${reset}"
  exit 0
fi

echo
if ! confirm "Запустить деплой с этими параметрами?"; then
  echo "Отменено пользователем."
  exit 0
fi

exec bash "$here/bootstrap-debian.sh"
