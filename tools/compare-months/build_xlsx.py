# -*- coding: utf-8 -*-
# Excel-сравнение август/сентябрь: значениями (recalc на маке недоступен).
import json
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

S = '/private/tmp/claude-501/-Users-aleksey-pegas-planner/e1757453-d539-4377-b209-1ccd478bae1d/scratchpad'
d = json.load(open(S + '/compare.json'))
A, Sp = d['aug'], d['sep']
DAYS = {'aug': 31, 'sep': 27}

wb = Workbook()
F = lambda **kw: Font(name='Arial', **kw)
H = F(bold=True, size=11)
TITLE = F(bold=True, size=14)
SUB = F(size=9, color='666666')
GOOD = Font(name='Arial', color='006300', bold=True)
BAD = Font(name='Arial', color='B8352A', bold=True)
HEAD_FILL = PatternFill('solid', fgColor='EFEFEA')
thin = Side(style='thin', color='D8D6CF')
BORDER = Border(bottom=thin)

def sheet(ws, title, note):
    ws['A1'] = title; ws['A1'].font = TITLE
    ws['A2'] = note + ' · август: 01–31.08 (31 дн) · сентябрь: 01–27.09 включительно (27 дн) · выручка без НДС по канону'
    ws['A2'].font = SUB

def header(ws, row, cols, widths=None):
    for i, name in enumerate(cols, 1):
        c = ws.cell(row=row, column=i, value=name)
        c.font = H; c.fill = HEAD_FILL; c.border = BORDER
        c.alignment = Alignment(wrap_text=True, vertical='center')
    if widths:
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

def put(ws, row, values, fmts=None, fonts=None):
    for i, v in enumerate(values, 1):
        c = ws.cell(row=row, column=i, value=v)
        c.font = F()
        if fmts and fmts[i-1]: c.number_format = fmts[i-1]
        if fonts and fonts[i-1]: c.font = fonts[i-1]

def delta_font(val, good_up=True, eps=0):
    if val is None: return None
    if abs(val) <= eps: return None
    return GOOD if (val > 0) == good_up else BAD

# ── 1. Сводка ──
ws = wb.active; ws.title = 'Сводка'
sheet(ws, 'Эффективность: август → сентябрь 2026', 'Ключевые показатели')
header(ws, 4, ['Показатель', 'Август', 'Сентябрь (27 дн)', 'Δ', 'Комментарий'], [44, 15, 17, 13, 52])
r = 5
def row(name, a, s, fmt='#,##0.0', good_up=True, comment='', eps=0):
    global r
    dv = None if (a is None or s is None) else s - a
    put(ws, r, [name, a, s, dv, comment],
        [None, fmt, fmt, ('+' + fmt + ';-' + fmt + ';0') if dv is not None else None, None],
        [None, None, None, delta_font(dv, good_up, eps), None])
    r += 1

wfA, wfS = A['waterfall'], Sp['waterfall']
veA, veS = A['driversPark']['ve'], Sp['driversPark']['ve']
row('Выручка бНДС, млн ₽', A['park']['rev']/1e6, Sp['park']['rev']/1e6, '#,##0.0', True, 'сентябрь ещё не закончен — см. /сутки')
row('Выручка бНДС, млн ₽/сутки', A['park']['rev']/1e6/31, Sp['park']['rev']/1e6/27, '#,##0.00', True, 'главная строка: темп вырос')
row('Прогноз сентября (темп × 30), млн ₽', None, Sp['park']['rev']/1e6/27*30, '#,##0.0', True, 'план 165')
row('Рейсов закрыто', A['park']['trips'], Sp['park']['trips'], '#,##0', True, '')
row('Рейсов в сутки', A['park']['trips']/31, Sp['park']['trips']/27, '#,##0.1', True, '')
row('Средний чек бНДС, ₽', A['park']['rev']/max(1,A['park']['trips']), Sp['park']['rev']/max(1,Sp['park']['trips']), '#,##0', True, '')
row('На линии среднесуточно, машин', A['avgOnline'], Sp['avgOnline'], '#,##0.0', True, 'живой ряд (рейсы+перегоны)')
row('КТГ, % (по закрытым)', A['park']['ktg'], Sp['park']['ktg'], '#,##0.0', True, '')
row('КВЛ, %', A['park']['kvl'], Sp['park']['kvl'], '#,##0.0', True, '')
row('КИП, %', A['park']['kip'], Sp['park']['kip'], '#,##0.0', True, 'доля времени линии под грузом')
row('Выручка на сцепку в сутки, ₽ (по линии)', A['park']['rev']/31/max(1,A['avgOnline']), Sp['park']['rev']/24/max(1,Sp['avgOnline']), '#,##0', True, '')
row('Скорость рейса Vэ, км/ч (медиана водителей)', veA, veS, '#,##0.1', True, '')
row('Дорожная скорость, км/ч (чистые цепочки)', wfA['km']/wfA['roadH'], wfS['km']/wfS['roadH'], '#,##0.1', True, 'убыл с погрузки → прибыл на выгрузку')
row('Ворота выгрузки, ч/рейс (средние)', wfA['unloadH']/wfA['n'], wfS['unloadH']/wfS['n'], '#,##0.1', False, 'цель руководителя 6 ч')
row('Ворота погрузки, ч/рейс', wfA['loadH']/wfA['n'], wfS['loadH']/wfS['n'], '#,##0.1', False, 'включая ожидание окна при ранней подаче')
row('Дисциплина отметок, % чистых цепочек', 100*wfA['n']/max(1,wfA['total']), 100*wfS['n']/max(1,wfS['total']), '#,##0', True, 'только чистые учат нормативы')
row('Прибытия на погрузку вовремя, %', 100*(A['late']['P']['n']-A['late']['P']['late1'])/max(1,A['late']['P']['n']), 100*(Sp['late']['P']['n']-Sp['late']['P']['late1'])/max(1,Sp['late']['P']['n']), '#,##0', True, 'опоздание = >1 ч')
row('Прибытия на выгрузку вовремя, %', 100*(A['late']['D']['n']-A['late']['D']['late1'])/max(1,A['late']['D']['n']), 100*(Sp['late']['D']['n']-Sp['late']['D']['late1'])/max(1,Sp['late']['D']['n']), '#,##0', True, '')
row('Следующий рейс назначен до выгрузки, %', A['next']['pct'], Sp['next']['pct'], '#,##0', True, 'цель 85%; такой стык 8 ч против 27,6')
row('Стык между рейсами, ч (медиана)', A['gaps']['medianH'], Sp['gaps']['medianH'], '#,##0.1', False, 'цель 8 ч')
row('Стык: ждали заказ, ч (в среднем)', A['gaps']['waitOrderAvg'], Sp['gaps']['waitOrderAvg'], '#,##0.1', False, 'зона продаж')
row('Стык: ждали окно клиента, ч', A['gaps']['waitSlotAvg'], Sp['gaps']['waitSlotAvg'], '#,##0.1', False, 'зона слотов погрузки')

# ── 2. Выручка ──
ws = wb.create_sheet('Выручка')
sheet(ws, 'Выручка по неделям и клиентам', 'Недели пн–вс из канона parkReportData')
header(ws, 4, ['Период', 'Неделя', 'Выручка бНДС, млн', 'Рейсов', 'КТГ %', 'КВЛ %', 'КИП %'], [11, 16, 18, 10, 9, 9, 9])
r = 5
for key, label in (('aug', 'август'), ('sep', 'сентябрь')):
    for w in d[key]['weeks']:
        put(ws, r, [label, f"{w['from'][8:]}–{w['to'][8:]}.{w['to'][5:7]}", w['rev']/1e6, w['trips'], w['ktg'], w['kvl'], w['kip']],
            [None, None, '#,##0.1', '#,##0', '#,##0', '#,##0', '#,##0'])
        r += 1
r += 1
ws.cell(row=r, column=1, value='Топ клиентов (сентябрь), сравнение с августом').font = H
r += 1
header(ws, r, ['Клиент', 'Август: рейсов', 'млн бНДС', 'Сентябрь: рейсов', 'млн бНДС', 'Δ млн'], [34, 14, 12, 15, 12, 11])
r += 1
augC = {c['name']: c for c in A['clients']}
for c in Sp['clients']:
    a = augC.get(c['name'])
    dv = c['rev']/1e6 - (a['rev']/1e6 if a else 0)
    put(ws, r, [c['name'][:36], a['n'] if a else 0, (a['rev']/1e6 if a else 0), c['n'], c['rev']/1e6, dv],
        [None, '#,##0', '#,##0.1', '#,##0', '#,##0.1', '+#,##0.1;-#,##0.1;0'],
        [None, None, None, None, None, delta_font(dv, True, 0.05)])
    r += 1

# ── 3. ТС ──
ws = wb.create_sheet('ТС')
sheet(ws, 'Эффективность по сцепкам', 'Vэ — км рейса на всё его время; Vт — по GPS/CAN в движении (справка)')
header(ws, 4, ['ТС', 'Водитель (сент.)', 'Авг: км GPS', 'Vэ', 'Vт', 'Сент: км GPS', 'Vэ', 'Vт', 'Δ Vэ'], [12, 26, 12, 8, 8, 13, 8, 8, 9])
augV = {v['plate']: v for v in A['speedByVehicle']}
r = 5
for v in sorted(Sp['speedByVehicle'], key=lambda x: -(x.get('km') or 0)):
    a = augV.get(v['plate'], {})
    dv = None if (v.get('op') is None or a.get('op') is None) else v['op'] - a['op']
    put(ws, r, [v['plate'], (v.get('driver') or '')[:28], a.get('km'), a.get('op'), a.get('tech'), v.get('km'), v.get('op'), v.get('tech'), dv],
        [None, None, '#,##0', '#,##0.1', '#,##0.1', '#,##0', '#,##0.1', '#,##0.1', '+#,##0.1;-#,##0.1;0'],
        [None, None, None, None, None, None, None, None, delta_font(dv, True, 0.5)])
    r += 1

# ── 4. Водители ──
ws = wb.create_sheet('Водители')
sheet(ws, 'Эффективность по водителям', 'Водитель рейса — по закреплению на момент старта; ворота — время клиента (справка)')
header(ws, 4, ['Водитель', 'Авг: рейсов', 'км', 'Vэ', 'Сент: рейсов', 'км', 'Vэ', 'Δ Vэ', 'Оп. на погрузку (сент)', 'Ворота В, ч', 'Чистые цепочки %'],
       [28, 11, 10, 8, 12, 10, 8, 9, 18, 12, 15])
augD = {x['name']: x for x in A['drivers']}
r = 5
for x in sorted(Sp['drivers'], key=lambda z: -z['trips']):
    a = augD.get(x['name'], {})
    dv = None if (x.get('ve') is None or a.get('ve') is None) else x['ve'] - a['ve']
    late = f"{x['lateLoad']}/{x['loadFacts']}" if x.get('loadFacts') else '—'
    put(ws, r, [x['name'][:30], a.get('trips'), a.get('km'), a.get('ve'), x['trips'], x['km'], x.get('ve'), dv, late, x.get('gateUnloadH'), x.get('cleanPct')],
        [None, '#,##0', '#,##0', '#,##0.1', '#,##0', '#,##0', '#,##0.1', '+#,##0.1;-#,##0.1;0', None, '#,##0.1', '#,##0'],
        [None, None, None, None, None, None, None, delta_font(dv, True, 0.5), None, None, None])
    r += 1

# ── 5. Назначения ──
ws = wb.create_sheet('Назначения')
sheet(ws, 'Назначения и точность', 'Стыковочные и точностные показатели работы офиса')
header(ws, 4, ['Показатель', 'Август', 'Сентябрь', 'Δ', 'Пояснение'], [46, 13, 13, 12, 50])
r = 5
def arow(name, a, s, fmt='#,##0.0', good_up=True, note='', eps=0):
    global r
    dv = None if (a is None or s is None) else s - a
    put(ws, r, [name, a, s, dv, note], [None, fmt, fmt, '+' + fmt + ';-' + fmt + ';0', None],
        [None, None, None, delta_font(dv, good_up, eps), None])
    r += 1
arow('Следующий рейс до выгрузки, % пар', A['next']['pct'], Sp['next']['pct'], '#,##0', True, 'цель 85% — главный рычаг стыков; сигналы «🔎» продажам с 23.09')
arow('… пар со следующим всего', A['next']['total'], Sp['next']['total'], '#,##0', True, '')
autoOf = lambda p: {x['outcome']: x['c'] for x in p['auto']}
aA, aS = autoOf(A), autoOf(Sp)
accA, totA = aA.get('accepted', 0), sum(aA.values())
accS, totS = aS.get('accepted', 0), sum(aS.values())
arow('Автоназначение: принято черновиков, %', 100*accA/max(1,totA), 100*accS/max(1,totS), '#,##0', True, f'решений: {totA} → {totS}; цель доверия 80%')
arow('Опоздания на погрузку >1 ч, % прибытий', 100*A['late']['P']['late1']/max(1,A['late']['P']['n']), 100*Sp['late']['P']['late1']/max(1,Sp['late']['P']['n']), '#,##0.1', False, f"прибытий с планом: {A['late']['P']['n']} → {Sp['late']['P']['n']}")
arow('Опоздания на выгрузку >1 ч, %', 100*A['late']['D']['late1']/max(1,A['late']['D']['n']), 100*Sp['late']['D']['late1']/max(1,Sp['late']['D']['n']), '#,##0.1', False, '')
arow('Медиана опоздания (погрузка), ч', A['late']['P'].get('median'), Sp['late']['P'].get('median'), '#,##0.1', False, 'среди опоздавших')
arow('Медиана опоздания (выгрузка), ч', A['late']['D'].get('median'), Sp['late']['D'].get('median'), '#,##0.1', False, '')

# ── 6. Стыки ──
ws = wb.create_sheet('Стыки')
sheet(ws, 'Стыки между рейсами', 'Стык = от фактической выгрузки до старта следующего рейса той же машины')
header(ws, 4, ['Показатель', 'Август', 'Сентябрь', 'Δ', 'Пояснение'], [40, 13, 13, 12, 48])
r = 5
def grow(name, a, s, good_up=False, note=''):
    global r
    dv = None if (a is None or s is None) else s - a
    put(ws, r, [name, a, s, dv, note], [None, '#,##0.1', '#,##0.1', '+#,##0.1;-#,##0.1;0', None],
        [None, None, None, delta_font(dv, good_up, 0.05), None])
    r += 1
grow('Пар рейсов', A['gaps']['pairs'], Sp['gaps']['pairs'], True, '')
grow('Медиана стыка, ч', A['gaps']['medianH'], Sp['gaps']['medianH'], False, 'цель руководителя 8 ч')
grow('Средний стык, ч', A['gaps']['avgH'], Sp['gaps']['avgH'], False, 'хвосты тянут среднее вверх')
grow('Ждали заказ, ч/стык', A['gaps']['waitOrderAvg'], Sp['gaps']['waitOrderAvg'], False, 'следующий ещё не был создан — зона продаж')
grow('Ждали окно клиента, ч/стык', A['gaps']['waitSlotAvg'], Sp['gaps']['waitSlotAvg'], False, 'заказ есть, погрузка позже — слоты')
r += 1
ws.cell(row=r, column=1, value='Стык по зонам выгрузки (медиана, ч)').font = H
r += 1
header(ws, r, ['Зона', 'Август: пар', 'медиана ч', 'Сентябрь: пар', 'медиана ч', 'Δ ч'], [18, 12, 11, 13, 11, 10])
r += 1
zA = {z['name']: z for z in A['zoneGaps']}
names = list(dict.fromkeys([z['name'] for z in Sp['zoneGaps']] + list(zA.keys())))
for name in names:
    a = zA.get(name); s = next((z for z in Sp['zoneGaps'] if z['name'] == name), None)
    dv = None if not (a and s) else s['medianH'] - a['medianH']
    put(ws, r, [name, a['pairs'] if a else None, a['medianH'] if a else None, s['pairs'] if s else None, s['medianH'] if s else None, dv],
        [None, '#,##0', '#,##0.1', '#,##0', '#,##0.1', '+#,##0.1;-#,##0.1;0'],
        [None, None, None, None, None, delta_font(dv, False, 0.3)])
    r += 1

out = S + '/Сравнение эффективности август–сентябрь 2026.xlsx'
wb.save(out)
print('OK', out)
