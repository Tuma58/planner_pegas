#!/bin/bash
# Держит маршрут к внутренней сети ПегасЛогистик (100.100.10.0/24) через
# основной шлюз — переживает перезагрузки Mac и смены сети. Работает как
# LaunchDaemon (root), проверка каждые 30 секунд.
while true; do
  if ! netstat -rn -f inet | grep -q "^100\.100\.10/24"; then
    GW=$(route -n get default 2>/dev/null | awk '/gateway/{print $2}')
    if [ -n "$GW" ]; then
      route -n add -net 100.100.10.0/24 "$GW" >/dev/null 2>&1 \
        && logger -t pegas-route "маршрут 100.100.10.0/24 добавлен через $GW"
    fi
  fi
  sleep 30
done
