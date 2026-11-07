// Путевые листы, Э1 (решение руководителя 07.11): база ПЛ внутри планера,
// наполнение фактом (водитель по графику, одометры из журнала, топливо
// РН-Карт), печатная форма по приказу Минтранса № 390. Подписи и обмен с
// ГИС ЭПД — этапы 2–3 (поля под медосмотр/техконтроль уже заложены).
import { api, escapeHtml, formatDateTime, toLocalInput, toast } from './api.js';

const fmtOrDash = iso => iso ? formatDateTime(iso) : '—';
const numText = waybill => `${waybill.year}-${String(waybill.number).padStart(4, '0')}`;
const STATUS = { draft: 'черновик', issued: 'выдан', closed: 'закрыт' };

// Создание (или открытие существующего) листа из рейса.
export async function waybillFromTrip(tripId, context) {
  try {
    const made = await api('/api/waybills', { method: 'POST', body: JSON.stringify({ tripId }) });
    if (made.existing) toast('Путевой лист по рейсу уже есть — открываю');
    await waybillDialog(made.id, context);
  } catch (error) { toast(error.message, 'error'); }
}

export async function waybillDialog(id, context) {
  let data;
  try { data = await api(`/api/waybills/${id}`); } catch (error) { toast(error.message, 'error'); return; }
  const w = data.waybill;
  const km = w.odo_start != null && w.odo_end != null ? w.odo_end - w.odo_start : null;
  context.showModal(`<form id="waybillForm">
    <h2>🧾 Путевой лист № ${numText(w)} <span class="badge ${w.status === 'closed' ? 'ok' : ''}">${STATUS[w.status]}</span></h2>
    <p class="muted"><span class="mono">${escapeHtml(w.plate)}${w.trailer_plate ? ` / ${escapeHtml(w.trailer_plate)}` : ''}</span>
      · ${escapeHtml(w.vehicle_model || w.type_name || '')}
      ${w.order_no ? ` · рейс № ${escapeHtml(String(w.order_no))}` : ''}
      ${w.from_point ? `<small style="display:block">${escapeHtml(w.from_point)} → ${escapeHtml(w.to_point || '')}</small>` : ''}</p>
    <div class="form-grid">
      <label class="field">Водитель<input name="driverName" value="${escapeHtml(w.driver_name || '')}"></label>
      <label class="field">Статус<select name="status">
        ${Object.entries(STATUS).map(([v, l]) => `<option value="${v}"${w.status === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <label class="field">Выезд<input type="datetime-local" name="startsAt" value="${toLocalInput(w.starts_at)}"></label>
      <label class="field">Возврат<input type="datetime-local" name="endsAt" value="${w.ends_at ? toLocalInput(w.ends_at) : ''}"></label>
      <label class="field">Одометр при выезде, км<input name="odoStart" inputmode="numeric" value="${w.odo_start ?? ''}"
        title="Автозаполнение — снимок журнала одометров на утро дня выезда; поправьте по факту"></label>
      <label class="field">Одометр при возврате, км<input name="odoEnd" inputmode="numeric" value="${w.odo_end ?? ''}"></label>
      <label class="field">Заправлено, л<input name="fuelLiters" inputmode="decimal" value="${w.fuel_liters ?? ''}"
        title="Сумма заправок РН-Карт за период (сторно учтено)"></label>
      <label class="field">Пробег по листу<input value="${km != null ? km + ' км' : '—'}" disabled></label>
      <label class="field">Предрейсовый медосмотр<input type="datetime-local" name="medPreAt" value="${w.med_pre_at ? toLocalInput(w.med_pre_at) : ''}"></label>
      <label class="field">Послерейсовый медосмотр<input type="datetime-local" name="medPostAt" value="${w.med_post_at ? toLocalInput(w.med_post_at) : ''}"></label>
      <label class="field">Предрейсовый контроль ТС<input type="datetime-local" name="techPreAt" value="${w.tech_pre_at ? toLocalInput(w.tech_pre_at) : ''}"></label>
      <label class="field">Контролёр (механик)<input name="techBy" value="${escapeHtml(w.tech_by || '')}" placeholder="ФИО механика"></label>
    </div>
    <label class="field">Заметка<input name="note" maxlength="300" value="${escapeHtml(w.note || '')}"></label>
    ${(data.signatures || []).length ? `<small class="muted" style="display:block;margin:2px 0 6px"
      title="Фундамент электронных подписей: сейчас роли подписывают бумагу, этап 2 подключит УКЭП механика и организации, УНЭП водителя (Госключ) и титул медика от МедПоинт/Тетрон">
      ✍ Подписи: ${data.signatures.map(s => `${{ dispatcher: 'диспетчер', medic: 'медик',
    mechanic: 'механик', driver: 'водитель' }[s.role]} ${s.status === 'signed' ? '✓' : '·'}`).join(' , ')}
      <span class="badge">${(data.waybill.epd_status || '') || 'без обмена с ГИС ЭПД'}</span></small>` : ''}
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Закрыть</button>
      <button type="button" class="button ghost" id="waybillPrint">🖨 Печать</button>
      <button class="button">Сохранить</button>
    </div></form>`);
  document.getElementById('waybillPrint').onclick = () => printWaybill(data);
  document.getElementById('waybillForm').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const isoOf = value => value ? new Date(value).toISOString() : null;
    try {
      await api(`/api/waybills/${id}`, { method: 'PATCH', body: JSON.stringify({
        driverName: values.driverName, status: values.status,
        startsAt: isoOf(values.startsAt), endsAt: isoOf(values.endsAt),
        odoStart: values.odoStart, odoEnd: values.odoEnd, fuelLiters: values.fuelLiters,
        medPreAt: isoOf(values.medPreAt), medPostAt: isoOf(values.medPostAt),
        techPreAt: isoOf(values.techPreAt), techBy: values.techBy, note: values.note
      }) });
      toast(`Путевой лист № ${numText(w)} сохранён`);
      context.closeModal();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Реестр листов за последние недели: открыть, печать, завести по ТС.
export async function waybillRegistry(context, data) {
  let list;
  try { list = (await api('/api/waybills')).waybills; } catch (error) { toast(error.message, 'error'); return; }
  const vehicles = (data?.vehicles || []).filter(v => v.active !== 0)
    .sort((a, b) => String(a.plate).localeCompare(String(b.plate), 'ru'));
  context.showModal(`<h2>🧾 Путевые листы <small class="muted">за 14 дней · ${list.length}</small></h2>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <select id="waybillVehicle" style="flex:1"><option value="">выдать новый лист: выберите ТС…</option>
        ${vehicles.map(v => `<option value="${v.id}">${escapeHtml(v.plate)} · ${escapeHtml(v.driver_name || 'без водителя')}</option>`).join('')}
      </select>
      <button type="button" class="button small" id="waybillNew">＋ Выдать</button>
    </div>
    <div class="list" style="max-height:52vh;overflow:auto">${list.map(w => `
      <button type="button" class="list-item" data-waybill="${w.id}" style="text-align:left">
        <span style="flex:1;min-width:0"><b>№ ${numText(w)}</b> · <span class="mono">${escapeHtml(w.plate)}</span>
          · ${escapeHtml(w.driver_name || '—')}
          <small class="muted" style="display:block">${fmtOrDash(w.starts_at)} → ${fmtOrDash(w.ends_at)}
            ${w.odo_start != null && w.odo_end != null ? ` · ${w.odo_end - w.odo_start} км` : ''}
            ${w.order_no ? ` · рейс № ${escapeHtml(String(w.order_no))}` : ''}</small></span>
        <span class="badge ${w.status === 'closed' ? 'ok' : w.status === 'issued' ? 'warn' : ''}">${STATUS[w.status]}</span>
      </button>`).join('') || '<p class="muted">Листов пока нет — выдайте первый по ТС выше или из карточки рейса.</p>'}</div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`);
  document.querySelectorAll('[data-waybill]').forEach(button =>
    button.addEventListener('click', () => waybillDialog(button.dataset.waybill, context)));
  document.getElementById('waybillNew').onclick = async () => {
    const vehicleId = document.getElementById('waybillVehicle').value;
    if (!vehicleId) { toast('Выберите ТС', 'error'); return; }
    try {
      const made = await api('/api/waybills', { method: 'POST', body: JSON.stringify({
        vehicleId, startsAt: new Date().toISOString() }) });
      await waybillDialog(made.id, context);
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Печатная форма по приказу Минтранса № 390: реквизиты, одометры, места
// подписей медика/механика/водителя/диспетчера. Юрзначимость — этап 3.
function printWaybill(data) {
  const w = data.waybill;
  const fmt = iso => iso ? formatDateTime(iso) : '«___» ________ 20__ г. ___:___';
  const km = w.odo_start != null && w.odo_end != null ? w.odo_end - w.odo_start : null;
  const sign = (role, name = '') => `<td class="sig">${role}<br>
    <span class="line">${name ? escapeHtml(name) : ''}</span><small>подпись / Ф. И. О.</small></td>`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
    <title>Путевой лист № ${numText(w)}</title><style>
      body { font: 13px/1.5 Arial, sans-serif; color: #000; margin: 24px; }
      h1 { font-size: 17px; text-align: center; margin: 0 0 2px; }
      .sub { text-align: center; margin: 0 0 14px; font-size: 12px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
      td, th { border: 1px solid #000; padding: 5px 8px; vertical-align: top; text-align: left; }
      th { background: #f0f0f0; font-weight: 600; width: 34%; }
      .sig { height: 64px; width: 25%; }
      .line { display: block; border-bottom: 1px solid #000; min-height: 22px; margin: 14px 4px 2px; }
      small { color: #555; }
      .note { font-size: 11px; color: #555; margin-top: 10px; }
      @media print { body { margin: 10mm; } }
    </style></head><body>
    <h1>ПУТЕВОЙ ЛИСТ ГРУЗОВОГО АВТОМОБИЛЯ № ${numText(w)}</h1>
    <p class="sub">${escapeHtml(data.companyName || '')} · сведения по приказу Минтранса России от 28.09.2022 № 390</p>
    <table>
      <tr><th>Срок действия</th><td>${fmt(w.starts_at)} — ${w.ends_at ? fmt(w.ends_at) : 'до завершения рейса'}</td></tr>
      <tr><th>Транспортное средство</th><td>${escapeHtml(w.vehicle_model || w.type_name || '')},
        рег. номер <b>${escapeHtml(w.plate)}</b>${w.trailer_plate
    ? `; полуприцеп ${escapeHtml(w.trailer_model || '')} ${escapeHtml(w.trailer_plate)}` : ''}</td></tr>
      <tr><th>Водитель</th><td><b>${escapeHtml(w.driver_name || '')}</b></td></tr>
      ${w.order_no || w.from_point ? `<tr><th>Задание (рейс)</th><td>${w.order_no
    ? `№ ${escapeHtml(String(w.order_no))} · ` : ''}${escapeHtml(w.from_point || '')} → ${escapeHtml(w.to_point || '')}</td></tr>` : ''}
      <tr><th>Одометр при выезде</th><td>${w.odo_start != null ? `<b>${w.odo_start}</b> км` : '__________ км'}
        · дата/время выезда: ${fmt(w.starts_at)}</td></tr>
      <tr><th>Одометр при возврате</th><td>${w.odo_end != null ? `<b>${w.odo_end}</b> км` : '__________ км'}
        · дата/время возврата: ${w.ends_at ? fmt(w.ends_at) : '«___» ________ ___:___'}</td></tr>
      <tr><th>Пробег по листу</th><td>${km != null ? `<b>${km}</b> км` : '__________ км'}</td></tr>
      <tr><th>Топливо (заправлено)</th><td>${w.fuel_liters != null ? `${w.fuel_liters} л (по данным топливного процессинга)` : '__________ л'}</td></tr>
      <tr><th>Предрейсовый медосмотр</th><td>${w.med_pre_at
    ? `${fmt(w.med_pre_at)} — прошёл предрейсовый медицинский осмотр, к исполнению трудовых обязанностей допущен`
    : 'прошёл предрейсовый медицинский осмотр, к исполнению трудовых обязанностей допущен: «___» ________ ___:___'}</td></tr>
      <tr><th>Послерейсовый медосмотр</th><td>${w.med_post_at ? fmt(w.med_post_at) : '«___» ________ ___:___'}</td></tr>
      <tr><th>Предрейсовый контроль ТС</th><td>${w.tech_pre_at
    ? `${fmt(w.tech_pre_at)} — контроль технического состояния пройден${w.tech_by ? `, контролёр: ${escapeHtml(w.tech_by)}` : ''}`
    : 'контроль технического состояния пройден: «___» ________ ___:___'}</td></tr>
      ${w.note ? `<tr><th>Отметки</th><td>${escapeHtml(w.note)}</td></tr>` : ''}
    </table>
    <table><tr>
      ${sign('Диспетчер (выдал)')}
      ${sign('Медицинский работник')}
      ${sign('Контролёр ТС (механик)', w.tech_by)}
      ${sign('Водитель', w.driver_name)}
    </tr></table>
    <p class="note">Лист сформирован планером PegasLogistic из данных учёта (журнал одометров,
      график водителей, топливный процессинг). Электронная форма и передача в ГИС ЭПД — следующий этап.</p>
    </body></html>`;
  const win = window.open('', '_blank');
  if (!win) { toast('Браузер заблокировал окно печати — разрешите всплывающие окна', 'error'); return; }
  win.document.write(html);
  win.document.close();
  setTimeout(() => { try { win.focus(); win.print(); } catch { /* окно закрыли */ } }, 400);
}
