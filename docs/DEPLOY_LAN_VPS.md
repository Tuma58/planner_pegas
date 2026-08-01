# Деплой PegasLogistic на VPS в локальной сети

Инструкция рассчитана на чистый Debian 12/13, приватный Git-репозиторий и VPS с постоянным адресом в локальной сети. Внешний домен, публичный IP и Let's Encrypt не требуются.

Скрипт устанавливает Docker, Nginx, UFW, Fail2ban, unattended-upgrades, Git и SQLite CLI. Контейнер приложения слушает только `127.0.0.1:3000`. Клиенты работают через Nginx, а firewall разрешает доступ только из заданной подсети.

> VPS должен иметь исходящий доступ в интернет к Debian/Docker repositories и Git-хосту. Для полностью изолированной сети понадобится отдельный offline bundle.

## 1. Подготовка VPS

Пример параметров:

```text
VPS:             192.168.10.50
Локальная сеть:  192.168.10.0/24
SSH:             22
Ветка:           main
```

Закрепите адрес VPS через статическую настройку или DHCP reservation. Установите Debian 12/13 и добавьте публичный SSH-ключ администратора в `/root/.ssh/authorized_keys`.

С рабочей станции проверьте подключение:

```bash
ssh root@192.168.10.50
```

До первого подключения сравните fingerprint SSH host key с fingerprint, показанным в консоли VPS. После проверки ключ должен находиться в локальном `~/.ssh/known_hosts`; deployment script использует `StrictHostKeyChecking=yes`.

## 2. Приватный Git-репозиторий

Если репозиторий уже создан и код опубликован, перейдите к разделу с deploy key.

Пример первоначальной публикации:

```bash
cd /path/to/Planner
git init -b main
git add .gitignore Dockerfile compose.yaml package.json README.md public src scripts test deploy docs
git commit -m "Prepare PegasLogistic planner"
git remote add origin git@github.com:ORG/PRIVATE_REPOSITORY.git
git push -u origin main
```

Репозиторий на GitHub/GitLab должен быть создан как private. Файлы `.env`, `.secrets/` и рабочие SQLite-файлы исключены через `.gitignore`.

## 3. Read-only deploy key для VPS

Создайте отдельный ключ без passphrase. Не используйте личный SSH-ключ разработчика:

```bash
install -d -m 700 "$HOME/.ssh/pegas-vps"
ssh-keygen -t ed25519 -N '' -C 'pegas-planner-vps-readonly' -f "$HOME/.ssh/pegas-vps/deploy_key"
cat "$HOME/.ssh/pegas-vps/deploy_key.pub"
```

Добавьте содержимое `.pub` в настройках приватного репозитория:

- GitHub: `Settings → Deploy keys → Add deploy key`;
- GitLab: `Settings → Repository → Deploy keys`.

Оставьте ключ read-only. Обновление VPS требует только `clone`/`fetch`.

Подготовьте отдельный `known_hosts` для Git-хоста:

```bash
ssh-keyscan -t ed25519 github.com > "$HOME/.ssh/pegas-vps/git_known_hosts"
ssh-keygen -lf "$HOME/.ssh/pegas-vps/git_known_hosts"
```

Для GitLab замените `github.com` на свой Git-хост. Обязательно сравните выведенный fingerprint с официально опубликованным fingerprint провайдера. Не используйте непроверенный результат `ssh-keyscan`.

Проверьте ключ:

```bash
GIT_SSH_COMMAND="ssh -i $HOME/.ssh/pegas-vps/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$HOME/.ssh/pegas-vps/git_known_hosts -o StrictHostKeyChecking=yes" \
git ls-remote git@github.com:ORG/PRIVATE_REPOSITORY.git HEAD
```

## 4. Первоначальный LAN-деплой

Команда выполняется на рабочей станции из корня локальной копии проекта:

```bash
cd /path/to/Planner
LAN_ONLY=true \
VPS_HOST=192.168.10.50 \
LAN_HOST=192.168.10.50 \
LAN_CIDR=192.168.10.0/24 \
REPO_URL=git@github.com:ORG/PRIVATE_REPOSITORY.git \
REPO_BRANCH=main \
DEPLOY_KEY="$HOME/.ssh/pegas-vps/deploy_key" \
KNOWN_HOSTS_FILE="$HOME/.ssh/pegas-vps/git_known_hosts" \
bash ./deploy/deploy-to-vps.sh
```

Однострочный вариант:

```bash
LAN_ONLY=true VPS_HOST=192.168.10.50 LAN_HOST=192.168.10.50 LAN_CIDR=192.168.10.0/24 REPO_URL=git@github.com:ORG/PRIVATE_REPOSITORY.git REPO_BRANCH=main DEPLOY_KEY="$HOME/.ssh/pegas-vps/deploy_key" KNOWN_HOSTS_FILE="$HOME/.ssh/pegas-vps/git_known_hosts" bash ./deploy/deploy-to-vps.sh
```

Дополнительные параметры:

```bash
VPS_USER=deploy       # вместо root; требуется passwordless sudo
SSH_PORT=2222         # нестандартный SSH-порт
LAN_TLS=false         # только для полностью доверенной сети; логины пойдут по HTTP
```

Рекомендуемое значение `LAN_TLS=true` используется по умолчанию. В этом режиме создаётся локальный сертификат с SAN для `LAN_HOST`, HTTP перенаправляется на HTTPS, а session cookie получает флаг `Secure`.

### 4.1. Интерактивный мастер (на самом VPS)

Как альтернатива запуску с рабочей станции, прямо на целевом VPS от root можно запустить пошаговый мастер:

```bash
sudo bash deploy/interactive-deploy.sh
```

Мастер по шагам запрашивает и валидирует все параметры, показывает сводку по разделам (режим, сеть и подсети, сертификаты, учётные данные администратора, безопасность, каталог/бэкапы) и запускает деплой только после подтверждения. Полезные детали:

- **Пароль администратора** — по умолчанию генерируется; можно ввести свой (скрытый ввод, минимум 12 символов).
- **Предпросмотр без запуска**: `DRY_RUN=1 bash deploy/interactive-deploy.sh` печатает итоговую сводку и завершает работу, ничего не устанавливая.
- **Предзаданные переменные окружения** мастер не переспрашивает — можно смешивать интерактив и автоматизацию.
- Дополнительно настраиваются: `APP_DIR`, `REPO_BRANCH`, расписание и срок хранения бэкапов (`BACKUP_ONCALENDAR`, `BACKUP_RETENTION_DAYS`), лимит логина nginx (`RATE_LIMIT_RATE`, `RATE_LIMIT_BURST`) и Fail2ban (`F2B_MAXRETRY`, `F2B_FINDTIME`, `F2B_BANTIME`).

## 5. Доверие локальному сертификату

Скопируйте только публичный сертификат. Закрытый ключ должен оставаться на VPS:

```bash
scp root@192.168.10.50:/etc/pegas-planner/lan-tls.crt ./pegas-planner-lan.crt
```

Linux Debian/Ubuntu:

```bash
sudo install -m 0644 ./pegas-planner-lan.crt /usr/local/share/ca-certificates/pegas-planner-lan.crt
sudo update-ca-certificates
```

Windows PowerShell от имени администратора:

```powershell
Import-Certificate -FilePath .\pegas-planner-lan.crt -CertStoreLocation Cert:\LocalMachine\Root
```

macOS:

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ./pegas-planner-lan.crt
```

После установки сертификата откройте:

```text
https://192.168.10.50
```

Если `LAN_HOST` задан внутренним DNS-именем, например `planner.office.lan`, сертификат будет выпущен для этого имени и открывать приложение нужно по нему.

## 6. Первый вход и проверка

Скрипт выводит первоначальный пароль. Он также хранится на VPS с правами `0600`:

```bash
ssh root@192.168.10.50 'cat /root/pegas-planner-initial-credentials.txt'
```

После первого входа смените пароль администратора.

Проверка сервисов:

```bash
ssh root@192.168.10.50 'cd /opt/pegas-planner && docker compose ps'
ssh root@192.168.10.50 'curl -fsS http://127.0.0.1:3000/api/health'
ssh root@192.168.10.50 'ufw status verbose'
ssh root@192.168.10.50 'systemctl status nginx fail2ban pegas-planner-backup.timer --no-pager'
```

В LAN-режиме UFW разрешает SSH только из первоначального `LAN_CIDR`. Веб-порты принимает Nginx, а приложение до показа страницы входа проверяет адрес клиента по списку «Настройки → Сеть и доступ». При первом запуске этот список **открыт для всех подсетей** (`0.0.0.0/0,::/0`), чтобы администратор гарантированно вошёл; сразу после первого входа ограничьте его фактическими CIDR. Стартовое значение можно переопределить переменной `INITIAL_ALLOWED_SUBNETS`. Добавлять и удалять веб-подсети можно без повторного деплоя; текущий IP администратора должен оставаться хотя бы в одной разрешённой подсети. Значение влияет только на инициализацию БД — повторные деплои список не перезаписывают.

Если VPS является Proxmox LXC, bootstrap проверяет фактический запуск Docker до сборки приложения. Ошибка `net.ipv4.ip_unprivileged_port_start ... permission denied` означает несовместимый AppArmor-профиль внешнего LXC. Исправление выполняется на хосте Proxmox: обновите `lxc-pve` до версии `6.0.5-2` или новее, включите для CT `nesting=1,keyctl=1`, затем полностью остановите и запустите CT. Отключение AppArmor или откат `runc` не используются.

## 7. Обновление из приватного репозитория

Сначала опубликуйте новую версию с рабочей станции:

```bash
cd /path/to/Planner
git status
git add <измененные-файлы>
git commit -m "Update planner"
git push origin main
```

Затем запустите update-deploy:

```bash
ssh root@192.168.10.50 /usr/local/sbin/pegas-planner-update
```

Update script:

1. блокирует параллельные обновления;
2. получает ветку через read-only deploy key;
3. разрешает только fast-forward;
4. создаёт SQLite backup;
5. пересобирает контейнеры;
6. проверяет `/api/health`;
7. при ошибке возвращает предыдущий commit.

Проверка установленной версии:

```bash
ssh root@192.168.10.50 'git -C /opt/pegas-planner log -1 --oneline'
```

## 8. Эксплуатационные команды

```bash
ssh root@192.168.10.50 'cd /opt/pegas-planner && docker compose logs --tail=200 planner'
ssh root@192.168.10.50 'cd /opt/pegas-planner && docker compose logs --tail=200 sync-worker'
ssh root@192.168.10.50 /usr/local/sbin/pegas-planner-backup
ssh root@192.168.10.50 'ls -lh /opt/pegas-planner/data/backups'
ssh root@192.168.10.50 'systemctl list-timers pegas-planner-backup.timer'
```

Расписание бэкапа задаётся в мастере/окружении (`BACKUP_ONCALENDAR`) и применяется через drop-in `/etc/systemd/system/pegas-planner-backup.timer.d/override.conf`; срок хранения (`BACKUP_RETENTION_DAYS`) хранится в `/etc/pegas-planner/deploy.env`. После ручной правки любого из них выполните `systemctl daemon-reload`.

Локальные копии на VPS не заменяют внешнее резервное хранение. Регулярно выгружайте `data/backups/` и `.secrets/` в зашифрованное хранилище. Без `APP_SECRET` невозможно расшифровать сохранённые секреты интеграции с 1С.
