import { api, escapeHtml, formatDate, logout, setupTheme, toast } from './api.js';
import { directionGoals } from './goals-core.js';
setupTheme();

const state = { section: 'general', admin: null, users: null };
const byId = id => document.getElementById(id);
const content = byId('settingsContent');

function showModal(html) {
  byId('modalRoot').innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  document.querySelector('.modal-backdrop').onclick = event => {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
  };
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = closeModal);
}

function closeModal() {
  byId('modalRoot').innerHTML = '';
}

function roleLabel(role) {
  return state.users?.roles?.[role] || role;
}

function statusBadge(status) {
  const tone = status === 'done' || status === 'sent' || status === 'work' ? 'ok'
    : status === 'failed' ? 'bad' : 'warn';
  return `<span class="badge ${tone}">${escapeHtml(status)}</span>`;
}

// BI-вид (04.11, по образцу «Рабочей среды СТ»): страница раздела =
// шапка .bi-sub → сетка .bi-grid из секций; карточка настроек = .section,
// её заголовок — шапка .sec-h. Поля, id и обработчики не меняются.
const biHead = (title, text = '', actions = '') => `<div class="bi-sub"><h2>${title}</h2>
  ${text ? `<p>${text}</p>` : ''}${actions ? `<div class="bi-actions">${actions}</div>` : ''}</div>`;
const biSec = (title, body, { span = '', hint = '', actions = '', flush = false } = {}) =>
  `<section class="section ${span}"><div class="sec-h"><span class="st">${title}</span>
    ${hint ? `<span class="hint">${hint}</span>` : ''}${actions ? `<div class="sec-actions">${actions}</div>` : ''}</div>
    <div class="sec-b${flush ? ' flush' : ''}">${body}</div></section>`;
const biPage = (headHtml, sections) => `<div class="bi-page svc-set">${headHtml}
  <div class="bi-grid">${sections.join('')}</div></div>`;

function renderGeneral() {
  const { general, calculation, statuses, rejectionReasons, orderOptions } = state.admin.settings;
  const turnover = state.admin.settings.turnover || {};
  const goals = directionGoals(calculation);
  content.innerHTML = biPage(biHead('Настройки планера',
    'Параметры, которые раньше были зашиты непосредственно в HTML.',
    '<button class="button" id="saveGeneral">Сохранить</button>'), [
    biSec('Общие', `<div class="fields">
      <label class="field">Название компании<input id="companyName" value="${escapeHtml(general.companyName)}"></label>
      <label class="field">Название приложения<input id="appName" value="${escapeHtml(general.appName)}"></label>
      <label class="field">Часовой пояс<input id="timezone" value="${escapeHtml(general.timezone)}"></label>
      <label class="field">Начало горизонта<input id="horizonStart" type="date" value="${general.horizonStart}"></label>
      <label class="field">Горизонт, месяцев<input id="horizonMonths" type="number" min="1" max="36" value="${general.horizonMonths}"></label>
      <label class="field">Ширина дня, px<input id="plannerCellWidth" type="number" min="28" max="100" value="${general.plannerCellWidth}"></label>
    </div>`, { span: 's6' }),
    biSec('Статусы рейса', `<div class="table-wrap"><table class="bi-table"><thead><tr><th>Код</th><th>Название</th><th>Цвет</th></tr></thead>
      <tbody>${statuses.map(([id, name, color]) => `<tr data-status="${escapeHtml(id)}"><td class="mono">${escapeHtml(id)}</td>
        <td><input data-status-name value="${escapeHtml(name)}"></td><td><input data-status-color type="color" value="${escapeHtml(color)}"></td></tr>`).join('')}</tbody></table></div>`,
      { span: 's6', flush: true }),
    // Реестр целей направления СТ (блок 2 «Слияния», 07.11): одна точка
    // правды, её читают «Цели и задачи», «Структура», «Руководитель»,
    // фонд машино-дней и дашборд (goals-core.js).
    biSec('Цели направления СТ', `<div class="fields three">
      <label class="field">Выручка, млн ₽/мес без НДС <small class="muted">стратегическая цель; план месяца — ступень, задаётся у руководителя</small>
        <input id="goalRevenueMln" type="number" min="0" step="1" value="${goals.revenueMln}"></label>
      <label class="field">КТГ, % <small class="muted">ТОиР — исправные от списка</small>
        <input id="ktgTargetPct" type="number" min="0" max="100" step="0.5" value="${goals.ktg}"></label>
      <label class="field">КВЛ, % <small class="muted">Эксплуатация — укомплектованные от исправных</small>
        <input id="kvlTargetPct" type="number" min="0" max="100" step="0.5" value="${goals.kvl}"></label>
      <label class="field">КИП, % <small class="muted">Логистика — с заданием от укомплектованных</small>
        <input id="kipTargetPct" type="number" min="0" max="100" step="0.5" value="${goals.kip}"></label>
      <div class="field"><span>Использование парка (КЭИП)</span><b class="mono" style="font-size:18px">${String(goals.use).replace('.', ',')}%</b>
        <small class="muted">= КТГ × КВЛ × КИП, считается само</small></div>
      <label class="field">Цель среднесуточного пробега, км/сут на машину
        <input id="dailyKmTarget" type="number" min="0" step="10" value="${goals.kmDay}"></label>
      <label class="field">Списочный парк, ТС<input id="fleetTarget" type="number" min="0" step="1" value="${goals.fleet}"></label>
      <label class="field">Вес своего KPI, % <small class="muted">остальное — сквозной контроль соседа (среда СТ: 70–80 / 20–30)</small>
        <input id="kpiOwnSharePct" type="number" min="0" max="100" step="5" value="${goals.kpiOwnPct}"></label>
      <label class="field">Сигнал на стыке вовремя, ч <small class="muted">цель бдительности: от возникновения случая до «⚑ Сигнал»</small>
        <input id="signalTargetHours" type="number" min="0" step="0.5" value="${goals.signalTargetH}"></label>
      <label class="field">КПП: личный транспорт стоит дольше, ч <small class="muted">подсветка в «🚧 КПП»</small>
        <input id="gateLongHours" type="number" min="1" step="1" value="${goals.gateLongH}"></label>
      <label class="field">Сроки документов — предупреждать за, дн <small class="muted">страховки, техосмотр, тахограф, допуски водителей</small>
        <input id="docsWarnDays" type="number" min="1" step="1" value="${goals.docsWarnDays}"></label>
      <label class="field">Горизонт плана, сут <small class="muted">«ТО скоро» — если машина проедет остаток за горизонт</small>
        <input id="planHorizonDays" type="number" min="0" step="1" value="${goals.planHorizonDays}"></label>
      <label class="field">Водитель: сдельно, ₽/км <small class="muted">Положение об оплате</small>
        <input id="driverRatePerKm" type="number" min="0" step="0.5" value="${goals.driverRatePerKm}"></label>
      <label class="field">Водитель: гарантия, ₽/сутки работы
        <input id="driverGuaranteePerDay" type="number" min="0" step="100" value="${goals.driverGuaranteePerDay}"></label>
      <label class="field">Водитель: доплата за сутки сверхвахты, ₽ <small class="muted">Положение об оплате</small>
        <input id="driverOvertimePerDay" type="number" min="0" step="100" value="${goals.driverOvertimePerDay ?? ''}"></label>
      <label class="check"><input id="crmReceivablesOn" type="checkbox" ${calculation.crmReceivablesOn === true ? 'checked' : ''}>
        Учёт дебиторки CRM <small class="muted">долги клиентов; включить, когда есть сотрудник и процесс</small></label>
      <label class="field">Норматив ФОТ управления, % выручки <small class="muted">пусто — не задан (блок «ФОТ»)</small>
        <input id="fotNormPct" type="number" min="0" max="100" step="0.1" value="${goals.fotPct ?? ''}"></label>
      <label class="field">Текучесть водителей: учёт с <small class="muted">справочник наполнялся в августе — приёмы до даты не считаются</small>
        <input id="turnoverFrom" type="date" value="${escapeHtml(turnover.accountingFrom || '')}"></label>
      <label class="field">Текучесть водителей: цель, % в месяц <small class="muted">пусто — не задана</small>
        <input id="turnoverTarget" type="number" min="0" step="0.1" value="${turnover.targetPct ?? ''}"></label>
      <label class="field">Короткий стаж, дней <small class="muted">пусто — медиана стажа уволенных</small>
        <input id="turnoverShort" type="number" min="0" step="1" value="${turnover.shortTenureDays ?? ''}"></label>
    </div>`, { span: 's12' }),
    biSec('Экономика и нормативы', `<div class="fields three">
      <label class="field">Себестоимость, ₽/км<input id="costPerKm" type="number" min="0" step=".01" value="${calculation.costPerKm}"></label>
      <label class="field">Страхование, Платон и дороги, ₽/км<input id="insuranceAndRoadsPerKm" type="number" min="0" step=".01" value="${calculation.insuranceAndRoadsPerKm}"></label>
      <label class="field">Водитель, ₽/сутки рейса<input id="driverPerTripDay" type="number" min="0" value="${calculation.driverPerTripDay}"></label>
      <label class="field">Рефустановка, ₽/сутки рейса<input id="refrigerationPerTripDay" type="number" min="0" value="${calculation.refrigerationPerTripDay}"></label>
      <label class="field">Лизинг/амортизация, ₽/машино-день<input id="leasePerVehicleDay" type="number" min="0" value="${calculation.leasePerVehicleDay}"></label>
      <label class="field">Накладные, ₽/машино-день<input id="overheadPerVehicleDay" type="number" min="0" value="${calculation.overheadPerVehicleDay}"></label>
      <label class="field">Ставка НДС<input id="vatRate" type="number" min="0" max="1" step=".01" value="${calculation.vatRate}"></label>
      <label class="field">Потолок КИП, % <small class="muted">(физический максимум «под грузом»; КИП в отчётах показывается от него; 0 — сырой КИП)</small>
        <input id="kipCeilingPct" type="number" min="0" max="100" step="1" value="${calculation.kipCeilingPct ?? 67}"></label>
      <label class="field">НДС для ИП<input id="individualEntrepreneurVatRate" type="number" min="0" max="1" step=".01" value="${calculation.individualEntrepreneurVatRate}"></label>
      <label class="field">Запас надёжности обещаний, %<input id="transitReservePct" type="number" min="0" max="50" step="1" value="${calculation.transitReservePct ?? 10}" title="Главный рычаг сроков (22.09): живой транзит (выученная дорожная скорость по дальности плеча + средние ворота) умножается на 1+запас. Рекомендацию из факта (p80) смотрите в «🧠 Живые нормативы» у руководителя; 0 — осознанно без запаса"></label>
      <label class="field">Скорость транзита, км/ч<input id="techSpeedKmh" type="number" min="1" value="${calculation.techSpeedKmh ?? 50}" title="Резервная: работает, только пока живые скорости не выучены (свежая база)"></label>
      <label class="field">Грузовая операция, ч<input id="handlingHoursPerOperation" type="number" min="0" step=".5" value="${calculation.handlingHoursPerOperation ?? 2}" title="Резерв на операцию, пока средние ворота не выучены"></label>
      <label class="field">Коэффициент транзита<input id="transitFactor" type="number" min="1" step=".1" value="${calculation.transitFactor ?? 1.5}" title="Резервный: применяется только в старой формуле (пока скорости не выучены); в живом транзите его сменил «Запас надёжности, %»"></label>
      <label class="field">Целевой стык между рейсами, ч<input id="targetGapHours" type="number" min="1" max="48" step="1" value="${calculation.targetGapHours ?? 8}" title="Рычаг стыковки (24.09): сколько часов допустимо от выгрузки до старта следующего рейса. От цели живут сигналы планированию, строка в Отчёте дня и разбор «кто передержал» в Нормативах недели. 8 ч — стык лучших пар"></label>
      <label class="field">Перегон требует оформления, км<input id="transferGapKm" type="number" min="0" max="2000" step="5" value="${calculation.transferGapKm ?? 100}" title="Инструмент отклонений (04.10): если следующая погрузка дальше этого порога от точки выгрузки, а порожний перегон не оформлен — пара попадает в «Требует решения» с кнопкой «Оформить». 0 — контроль выключен"></label>
      <label class="field">Цель: следующий до выгрузки, %<input id="nextAssignTargetPct" type="number" min="0" max="100" step="1" value="${calculation.nextAssignTargetPct ?? 85}" title="Норматив стыковки (23.09): у какой доли рейсов следующий должен быть назначен ДО фактической выгрузки. Такой стык — 8 ч против 27,6 у назначенных после. Факт — в Отчёте дня и Нормативах недели; планированию приходит «🔎 Освобождаются без груза» за 6–24 ч до выгрузки"></label>
      <label class="field">Цель: ворота выгрузки, ч<input id="gateTargetHours" type="number" min="1" step="1" value="${calculation.gateTargetHours ?? 6}" title="Цель руководителя (22.09): сколько часов машина должна проводить на выгрузке (прибыл → выгружен). Превышение у клиентов со ставкой простоя в карточке — претензия; у остальных — понедельничная аналитика «Дорогие ворота» планированию"></label>
      <label class="field">Простой: бесплатно, ч<input id="demurrageFreeHours" type="number" min="0" step="1" value="${calculation.demurrageFreeHours ?? 8}" title="Общий норматив бесплатного простоя от планового времени операции — применяется, когда в карточке клиента не заданы свои часы"></label>
      <label class="field">Простой: тариф, ₽/ч<input id="demurrageRatePerHour" type="number" min="0" step="50" value="${calculation.demurrageRatePerHour ?? 1000}" title="Ставка за каждый начатый час сверхнормативного простоя — попадает в документ претензии"></label>
      <label class="field">Скидка ГИБДД «горит», дн<input id="gibddWarnDays" type="number" min="0" max="30" step="1" value="${calculation.gibddWarnDays ?? 7}" title="Штрафы (09.11): за сколько дней до конца скидки 50 % неоплаченный штраф подсвечивается «скидка горит» в Затратах"></label>
      <label class="field">Коридор рамок ВГК, км<input id="frameCorridorKm" type="number" min="0" max="200" step="5" value="${calculation.frameCorridorKm ?? 15}" title="Рамки весогабаритного контроля (10.11): если рамка из справочника (выучен из наших штрафов) ближе этого расстояния к прямой маршрута заявки — менеджеру и логисту показывается предупреждение. 0 — предупреждения выключены"></label>
      <label class="field">Радиус платной парковки, м<input id="paidParkRadiusM" type="number" min="0" max="3000" step="50" value="${calculation.paidParkRadiusM ?? 400}" title="Платные парковки (10.11): точки выучены из парковочных штрафов. Адрес заявки или стоянка борта ближе этого радиуса — предупреждение в форме заявки, уведомление диспетчеру при выезде рейса и по факту стоянки (запустить сессию в ЛК Моспаркинга). 0 — контроль выключен"></label>
    </div>`, { hint: 'цели руководителя и резервные формулы; живые нормативы — у руководителя' }),
    biSec('Причины отклонения', `
      <label class="field">По одной причине в строке<textarea id="rejectionReasons">${escapeHtml(rejectionReasons.join('\n'))}</textarea></label>`,
      { span: 's4' }),
    biSec('Параметры заявок', `<div class="fields three">
      <label class="field">Температурные режимы, по одному в строке<textarea id="temperatureModes">${escapeHtml(orderOptions.temperatureModes.join('\n'))}</textarea></label>
      <label class="field">Типы кузова, по одному в строке<textarea id="bodyTypes">${escapeHtml(orderOptions.bodyTypes.join('\n'))}</textarea></label>
      <label class="field">Этапы заявки, по одному в строке<textarea id="orderStages">${escapeHtml(orderOptions.stages.join('\n'))}</textarea></label>
    </div>`, { span: 's8' })
  ]);
  byId('saveGeneral').onclick = saveGeneral;
}

async function saveGeneral() {
  const numeric = id => Number(byId(id).value);
  const payload = {
    general: {
      companyName: byId('companyName').value.trim(), appName: byId('appName').value.trim(),
      timezone: byId('timezone').value.trim(), horizonStart: byId('horizonStart').value,
      horizonMonths: numeric('horizonMonths'), plannerCellWidth: numeric('plannerCellWidth')
    },
    calculation: {
      costPerKm: numeric('costPerKm'), vatRate: numeric('vatRate'),
      kipCeilingPct: numeric('kipCeilingPct'),
      ktgTargetPct: numeric('ktgTargetPct'), kvlTargetPct: numeric('kvlTargetPct'),
      kipTargetPct: numeric('kipTargetPct'),
      goalRevenueMln: numeric('goalRevenueMln'), fleetTarget: numeric('fleetTarget'),
      kpiOwnSharePct: numeric('kpiOwnSharePct'), signalTargetHours: numeric('signalTargetHours'),
      gateLongHours: numeric('gateLongHours'), docsWarnDays: numeric('docsWarnDays'),
      planHorizonDays: numeric('planHorizonDays'), driverRatePerKm: numeric('driverRatePerKm'),
      driverGuaranteePerDay: numeric('driverGuaranteePerDay'),
      driverOvertimePerDay: byId('driverOvertimePerDay').value === '' ? '' : numeric('driverOvertimePerDay'),
      crmReceivablesOn: byId('crmReceivablesOn').checked,
      fotNormPct: byId('fotNormPct').value === '' ? '' : numeric('fotNormPct'),
      dailyKmTarget: numeric('dailyKmTarget'),
      insuranceAndRoadsPerKm: numeric('insuranceAndRoadsPerKm'),
      driverPerTripDay: numeric('driverPerTripDay'),
      refrigerationPerTripDay: numeric('refrigerationPerTripDay'),
      leasePerVehicleDay: numeric('leasePerVehicleDay'),
      overheadPerVehicleDay: numeric('overheadPerVehicleDay'),
      individualEntrepreneurVatRate: numeric('individualEntrepreneurVatRate'),
      techSpeedKmh: numeric('techSpeedKmh'),
      transitReservePct: numeric('transitReservePct'),
      handlingHoursPerOperation: numeric('handlingHoursPerOperation'),
      transitFactor: numeric('transitFactor'),
      demurrageFreeHours: numeric('demurrageFreeHours'),
      demurrageRatePerHour: numeric('demurrageRatePerHour'),
      gateTargetHours: numeric('gateTargetHours'),
      nextAssignTargetPct: numeric('nextAssignTargetPct'),
      targetGapHours: numeric('targetGapHours'),
      transferGapKm: numeric('transferGapKm'),
      gibddWarnDays: numeric('gibddWarnDays'),
      frameCorridorKm: numeric('frameCorridorKm'),
      paidParkRadiusM: numeric('paidParkRadiusM')
    },
    orderOptions: {
      temperatureModes: byId('temperatureModes').value.split('\n').map(item => item.trim()).filter(Boolean),
      bodyTypes: byId('bodyTypes').value.split('\n').map(item => item.trim()).filter(Boolean),
      stages: byId('orderStages').value.split('\n').map(item => item.trim()).filter(Boolean)
    },
    statuses: [...document.querySelectorAll('[data-status]')].map(row => [
      row.dataset.status, row.querySelector('[data-status-name]').value.trim(),
      row.querySelector('[data-status-color]').value
    ]),
    rejectionReasons: byId('rejectionReasons').value.split('\n').map(item => item.trim()).filter(Boolean),
    // Текучесть водителей (поле Эксплуатации): пусто — не задано, ноль — осознанно.
    turnover: {
      ...(state.admin.settings.turnover || {}),
      accountingFrom: byId('turnoverFrom').value || null,
      targetPct: byId('turnoverTarget').value === '' ? null : Number(byId('turnoverTarget').value),
      shortTenureDays: byId('turnoverShort').value === '' ? null : Number(byId('turnoverShort').value)
    }
  };
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    Object.assign(state.admin.settings, payload);
    toast('Настройки сохранены');
  } catch (error) { toast(error.message, 'error'); }
}

function renderNetwork() {
  const allowedSubnets = state.admin.settings.networkAccess?.allowedSubnets || [];
  content.innerHTML = biPage(biHead('Сеть и доступ',
    'Подсети, из которых разрешено открывать планер и страницу входа.',
    '<button class="button" id="saveNetwork">Сохранить</button>'), [
    biSec('Разрешённые подсети', `
      <label class="field">По одной IPv4- или IPv6-подсети в строке
        <textarea id="allowedSubnets" rows="9" spellcheck="false"
          placeholder="192.168.10.0/24&#10;10.20.0.0/16">${escapeHtml(allowedSubnets.join('\n'))}</textarea>
      </label>
      <p class="muted">Текущий адрес: <span class="mono">${escapeHtml(state.admin.network?.currentIp || 'не определён')}</span>.
        Он должен входить хотя бы в одну сохраняемую подсеть — защита от случайной потери доступа.</p>
      <p class="muted">Изменение применяется сразу ко всему веб-интерфейсу и API. Ограничение SSH на VPS управляется отдельно системным firewall.</p>`,
      { span: 's7' }),
    biSec('Примеры CIDR', `
      <div class="code">192.168.10.0/24 — адреса 192.168.10.1–192.168.10.254<br>
10.20.0.15/32 — только один компьютер<br>
2001:db8:1234::/64 — IPv6-подсеть</div>`, { span: 's5' })
  ]);
  byId('saveNetwork').onclick = saveNetwork;
}

async function saveNetwork() {
  const allowedSubnets = byId('allowedSubnets').value.split('\n')
    .map(item => item.trim()).filter(Boolean);
  try {
    await api('/api/admin/settings', {
      method: 'PUT', body: JSON.stringify({ networkAccess: { allowedSubnets } })
    });
    state.admin.settings.networkAccess = { allowedSubnets };
    toast('Сетевой доступ обновлён');
    await loadAdmin();
    renderNetwork();
  } catch (error) { toast(error.message, 'error'); }
}

function renderDictionaries() {
  const { zones, vehicleTypes, routeRates } = state.admin.reference;
  content.innerHTML = biPage(biHead('Справочники',
    'Зоны, типы ТС и нормативные маршруты, перенесенные из прототипа.',
    '<button class="button" id="saveDictionaries">Сохранить</button>'), [
    biSec('Геозоны', `<div class="table-wrap bi-scroll"><table class="bi-table"><thead><tr><th>Порядок</th><th>Зона</th><th>Цвет</th><th>Координаты</th><th>Города и регионы</th><th>ID 1С</th></tr></thead>
      <tbody>${zones.map(zone => `<tr data-zone="${zone.id}"><td>${zone.sort_order + 1}</td><td><input data-zone-name value="${escapeHtml(zone.name)}"></td>
      <td><input data-zone-color type="color" value="${escapeHtml(zone.color)}"></td>
      <td><div class="actions"><input data-zone-lat type="number" step=".01" value="${zone.latitude ?? ''}" placeholder="широта">
      <input data-zone-lon type="number" step=".01" value="${zone.longitude ?? ''}" placeholder="долгота"></div></td>
      <td><textarea data-zone-aliases rows="2">${escapeHtml((zone.aliases || []).join('\n'))}</textarea></td>
      <td class="mono muted">${escapeHtml(zone.external_id || 'не связан')}</td></tr>`).join('')}</tbody></table></div>`,
      { flush: true, hint: `${zones.length} зон` }),
    biSec('Типы транспортных средств', `<div class="actions">
      ${vehicleTypes.map(type => `<label class="field" data-type="${type.id}"><input data-type-name value="${escapeHtml(type.name)}"></label>`).join('')}</div>`,
      { span: 's5', hint: `${vehicleTypes.length} типов` }),
    biSec('Расстояния и ставки по умолчанию', `
      <div class="table-wrap bi-scroll"><table class="bi-table"><thead><tr><th>Откуда</th><th>Куда</th><th>Км</th><th>Ставка с НДС</th></tr></thead>
      <tbody>${routeRates.map(rate => `<tr data-rate="${rate.id}"><td>${escapeHtml(rate.from_name)}</td><td>${escapeHtml(rate.to_name)}</td>
      <td><input data-rate-km type="number" min="0" value="${rate.distance_km}"></td>
      <td><input data-rate-value type="number" min="0" value="${rate.default_rate_vat}"></td></tr>`).join('')}</tbody></table></div>`,
      { span: 's7', flush: true, hint: `${routeRates.length} маршрутов` })
  ]);
  byId('saveDictionaries').onclick = saveDictionaries;
}

function renderFleet() {
  const vehicles = state.admin.vehicles;
  content.innerHTML = biPage(biHead('Состав транспортных средств',
    'Сцепки, водители, текущая зона и доступность.',
    '<button class="button" id="newVehicle">+ Добавить ТС</button>'), [
    biSec('Сцепки', `<div class="table-wrap bi-scroll"><table class="bi-table"><thead><tr><th>Тягач</th><th>Прицеп</th><th>Тип</th><th>Водитель</th><th>Зона</th><th>Статус</th><th></th></tr></thead>
      <tbody>${vehicles.map(vehicle => `<tr><td class="mono"><strong>${escapeHtml(vehicle.plate)}</strong></td>
        <td class="mono">${escapeHtml(vehicle.trailer_plate || '—')}</td><td>${escapeHtml(vehicle.type_name)}</td>
        <td>${escapeHtml(vehicle.driver_name || '—')}</td><td>${escapeHtml(vehicle.zone_name || '—')}</td>
        <td>${statusBadge(vehicle.status)}${vehicle.status === 'out' && vehicle.out_since
          ? ` <span class="hint" title="дата вывода из эксплуатации">с ${vehicle.out_since.slice(8, 10)}.${vehicle.out_since.slice(5, 7)}.${vehicle.out_since.slice(0, 4)}</span>` : ''}</td>
        <td><button class="button ghost small" data-edit-vehicle="${vehicle.id}">Изменить</button></td>
      </tr>`).join('')}</tbody></table></div>`,
      { flush: true, hint: `${vehicles.length} ТС · в работе ${vehicles.filter(vehicle => vehicle.status === 'work').length}` }),
    biSec('Прицепы', '<div class="table-wrap bi-scroll" id="trailerRegistry">Загрузка…</div>', { flush: true,
      hint: 'реестр: тип, на каком тягаче, вывод из эксплуатации. Двигать прицепы — только перецепкой в «Ресурсе»' })
  ]);
  byId('newVehicle').onclick = () => editVehicle();
  document.querySelectorAll('[data-edit-vehicle]').forEach(button =>
    button.onclick = () => editVehicle(vehicles.find(vehicle => vehicle.id === button.dataset.editVehicle)));
  renderTrailerRegistry();
}

async function renderTrailerRegistry() {
  const box = byId('trailerRegistry');
  if (!box) return;
  try {
    const data = await api('/api/trailers-registry');
    const rows = data.trailers || [];
    box.innerHTML = `<table class="bi-table"><thead><tr><th>Прицеп</th><th>Модель</th><th>Тип</th><th>Где</th><th>Статус</th><th></th></tr></thead>
      <tbody>${rows.map(item => `<tr>
        <td class="mono"><strong>${escapeHtml(item.plate)}</strong></td>
        <td><input data-trailer-model="${escapeHtml(item.plate)}" value="${escapeHtml(item.model || '')}"
          placeholder="SKO24" style="width:150px" title="Модель живёт на прицепе: при перецепке уедет вместе с ним"></td>
        <td><select data-trailer-type="${escapeHtml(item.plate)}" title="Тип кузова живёт на прицепе: смена сразу выравнивает сцепку-держателя">
          <option value="">—</option>
          ${state.admin.reference.vehicleTypes.map(type =>
            `<option value="${type.id}" ${item.type_name === type.name ? 'selected' : ''}>${escapeHtml(type.name)}</option>`).join('')}
        </select></td>
        <td>${item.holder_plate ? 'на ' + escapeHtml(item.holder_plate) : '<span class="hint">свободен</span>'}</td>
        <td>${item.out_since
          ? `<span class="badge bad">Выведен</span> <span class="hint">с ${item.out_since.slice(8, 10)}.${item.out_since.slice(5, 7)}.${item.out_since.slice(0, 4)}</span>`
          : '<span class="badge ok">В работе</span>'}</td>
        <td>${item.out_since
          ? `<button class="button ghost small" data-trailer-return="${escapeHtml(item.plate)}">Вернуть в работу</button>`
          : `<button class="button ghost small" data-trailer-out="${escapeHtml(item.plate)}"
               ${item.holder_plate ? `title="прицеп висит на ${escapeHtml(item.holder_plate)} — сначала отцепите перецепкой" disabled` : 'title="продажа или списание — с датой, можно задним числом"'}>Вывести</button>`}</td>
      </tr>`).join('')}</tbody></table>`;
    box.querySelectorAll('[data-trailer-model]').forEach(input => input.onchange = async () => {
      try {
        await api(`/api/trailers/${encodeURIComponent(input.dataset.trailerModel)}`, {
          method: 'PATCH', body: JSON.stringify({ model: input.value.trim() })
        });
        toast('Модель прицепа сохранена');
      } catch (error) { toast(error.message, 'error'); renderTrailerRegistry(); }
    });
    box.querySelectorAll('[data-trailer-type]').forEach(select => select.onchange = async () => {
      if (!select.value) { renderTrailerRegistry(); return; }
      try {
        await api(`/api/trailers/${encodeURIComponent(select.dataset.trailerType)}`, {
          method: 'PATCH', body: JSON.stringify({ typeId: select.value })
        });
        toast('Тип прицепа сохранён — сцепка выровнена'); renderTrailerRegistry();
      } catch (error) { toast(error.message, 'error'); renderTrailerRegistry(); }
    });
    box.querySelectorAll('[data-trailer-out]').forEach(button => button.onclick = async () => {
      const date = prompt(`Дата вывода прицепа ${button.dataset.trailerOut} (ГГГГ-ММ-ДД, пусто — сегодня)`,
        new Date().toISOString().slice(0, 10));
      if (date === null) return;
      try {
        await api(`/api/trailers/${encodeURIComponent(button.dataset.trailerOut)}`, {
          method: 'PATCH', body: JSON.stringify({ outSince: date || new Date().toISOString().slice(0, 10) })
        });
        toast('Прицеп выведен из эксплуатации'); renderTrailerRegistry();
      } catch (error) { toast(error.message, 'error'); }
    });
    box.querySelectorAll('[data-trailer-return]').forEach(button => button.onclick = async () => {
      try {
        await api(`/api/trailers/${encodeURIComponent(button.dataset.trailerReturn)}`, {
          method: 'PATCH', body: JSON.stringify({ outSince: null })
        });
        toast('Прицеп возвращён в работу'); renderTrailerRegistry();
      } catch (error) { toast(error.message, 'error'); }
    });
  } catch (error) {
    box.innerHTML = `<p class="hint">Реестр прицепов не загрузился: ${escapeHtml(error.message)}</p>`;
  }
}

function editVehicle(vehicle = null) {
  const types = state.admin.reference.vehicleTypes.map(type =>
    `<option value="${type.id}" ${vehicle?.type_id === type.id ? 'selected' : ''}>${escapeHtml(type.name)}</option>`).join('');
  const zones = state.admin.reference.zones.map(zone =>
    `<option value="${zone.id}" ${vehicle?.zone_id === zone.id ? 'selected' : ''}>${escapeHtml(zone.name)}</option>`).join('');
  const statuses = [['work', 'В работе'], ['no_driver', 'Без водителя'], ['repair', 'В ремонте'], ['out', 'Выведен']];
  showModal(`<form id="vehicleForm"><h2>${vehicle ? 'Редактирование ТС' : 'Новое ТС'}</h2>
    <div class="fields">
      <label class="field">Госномер<input name="plate" value="${escapeHtml(vehicle?.plate || '')}" required></label>
      <label class="field">Модель тягача<input name="model" value="${escapeHtml(vehicle?.model || '')}" placeholder="DAF FT XF 105 460"></label>
      <label class="field">Прицеп<input name="trailerPlate" value="${escapeHtml(vehicle?.trailer_plate || '')}"></label>
      <label class="field">Модель прицепа<input name="trailerModel" value="${escapeHtml(vehicle?.trailer_model || '')}" placeholder="SKO24"></label>
      <label class="field">Тип<select name="typeId">${types}</select></label>
      <label class="field">Водитель<input name="driverName" value="${escapeHtml(vehicle?.driver_name || '')}"></label>
      <label class="field">Зона<select name="zoneId">${zones}</select></label>
      <label class="field">Статус<select name="status">${statuses.map(([id, label]) =>
        `<option value="${id}" ${vehicle?.status === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    <div class="form-grid">
      <label class="field">Недоступно с<input name="unavailableFrom" type="date" value="${vehicle?.unavailable_from || ''}"></label>
      <label class="field">Недоступно до<input name="unavailableTo" type="date" value="${vehicle?.unavailable_to || ''}"></label>
      <label class="field" title="учитывается при статусе «Выведен»: продажа или списание, можно задним числом; пусто — сегодня. График и процессы закрываются с этой даты, история остаётся">
        Выведен с<input name="outSince" type="date" value="${vehicle?.out_since || ''}"></label>
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button></div></form>`);
  byId('vehicleForm').onsubmit = async event => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(vehicle ? `/api/vehicles/${vehicle.id}` : '/api/vehicles', {
        method: vehicle ? 'PATCH' : 'POST', body: JSON.stringify(payload)
      });
      closeModal(); toast(vehicle ? 'ТС обновлено' : 'ТС добавлено');
      await loadAdmin(); renderFleet();
    } catch (error) { toast(error.message, 'error'); }
  };
}

function renderCustomers() {
  const customers = state.admin.customers || [];
  content.innerHTML = biPage(biHead('Заказчики',
    'Маршруты, средняя ставка и плановая частота перевозок.',
    '<button class="button" id="newCustomer">+ Добавить</button>'), [
    biSec('Справочник заказчиков', `<div class="table-wrap bi-scroll"><table class="bi-table">
      <thead><tr><th>Заказчик</th><th>Маршрут</th><th class="r">Рейсов</th><th class="r">Средняя ставка</th><th class="r">Рейсов/мес.</th><th></th></tr></thead>
      <tbody>${customers.map(item => `<tr>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td>${escapeHtml(item.from_name || '—')} → ${escapeHtml(item.to_name || '—')}</td>
        <td class="num">${item.trip_count}</td><td class="num">${Number(item.average_rate_vat).toLocaleString('ru-RU')} ₽</td>
        <td class="num">${item.trips_per_month}</td>
        <td><button class="button ghost small" data-edit-customer="${item.id}">Изменить</button></td>
      </tr>`).join('')}</tbody></table></div>`, { flush: true, hint: `${customers.length} заказчиков` })
  ]);
  byId('newCustomer').onclick = () => editCustomer();
  document.querySelectorAll('[data-edit-customer]').forEach(button =>
    button.onclick = () => editCustomer(customers.find(item => item.id === button.dataset.editCustomer)));
}

function editCustomer(customer = null) {
  const zoneOptions = selected => state.admin.reference.zones.map(zone =>
    `<option value="${zone.id}" ${selected === zone.id ? 'selected' : ''}>${escapeHtml(zone.name)}</option>`).join('');
  showModal(`<form id="customerForm"><h2>${customer ? 'Редактирование заказчика' : 'Новый заказчик'}</h2>
    <label class="field">Название<input name="name" value="${escapeHtml(customer?.name || '')}" required></label>
    <div class="form-grid">
      <label class="field">Откуда<select name="fromZoneId">${zoneOptions(customer?.from_zone_id)}</select></label>
      <label class="field">Куда<select name="toZoneId">${zoneOptions(customer?.to_zone_id)}</select></label>
    </div>
    <div class="fields three">
      <label class="field">Рейсов<input name="tripCount" type="number" min="0" value="${customer?.trip_count || 0}"></label>
      <label class="field">Средняя ставка<input name="averageRateVat" type="number" min="0" value="${customer?.average_rate_vat || 0}"></label>
      <label class="field">Рейсов в месяц<input name="tripsPerMonth" type="number" min="0" step=".1" value="${customer?.trips_per_month || 0}"></label>
    </div>
    <div class="modal-actions">
      ${customer ? '<button type="button" class="button danger" id="deleteCustomer">Удалить</button>' : ''}
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button>
    </div></form>`);
  byId('customerForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api(customer ? `/api/customers/${customer.id}` : '/api/customers', {
        method: customer ? 'PATCH' : 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
      });
      closeModal(); toast('Заказчик сохранен'); await loadAdmin(); renderCustomers();
    } catch (error) { toast(error.message, 'error'); }
  };
  if (customer) byId('deleteCustomer').onclick = async () => {
    if (!confirm('Удалить заказчика?')) return;
    try {
      await api(`/api/customers/${customer.id}`, { method: 'DELETE' });
      closeModal(); toast('Заказчик удален'); await loadAdmin(); renderCustomers();
    } catch (error) { toast(error.message, 'error'); }
  };
}

async function saveDictionaries() {
  const payload = {
    zones: [...document.querySelectorAll('[data-zone]')].map(row => ({
      id: row.dataset.zone, name: row.querySelector('[data-zone-name]').value,
      color: row.querySelector('[data-zone-color]').value,
      latitude: row.querySelector('[data-zone-lat]').value,
      longitude: row.querySelector('[data-zone-lon]').value,
      aliases: row.querySelector('[data-zone-aliases]').value.split('\n').map(item => item.trim()).filter(Boolean)
    })),
    vehicleTypes: [...document.querySelectorAll('[data-type]')].map(row => ({
      id: row.dataset.type, name: row.querySelector('[data-type-name]').value
    })),
    routeRates: [...document.querySelectorAll('[data-rate]')].map(row => ({
      id: row.dataset.rate, distanceKm: Number(row.querySelector('[data-rate-km]').value),
      defaultRateVat: Number(row.querySelector('[data-rate-value]').value)
    }))
  };
  try {
    await api('/api/admin/reference', { method: 'PUT', body: JSON.stringify(payload) });
    toast('Справочники сохранены');
    await loadAdmin();
    renderDictionaries();
  } catch (error) { toast(error.message, 'error'); }
}

async function ensureUsers() {
  if (!state.users) state.users = await api('/api/admin/users');
}

async function renderUsers() {
  await ensureUsers();
  if (!state.admin) await loadAdmin();
  content.innerHTML = biPage(biHead('Пользователи',
    'Создание учетных записей, изменение ролей и блокировка доступа.',
    '<button class="button" id="newUser">+ Создать</button>'), [
    biSec('Учётные записи', `<div class="table-wrap bi-scroll"><table class="bi-table">
      <thead><tr><th>Пользователь</th><th>Логин</th><th>Роли</th><th>Состояние</th><th>Создан</th><th></th></tr></thead>
      <tbody>${state.users.items.map(user => `<tr>
        <td><strong>${escapeHtml(user.full_name)}</strong><br><small class="muted">${escapeHtml(user.email || '')}</small></td>
        <td class="mono">${escapeHtml(user.username)}</td>
        <td>${(user.roles || [user.role]).map(role => `<span class="badge">${escapeHtml(roleLabel(role))}</span>`).join(' ')}</td>
        <td>${user.active ? '<span class="badge ok">активен</span>' : '<span class="badge bad">отключен</span>'}
          ${user.guest ? ' <span class="badge warn" title="Гостевой режим: только просмотр, без прав редактирования">👁 гость</span>' : ''}</td>
        <td>${formatDate(user.created_at, { day: '2-digit', month: '2-digit', year: 'numeric' })}</td>
        <td style="white-space:nowrap"><button class="button ghost small" data-edit-user="${user.id}">Изменить</button>
          <button class="button ghost small danger" data-delete-user="${user.id}"
            title="Удалить пользователя: учётка без истории удаляется совсем, с историей — скрывается с сохранением всех записей и отчётов">✕</button></td>
      </tr>`).join('')}</tbody></table></div>`, { flush: true,
      hint: `${state.users.items.length} · активных ${state.users.items.filter(user => user.active).length}` }),
    biSec('Справочник «Сотрудники»', `
    <p class="muted">Карточки, приём/увольнение и графики смен живут во вкладке
      «Сотрудники» планера. Здесь — кто имеет к ней полный доступ помимо
      руководителя и администратора, и часы смен для графиков.</p>
    <form id="staffSettingsForm" class="fields">
      <label class="field">Полный доступ к справочнику (логины через запятую)
        <input name="fullAccess" value="${escapeHtml(state.admin?.settings?.staff?.fullAccess || '')}"
          placeholder="например: nikulina"></label>
      <label class="field">Доступ к учёту затрат «💸 Затраты» (логины через запятую; админ видит всегда)
        <input name="expensesAccess" value="${escapeHtml(state.admin?.settings?.expenses?.access || '')}"
          placeholder="пусто = только администратор"></label>
      <div class="form-grid">
        <label class="field">Дневная смена<input name="dayHours"
          value="${escapeHtml(state.admin?.settings?.staff?.dayHours || '08:00–20:00')}"></label>
        <label class="field">Ночная смена<input name="nightHours"
          value="${escapeHtml(state.admin?.settings?.staff?.nightHours || '20:00–08:00')}"></label>
      </div>
      <button class="button">Сохранить</button>
    </form>`)
  ]);
  byId('staffSettingsForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
        staff: {
          fullAccess: form.elements.fullAccess.value.trim(),
          dayHours: form.elements.dayHours.value.trim(),
          nightHours: form.elements.nightHours.value.trim()
        },
        expenses: { access: form.elements.expensesAccess.value.trim() }
      }) });
      toast('Настройки справочника сохранены');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('newUser').onclick = () => editUser();
  document.querySelectorAll('[data-edit-user]').forEach(button =>
    button.onclick = () => editUser(state.users.items.find(user => user.id === button.dataset.editUser)));
  document.querySelectorAll('[data-delete-user]').forEach(button =>
    button.onclick = async () => {
      const user = state.users.items.find(item => item.id === button.dataset.deleteUser);
      if (!user) return;
      if (!confirm(`Удалить пользователя «${user.full_name}» (${user.username})?\n\n` +
        'Доступ закроется сразу. Если по сотруднику есть история действий, ' +
        'она сохранится в журнале и отчётах, а учётка скроется из списка.')) return;
      try {
        const result = await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
        state.users = null;
        toast(result.mode === 'hard' ? 'Пользователь удалён'
          : 'Пользователь удалён; история действий сохранена');
        await renderUsers();
      } catch (error) { toast(error.message, 'error'); }
    });
}

function editUser(user = null) {
  // Мульти-роли: чекбоксы вместо select — пользователю можно назначить несколько ролей.
  const userRoles = user ? (user.roles || [user.role]) : ['logist'];
  const roleChecks = Object.entries(state.users.roles).map(([id, label]) =>
    `<label class="check"><input type="checkbox" name="roles" value="${id}" ${userRoles.includes(id) ? 'checked' : ''}>
     ${escapeHtml(label)}</label>`).join('');
  showModal(`<form id="userForm"><h2>${user ? 'Редактирование пользователя' : 'Новый пользователь'}</h2>
    <div class="fields">
      <label class="field">ФИО<input name="fullName" value="${escapeHtml(user?.full_name || '')}" required></label>
      <label class="field">Логин<input name="username" value="${escapeHtml(user?.username || '')}" required></label>
      <label class="field">Email<input name="email" type="email" value="${escapeHtml(user?.email || '')}"></label>
      <label class="field" title="По телефону определяется входящий звонок, и его же диспетчер называет водителю">
        Телефон<input name="phone" value="${escapeHtml(user?.phone || '')}" placeholder="+7 987 510-59-21"></label>
    </div>
    <fieldset class="roles-set"><legend>Роли (можно несколько — права объединяются)</legend>${roleChecks}</fieldset>
    <label class="field">${user ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Временный пароль'}
      <input name="password" type="password" minlength="10" ${user ? '' : 'required'} autocomplete="new-password">
    </label>
    <label class="check"><input name="active" type="checkbox" ${user?.active === 0 ? '' : 'checked'}> Доступ разрешен</label>
    <label class="check" title="Видит все свои вкладки и данные, но ничего не может изменить: кнопки действий скрыты, сервер отклоняет запись">
      <input name="guest" type="checkbox" ${user?.guest ? 'checked' : ''}> 👁 Гостевой режим — только просмотр, без прав редактирования</label>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button></div>
  </form>`);
  byId('userForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    values.roles = [...form.querySelectorAll('input[name="roles"]:checked')].map(input => input.value);
    if (!values.roles.length) { toast('Выберите хотя бы одну роль', 'error'); return; }
    values.active = form.elements.active.checked;
    values.guest = form.elements.guest.checked;
    if (!values.password) delete values.password;
    const phone = String(values.phone || '').trim();
    delete values.phone;
    try {
      const saved = await api(user ? `/api/admin/users/${user.id}` : '/api/admin/users', {
        method: user ? 'PATCH' : 'POST', body: JSON.stringify(values)
      });
      // Телефон правится отдельным эндпоинтом — он же нормализует формат.
      const userId = user?.id || saved?.id;
      if (userId && phone !== String(user?.phone || '')) {
        await api(`/api/admin/users/${userId}/phone`, {
          method: 'PATCH', body: JSON.stringify({ phone })
        }).catch(error => toast(`Телефон не сохранён: ${error.message}`, 'error'));
      }
      state.users = null;
      closeModal();
      toast(user ? 'Пользователь обновлен' : 'Пользователь создан');
      await renderUsers();
    } catch (error) { toast(error.message, 'error'); }
  };
}

function mappingData(mapping) {
  try { return JSON.parse(mapping.field_map_json); } catch { return {}; }
}

function renderIntegration() {
  const cfg = state.admin.integration;
  const mappings = state.admin.mappings;
  content.innerHTML = biPage(biHead('Интеграция с 1С',
    'Загрузка по OData и управляемая обратная запись через очередь.',
    '<button class="button" id="saveIntegration">Сохранить</button>'), [
    biSec('Подключение OData', `
      <div class="fields">
        <label class="field">URL публикации OData<input id="baseUrl" type="url" placeholder="https://1c.example.ru/base/odata/standard.odata" value="${escapeHtml(cfg.baseUrl)}"></label>
        <label class="field">Пользователь 1С<input id="odataUsername" value="${escapeHtml(cfg.username)}" autocomplete="off"></label>
        <label class="field">Пароль ${cfg.hasPassword ? '(сохранен)' : ''}<input id="odataPassword" type="password" placeholder="${cfg.hasPassword ? 'оставьте пустым, чтобы не менять' : ''}" autocomplete="new-password"></label>
        <label class="field">Интервал загрузки, минут<input id="pullIntervalMin" type="number" min="5" value="${cfg.pullIntervalMin}"></label>
      </div>
      <label class="check"><input id="integrationEnabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}> Включить фоновую загрузку</label>
      <div class="actions"><button class="button ghost" id="testIntegration" type="button">Проверить подключение</button>
        <button class="button secondary" id="runSync" type="button">Загрузить сейчас</button>
        <span class="muted">Последняя успешная: ${cfg.lastSuccessAt ? formatDate(cfg.lastSuccessAt, { dateStyle: 'short', timeStyle: 'short' }) : 'еще не выполнялась'}</span></div>`,
      { span: 's6' }),
    biSec('Телематика / мониторинг', `
      <div class="fields">
        <label class="field">URL API<input id="telematicsUrl" type="url" value="${escapeHtml(cfg.telematics?.baseUrl || '')}"></label>
        <label class="field">Токен ${cfg.telematics?.hasToken ? '(сохранен)' : ''}<input id="telematicsToken" type="password"
          placeholder="${cfg.telematics?.hasToken ? 'оставьте пустым, чтобы не менять' : ''}" autocomplete="new-password"></label>
      </div>
      <label class="check"><input id="telematicsEnabled" type="checkbox" ${cfg.telematics?.enabled ? 'checked' : ''}> Включить коннектор</label>
      <p class="muted">Контракт входных данных: rideId, km, status, unloadedAt. Фактический пробег сохраняется отдельно и участвует в рейсе.</p>`,
      { span: 's6' }),
    biSec('Дорожная сеть (Dornet) — затраты', `
      <div class="fields">
        <label class="field">Токен API ${cfg.dornet?.hasToken ? '(сохранен)' : ''}<input id="dornetToken" type="password"
          placeholder="${cfg.dornet?.hasToken ? 'оставьте пустым, чтобы не менять' : 'из окна «Для разработчиков»'}" autocomplete="new-password"></label>
        <label class="field">CID (ID юрлица)<input id="dornetCid" type="number" min="1" value="${cfg.dornet?.cid || ''}"></label>
      </div>
      <label class="check"><input id="dornetEnabled" type="checkbox" ${cfg.dornet?.enabled ? 'checked' : ''}> Включить коннектор</label>
      <p class="muted">Заказы по видам услуг (стоянки, мойки, шиномонтаж, СТО…) и оплаченные штрафы
        сами ложатся в журнал «💸 Затраты» каждые 6 часов (окно — неделя назад, дубли невозможны).
        ${cfg.dornet?.lastSuccessAt ? `Последняя синхронизация: ${formatDate(cfg.dornet.lastSuccessAt, { dateStyle: 'short', timeStyle: 'short' })}${cfg.dornet?.last?.added != null ? ` (+${cfg.dornet.last.added})` : ''}.` : 'Синхронизаций ещё не было.'}</p>
      <div class="actions">
        <label class="field">с <input id="dornetFrom" type="date"></label>
        <label class="field">по <input id="dornetTo" type="date"></label>
        <button class="button secondary" id="dornetSync" type="button">Загрузить период</button>
        <span class="muted">Бэкафилл истории: введите токен и CID, выберите период (до года) и жмите — кнопка сохранит настройки сама.</span>
      </div>`, { span: 's6' }),
    biSec('OnlineГИБДД — штрафы', `
      <div class="fields">
        <label class="field">Ключ API ${cfg.onlinegibdd?.hasToken ? '(сохранен)' : ''}<input id="gibddToken" type="password"
          placeholder="${cfg.onlinegibdd?.hasToken ? 'оставьте пустым, чтобы не менять' : 'личный кабинет → «API документация»'}" autocomplete="new-password"></label>
      </div>
      <label class="check"><input id="gibddEnabled" type="checkbox" ${cfg.onlinegibdd?.enabled ? 'checked' : ''}> Включить коннектор</label>
      <p class="muted">СТС машин сами подтягиваются из личного кабинета сервиса в «Паспорт ТС»
        (по совпадению госномера), штрафы с виновником по закреплению едут на экран
        «Безопасность движения» трижды в сутки. В «💸 Затраты» этот коннектор не пишет —
        оплаченные штрафы кладёт Dornet.
        ${cfg.onlinegibdd?.last ? `Последняя синхронизация ${formatDate(cfg.onlinegibdd.last.at, { dateStyle: 'short', timeStyle: 'short' })}: +${cfg.onlinegibdd.last.added} / обновлено ${cfg.onlinegibdd.last.updated}, машин добавлено ${cfg.onlinegibdd.last.autosAdded}, СТС импортировано ${cfg.onlinegibdd.last.stsImported ?? 0}${cfg.onlinegibdd.last.noSts ? ` · без СТС ${cfg.onlinegibdd.last.noSts}` : ''}${cfg.onlinegibdd.last.errors?.length ? ` · ошибка: ${escapeHtml(String(cfg.onlinegibdd.last.errors[0]).slice(0, 120))}` : ''}.` : 'Синхронизаций ещё не было.'}</p>
      <div class="actions">
        <button class="button secondary" id="gibddSync" type="button">Синхронизировать сейчас</button>
        <span class="muted">Кнопка сохранит ключ сама; машины, не найденные в сервисе, видны на экране БДД.</span>
      </div>`, { span: 's6' }),
    biSec('РН-Карт (Роснефть) — топливо', `
      <div class="fields">
        <label class="field">Логин ЛК (лучше отдельная учётка для API)
          <input id="rncardLogin" value="${escapeHtml(cfg.rncard?.login || '')}" autocomplete="off"></label>
        <label class="field">Пароль ${cfg.rncard?.hasPassword ? '(сохранен)' : ''}<input id="rncardPassword" type="password"
          placeholder="${cfg.rncard?.hasPassword ? 'оставьте пустым, чтобы не менять' : ''}" autocomplete="new-password"></label>
        <label class="field">Коды договоров (ISS…, из ЛК «Дополнительная информация»; несколько — через запятую)
          <input id="rncardContract" value="${escapeHtml(cfg.rncard?.contract || '')}" autocomplete="off"
            placeholder="например: ISS12345, ISS67890"></label>
      </div>
      <label class="check"><input id="rncardEnabled" type="checkbox" ${cfg.rncard?.enabled ? 'checked' : ''}> Включить коннектор</label>
      <p class="muted">Заправки и услуги АЗС сами ложатся в «💸 Затраты» каждые 6 часов с
        литрами в заметке и привязкой к бортам (ТС карты из ЛК, иначе — примечание карты).
        Если в ЛК включён белый список IP — добавьте туда адрес сервера планера.
        ${cfg.rncard?.last ? `Последняя синхронизация ${formatDate(cfg.rncard.last.at, { dateStyle: 'short', timeStyle: 'short' })}: +${cfg.rncard.last.added}${cfg.rncard.last.skippedForeign ? ` · отсеяно чужих ${cfg.rncard.last.skippedForeign}` : ''}${cfg.rncard.last.errors?.length ? ` · ошибка: ${escapeHtml(String(cfg.rncard.last.errors[0]).slice(0, 120))}` : ''}.` : 'Синхронизаций ещё не было.'}</p>
      <div class="actions">
        <label class="field">с <input id="rncardFrom" type="date"></label>
        <label class="field">по <input id="rncardTo" type="date"></label>
        <button class="button secondary" id="rncardSync" type="button">Загрузить период</button>
        <span class="muted">Кнопка сохранит настройки сама и загрузит период (до года, кусками по 2 месяца).</span>
      </div>`, { span: 's6' }),
    biSec('Импорт по контракту обмена v1.0', `
      <p class="muted">Для 1С поддерживаются геозоны или города из справочника. Повторная передача того же id обновляет рейс и не создает дубль.</p>
      <label class="field">JSON-массив<textarea id="contractImport" rows="8"
        placeholder='[{"id":"1С-0001","zoneFrom":"Пенза","zoneTo":"Москва","truck":"а001аа58","client":"ЧМПЗ АО","depDate":"2026-07-05","doneDate":"2026-07-06","revenue":95000,"status":"plan"}]'></textarea></label>
      <div class="actions">
        <button class="button secondary" id="import1c" type="button">Импортировать из 1С</button>
        <button class="button ghost" id="importTelematics" type="button">Импортировать телематику</button>
      </div>`, { span: 's6' }),
    biSec('Обратная запись в 1С', `
      <div class="code">UI → SQLite (транзакция) → outbox → подтверждение → OData → аудит</div>
      <label class="check"><input id="writeEnabled" type="checkbox" ${cfg.writeEnabled ? 'checked' : ''}> Разрешить обработчику отправлять одобренные изменения</label>
      <label class="field">Политика отправки<select id="writePolicy">
        <option value="manual" ${cfg.writePolicy === 'manual' ? 'selected' : ''}>Только после подтверждения администратором</option>
        <option value="automatic" ${cfg.writePolicy === 'automatic' ? 'selected' : ''}>Автоматически (после приемочных испытаний)</option>
      </select></label>
      <p class="muted">Рекомендуется оставить ручной режим до настройки регистра IntegrationKey в 1С и проверки прав сервисного пользователя.</p>`,
      { span: 's6' }),
    biSec('Сопоставление сущностей', `
      <p class="muted">Имена наборов и полей зависят от конфигурации 1С. Поля задаются JSON: локальное поле → поле OData.</p>
      ${mappings.map(mapping => `<div class="mapping" data-mapping="${mapping.entity}">
        <label class="field">Сущность<input value="${escapeHtml(mapping.entity)}" disabled></label>
        <label class="field">Набор OData<input data-key="entitySet" value="${escapeHtml(mapping.entity_set)}"></label>
        <label class="field">Направление<select data-key="direction">
          ${['pull', 'push', 'both'].map(value => `<option ${mapping.direction === value ? 'selected' : ''}>${value}</option>`).join('')}
        </select></label>
        <label class="check"><input data-key="enabled" type="checkbox" ${mapping.enabled ? 'checked' : ''}> активно</label>
        <label class="field">Фильтр OData<input data-key="filterQuery" value="${escapeHtml(mapping.filter_query)}"></label>
        <label class="field">Карта полей JSON<textarea data-key="fieldMap">${escapeHtml(JSON.stringify(mappingData(mapping), null, 2))}</textarea></label>
      </div>`).join('')}`, { hint: `${mappings.length} сущностей` }),
    biSec('Последние задания', jobsTable(state.admin.jobs), { flush: state.admin.jobs.length > 0 })
  ]);
  byId('saveIntegration').onclick = saveIntegration;
  byId('dornetSync').onclick = async () => {
    try {
      // Кнопка сама сохраняет поля карточки: общая «Сохранить» далеко,
      // и забытая галка/токен давали «коннектор не настроен» (03.11).
      byId('dornetEnabled').checked = true;
      await api('/api/admin/integration', { method: 'PUT', body: JSON.stringify({ dornet: {
        token: byId('dornetToken').value,
        cid: Number(byId('dornetCid').value) || 0,
        enabled: true
      } }) });
      const result = await api('/api/admin/dornet/sync', { method: 'POST', body: JSON.stringify({
        from: byId('dornetFrom').value, to: byId('dornetTo').value }) });
      const detail = Object.entries(result.byService || {})
        .map(([label, count]) => `${label} ${count}`).join(' · ');
      toast(`Dornet: добавлено ${result.added}${detail ? ` (${detail})` : ''}` +
        (result.errors?.length ? ` · ошибки: ${result.errors[0]}` : ''));
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('gibddSync').onclick = async () => {
    try {
      // Кнопка сама сохраняет поля карточки (урок Dornet 03.11).
      byId('gibddEnabled').checked = true;
      await api('/api/admin/integration', { method: 'PUT', body: JSON.stringify({ onlinegibdd: {
        token: byId('gibddToken').value,
        enabled: true
      } }) });
      const result = await api('/api/admin/gibdd/sync', { method: 'POST', body: '{}' });
      toast(`OnlineГИБДД: +${result.added} штрафов, обновлено ${result.updated}, машин добавлено ${result.autosAdded}, СТС импортировано ${result.stsImported ?? 0}` +
        (result.errors?.length ? ` · ошибка: ${result.errors[0]}` : ''));
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('rncardSync').onclick = async () => {
    try {
      // Кнопка сама сохраняет поля карточки (урок Dornet 03.11).
      byId('rncardEnabled').checked = true;
      await api('/api/admin/integration', { method: 'PUT', body: JSON.stringify({ rncard: {
        login: byId('rncardLogin').value.trim(),
        password: byId('rncardPassword').value,
        contract: byId('rncardContract').value.trim(),
        enabled: true
      } }) });
      await api('/api/admin/rncard/sync', { method: 'POST', body: JSON.stringify({
        from: byId('rncardFrom').value, to: byId('rncardTo').value }) });
      toast('РН-Карт: загрузка началась в фоне — первая опрашивает ТС всех карт и идёт несколько минут. Итог появится в этой карточке, обновите страницу позже.');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('testIntegration').onclick = async () => {
    try { await api('/api/admin/integration/test', { method: 'POST' }); toast('Подключение установлено'); }
    catch (error) { toast(error.message, 'error'); }
  };
  byId('runSync').onclick = async () => {
    try {
      const result = await api('/api/admin/integration/sync', { method: 'POST' });
      toast(`Синхронизация завершена: ${result.jobId || 'нет активных правил'}`);
      await loadAdmin();
      renderIntegration();
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('import1c').onclick = () => runContractImport('1c');
  byId('importTelematics').onclick = () => runContractImport('telematics');
}

async function runContractImport(kind) {
  try {
    const items = JSON.parse(byId('contractImport').value);
    const result = await api(`/api/admin/integration/import/${kind}`, {
      method: 'POST', body: JSON.stringify(items)
    });
    toast(kind === '1c'
      ? `Импортировано: ${result.imported}, обновлено: ${result.updated}, пропущено: ${result.skipped}`
      : `Сопоставлено: ${result.matched}, пробег: ${result.kmUpdated}, статусы: ${result.statusUpdated}`);
    await loadAdmin();
  } catch (error) { toast(error.message, 'error'); }
}

function jobsTable(jobs) {
  if (!jobs.length) return '<p class="muted">Заданий еще не было.</p>';
  return `<div class="table-wrap bi-scroll"><table class="bi-table"><thead><tr><th>Запуск</th><th>Тип</th><th>Статус</th><th>Загружено</th><th>Ошибка</th></tr></thead>
    <tbody>${jobs.map(job => `<tr><td>${formatDate(job.started_at, { dateStyle: 'short', timeStyle: 'short' })}</td>
    <td>${escapeHtml(job.kind)}</td><td>${statusBadge(job.status)}</td><td>${job.pulled}</td>
    <td class="danger">${escapeHtml(job.error_text || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

async function saveIntegration() {
  const mappings = [...document.querySelectorAll('[data-mapping]')].map(row => {
    let fieldMap;
    try { fieldMap = JSON.parse(row.querySelector('[data-key="fieldMap"]').value); }
    catch { throw new Error(`Некорректный JSON в сопоставлении ${row.dataset.mapping}`); }
    return {
      entity: row.dataset.mapping,
      entitySet: row.querySelector('[data-key="entitySet"]').value.trim(),
      direction: row.querySelector('[data-key="direction"]').value,
      filterQuery: row.querySelector('[data-key="filterQuery"]').value.trim(),
      enabled: row.querySelector('[data-key="enabled"]').checked,
      fieldMap
    };
  });
  const payload = {
    baseUrl: byId('baseUrl').value.trim(), username: byId('odataUsername').value.trim(),
    password: byId('odataPassword').value, pullIntervalMin: Number(byId('pullIntervalMin').value),
    enabled: byId('integrationEnabled').checked, writeEnabled: byId('writeEnabled').checked,
    writePolicy: byId('writePolicy').value, mappings,
    telematics: {
      baseUrl: byId('telematicsUrl').value.trim(),
      token: byId('telematicsToken').value,
      enabled: byId('telematicsEnabled').checked
    },
    dornet: {
      token: byId('dornetToken').value,
      cid: Number(byId('dornetCid').value) || 0,
      enabled: byId('dornetEnabled').checked
    },
    rncard: {
      login: byId('rncardLogin').value.trim(),
      password: byId('rncardPassword').value,
      contract: byId('rncardContract').value.trim(),
      enabled: byId('rncardEnabled').checked
    },
    onlinegibdd: {
      token: byId('gibddToken').value,
      enabled: byId('gibddEnabled').checked
    }
  };
  try {
    await api('/api/admin/integration', { method: 'PUT', body: JSON.stringify(payload) });
    toast('Интеграция сохранена');
    await loadAdmin();
    renderIntegration();
  } catch (error) { toast(error.message, 'error'); }
}

function renderOutbox() {
  const items = state.admin.outbox;
  content.innerHTML = biPage(biHead('Исходящие изменения',
    'Контролируемая очередь будущей записи в 1С.'), [
    biSec('Очередь outbox', `
      ${items.length ? `<div class="table-wrap bi-scroll"><table class="bi-table"><thead><tr><th>Создано</th><th>Сущность</th><th>Операция</th><th>Статус</th><th>Попытки</th><th>Ошибка</th><th></th></tr></thead>
      <tbody>${items.map(item => `<tr><td>${formatDate(item.created_at, { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${escapeHtml(item.entity)}<br><small class="mono muted">${escapeHtml(item.entity_id)}</small></td>
        <td>${escapeHtml(item.operation)}</td><td>${statusBadge(item.status)}</td><td>${item.attempts}</td>
        <td class="danger">${escapeHtml(item.last_error || '')}</td><td><div class="actions">
          ${item.status === 'pending_approval' ? `<button class="button small" data-outbox="${item.id}" data-action="approve">Одобрить</button>` : ''}
          ${item.status === 'failed' ? `<button class="button small" data-outbox="${item.id}" data-action="retry">Повторить</button>` : ''}
          ${!['sent', 'cancelled'].includes(item.status) ? `<button class="button ghost small" data-outbox="${item.id}" data-action="cancel">Отменить</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table></div>` : '<div class="bi-empty">Очередь пуста.</div>'}`,
      { flush: true, hint: `${items.length} записей` })
  ]);
  document.querySelectorAll('[data-outbox]').forEach(button => button.onclick = async () => {
    try {
      await api(`/api/admin/outbox/${button.dataset.outbox}/${button.dataset.action}`, { method: 'POST' });
      toast('Состояние очереди обновлено');
      await loadAdmin();
      renderOutbox();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function loadAdmin() {
  state.admin = await api('/api/admin/settings');
}

// Телефония и справочник сервисов: карточка звонка бесполезна без телефонов
// сотрудников и точек, куда отправлять водителя, поэтому оба живут рядом.
const SERVICE_KINDS = [
  { kind: 'wash', label: '🚿 Мойка' }, { kind: 'service', label: '🔧 Сервис / ремзона' },
  { kind: 'tire', label: '🛞 Шиномонтаж' }, { kind: 'parking', label: '🅿 Стоянка' },
  { kind: 'fuel', label: '⛽ Заправка' }, { kind: 'rest', label: '🛏 Отдых' }
];

// Зеркало серверного NOTIFY_CATEGORIES (src/server.mjs): ключ, подпись,
// уровень по умолчанию. Меняешь там — поменяй здесь.
const NOTIFY_CATEGORIES = [
  ['stuck', '🚨 Простои на точках (не выгружают/не грузят)', 'critical'],
  ['balance', '⚖ Узкие дни баланса парк↔сетка', 'critical'],
  ['missed_departure', '⏰ Невыход машины в окно погрузки', 'critical'],
  ['daily_report', '📆 Утренний отчёт дня (всем)', 'normal'],
  ['gap_review', '📬 Ревизия зазоров 10/14/16', 'normal'],
  ['debt_1c', '📒 Долги перед 1С', 'normal'],
  ['driver_questions', '⏱ Просроченные вопросы водителей', 'normal'],
  ['claims', '📑 Претензии (срывы, простои П/В)', 'normal'],
  ['order_deadlines', '⏳ Дедлайны заявок (подтвердить/назначить)', 'normal'],
  ['shift_handover', '🌙 Ночная передача смены', 'normal'],
  ['stale_transfers', '🚚 Зависшие перегоны', 'normal'],
  ['sales_directions', '🧭 Утренние направления планированию', 'normal'],
  ['no_next', '⏭ Выгрузка близко, следующий рейс не назначен', 'normal'],
  ['resource_watch', '🔧 Сторож ресурса (без водителя/заказа 3+ дн)', 'normal'],
  ['shift_digest', '📋 Сводка смены (18:00 на ночь / 06:00 на день)', 'normal'],
  ['control_silence', '🕐 Рейсы без контроля (эскалация руководителю)', 'normal'],
  ['gps_control', '📡 GPS-контроль (подсказки фактов, температура рефа)', 'normal'],
  ['crm', '🎂 CRM-поводы (дни рождения, контакты)', 'off'],
  ['other', 'Прочее (операционный конвейер)', 'normal']
];

async function renderNotifications() {
  const notifyCfg = await api('/api/admin/notify/config');
  const sms = state.admin.settings?.sms || {};
  const smtp = state.admin.settings?.smtp || {};
  const channels = state.admin.settings?.notifyChannels || {};
  byId('settingsContent').innerHTML = biPage(biHead('Уведомления и оповещения',
    `Каналы: лента планера (всегда) · Telegram · SMS (smsc.ru) · почта (SMTP reg.ru).
        Сценарии ниже задают уровень и каналы каждой категории.${notifyCfg.outboundLive ? ''
    : ' <b>Исходящие SMS/SMTP/Telegram на этом экземпляре подавлены (не production).</b>'}`), [
    biSec('🔔 Telegram', `
    <p class="muted">Создайте бота у @BotFather, вставьте токен — сотрудники привяжут чаты
      кнопкой «🔔» в шапке. Режимы у каждого: только аварии или все уведомления роли.</p>
    <form id="telegramForm" class="fields">
      <label class="field">Токен бота<input name="botToken" value="${escapeHtml(state.admin.settings?.telegram?.botToken || '')}"
        placeholder="123456789:AA…" autocomplete="off"></label>
      <label class="field">Имя бота (для ссылки привязки)<input name="botName" value="${escapeHtml(state.admin.settings?.telegram?.botName || '')}"
        placeholder="pegas_planner_bot (без @)"></label>
      <label class="field">Токен бота ВОДИТЕЛЕЙ («Пегас Водитель», отдельный бот)
        <input name="driverBotToken" value="${escapeHtml(state.admin.settings?.telegram?.driverBotToken || '')}"
        placeholder="создайте второго бота у @BotFather" autocomplete="off"></label>
      <label class="field">Базовый URL вебхуков (пусто = опрос раз в 20 с)
        <input name="webhookBase" value="${escapeHtml(state.admin.settings?.telegram?.webhookBase || '')}"
        placeholder="https://planner.pegasavto.ru" autocomplete="off"></label>
      <button class="button">Сохранить</button>
    </form>`, { span: 's4' }),
    biSec('📱 SMS-центр (smsc.ru)', `
    <p class="muted">Секрет <code>.secrets/smsc_apikey</code> — три строки:
      пароль, логин, имя отправителя
      ${notifyCfg.sms?.passwordSet || notifyCfg.sms?.apikeySet
        ? '— <b>секрет на месте ✓</b>' : '— <b>секрет не задан</b>'}
      ${notifyCfg.sms?.loginFromSecret ? ' · логин из файла' : ''}
      ${notifyCfg.sms?.senderFromSecret ? ' · отправитель из файла' : ''}.</p>
    <form id="smsForm" class="fields">
      <label class="check"><input type="checkbox" name="enabled" ${sms.enabled || notifyCfg.sms?.enabled ? 'checked' : ''}>
        SMS-канал включён (платные сообщения)</label>
      <label class="field">Логин SMSC (если не в секрете)<input name="login" value="${escapeHtml(sms.login || notifyCfg.sms?.login || '')}"
        placeholder="логин кабинета smsc.ru" autocomplete="off"></label>
      <label class="field">Имя отправителя (если не в секрете)<input name="sender" value="${escapeHtml(sms.sender || notifyCfg.sms?.sender || '')}"
        placeholder="как в кабинете SMSC" autocomplete="off"></label>
      <button class="button">Сохранить</button>
      <button class="button ghost" type="button" id="smsBalance">Баланс SMSC</button>
      <button class="button ghost" type="button" id="smsTest">Тест SMS</button>
    </form>`, { span: 's4' }),
    biSec('✉️ SMTP (reg.ru)', `
    <p class="muted">Ящик исходящей почты. Пароль — только
      <code>.secrets/smtp_password</code>
      ${notifyCfg.smtp?.passwordSet ? '— <b>пароль на месте ✓</b>' : '— <b>пароль не задан</b>'}.</p>
    <form id="smtpForm" class="fields">
      <label class="check"><input type="checkbox" name="enabled" ${(smtp.enabled ?? notifyCfg.smtp?.enabled) !== false ? 'checked' : ''}>
        Почтовый канал включён</label>
      <label class="field">SMTP-хост<input name="host" value="${escapeHtml(smtp.host || notifyCfg.smtp?.host || 'mail.hosting.reg.ru')}"></label>
      <label class="field">Порт<input name="port" type="number" value="${escapeHtml(String(smtp.port || notifyCfg.smtp?.port || 465))}"></label>
      <label class="check"><input type="checkbox" name="secure" ${(smtp.secure ?? notifyCfg.smtp?.secure) !== false ? 'checked' : ''}>
        Implicit TLS (порт 465; для 587 снимите галку — STARTTLS)</label>
      <label class="field">Логин / From<input name="user" value="${escapeHtml(smtp.user || notifyCfg.smtp?.user || 'info@pegasavto.ru')}"
        autocomplete="off"></label>
      <label class="field">Подпись From (если отличается)<input name="from" value="${escapeHtml(smtp.from || notifyCfg.smtp?.from || '')}"
        placeholder="info@pegasavto.ru" autocomplete="off"></label>
      <button class="button">Сохранить</button>
      <button class="button ghost" type="button" id="smtpTest">Тест письма</button>
    </form>`, { span: 's4' }),
    biSec('Сценарии оповещений', `
    <p class="muted"><b>Уровень:</b> Выкл — внешние каналы молчат (лента планера остаётся);
      Аварийное — все привязанные (и «только аварии», и «все»);
      Обычное — только режим «все уведомления».
      <b>Каналы:</b> кому уходит текст роли/рассылки. SMS — на рабочий/личный телефон,
      почта — на e-mail сотрудника.</p>
    <div class="table-wrap"><table class="bi-table">
      <thead><tr>
        <th>Категория</th><th style="width:130px">Уровень</th>
        <th style="width:70px">TG</th><th style="width:70px">SMS</th><th style="width:70px">E-mail</th>
      </tr></thead>
      <tbody>${NOTIFY_CATEGORIES.map(([key, label, def]) => {
        const current = state.admin.settings?.notifyRules?.[key] || def;
        const ch = channels[key] || {};
        const tgOn = ch.telegram !== false;
        const smsOn = Boolean(ch.sms);
        const mailOn = Boolean(ch.email);
        return `<tr>
          <td>${escapeHtml(label)}${current === def ? '' : ' <small class="muted">(изменено)</small>'}</td>
          <td><select data-notify-rule="${key}">
            <option value="off" ${current === 'off' ? 'selected' : ''}>Выкл</option>
            <option value="critical" ${current === 'critical' ? 'selected' : ''}>Аварийное</option>
            <option value="normal" ${current === 'normal' ? 'selected' : ''}>Обычное</option>
          </select></td>
          <td style="text-align:center"><input type="checkbox" data-notify-ch="${key}" data-ch="telegram" ${tgOn ? 'checked' : ''}></td>
          <td style="text-align:center"><input type="checkbox" data-notify-ch="${key}" data-ch="sms" ${smsOn ? 'checked' : ''}></td>
          <td style="text-align:center"><input type="checkbox" data-notify-ch="${key}" data-ch="email" ${mailOn ? 'checked' : ''}></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <button class="button" id="saveNotifyRules" style="margin-top:8px">Сохранить сценарии</button>`,
      { hint: `${NOTIFY_CATEGORIES.length} категорий` })
  ]);

  byId('telegramForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const telegram = {
        botToken: form.elements.botToken.value.trim(),
        botName: form.elements.botName.value.trim().replace(/^@/, ''),
        driverBotToken: form.elements.driverBotToken.value.trim(),
        webhookBase: form.elements.webhookBase.value.trim()
      };
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ telegram }) });
      state.admin.settings.telegram = telegram;
      toast('Telegram сохранён');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('smsForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const sms = {
        enabled: form.elements.enabled.checked,
        login: form.elements.login.value.trim(),
        sender: form.elements.sender.value.trim()
      };
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ sms }) });
      state.admin.settings.sms = sms;
      toast('SMS-центр сохранён');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('smtpForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const smtp = {
        enabled: form.elements.enabled.checked,
        host: form.elements.host.value.trim() || 'mail.hosting.reg.ru',
        port: Number(form.elements.port.value) || 465,
        secure: form.elements.secure.checked,
        user: form.elements.user.value.trim(),
        from: form.elements.from.value.trim() || form.elements.user.value.trim()
      };
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ smtp }) });
      state.admin.settings.smtp = smtp;
      toast('SMTP сохранён');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('saveNotifyRules').onclick = async () => {
    const rules = {};
    const notifyChannels = {};
    document.querySelectorAll('[data-notify-rule]').forEach(select => {
      rules[select.dataset.notifyRule] = select.value;
    });
    for (const [key] of NOTIFY_CATEGORIES) {
      notifyChannels[key] = { telegram: true, sms: false, email: false };
    }
    document.querySelectorAll('[data-notify-ch]').forEach(box => {
      const key = box.dataset.notifyCh;
      const ch = box.dataset.ch;
      if (!notifyChannels[key]) notifyChannels[key] = {};
      notifyChannels[key][ch] = box.checked;
    });
    try {
      await api('/api/admin/settings', {
        method: 'PUT', body: JSON.stringify({ notifyRules: rules, notifyChannels })
      });
      state.admin.settings.notifyRules = rules;
      state.admin.settings.notifyChannels = notifyChannels;
      toast('Сценарии сохранены — со следующего уведомления');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('smsBalance').onclick = async () => {
    try {
      const result = await api('/api/admin/notify/smsc-balance');
      toast(result.ok ? `Баланс SMSC: ${result.balance}` : (result.error || 'Ошибка'), result.ok ? undefined : 'error');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('smsTest').onclick = async () => {
    const phone = prompt('Номер для тестовой SMS (+7…)');
    if (!phone) return;
    try {
      const result = await api('/api/admin/notify/test-sms', {
        method: 'POST', body: JSON.stringify({ phone })
      });
      toast(result.ok ? 'SMS отправлена' : (result.error || 'Не удалось'), result.ok ? undefined : 'error');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('smtpTest').onclick = async () => {
    const to = prompt('E-mail для тестового письма', state.admin.settings?.smtp?.user || 'info@pegasavto.ru');
    if (!to) return;
    try {
      const result = await api('/api/admin/notify/test-smtp', {
        method: 'POST', body: JSON.stringify({ to })
      });
      toast(result.ok ? 'Письмо отправлено' : (result.error || 'Не удалось'), result.ok ? undefined : 'error');
    } catch (error) { toast(error.message, 'error'); }
  };
}

async function renderTelephony() {
  const [config, points] = await Promise.all([
    api('/api/telephony/config'), api('/api/service-points')
  ]);
  byId('settingsContent').innerHTML = biPage(biHead('Телефония и сервисы',
    'Мониторинг Pilot-GPS, АТС, эскалация доски диспетчерской и точки сервиса для водителей.'), [
    biSec('🛰 Мониторинг Pilot-GPS', `
    <p class="muted">Логин/пароль кабинета Пилота — планер сам получает токен (живёт 48 ч)
      и раз в минуту подтягивает позиции сцепок. После сохранения нажмите «Сопоставить парк» —
      трекеры привяжутся к сцепкам по госномерам (кириллица/латиница и пробелы выравниваются).</p>
    <form id="monitoringForm" class="fields">
      <label class="field">Сервер<input name="baseUrl" value="${escapeHtml(state.admin.settings?.monitoring?.baseUrl || 'blade.pilot-gps.com')}"></label>
      <label class="field">Логин<input name="login" value="${escapeHtml(state.admin.settings?.monitoring?.login || '')}" autocomplete="off"></label>
      <label class="field">Пароль<input name="password" type="password" value="${escapeHtml(state.admin.settings?.monitoring?.password || '')}" autocomplete="off"></label>
      <button class="button">Сохранить</button>
      <button class="button ghost" type="button" id="monitoringMap"
        title="Скачать список объектов из Пилота и привязать трекеры к сцепкам по госномерам">🔗 Сопоставить парк</button>
    </form>
    <p class="muted" style="margin-top:10px">Сценарии Telegram / SMS / почты —
      в разделе <b>Уведомления</b>.</p>`, { span: 's6' }),
    biSec('Доска диспетчерской: эскалация', `
    <p class="muted">Карточка без движения дольше норматива колонки × множитель уходит
      старшему смены (должность со словом «старший»), ещё через указанные минуты —
      руководителю диспетчерской службы. Нормативы живые: подготовка — медиана по факту,
      погрузка/выгрузка — ворота, в пути — интервал промежуточного контроля.</p>
    <form id="dispatchForm" class="fields">
      <label class="field">Множитель просрочки (во сколько раз дольше норматива)
        <input name="escalateFactor" type="number" min="0" step="0.5"
          value="${state.admin.settings?.dispatch?.escalateFactor ?? 2}">
        <small class="muted">0 — эскалация выключена.</small></label>
      <label class="field">Минут у старшего смены до передачи руководителю службы
        <input name="escalateHeadMin" type="number" min="0" step="5"
          value="${state.admin.settings?.dispatch?.escalateHeadMin ?? 60}">
        <small class="muted">0 — выше старшего смены не поднимать.</small></label>
      <label class="field">Карточек за проход (каждые 10 минут)
        <input name="escalateMaxPerTick" type="number" min="0" step="1"
          value="${state.admin.settings?.dispatch?.escalateMaxPerTick ?? 5}">
        <small class="muted">Поднимаются самые горящие, остальные ждут очереди —
          чтобы накопленный хвост не упал на старшего залпом.</small></label>
      <label class="field">Потолок эскалаций на человеке
        <input name="escalateCapPerPerson" type="number" min="0" step="1"
          value="${state.admin.settings?.dispatch?.escalateCapPerPerson ?? 10}">
        <small class="muted">Больше этого числа ни старший, ни руководитель службы
          не держат — очередь ждёт отработки. 0 — без потолка.</small></label>
      <label class="field">«Мёртвый хвост»: суток без движения
        <input name="escalateDeadDays" type="number" min="0" step="1"
          value="${state.admin.settings?.dispatch?.escalateDeadDays ?? 7}">
        <small class="muted">Старше порога — карточка выходит из эскалаций и попадает
          списком зачистки в пятничный выпуск. 0 — выключено.</small></label>
      <button class="button">Сохранить</button>
    </form>`, { span: 's6' }),
    biSec('Телефония', `
    <p class="muted">Когда АТС подключена, входящий звонок сам поднимает карточку водителя
      у сотрудника. До подключения та же карточка открывается кнопкой «📞 Звонок» в шапке —
      процесс работы не меняется.</p>
    <form id="telephonyForm" class="fields">
      <label class="check"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}>
        Телефония подключена (принимать события от АТС)</label>
      <label class="check"><input type="checkbox" name="popup" ${config.popup ? 'checked' : ''}>
        Поднимать карточку автоматически при входящем звонке</label>
      <label class="field">Провайдер (для себя)<input name="provider" value="${escapeHtml(config.provider || '')}"
        placeholder="например: Билайн Облачная АТС"></label>
      <label class="field">Токен вебхука<input name="token" value="${escapeHtml(config.token || '')}"
        placeholder="придумайте длинную строку и укажите её в АТС"></label>
      <label class="field">Публичный адрес приложения (для событий Билайна в реальном времени)
        <input name="publicBase" value="${escapeHtml(config.publicBase || '')}"
        placeholder="https://planner.pegasavto.ru"></label>
      <label class="field">Дежурные номера (через запятую)
        <input name="dutyPhones" value="${escapeHtml(config.dutyPhones || '')}" placeholder="8909..., 8909...">
        <small class="muted">Трубки смены: не принадлежат никому — звонки и карточки приходят тому,
        кто вошёл в планер с этим номером; подписка АТС на них держится всегда</small></label>
      <label class="check"><input type="checkbox" name="subscribeMapped" ${config.subscribeMapped ? 'checked' : ''}>
        Подписки на события — только на добавочные, сопоставленные с сотрудниками
        <small class="muted" style="display:block">Незадействованные номера АТС перестанут слать события и шуметь в журнале; сопоставление — «Сотрудники → ☎ Сверка с АТС»</small></label>
      <label class="field">Пропущенный звонок водителя → «Вопрос водителя» через, минут
        <input name="missedToQuestionMin" type="number" min="0" step="1"
          value="${config.missedToQuestionMin ?? 10}">
        <small class="muted">Входящий от водителя без карточки и перезвона за это время
          становится вопросом с нормативом ответа. 0 — выключить.</small></label>
      <button class="button">Сохранить</button>
    </form>
    <div class="hint" style="margin-top:10px">
      <b>Облачная АТС Билайн.</b> Токен API АТС хранится на сервере
      (<code>.secrets/beeline_ats_token</code>) и в этом окне не показывается
      ${config.beeline?.tokenSet ? '— <b>токен на месте ✓</b>' : '— <b>токен не задан</b>'}.
      Журнал звонков подтягивается автоматически раз в минуту. Публичный адрес включает
      события в реальном времени: система сама подпишется на звонки всех сотрудников АТС
      (Xsi-Events) и будет поднимать карточку по номеру звонящего в момент вызова.
    </div>
    <div class="hint" style="margin-top:10px">
      <b>Что передать в АТС.</b> Адрес: <code>POST https://ваш-адрес/api/telephony/webhook</code>,
      заголовок <code>X-Telephony-Token: ваш токен</code>, тело JSON:
      <code>{"from":"+79875105921","to":"+7495...","callId":"уникальный-id","at":"2026-08-27T10:00:00Z"}</code>.
      Система сама определит, кто звонит — водитель, сотрудник или контакт клиента, —
      и поднимет карточку. Повторная доставка того же callId не создаёт дубль.
    </div>`),
    biSec('Точки сервиса', `
    <p class="muted">Мойки, шиномонтаж, стоянки, заправки — то, что водитель спрашивает на линии.
      В карточке звонка они показываются от ближайшей к машине.</p>
    <form id="servicePointForm" class="fields">
      <label class="field">Вид<select name="kind">${SERVICE_KINDS.map(item =>
    `<option value="${item.kind}">${item.label}</option>`).join('')}</select></label>
      <label class="field">Название<input name="name" required placeholder="например: Мойка на М5, 620 км"></label>
      <label class="field">Адрес<input name="address" placeholder="город, улица, ориентир"></label>
      <label class="field">Субъект<input name="region" placeholder="Пензенская обл"></label>
      <label class="field">Телефон<input name="phone" placeholder="+7 ..."></label>
      <label class="field">Часы работы<input name="workHours" placeholder="круглосуточно"></label>
      <label class="field">Широта<input name="latitude" type="number" step="any" placeholder="53.2"></label>
      <label class="field">Долгота<input name="longitude" type="number" step="any" placeholder="45.0"></label>
      <label class="field">Комментарий<input name="note" placeholder="для наших — скидка, пропуск по номеру"></label>
      <button class="button">Добавить точку</button>
    </form>
    <div class="table-wrap bi-scroll" style="margin-top:12px"><table class="bi-table"><thead><tr>
      <th>Вид</th><th>Название</th><th>Адрес</th><th>Телефон</th><th>Часы</th><th></th></tr></thead>
      <tbody>${points.items.length ? points.items.map(point => `<tr>
        <td>${escapeHtml(SERVICE_KINDS.find(item => item.kind === point.kind)?.label || point.kind)}</td>
        <td><b>${escapeHtml(point.name)}</b>${point.note ? `<small class="muted" style="display:block">${escapeHtml(point.note)}</small>` : ''}</td>
        <td>${escapeHtml(point.address || point.region || '—')}</td>
        <td>${escapeHtml(point.phone || '—')}</td>
        <td>${escapeHtml(point.work_hours || '—')}</td>
        <td><button class="button ghost small danger" data-point-del="${point.id}">✕</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">Точек пока нет — водителю нечего подсказать.</td></tr>'}
      </tbody></table></div>`, { hint: `${points.items.length} точек` })
  ]);
  byId('monitoringForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const monitoring = { baseUrl: form.elements.baseUrl.value.trim(),
      login: form.elements.login.value.trim(), password: form.elements.password.value };
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ monitoring }) });
      state.admin.settings.monitoring = monitoring;
      toast('Мониторинг сохранён — теперь «Сопоставить парк»');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('monitoringMap').onclick = async event => {
    event.target.disabled = true;
    try {
      const result = await api('/api/monitoring/map-fleet', { method: 'POST', body: '{}' });
      showModal(`<h2>🔗 Сопоставление парка</h2>
        <p>В Пилоте объектов: <b>${result.pilotTotal}</b> · привязано тягачей: <b>${result.matched}</b>
          · прицепов сцепок: <b>${result.trailers ?? 0}</b></p>
        ${result.unmatchedOurs?.length ? `<p class="muted">Наши без трекера (${result.unmatchedOurs.length}):
          ${result.unmatchedOurs.map(escapeHtml).join(', ')}</p>` : '<p>Все сцепки нашли свой трекер ✓</p>'}
        <div class="modal-actions"><button class="button" data-close>Закрыть</button></div>`);
    } catch (error) { toast(error.message, 'error'); }
    event.target.disabled = false;
  };
  byId('telephonyForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
        telephony: {
          enabled: form.elements.enabled.checked, popup: form.elements.popup.checked,
          provider: form.elements.provider.value.trim(), token: form.elements.token.value.trim(),
          publicBase: form.elements.publicBase.value.trim(),
          missedToQuestionMin: Math.max(0, Number(form.elements.missedToQuestionMin.value) || 0),
          subscribeMapped: form.elements.subscribeMapped.checked,
          dutyPhones: String(form.elements.dutyPhones.value || '').trim()
        }
      }) });
      toast('Настройки телефонии сохранены');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('dispatchForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
        dispatch: {
          escalateFactor: Math.max(0, Number(form.elements.escalateFactor.value) || 0),
          escalateHeadMin: Math.max(0, Number(form.elements.escalateHeadMin.value) || 0),
          escalateMaxPerTick: Math.max(0, Number(form.elements.escalateMaxPerTick.value) || 0),
          escalateCapPerPerson: Math.max(0, Number(form.elements.escalateCapPerPerson.value) || 0),
          escalateDeadDays: Math.max(0, Number(form.elements.escalateDeadDays.value) || 0)
        }
      }) });
      toast('Настройки эскалации сохранены');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('servicePointForm').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api('/api/service-points', { method: 'POST', body: JSON.stringify(values) });
      toast('Точка добавлена');
      await renderTelephony();
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('settingsContent').querySelectorAll('[data-point-del]').forEach(button =>
    button.addEventListener('click', async () => {
      try {
        await api(`/api/service-points/${button.dataset.pointDel}`, { method: 'DELETE' });
        toast('Точка удалена');
        await renderTelephony();
      } catch (error) { toast(error.message, 'error'); }
    }));
}

// ── Перенос «Слияния» по отделам (10.11) ──
// Отдел включается загрузкой его людей из проверенного снимка: таблица
// «кто кем станет» (сопоставление с учётками прода — авто, правится
// вручную), «Включить отдел», «Откатить отдел». Прочие — без изменений.
const MERGER_HOW = { exact: ['✓ найдена', ''], close: ['≈ похоже — проверьте', 'warn'], manual: ['✎ выбрано вручную', ''],
  new: ['＋ новая учётка', ''], ambiguous: ['⚠ несколько похожих — выберите', 'bad'], skip: ['пропустить', 'warn'] };
const MERGER_ACTION = { update: 'права и должность', create: 'создать в справочнике', fire: 'уволить', none: '—' };
async function renderMerger() {
  state.mergerDept = state.mergerDept || 'toir';
  state.mergerOverrides = state.mergerOverrides || {};
  const query = new URLSearchParams({ dept: state.mergerDept, overrides: JSON.stringify(state.mergerOverrides[state.mergerDept] || {}) });
  const data = await api(`/api/merger?${query}`);
  const plan = data.plan;
  const current = data.status.find(item => item.key === state.mergerDept);
  const options = row => `<select data-merger-pick="${escapeHtml(row.fullName)}" style="max-width:240px">
      <option value="">авто${row.prod ? `: ${escapeHtml(row.prod.name)}` : ''}</option>
      <option value="new" ${state.mergerOverrides[state.mergerDept]?.[row.fullName] === 'new' ? 'selected' : ''}>＋ новая учётка</option>
      <option value="skip" ${state.mergerOverrides[state.mergerDept]?.[row.fullName] === 'skip' ? 'selected' : ''}>пропустить</option>
      ${plan.accounts.map(account => `<option value="${account.id}" ${state.mergerOverrides[state.mergerDept]?.[row.fullName] === account.id ? 'selected' : ''}>${escapeHtml(account.name)} · ${escapeHtml(account.username)}</option>`).join('')}
    </select>`;
  content.innerHTML = biPage(biHead('Перенос по отделам',
    'Отдел включается загрузкой его людей из штата, проверенного в лаборатории: должность и набор прав. Остальные сотрудники живут по-старому. Откат возвращает прежние права.'), [
    biSec('Отделы', `<div class="actions">${data.status.map(item => `<button class="button ${item.key === state.mergerDept ? '' : 'ghost'} small" data-merger-dept="${item.key}">
      ${escapeHtml(item.title)} ${item.applied ? `✅ ${item.people} чел.` : '— не включён'}</button>`).join(' ')}</div>
      <p class="muted">Порядок руководителя: ТОиР → Эксплуатация → Логистика → Штаб.</p>`),
    biSec(`Кто кем станет · ${escapeHtml(current?.title || '')}`, `
      <p class="muted">Обновить — ${plan.summary.update} · создать — ${plan.summary.create} · уволить — ${plan.summary.fire}
        ${plan.summary.attention ? ` · <b>требуют внимания ${plan.summary.attention}</b>` : ''}</p>
      <div class="table-wrap bi-scroll"><table class="bi-table"><thead><tr><th>Сотрудник (табель)</th><th>Должность</th><th>Роль</th>
        <th>Учётка на проде</th><th>Сопоставление</th><th>Действие</th></tr></thead><tbody>
        ${plan.rows.map(row => {
          const [how, tone] = MERGER_HOW[row.how] || ['', ''];
          return `<tr>
          <td>${escapeHtml(row.fullName)}${row.active ? '' : ' <span class="badge warn">уволен</span>'}${row.applied ? ' <span class="badge ok">включён</span>' : ''}</td>
          <td>${escapeHtml(row.position)}${row.positionKnown ? '' : ' <span class="badge bad">нет в структуре</span>'}</td>
          <td>${escapeHtml(row.roleTitles.join(' + ') || 'без входа')}${row.unknownSets.length ? ' <span class="badge bad">набор не найден</span>' : ''}</td>
          <td>${row.prod ? `${escapeHtml(row.prod.name)} <small class="muted">${escapeHtml(row.prod.username)}</small>` : '<span class="muted">нет</span>'}
            ${row.candidates.length > 1 ? `<br><small class="muted">похожие: ${row.candidates.map(item => escapeHtml(item.name)).join(', ')}</small>` : ''}</td>
          <td><span class="badge ${tone}">${how}</span><br>${options(row)}</td>
          <td>${MERGER_ACTION[row.action] || row.action}</td></tr>`;
        }).join('')}</tbody></table></div>
      <div class="actions" style="margin-top:10px">
        <button class="button" id="mergerApply">${current?.applied ? 'Применить ещё раз' : `Включить отдел «${escapeHtml(current?.title || '')}»`}</button>
        ${current?.applied ? '<button class="button ghost danger" id="mergerRollback">Откатить отдел</button>' : ''}
      </div>
      <p class="muted">После включения: «Сотрудники» → «🔐 Выдать доступ · N» — листки с логинами людям отдела.
        Учётки с прежними правами получают права набора; их пароль не меняется.</p>`, { flush: false })
  ]);
  content.querySelectorAll('[data-merger-dept]').forEach(button => button.onclick = () => {
    state.mergerDept = button.dataset.mergerDept; render();
  });
  content.querySelectorAll('[data-merger-pick]').forEach(select => select.onchange = () => {
    const bucket = state.mergerOverrides[state.mergerDept] = state.mergerOverrides[state.mergerDept] || {};
    if (select.value) bucket[select.dataset.mergerPick] = select.value; else delete bucket[select.dataset.mergerPick];
    render();
  });
  byId('mergerApply').onclick = async () => {
    if (!confirm(`Включить отдел «${current?.title}»: ${plan.summary.update} обновить, ${plan.summary.create} создать, ${plan.summary.fire} уволить?\n\nОткат — кнопкой «Откатить отдел».`)) return;
    try {
      const result = await api('/api/merger/apply', { method: 'POST',
        body: JSON.stringify({ dept: state.mergerDept, overrides: state.mergerOverrides[state.mergerDept] || {} }) });
      toast(`Отдел включён: обновлено ${result.updated}, создано ${result.created}, уволено ${result.fired}`);
      render();
    } catch (error) { toast(error.message, 'error'); }
  };
  const rollback = byId('mergerRollback');
  if (rollback) rollback.onclick = async () => {
    if (!confirm(`Откатить отдел «${current?.title}»? Прежние права вернутся, созданные учётки останутся в справочнике без входа.`)) return;
    try {
      const result = await api('/api/merger/rollback', { method: 'POST', body: JSON.stringify({ dept: state.mergerDept }) });
      toast(`Откат выполнен: ${result.restored} записей`);
      render();
    } catch (error) { toast(error.message, 'error'); }
  };
}

async function render() {
  try {
    if (state.section === 'general') renderGeneral();
    else if (state.section === 'dictionaries') renderDictionaries();
    else if (state.section === 'fleet') renderFleet();
    else if (state.section === 'customers') renderCustomers();
    else if (state.section === 'users') await renderUsers();
    else if (state.section === 'network') renderNetwork();
    else if (state.section === 'notifications') await renderNotifications();
    else if (state.section === 'telephony') await renderTelephony();
    else if (state.section === 'integration') renderIntegration();
    else if (state.section === 'outbox') renderOutbox();
    else if (state.section === 'merger') await renderMerger();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// Оглавление-якоря раздела (BI-вид 04.11): под активной кнопкой слева —
// ссылки на секции страницы. Строится наблюдателем за #settingsContent,
// поэтому переживает любые перерисовки (сохранение, «добавить точку»).
let tocTargets = [];
function buildToc() {
  byId('settingsNav').querySelector('.svc-toc')?.remove();
  tocTargets = [...content.querySelectorAll('.section > .sec-h .st')];
  const active = byId('settingsNav').querySelector('[data-section].active');
  if (!active || tocTargets.length < 2) return;
  active.insertAdjacentHTML('afterend', `<div class="svc-toc">${tocTargets.map((title, index) =>
    `<a href="#" data-toc="${index}">${escapeHtml(title.textContent.trim())}</a>`).join('')}</div>`);
}
new MutationObserver(buildToc).observe(content, { childList: true });

byId('settingsNav').onclick = event => {
  const jump = event.target.closest('[data-toc]');
  if (jump) {
    event.preventDefault();
    tocTargets[Number(jump.dataset.toc)]?.closest('.section')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const button = event.target.closest('[data-section]');
  if (!button) return;
  state.section = button.dataset.section;
  document.querySelectorAll('[data-section]').forEach(item =>
    item.classList.toggle('active', item === button));
  render();
};
byId('logout').onclick = logout;

try {
  const me = await api('/api/auth/me');
  if (!(me.user.roles || [me.user.role]).includes('admin')) {
    location.href = '/planner';
  } else {
    byId('profileName').textContent = me.user.fullName;
    byId('avatar').textContent = me.user.fullName.charAt(0).toUpperCase();
    await loadAdmin();
    render();
  }
} catch (error) {
  if (!error.message.includes('Требуется вход')) toast(error.message, 'error');
}
