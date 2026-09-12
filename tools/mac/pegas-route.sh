#!/bin/sh
# Маршрут к прод-сети планера (100.100.10.0/24) через офисный VPN Пегаса.
#
# Правило (установка руководителя 12.09): маршрут существует ТОЛЬКО пока
# офисный VPN активен — на маке есть адрес 172.15.35.x. VPN поднялся —
# маршрут добавляется через шлюз VPN 172.15.35.1; VPN упал — маршрут
# удаляется, чтобы трафик к 100.100.10.x не утекал в чужой шлюз.
#
# Запускается службой ru.pegas.route (root): при загрузке, каждые 45 с
# и при любой смене сетевой конфигурации. Один идемпотентный проход.
SUBNET=100.100.10.0/24
GATEWAY=172.15.35.1

vpn_ip=$(/sbin/ifconfig 2>/dev/null | /usr/bin/grep -o 'inet 172\.15\.35\.[0-9]*' | /usr/bin/head -1)
have_route=$(/usr/sbin/netstat -rn -f inet | /usr/bin/grep -c '^100\.100\.10')

if [ -n "$vpn_ip" ]; then
  if [ "$have_route" -eq 0 ]; then
    /sbin/route -n add -net "$SUBNET" "$GATEWAY" >/dev/null 2>&1 \
      && /usr/bin/logger -t pegas-route "маршрут $SUBNET добавлен через $GATEWAY (VPN активен: ${vpn_ip#inet })"
  fi
else
  if [ "$have_route" -gt 0 ]; then
    /sbin/route -n delete -net "$SUBNET" >/dev/null 2>&1 \
      && /usr/bin/logger -t pegas-route "маршрут $SUBNET удалён (офисный VPN не активен)"
  fi
fi
exit 0
