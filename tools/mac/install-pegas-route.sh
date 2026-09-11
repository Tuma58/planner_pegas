#!/bin/bash
# Установка постоянного маршрута к серверу ПегасЛогистик (запуск: sudo bash install-pegas-route.sh)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$DIR/pegas-route.sh" /usr/local/bin/pegas-route.sh
chmod 755 /usr/local/bin/pegas-route.sh
cp "$DIR/ru.pegas.route.plist" /Library/LaunchDaemons/ru.pegas.route.plist
chown root:wheel /Library/LaunchDaemons/ru.pegas.route.plist
chmod 644 /Library/LaunchDaemons/ru.pegas.route.plist
launchctl unload /Library/LaunchDaemons/ru.pegas.route.plist 2>/dev/null || true
launchctl load -w /Library/LaunchDaemons/ru.pegas.route.plist
sleep 2
netstat -rn -f inet | grep "^100\.100\.10/24" && echo "✅ Служба установлена, маршрут на месте" \
  || echo "Служба установлена — маршрут появится в течение 30 секунд"
