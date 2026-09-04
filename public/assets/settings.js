import { api, escapeHtml, formatDate, logout, setupTheme, toast } from './api.js';
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

function renderGeneral() {
  const { general, calculation, statuses, rejectionReasons, orderOptions } = state.admin.settings;
  content.innerHTML = `<section>
    <div class="section-head"><div><h1>Настройки планера</h1>
      <p>Параметры, которые раньше были зашиты непосредственно в HTML.</p></div>
      <button class="button" id="saveGeneral">Сохранить</button></div>
    <div class="card"><h2>Общие</h2><div class="fields three">
      <label class="field">Название компании<input id="companyName" value="${escapeHtml(general.companyName)}"></label>
      <label class="field">Название приложения<input id="appName" value="${escapeHtml(general.appName)}"></label>
      <label class="field">Часовой пояс<input id="timezone" value="${escapeHtml(general.timezone)}"></label>
      <label class="field">Начало горизонта<input id="horizonStart" type="date" value="${general.horizonStart}"></label>
      <label class="field">Горизонт, месяцев<input id="horizonMonths" type="number" min="1" max="36" value="${general.horizonMonths}"></label>
      <label class="field">Ширина дня, px<input id="plannerCellWidth" type="number" min="28" max="100" value="${general.plannerCellWidth}"></label>
    </div></div>
    <div class="card"><h2>Экономика и нормативы</h2><div class="fields three">
      <label class="field">Себестоимость, ₽/км<input id="costPerKm" type="number" min="0" step=".01" value="${calculation.costPerKm}"></label>
      <label class="field">Страхование, Платон и дороги, ₽/км<input id="insuranceAndRoadsPerKm" type="number" min="0" step=".01" value="${calculation.insuranceAndRoadsPerKm}"></label>
      <label class="field">Водитель, ₽/сутки рейса<input id="driverPerTripDay" type="number" min="0" value="${calculation.driverPerTripDay}"></label>
      <label class="field">Рефустановка, ₽/сутки рейса<input id="refrigerationPerTripDay" type="number" min="0" value="${calculation.refrigerationPerTripDay}"></label>
      <label class="field">Лизинг/амортизация, ₽/машино-день<input id="leasePerVehicleDay" type="number" min="0" value="${calculation.leasePerVehicleDay}"></label>
      <label class="field">Накладные, ₽/машино-день<input id="overheadPerVehicleDay" type="number" min="0" value="${calculation.overheadPerVehicleDay}"></label>
      <label class="field">Ставка НДС<input id="vatRate" type="number" min="0" max="1" step=".01" value="${calculation.vatRate}"></label>
      <label class="field">НДС для ИП<input id="individualEntrepreneurVatRate" type="number" min="0" max="1" step=".01" value="${calculation.individualEntrepreneurVatRate}"></label>
      <label class="field">Скорость транзита, км/ч<input id="techSpeedKmh" type="number" min="1" value="${calculation.techSpeedKmh ?? 50}"></label>
      <label class="field">Грузовая операция, ч<input id="handlingHoursPerOperation" type="number" min="0" step=".5" value="${calculation.handlingHoursPerOperation ?? 2}"></label>
      <label class="field">Коэффициент транзита<input id="transitFactor" type="number" min="1" step=".1" value="${calculation.transitFactor ?? 1.5}" title="(км/скорость + 2 операции) × коэффициент — запас включает отдых водителя"></label>
      <label class="field">Целевая утилизация<input id="utilizationTarget" type="number" min="0" max="1" step=".001" value="${calculation.utilizationTarget}"></label>
      <label class="field">Простой: бесплатно, ч<input id="demurrageFreeHours" type="number" min="0" step="1" value="${calculation.demurrageFreeHours ?? 8}" title="Норматив бесплатного простоя под погрузкой/выгрузкой от планового времени операции по заявке; сверх — претензия клиенту"></label>
      <label class="field">Простой: тариф, ₽/ч<input id="demurrageRatePerHour" type="number" min="0" step="50" value="${calculation.demurrageRatePerHour ?? 1000}" title="Ставка за каждый начатый час сверхнормативного простоя — попадает в документ претензии"></label>
    </div></div>
    <div class="card"><h2>Статусы рейса</h2>
      <div class="table-wrap"><table><thead><tr><th>Код</th><th>Название</th><th>Цвет</th></tr></thead>
      <tbody>${statuses.map(([id, name, color]) => `<tr data-status="${escapeHtml(id)}"><td class="mono">${escapeHtml(id)}</td>
        <td><input data-status-name value="${escapeHtml(name)}"></td><td><input data-status-color type="color" value="${escapeHtml(color)}"></td></tr>`).join('')}</tbody></table></div>
    </div>
    <div class="card"><h2>Причины отклонения</h2>
      <label class="field">По одной причине в строке<textarea id="rejectionReasons">${escapeHtml(rejectionReasons.join('\n'))}</textarea></label>
    </div>
    <div class="card"><h2>Параметры заявок</h2><div class="fields">
      <label class="field">Температурные режимы, по одному в строке<textarea id="temperatureModes">${escapeHtml(orderOptions.temperatureModes.join('\n'))}</textarea></label>
      <label class="field">Типы кузова, по одному в строке<textarea id="bodyTypes">${escapeHtml(orderOptions.bodyTypes.join('\n'))}</textarea></label>
      <label class="field">Этапы заявки, по одному в строке<textarea id="orderStages">${escapeHtml(orderOptions.stages.join('\n'))}</textarea></label>
    </div></div>
  </section>`;
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
      insuranceAndRoadsPerKm: numeric('insuranceAndRoadsPerKm'),
      driverPerTripDay: numeric('driverPerTripDay'),
      refrigerationPerTripDay: numeric('refrigerationPerTripDay'),
      leasePerVehicleDay: numeric('leasePerVehicleDay'),
      overheadPerVehicleDay: numeric('overheadPerVehicleDay'),
      individualEntrepreneurVatRate: numeric('individualEntrepreneurVatRate'),
      techSpeedKmh: numeric('techSpeedKmh'),
      handlingHoursPerOperation: numeric('handlingHoursPerOperation'),
      transitFactor: numeric('transitFactor'),
      utilizationTarget: numeric('utilizationTarget'),
      demurrageFreeHours: numeric('demurrageFreeHours'),
      demurrageRatePerHour: numeric('demurrageRatePerHour')
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
    rejectionReasons: byId('rejectionReasons').value.split('\n').map(item => item.trim()).filter(Boolean)
  };
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    Object.assign(state.admin.settings, payload);
    toast('Настройки сохранены');
  } catch (error) { toast(error.message, 'error'); }
}

function renderNetwork() {
  const allowedSubnets = state.admin.settings.networkAccess?.allowedSubnets || [];
  content.innerHTML = `<section>
    <div class="section-head"><div><h1>Сеть и доступ</h1>
      <p>Подсети, из которых разрешено открывать планер и страницу входа.</p></div>
      <button class="button" id="saveNetwork">Сохранить</button></div>
    <div class="card"><h2>Разрешённые подсети</h2>
      <label class="field">По одной IPv4- или IPv6-подсети в строке
        <textarea id="allowedSubnets" rows="9" spellcheck="false"
          placeholder="192.168.10.0/24&#10;10.20.0.0/16">${escapeHtml(allowedSubnets.join('\n'))}</textarea>
      </label>
      <p class="muted">Текущий адрес: <span class="mono">${escapeHtml(state.admin.network?.currentIp || 'не определён')}</span>.
        Он должен входить хотя бы в одну сохраняемую подсеть — защита от случайной потери доступа.</p>
      <p class="muted">Изменение применяется сразу ко всему веб-интерфейсу и API. Ограничение SSH на VPS управляется отдельно системным firewall.</p>
    </div>
    <div class="card"><h2>Примеры CIDR</h2>
      <div class="code">192.168.10.0/24 — адреса 192.168.10.1–192.168.10.254<br>
10.20.0.15/32 — только один компьютер<br>
2001:db8:1234::/64 — IPv6-подсеть</div>
    </div>
  </section>`;
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
  content.innerHTML = `<section>
    <div class="section-head"><div><h1>Справочники</h1>
      <p>Зоны, типы ТС и нормативные маршруты, перенесенные из прототипа.</p></div>
      <button class="button" id="saveDictionaries">Сохранить</button></div>
    <div class="card"><h2>Геозоны</h2><div class="table-wrap"><table><thead><tr><th>Порядок</th><th>Зона</th><th>Цвет</th><th>Координаты</th><th>Города и регионы</th><th>ID 1С</th></tr></thead>
      <tbody>${zones.map(zone => `<tr data-zone="${zone.id}"><td>${zone.sort_order + 1}</td><td><input data-zone-name value="${escapeHtml(zone.name)}"></td>
      <td><input data-zone-color type="color" value="${escapeHtml(zone.color)}"></td>
      <td><div class="actions"><input data-zone-lat type="number" step=".01" value="${zone.latitude ?? ''}" placeholder="широта">
      <input data-zone-lon type="number" step=".01" value="${zone.longitude ?? ''}" placeholder="долгота"></div></td>
      <td><textarea data-zone-aliases rows="2">${escapeHtml((zone.aliases || []).join('\n'))}</textarea></td>
      <td class="mono muted">${escapeHtml(zone.external_id || 'не связан')}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><h2>Типы транспортных средств</h2><div class="actions">
      ${vehicleTypes.map(type => `<label class="field" data-type="${type.id}"><input data-type-name value="${escapeHtml(type.name)}"></label>`).join('')}</div></div>
    <div class="card"><h2>Расстояния и ставки по умолчанию</h2>
      <div class="table-wrap"><table><thead><tr><th>Откуда</th><th>Куда</th><th>Км</th><th>Ставка с НДС</th></tr></thead>
      <tbody>${routeRates.map(rate => `<tr data-rate="${rate.id}"><td>${escapeHtml(rate.from_name)}</td><td>${escapeHtml(rate.to_name)}</td>
      <td><input data-rate-km type="number" min="0" value="${rate.distance_km}"></td>
      <td><input data-rate-value type="number" min="0" value="${rate.default_rate_vat}"></td></tr>`).join('')}</tbody></table></div>
    </div>
  </section>`;
  byId('saveDictionaries').onclick = saveDictionaries;
}

function renderFleet() {
  const vehicles = state.admin.vehicles;
  content.innerHTML = `<section>
    <div class="section-head"><div><h1>Состав транспортных средств</h1>
      <p>Сцепки, водители, текущая зона и доступность.</p></div>
      <button class="button" id="newVehicle">+ Добавить ТС</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Тягач</th><th>Прицеп</th><th>Тип</th><th>Водитель</th><th>Зона</th><th>Статус</th><th></th></tr></thead>
      <tbody>${vehicles.map(vehicle => `<tr><td class="mono"><strong>${escapeHtml(vehicle.plate)}</strong></td>
        <td class="mono">${escapeHtml(vehicle.trailer_plate || '—')}</td><td>${escapeHtml(vehicle.type_name)}</td>
        <td>${escapeHtml(vehicle.driver_name || '—')}</td><td>${escapeHtml(vehicle.zone_name || '—')}</td>
        <td>${statusBadge(vehicle.status)}</td><td><button class="button ghost small" data-edit-vehicle="${vehicle.id}">Изменить</button></td>
      </tr>`).join('')}</tbody></table></div></div>
  </section>`;
  byId('newVehicle').onclick = () => editVehicle();
  document.querySelectorAll('[data-edit-vehicle]').forEach(button =>
    button.onclick = () => editVehicle(vehicles.find(vehicle => vehicle.id === button.dataset.editVehicle)));
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
      <label class="field">Прицеп<input name="trailerPlate" value="${escapeHtml(vehicle?.trailer_plate || '')}"></label>
      <label class="field">Тип<select name="typeId">${types}</select></label>
      <label class="field">Водитель<input name="driverName" value="${escapeHtml(vehicle?.driver_name || '')}"></label>
      <label class="field">Зона<select name="zoneId">${zones}</select></label>
      <label class="field">Статус<select name="status">${statuses.map(([id, label]) =>
        `<option value="${id}" ${vehicle?.status === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    </div>
    <div class="form-grid">
      <label class="field">Недоступно с<input name="unavailableFrom" type="date" value="${vehicle?.unavailable_from || ''}"></label>
      <label class="field">Недоступно до<input name="unavailableTo" type="date" value="${vehicle?.unavailable_to || ''}"></label>
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
  content.innerHTML = `<section>
    <div class="section-head"><div><h1>Заказчики</h1>
      <p>Маршруты, средняя ставка и плановая частота перевозок.</p></div>
      <button class="button" id="newCustomer">+ Добавить</button></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Заказчик</th><th>Маршрут</th><th>Рейсов</th><th>Средняя ставка</th><th>Рейсов/мес.</th><th></th></tr></thead>
      <tbody>${customers.map(item => `<tr>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td>${escapeHtml(item.from_name || '—')} → ${escapeHtml(item.to_name || '—')}</td>
        <td>${item.trip_count}</td><td>${Number(item.average_rate_vat).toLocaleString('ru-RU')} ₽</td>
        <td>${item.trips_per_month}</td>
        <td><button class="button ghost small" data-edit-customer="${item.id}">Изменить</button></td>
      </tr>`).join('')}</tbody></table></div></div>
  </section>`;
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
  content.innerHTML = `<section>
    <div class="section-head"><div><h1>Пользователи</h1>
      <p>Создание учетных записей, изменение ролей и блокировка доступа.</p></div>
      <button class="button" id="newUser">+ Создать</button></div>
    <div class="card"><div class="table-wrap"><table>
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
      </tr>`).join('')}</tbody></table></div></div>
  </section>`;
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
  content.innerHTML = `<section>
    <div class="section-head"><div><h1>Интеграция с 1С</h1>
      <p>Загрузка по OData и управляемая обратная запись через очередь.</p></div>
      <button class="button" id="saveIntegration">Сохранить</button></div>
    <div class="card"><h2>Подключение OData</h2>
      <div class="fields">
        <label class="field">URL публикации OData<input id="baseUrl" type="url" placeholder="https://1c.example.ru/base/odata/standard.odata" value="${escapeHtml(cfg.baseUrl)}"></label>
        <label class="field">Пользователь 1С<input id="odataUsername" value="${escapeHtml(cfg.username)}" autocomplete="off"></label>
        <label class="field">Пароль ${cfg.hasPassword ? '(сохранен)' : ''}<input id="odataPassword" type="password" placeholder="${cfg.hasPassword ? 'оставьте пустым, чтобы не менять' : ''}" autocomplete="new-password"></label>
        <label class="field">Интервал загрузки, минут<input id="pullIntervalMin" type="number" min="5" value="${cfg.pullIntervalMin}"></label>
      </div>
      <label class="check"><input id="integrationEnabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}> Включить фоновую загрузку</label>
      <div class="actions"><button class="button ghost" id="testIntegration" type="button">Проверить подключение</button>
        <button class="button secondary" id="runSync" type="button">Загрузить сейчас</button>
        <span class="muted">Последняя успешная: ${cfg.lastSuccessAt ? formatDate(cfg.lastSuccessAt, { dateStyle: 'short', timeStyle: 'short' }) : 'еще не выполнялась'}</span></div>
    </div>
    <div class="card"><h2>Телематика / мониторинг</h2>
      <div class="fields">
        <label class="field">URL API<input id="telematicsUrl" type="url" value="${escapeHtml(cfg.telematics?.baseUrl || '')}"></label>
        <label class="field">Токен ${cfg.telematics?.hasToken ? '(сохранен)' : ''}<input id="telematicsToken" type="password"
          placeholder="${cfg.telematics?.hasToken ? 'оставьте пустым, чтобы не менять' : ''}" autocomplete="new-password"></label>
      </div>
      <label class="check"><input id="telematicsEnabled" type="checkbox" ${cfg.telematics?.enabled ? 'checked' : ''}> Включить коннектор</label>
      <p class="muted">Контракт входных данных: rideId, km, status, unloadedAt. Фактический пробег сохраняется отдельно и участвует в рейсе.</p>
    </div>
    <div class="card"><h2>Импорт по контракту PegasLogistic v1.0</h2>
      <p class="muted">Для 1С поддерживаются геозоны или города из справочника. Повторная передача того же id обновляет рейс и не создает дубль.</p>
      <label class="field">JSON-массив<textarea id="contractImport" rows="8"
        placeholder='[{"id":"1С-0001","zoneFrom":"Пенза","zoneTo":"Москва","truck":"а001аа58","client":"ЧМПЗ АО","depDate":"2026-07-05","doneDate":"2026-07-06","revenue":95000,"status":"plan"}]'></textarea></label>
      <div class="actions">
        <button class="button secondary" id="import1c" type="button">Импортировать из 1С</button>
        <button class="button ghost" id="importTelematics" type="button">Импортировать телематику</button>
      </div>
    </div>
    <div class="card"><h2>Сопоставление сущностей</h2>
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
      </div>`).join('')}
    </div>
    <div class="card"><h2>Обратная запись в 1С</h2>
      <div class="code">UI → SQLite (транзакция) → outbox → подтверждение → OData → аудит</div>
      <label class="check"><input id="writeEnabled" type="checkbox" ${cfg.writeEnabled ? 'checked' : ''}> Разрешить обработчику отправлять одобренные изменения</label>
      <label class="field">Политика отправки<select id="writePolicy">
        <option value="manual" ${cfg.writePolicy === 'manual' ? 'selected' : ''}>Только после подтверждения администратором</option>
        <option value="automatic" ${cfg.writePolicy === 'automatic' ? 'selected' : ''}>Автоматически (после приемочных испытаний)</option>
      </select></label>
      <p class="muted">Рекомендуется оставить ручной режим до настройки регистра IntegrationKey в 1С и проверки прав сервисного пользователя.</p>
    </div>
    <div class="card"><h2>Последние задания</h2>${jobsTable(state.admin.jobs)}</div>
  </section>`;
  byId('saveIntegration').onclick = saveIntegration;
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
  return `<div class="table-wrap"><table><thead><tr><th>Запуск</th><th>Тип</th><th>Статус</th><th>Загружено</th><th>Ошибка</th></tr></thead>
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
  content.innerHTML = `<section>
    <div class="section-head"><div><h1>Исходящие изменения</h1>
      <p>Контролируемая очередь будущей записи в 1С.</p></div></div>
    <div class="card">
      ${items.length ? `<div class="table-wrap"><table><thead><tr><th>Создано</th><th>Сущность</th><th>Операция</th><th>Статус</th><th>Попытки</th><th>Ошибка</th><th></th></tr></thead>
      <tbody>${items.map(item => `<tr><td>${formatDate(item.created_at, { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td>${escapeHtml(item.entity)}<br><small class="mono muted">${escapeHtml(item.entity_id)}</small></td>
        <td>${escapeHtml(item.operation)}</td><td>${statusBadge(item.status)}</td><td>${item.attempts}</td>
        <td class="danger">${escapeHtml(item.last_error || '')}</td><td><div class="actions">
          ${item.status === 'pending_approval' ? `<button class="button small" data-outbox="${item.id}" data-action="approve">Одобрить</button>` : ''}
          ${item.status === 'failed' ? `<button class="button small" data-outbox="${item.id}" data-action="retry">Повторить</button>` : ''}
          ${!['sent', 'cancelled'].includes(item.status) ? `<button class="button ghost small" data-outbox="${item.id}" data-action="cancel">Отменить</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Очередь пуста.</p>'}
    </div>
  </section>`;
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
  ['sales_directions', '🧭 Утренние направления продажам', 'normal'],
  ['no_next', '⏭ Выгрузка близко, следующий рейс не назначен', 'normal'],
  ['resource_watch', '🔧 Сторож ресурса (без водителя/заказа 3+ дн)', 'normal'],
  ['crm', '🎂 CRM-поводы (дни рождения, контакты)', 'off'],
  ['other', 'Прочее (операционный конвейер)', 'normal']
];

async function renderTelephony() {
  const [config, points] = await Promise.all([
    api('/api/telephony/config'), api('/api/service-points')
  ]);
  byId('settingsContent').innerHTML = `
    <h2>🔔 Telegram-уведомления</h2>
    <p class="muted">Бот шлёт уведомления планера в мессенджер на телефон. Создайте бота у
      @BotFather (/newbot, 2 минуты), вставьте токен и имя бота — сотрудники привяжут свои
      чаты кнопкой «🔔» в шапке планера. Режимы у каждого свои: только аварии или все
      уведомления роли.</p>
    <form id="telegramForm" class="fields">
      <label class="field">Токен бота<input name="botToken" value="${escapeHtml(state.admin.settings?.telegram?.botToken || '')}"
        placeholder="123456789:AA…" autocomplete="off"></label>
      <label class="field">Имя бота (для ссылки привязки)<input name="botName" value="${escapeHtml(state.admin.settings?.telegram?.botName || '')}"
        placeholder="pegas_planner_bot (без @)"></label>
      <label class="field">Токен бота ВОДИТЕЛЕЙ («Пегас Водитель», отдельный бот)
        <input name="driverBotToken" value="${escapeHtml(state.admin.settings?.telegram?.driverBotToken || '')}"
        placeholder="создайте второго бота у @BotFather" autocomplete="off"></label>
      <button class="button">Сохранить</button>
    </form>
    <h3 style="margin-top:14px">Что отправлять в Telegram</h3>
    <p class="muted">Уровень каждой категории: <b>Выкл</b> — в мессенджер не идёт (лента планера
      остаётся); <b>Аварийное</b> — получают все привязанные сотрудники (и режим «только аварии»,
      и «все»); <b>Обычное</b> — только выбравшие режим «все уведомления». Кому именно —
      определяется ролью уведомления и ролью сотрудника.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Категория</th><th style="width:150px">Уровень</th></tr></thead>
      <tbody>${NOTIFY_CATEGORIES.map(([key, label, def]) => {
        const current = state.admin.settings?.notifyRules?.[key] || def;
        return `<tr><td>${escapeHtml(label)}${current === def ? '' : ' <small class="muted">(изменено)</small>'}</td>
          <td><select data-notify-rule="${key}">
            <option value="off" ${current === 'off' ? 'selected' : ''}>Выкл</option>
            <option value="critical" ${current === 'critical' ? 'selected' : ''}>Аварийное</option>
            <option value="normal" ${current === 'normal' ? 'selected' : ''}>Обычное</option>
          </select></td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <button class="button" id="saveNotifyRules" style="margin-top:8px">Сохранить правила рассылки</button>
    <h2 style="margin-top:18px">Телефония</h2>
    <p class="muted">Когда АТС подключена, входящий звонок сам поднимает карточку водителя
      у сотрудника. До подключения та же карточка открывается кнопкой «📞 Звонок» в шапке —
      процесс работы не меняется.</p>
    <form id="telephonyForm" class="fields">
      <label class="check"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''}>
        Телефония подключена (принимать события от АТС)</label>
      <label class="check"><input type="checkbox" name="popup" ${config.popup ? 'checked' : ''}>
        Поднимать карточку автоматически при входящем звонке</label>
      <label class="field">Провайдер (для себя)<input name="provider" value="${escapeHtml(config.provider || '')}"
        placeholder="например: Mango, Билайн Облачная АТС, Asterisk"></label>
      <label class="field">Токен вебхука<input name="token" value="${escapeHtml(config.token || '')}"
        placeholder="придумайте длинную строку и укажите её в АТС"></label>
      <button class="button">Сохранить</button>
    </form>
    <div class="hint" style="margin-top:10px">
      <b>Что передать в АТС.</b> Адрес: <code>POST https://ваш-адрес/api/telephony/webhook</code>,
      заголовок <code>X-Telephony-Token: ваш токен</code>, тело JSON:
      <code>{"from":"+79875105921","to":"+7495...","callId":"уникальный-id","at":"2026-08-27T10:00:00Z"}</code>.
      Система сама определит, кто звонит — водитель, сотрудник или контакт клиента, —
      и поднимет карточку. Повторная доставка того же callId не создаёт дубль.
    </div>
    <h2 style="margin-top:18px">Точки сервиса</h2>
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
    <table class="grid" style="margin-top:12px"><thead><tr>
      <th>Вид</th><th>Название</th><th>Адрес</th><th>Телефон</th><th>Часы</th><th></th></tr></thead>
      <tbody>${points.items.length ? points.items.map(point => `<tr>
        <td>${escapeHtml(SERVICE_KINDS.find(item => item.kind === point.kind)?.label || point.kind)}</td>
        <td><b>${escapeHtml(point.name)}</b>${point.note ? `<small class="muted" style="display:block">${escapeHtml(point.note)}</small>` : ''}</td>
        <td>${escapeHtml(point.address || point.region || '—')}</td>
        <td>${escapeHtml(point.phone || '—')}</td>
        <td>${escapeHtml(point.work_hours || '—')}</td>
        <td><button class="button ghost small danger" data-point-del="${point.id}">✕</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">Точек пока нет — водителю нечего подсказать.</td></tr>'}
      </tbody></table>`;
  byId('saveNotifyRules').onclick = async () => {
    const rules = {};
    document.querySelectorAll('[data-notify-rule]').forEach(select => {
      rules[select.dataset.notifyRule] = select.value;
    });
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ notifyRules: rules }) });
      state.admin.settings.notifyRules = rules;
      toast('Правила рассылки сохранены — действуют со следующего уведомления');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('telegramForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
        telegram: { botToken: form.elements.botToken.value.trim(),
          botName: form.elements.botName.value.trim().replace(/^@/, ''),
          driverBotToken: form.elements.driverBotToken.value.trim() }
      }) });
      state.admin.settings.telegram = { botToken: form.elements.botToken.value.trim(),
        botName: form.elements.botName.value.trim().replace(/^@/, ''),
        driverBotToken: form.elements.driverBotToken.value.trim() };
      toast('Telegram сохранён — сотрудники могут привязываться (кнопка «🔔»)');
    } catch (error) { toast(error.message, 'error'); }
  };
  byId('telephonyForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
        telephony: {
          enabled: form.elements.enabled.checked, popup: form.elements.popup.checked,
          provider: form.elements.provider.value.trim(), token: form.elements.token.value.trim()
        }
      }) });
      toast('Настройки телефонии сохранены');
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

async function render() {
  try {
    if (state.section === 'general') renderGeneral();
    else if (state.section === 'dictionaries') renderDictionaries();
    else if (state.section === 'fleet') renderFleet();
    else if (state.section === 'customers') renderCustomers();
    else if (state.section === 'users') await renderUsers();
    else if (state.section === 'network') renderNetwork();
    else if (state.section === 'telephony') await renderTelephony();
    else if (state.section === 'integration') renderIntegration();
    else if (state.section === 'outbox') renderOutbox();
  } catch (error) {
    toast(error.message, 'error');
  }
}

byId('settingsNav').onclick = event => {
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
