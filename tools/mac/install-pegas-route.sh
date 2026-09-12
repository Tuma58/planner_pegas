#!/bin/sh
# Установка службы маршрута к прод-сети планера.
# Запуск: sudo bash tools/mac/install-pegas-route.sh
#
# Что делает служба: держит маршрут 100.100.10.0/24 через шлюз офисного
# VPN (192.168.89.170) ТОЛЬКО пока VPN активен (на маке есть адрес из
# сети 192.168.89.x); при падении VPN маршрут убирается сам. Проверка — при
# загрузке, каждые 45 с и при любой смене сети.
#
# Удаление службы:
#   sudo launchctl bootout system/ru.pegas.route
#   sudo rm /Library/LaunchDaemons/ru.pegas.route.plist /usr/local/lib/pegas-route.sh
set -e
cd "$(dirname "$0")"
[ "$(id -u)" = "0" ] || { echo "Нужны права root: sudo bash $0"; exit 1; }

mkdir -p /usr/local/lib
cp pegas-route.sh /usr/local/lib/pegas-route.sh
chmod 755 /usr/local/lib/pegas-route.sh
chown root:wheel /usr/local/lib/pegas-route.sh

cp ru.pegas.route.plist /Library/LaunchDaemons/ru.pegas.route.plist
chown root:wheel /Library/LaunchDaemons/ru.pegas.route.plist
chmod 644 /Library/LaunchDaemons/ru.pegas.route.plist

launchctl bootout system/ru.pegas.route 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/ru.pegas.route.plist
launchctl kickstart system/ru.pegas.route

echo "Служба ru.pegas.route установлена."
echo "Маршрут 100.100.10.0/24 появится сам, как только офисный VPN станет активен."
echo "Журнал: log show --last 1h --predicate 'process == \"logger\"' | grep pegas-route"
