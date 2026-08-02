#!/usr/bin/env python3
"""Конвертер выгрузки рейсов из 1С (xlsx) в JSON контракта v1.0 для replace-trips.mjs.

Требует pandas и openpyxl (только для разовой конвертации; само приложение зависимостей не имеет).

    python3 scripts/xlsx-to-trips.py "Июль (2).xlsx" -o trips.json --from 2026-07-01 --to 2026-07-31

Фильтр применяется к дате выполнения. Адреса нормализуются (снимаются суффиксы «г./п./с./д.»,
уточнения в скобках и после запятой) — распознавание геозон выполняет сервер по алиасам.
"""
import argparse
import json
import re
import sys

import pandas as pd

COLUMNS = {
    'id': 'Номер',
    'depDate': 'Дата отправления',
    'doneDate': 'Дата выполнения',
    'depTime': 'Отправление с',
    'doneTime': 'Время доставки с',
    'truck': 'ТС',
    'trailer': 'Состав ТС',
    'type': 'Тип ТС(Карточка)',
    'driver': 'Водитель',
    'client': 'Заказчик',
    'from': 'Адрес отправления',
    'to': 'Адрес назначения',
    'revenue': 'Сумма документа',
}

SUFFIX = re.compile(r'\s+(г|п|д|с|пгт|рп|ст|х|б|тер|обл|р-н)\.?$', re.IGNORECASE)


def normalize_place(value):
    """«Васильевка д. (Пенза)» → «Васильевка», «Куженер, Марий ЭЛ.» → «Куженер»."""
    text = str(value or '').strip()
    text = text.split(',')[0]
    text = re.sub(r'\s*\(.*?\)', '', text)
    text = re.sub(r'\s+\S+\s+р-н$', '', text, flags=re.IGNORECASE)
    previous = None
    while previous != text:
        previous = text
        text = SUFFIX.sub('', text).strip()
    return text


def combine(date_value, time_value):
    """Дата + время суток → ISO-8601 без часового пояса (трактуется как локальное время склада)."""
    date = pd.to_datetime(date_value, format='%d.%m.%Y')
    parts = str(time_value or '0:00:00').split(':')
    hours, minutes = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
    return (date + pd.Timedelta(hours=hours, minutes=minutes)).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def main():
    parser = argparse.ArgumentParser(description='xlsx выгрузка 1С → JSON контракта v1.0')
    parser.add_argument('source', help='путь к xlsx')
    parser.add_argument('-o', '--output', required=True, help='куда записать JSON')
    parser.add_argument('--from', dest='date_from', required=True, help='дата выполнения не ранее, YYYY-MM-DD')
    parser.add_argument('--to', dest='date_to', required=True, help='дата выполнения не позднее, YYYY-MM-DD')
    parser.add_argument('--sheet', default=0, help='лист книги (индекс или имя)')
    args = parser.parse_args()

    frame = pd.read_excel(args.source, sheet_name=args.sheet)
    missing = [name for name in COLUMNS.values() if name not in frame.columns]
    if missing:
        sys.exit(f'В таблице нет колонок: {", ".join(missing)}')

    done = pd.to_datetime(frame[COLUMNS['doneDate']], format='%d.%m.%Y', errors='coerce')
    selected = frame[(done >= args.date_from) & (done <= args.date_to)]

    rows = []
    for _, row in selected.iterrows():
        starts_at = combine(row[COLUMNS['depDate']], row[COLUMNS['depTime']])
        ends_at = combine(row[COLUMNS['doneDate']], row[COLUMNS['doneTime']])
        rows.append({
            'id': str(row[COLUMNS['id']]).strip(),
            'truck': str(row[COLUMNS['truck']]).strip(),
            'trailer': str(row[COLUMNS['trailer']] or '').strip(),
            'type': str(row[COLUMNS['type']] or '').strip(),
            'driver': str(row[COLUMNS['driver']] or '').strip(),
            'client': str(row[COLUMNS['client']] or '').strip(),
            'from': normalize_place(row[COLUMNS['from']]),
            'to': normalize_place(row[COLUMNS['to']]),
            'depDate': starts_at,
            'doneDate': ends_at,
            'revenue': float(row[COLUMNS['revenue']] or 0),
            'status': 'done',
        })

    with open(args.output, 'w', encoding='utf-8') as file:
        json.dump(rows, file, ensure_ascii=False, indent=1)

    revenue = sum(item['revenue'] for item in rows)
    places = sorted({item['from'] for item in rows} | {item['to'] for item in rows})
    print(f'Отобрано рейсов: {len(rows)} из {len(frame)} (дата выполнения {args.date_from}…{args.date_to})')
    print(f'Сумма: {revenue:,.0f} | ТС: {len({r["truck"] for r in rows})} | заказчиков: {len({r["client"] for r in rows})}')
    print(f'Уникальных населённых пунктов после нормализации: {len(places)}')
    print(f'Записано: {args.output}')


if __name__ == '__main__':
    main()
