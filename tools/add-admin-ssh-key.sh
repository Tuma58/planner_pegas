#!/bin/bash
# Добавляет админский SSH-ключ в /root/.ssh/authorized_keys.
# Запускать на сервере от root (консоль Proxmox / уже открытая сессия).
set -euo pipefail

PUB_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHrthQ4KnGRs+O4wiRbVQAXKvgOqBHyJmlDfuIFAlj01 admin@MacBook-Pro-Admin.local'
AUTH_KEYS=/root/.ssh/authorized_keys

install -d -m 700 /root/.ssh
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
chown -R root:root /root/.ssh

if grep -Fqx "$PUB_KEY" "$AUTH_KEYS"; then
  echo "Ключ уже есть в $AUTH_KEYS"
  exit 0
fi

{
  echo ''
  echo '# --- BEGIN admin MacBook-Pro ---'
  echo "$PUB_KEY"
  echo '# --- END admin MacBook-Pro ---'
} >> "$AUTH_KEYS"

chmod 600 "$AUTH_KEYS"
echo "Ключ добавлен. Проверка:"
grep -F "admin@MacBook-Pro-Admin.local" "$AUTH_KEYS"
