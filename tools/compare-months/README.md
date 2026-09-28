# Excel «Сравнение эффективности месяцев»

Повторяемый отчёт руководителю (первый выпуск 25–28.09.2026): 7 листов —
Сводка, Сентябрь 1-2 (половины), Выручка, ТС, Водители, Назначения,
Стыки. Выручка — ПО ДАТЕ ВЫПОЛНЕНИЯ (методика плитки), скорости/стыки —
канон planner-service; КВЛ/КИП — union-канон.

## Как собрать (с мака, нужен VPN до 100.100.10.77)

1. Поправить периоды в collect.mjs / collect2.mjs / collect3.mjs
   (константа P: aug/sep|h1/h2; конец эксклюзивен).
2. Прогнать сборщики на проде через data-том (контейнер read-only):
   scp collect.mjs root@100.100.10.77:/opt/pegas-planner/data/c-tmp.mjs
   ssh root@100.100.10.77 'docker exec pegas-planner-planner-1 \
     node /app/data/c-tmp.mjs 2>/dev/null; rm -f /opt/pegas-planner/data/c-tmp.mjs' > compare.json
   (аналогично collect2 → revenue2.json, collect3 → halves.json).
3. В build_xlsx.py / patch_xlsx.py / halves_xlsx.py поправить пути S
   (каталог с json), дни периодов (DAYS, делители /N) и подписи дат.
4. python3 build_xlsx.py && python3 patch_xlsx.py && python3 halves_xlsx.py
   → «Сравнение эффективности … .xlsx» (openpyxl, значениями — recalc
   на маке недоступен).

Порядок питонов обязателен: build создаёт книгу, patch переписывает
выручку методикой плитки, halves добавляет лист половин.
