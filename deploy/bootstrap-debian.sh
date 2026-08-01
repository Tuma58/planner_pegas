#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

if [[ "${EUID}" -ne 0 ]]; then
  echo "Bootstrap необходимо запускать от root" >&2
  exit 1
fi

DEPLOY_MODE="${DEPLOY_MODE:-public}"
REPO_ACCESS="${REPO_ACCESS:-private}"
LAN_TLS="${LAN_TLS:-true}"
[[ "$DEPLOY_MODE" == "public" || "$DEPLOY_MODE" == "lan" ]] || {
  echo "DEPLOY_MODE должен быть public или lan" >&2
  exit 2
}
[[ "$REPO_ACCESS" == "public" || "$REPO_ACCESS" == "private" ]] || {
  echo "REPO_ACCESS должен быть public или private" >&2
  exit 2
}

required=(REPO_URL)
if [[ "$REPO_ACCESS" == "private" ]]; then
  required+=(STAGED_DEPLOY_KEY STAGED_KNOWN_HOSTS)
fi
if [[ "$DEPLOY_MODE" == "public" ]]; then
  required+=(APP_DOMAIN ADMIN_EMAIL)
else
  required+=(LAN_CIDR LAN_HOST)
fi
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "Не задана переменная $name" >&2; exit 2; }
done

REPO_BRANCH="${REPO_BRANCH:-main}"
DEPLOY_SSH_PORT="${DEPLOY_SSH_PORT:-22}"
APP_DIR="${APP_DIR:-/opt/pegas-planner}"
DEPLOY_CONFIG_DIR="/etc/pegas-planner"
DEPLOY_KEY="$DEPLOY_CONFIG_DIR/deploy_key"
GIT_KNOWN_HOSTS="$DEPLOY_CONFIG_DIR/known_hosts"

# Опциональные параметры (дефолты повторяют прежнее поведение).
BACKUP_ONCALENDAR="${BACKUP_ONCALENDAR:-*-*-* 02:30:00}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
RATE_LIMIT_RATE="${RATE_LIMIT_RATE:-10r/m}"
RATE_LIMIT_BURST="${RATE_LIMIT_BURST:-5}"
F2B_MAXRETRY="${F2B_MAXRETRY:-5}"
F2B_BANTIME="${F2B_BANTIME:-1h}"
F2B_FINDTIME="${F2B_FINDTIME:-10m}"

source /etc/os-release
[[ "${ID:-}" == "debian" ]] || { echo "Поддерживается только Debian" >&2; exit 2; }
[[ "${VERSION_ID:-}" == "12" || "${VERSION_ID:-}" == "13" ]] || {
  echo "Поддерживаются Debian 12 и 13 stable" >&2
  exit 2
}
if [[ "$DEPLOY_MODE" == "public" ]]; then
  [[ "$APP_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Некорректный домен" >&2; exit 2; }
  [[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { echo "Некорректный email" >&2; exit 2; }
else
  [[ "$LAN_CIDR" =~ ^[0-9A-Fa-f:./]+$ ]] || { echo "Некорректный LAN_CIDR" >&2; exit 2; }
  [[ "$LAN_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Некорректный LAN_HOST" >&2; exit 2; }
  [[ "$LAN_TLS" == "true" || "$LAN_TLS" == "false" ]] || { echo "LAN_TLS должен быть true или false" >&2; exit 2; }
fi
[[ "$REPO_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Некорректная ветка" >&2; exit 2; }
[[ "$DEPLOY_SSH_PORT" =~ ^[0-9]{1,5}$ ]] || { echo "Некорректный SSH-порт" >&2; exit 2; }
oncalendar_re='^[0-9A-Za-z:*/,. -]+$'
[[ "$BACKUP_ONCALENDAR" =~ $oncalendar_re ]] || { echo "Некорректный BACKUP_ONCALENDAR" >&2; exit 2; }
{ [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]{1,4}$ ]] && (( BACKUP_RETENTION_DAYS >= 1 )); } || { echo "BACKUP_RETENTION_DAYS должен быть числом ≥ 1" >&2; exit 2; }
[[ "$RATE_LIMIT_RATE" =~ ^[0-9]{1,5}r/[sm]$ ]] || { echo "RATE_LIMIT_RATE должен быть в формате Nr/s или Nr/m" >&2; exit 2; }
[[ "$RATE_LIMIT_BURST" =~ ^[0-9]{1,4}$ ]] || { echo "RATE_LIMIT_BURST должен быть числом" >&2; exit 2; }
[[ "$F2B_MAXRETRY" =~ ^[0-9]{1,3}$ ]] || { echo "F2B_MAXRETRY должен быть числом" >&2; exit 2; }
[[ "$F2B_BANTIME" =~ ^[0-9]{1,7}[smhdw]?$ ]] || { echo "Некорректный F2B_BANTIME" >&2; exit 2; }
[[ "$F2B_FINDTIME" =~ ^[0-9]{1,7}[smhdw]?$ ]] || { echo "Некорректный F2B_FINDTIME" >&2; exit 2; }
if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
  (( ${#ADMIN_PASSWORD} >= 12 )) || { echo "ADMIN_PASSWORD должен быть не короче 12 символов" >&2; exit 2; }
fi
if [[ "$REPO_ACCESS" == "private" ]]; then
  [[ "$REPO_URL" == git@*:* || "$REPO_URL" == ssh://* ]] || {
    echo "Для private-режима REPO_URL должен быть SSH URL" >&2
    exit 2
  }
  [[ -s "$STAGED_DEPLOY_KEY" && -s "$STAGED_KNOWN_HOSTS" ]] || {
    echo "Deploy key или known_hosts не переданы" >&2
    exit 2
  }
else
  [[ "$REPO_URL" == https://* ]] || {
    echo "Для public-режима REPO_URL должен быть HTTPS URL" >&2
    exit 2
  }
fi
existing_deployment=0
if [[ -e "$APP_DIR/.git" ]]; then
  existing_deployment=1
  current_remote="$(git -C "$APP_DIR" remote get-url origin)"
  [[ "$current_remote" == "$REPO_URL" ]] || {
    echo "$APP_DIR уже связан с другим репозиторием" >&2
    exit 2
  }
elif [[ -e "$APP_DIR" ]]; then
  echo "$APP_DIR существует, но не является Git-репозиторием" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git openssl sqlite3 \
  openssh-server openssh-client util-linux \
  nginx \
  ufw fail2ban unattended-upgrades apt-listchanges
if [[ "$DEPLOY_MODE" == "public" ]]; then
  apt-get install -y --no-install-recommends certbot python3-certbot-nginx
fi

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
architecture="$(dpkg --print-architecture)"
rm -f /etc/apt/sources.list.d/docker.list
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $VERSION_CODENAME
Components: stable
Architectures: $architecture
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get remove -y docker.io docker-compose docker-doc podman-docker containerd runc || true
apt-get install -y --no-install-recommends \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

install -m 0755 -d /etc/docker
if [[ ! -e /etc/docker/daemon.json ]]; then
  install -m 0644 /dev/null /etc/docker/daemon.json
  printf '%s\n' \
    '{"live-restore":true,"no-new-privileges":true,"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"}}' \
    > /etc/docker/daemon.json
fi
systemctl enable --now docker

runtime_log="$(mktemp /tmp/pegas-docker-runtime.XXXXXX)"
runtime_container="pegas-runtime-check-$$"
if ! docker run --name "$runtime_container" --rm hello-world >"$runtime_log" 2>&1; then
  docker rm -f "$runtime_container" >/dev/null 2>&1 || true
  cat "$runtime_log" >&2
  virtualization="$(systemd-detect-virt 2>/dev/null || true)"
  if grep -Fq 'net.ipv4.ip_unprivileged_port_start' "$runtime_log" &&
      grep -Fq 'permission denied' "$runtime_log"; then
    cat >&2 <<EOF

ОШИБКА СОВМЕСТИМОСТИ DOCKER: обнаружено окружение ${virtualization:-unknown}.
Docker установлен, но внешний AppArmor-профиль запрещает запуск контейнеров.
Это исправляется на хосте виртуализации, а не внутри гостевой Debian.

Для Proxmox LXC выполните НА ХОСТЕ Proxmox:
  1. Обновите пакет lxc-pve до версии 6.0.5-2 или новее.
  2. Включите для CT функции nesting=1,keyctl=1.
  3. Полностью остановите и снова запустите CT.

Пример (замените 110 на фактический CTID):
  apt-get update && apt-get install --only-upgrade -y lxc-pve
  pct set 110 -features nesting=1,keyctl=1
  pct shutdown 110
  pct start 110

Если apt сообщает 401 для enterprise.proxmox.com, сначала отключите
Enterprise/Ceph Enterprise без подписки и старые репозитории другого Debian release.
Не отключайте AppArmor и не откатывайте runc: это снижает безопасность хоста.
После исправления запустите ту же команду деплоя повторно.
EOF
  else
    cat >&2 <<EOF

Docker runtime не прошёл обязательную проверку. Деплой остановлен до клонирования
и запуска приложения. Исправьте ошибку Docker выше и повторите ту же команду.
Тип виртуализации: ${virtualization:-unknown}
EOF
  fi
  rm -f -- "$runtime_log"
  exit 1
fi
rm -f -- "$runtime_log"

install -m 0700 -d "$DEPLOY_CONFIG_DIR"
git_ssh=""
if [[ "$REPO_ACCESS" == "private" ]]; then
  install -m 0600 "$STAGED_DEPLOY_KEY" "$DEPLOY_KEY"
  install -m 0600 "$STAGED_KNOWN_HOSTS" "$GIT_KNOWN_HOSTS"
  rm -f "$STAGED_DEPLOY_KEY" "$STAGED_KNOWN_HOSTS"

  git_host=""
  if [[ "$REPO_URL" =~ ^git@([^:]+): ]]; then
    git_host="${BASH_REMATCH[1]}"
  elif [[ "$REPO_URL" =~ ^ssh://([^@/]+@)?([^/:]+) ]]; then
    git_host="${BASH_REMATCH[2]}"
  fi
  [[ -n "$git_host" ]] || { echo "Не удалось определить Git-хост" >&2; exit 2; }
  ssh-keygen -F "$git_host" -f "$GIT_KNOWN_HOSTS" >/dev/null || {
    echo "В known_hosts нет проверенного ключа для $git_host" >&2
    exit 2
  }

  git_ssh="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$GIT_KNOWN_HOSTS -o StrictHostKeyChecking=yes"
fi
install -m 0755 -d "$(dirname "$APP_DIR")"
if [[ "$existing_deployment" -eq 0 ]]; then
  if [[ "$REPO_ACCESS" == "private" ]]; then
    GIT_SSH_COMMAND="$git_ssh" git clone --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
  else
    git clone --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
  fi
fi

install -m 0750 -d "$APP_DIR/data" "$APP_DIR/data/backups" "$APP_DIR/.secrets"
if [[ ! -s "$APP_DIR/.secrets/app_secret" ]]; then
  openssl rand -hex 48 > "$APP_DIR/.secrets/app_secret"
fi
if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
  printf '%s' "$ADMIN_PASSWORD" > "$APP_DIR/.secrets/admin_password"
elif [[ ! -s "$APP_DIR/.secrets/admin_password" ]]; then
  openssl rand -hex 16 > "$APP_DIR/.secrets/admin_password"
fi
admin_password="$(tr -d '\r\n' < "$APP_DIR/.secrets/admin_password")"
chown -R 1000:1000 "$APP_DIR/data" "$APP_DIR/.secrets"
chmod 0700 "$APP_DIR/.secrets"
chmod 0400 "$APP_DIR/.secrets/app_secret" "$APP_DIR/.secrets/admin_password"
cookie_secure=false
if [[ "$DEPLOY_MODE" == "public" || "$LAN_TLS" == "true" ]]; then
  cookie_secure=true
fi
# При первом запуске доступ открыт со всех подсетей, чтобы администратор гарантированно вошёл
# (LAN_CIDR ограничивает только SSH в UFW). Веб-подсети ограничиваются после первого входа в
# «Настройки → Сеть и доступ». Значение влияет лишь на инициализацию БД (guard network_access_initialized),
# при повторных деплоях пользовательский список не перезаписывается.
initial_allowed_subnets="${INITIAL_ALLOWED_SUBNETS:-0.0.0.0/0,::/0}"
printf 'ADMIN_USERNAME=admin\nCOOKIE_SECURE=%s\nINITIAL_ALLOWED_SUBNETS=%s\n' \
  "$cookie_secure" "$initial_allowed_subnets" > "$APP_DIR/.env"
chmod 0600 "$APP_DIR/.env"

cat > "$DEPLOY_CONFIG_DIR/deploy.env" <<EOF
APP_DIR=$APP_DIR
REPO_BRANCH=$REPO_BRANCH
REPO_ACCESS=$REPO_ACCESS
DEPLOY_MODE=$DEPLOY_MODE
EOF
if [[ "$DEPLOY_MODE" == "public" ]]; then
  printf 'APP_DOMAIN=%s\n' "$APP_DOMAIN" >> "$DEPLOY_CONFIG_DIR/deploy.env"
else
  printf 'LAN_HOST=%s\nLAN_CIDR=%s\nLAN_TLS=%s\n' \
    "$LAN_HOST" "$LAN_CIDR" "$LAN_TLS" >> "$DEPLOY_CONFIG_DIR/deploy.env"
fi
# BACKUP_ONCALENDAR содержит пробелы и '*', поэтому пишется в кавычках — deploy.env читается через source.
printf 'BACKUP_ONCALENDAR="%s"\nBACKUP_RETENTION_DAYS=%s\n' \
  "$BACKUP_ONCALENDAR" "$BACKUP_RETENTION_DAYS" >> "$DEPLOY_CONFIG_DIR/deploy.env"
chmod 0600 "$DEPLOY_CONFIG_DIR/deploy.env"

cd "$APP_DIR"
docker compose config --quiet
docker compose build --pull
docker compose up -d --remove-orphans

healthy=0
planner_container="$(docker compose ps -q planner)"
[[ -n "$planner_container" ]] || { docker compose logs --tail=150; exit 1; }
for _ in $(seq 1 60); do
  health_status="$(docker inspect --format '{{.State.Health.Status}}' "$planner_container" 2>/dev/null || true)"
  if [[ "$health_status" == "healthy" ]]; then
    healthy=1
    break
  fi
  if [[ "$health_status" == "unhealthy" ]]; then
    break
  fi
  sleep 2
done
[[ "$healthy" -eq 1 ]] || { docker compose logs --tail=150; exit 1; }

rm -f /etc/nginx/sites-enabled/default
cat > /etc/nginx/conf.d/pegas-rate-limit.conf <<EOF
limit_req_zone \$binary_remote_addr zone=pegas_login:10m rate=$RATE_LIMIT_RATE;
EOF
# heredoc без кавычек: подставляем $RATE_LIMIT_BURST, а nginx-переменные экранируем через \$.
cat > /etc/nginx/snippets/pegas-planner-proxy.conf <<EOF
    server_tokens off;
    client_max_body_size 10m;

    location = /api/auth/login {
        limit_req zone=pegas_login burst=$RATE_LIMIT_BURST nodelay;
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
EOF

if [[ "$DEPLOY_MODE" == "lan" && "$LAN_TLS" == "true" ]]; then
  tls_key="$DEPLOY_CONFIG_DIR/lan-tls.key"
  tls_cert="$DEPLOY_CONFIG_DIR/lan-tls.crt"
  if [[ ! -s "$tls_key" || ! -s "$tls_cert" ]]; then
    san_type="DNS"
    if [[ "$LAN_HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      san_type="IP"
    fi
    openssl req -x509 -nodes -newkey rsa:3072 -sha256 -days 825 \
      -keyout "$tls_key" -out "$tls_cert" -subj "/CN=$LAN_HOST" \
      -addext "subjectAltName=$san_type:$LAN_HOST" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign"
    chmod 0600 "$tls_key"
    chmod 0644 "$tls_cert"
  fi
  cat > /etc/nginx/sites-available/pegas-planner.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $LAN_HOST;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $LAN_HOST;
    ssl_certificate $tls_cert;
    ssl_certificate_key $tls_key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:PegasTLS:10m;
    ssl_session_timeout 1d;
    include /etc/nginx/snippets/pegas-planner-proxy.conf;
}
EOF
else
  if [[ "$DEPLOY_MODE" == "public" ]]; then
    nginx_host="$APP_DOMAIN"
  else
    nginx_host="$LAN_HOST"
  fi
  hsts=""
  if [[ "$DEPLOY_MODE" == "public" ]]; then
    hsts='    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'
  fi
  cat > /etc/nginx/sites-available/pegas-planner.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $nginx_host;
    include /etc/nginx/snippets/pegas-planner-proxy.conf;
${hsts}
}
EOF
fi
ln -sfn /etc/nginx/sites-available/pegas-planner.conf /etc/nginx/sites-enabled/pegas-planner.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx

ufw default deny incoming
ufw default allow outgoing
if [[ "$DEPLOY_MODE" == "public" ]]; then
  ufw allow "$DEPLOY_SSH_PORT/tcp" comment SSH
  ufw allow 80/tcp comment HTTP
  ufw allow 443/tcp comment HTTPS
else
  ufw allow from "$LAN_CIDR" to any port "$DEPLOY_SSH_PORT" proto tcp comment LAN-SSH
  ufw allow 80/tcp comment Planner-HTTP
  if [[ "$LAN_TLS" == "true" ]]; then
    ufw allow 443/tcp comment Planner-HTTPS
  fi
fi
ufw --force enable

cat > /etc/fail2ban/jail.d/pegas-sshd.local <<EOF
[sshd]
enabled = true
port = $DEPLOY_SSH_PORT
maxretry = $F2B_MAXRETRY
findtime = $F2B_FINDTIME
bantime = $F2B_BANTIME
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now unattended-upgrades

ssh_authorized=""
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  ssh_authorized="$(getent passwd "$SUDO_USER" | cut -d: -f6)/.ssh/authorized_keys"
else
  ssh_authorized="/root/.ssh/authorized_keys"
fi
if [[ -s "$ssh_authorized" ]]; then
  cat > /etc/ssh/sshd_config.d/90-pegas-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 5
X11Forwarding no
AllowTcpForwarding no
EOF
  sshd -t
  systemctl reload ssh
else
  echo "ВНИМАНИЕ: парольный SSH не отключен — authorized_keys не найден." >&2
fi

if [[ "$DEPLOY_MODE" == "public" ]]; then
  certbot --nginx --non-interactive --agree-tos --redirect \
    --email "$ADMIN_EMAIL" -d "$APP_DOMAIN"
  systemctl enable --now certbot.timer
fi

install -m 0750 "$APP_DIR/deploy/update-vps.sh" /usr/local/sbin/pegas-planner-update
install -m 0750 "$APP_DIR/deploy/backup-vps.sh" /usr/local/sbin/pegas-planner-backup
install -m 0644 "$APP_DIR/deploy/pegas-planner-backup.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/pegas-planner-backup.timer" /etc/systemd/system/
# Расписание задаётся drop-in override, а не правкой базового юнита: переживает переустановку .timer при обновлениях.
install -m 0755 -d /etc/systemd/system/pegas-planner-backup.timer.d
cat > /etc/systemd/system/pegas-planner-backup.timer.d/override.conf <<EOF
[Timer]
OnCalendar=
OnCalendar=$BACKUP_ONCALENDAR
EOF
systemctl daemon-reload
systemctl enable --now pegas-planner-backup.timer

credentials_file="/root/pegas-planner-initial-credentials.txt"
if [[ "$DEPLOY_MODE" == "public" ]]; then
  deployment_url="https://$APP_DOMAIN"
else
  deployment_url="http://$LAN_HOST"
  if [[ "$LAN_TLS" == "true" ]]; then
    deployment_url="https://$LAN_HOST"
  fi
fi
printf 'URL=%s\nLogin=admin\nPassword=%s\n' \
  "$deployment_url" "$admin_password" > "$credentials_file"
chmod 0600 "$credentials_file"

echo
echo "Деплой завершен: $deployment_url"
if [[ "$DEPLOY_MODE" == "lan" && "$LAN_TLS" == "true" ]]; then
  echo "Сертификат для доверия на клиентских ПК: $DEPLOY_CONFIG_DIR/lan-tls.crt"
fi
echo "Начальные реквизиты сохранены в $credentials_file"
echo "Пароль администратора: $admin_password"
echo "Смените пароль после первого входа."
