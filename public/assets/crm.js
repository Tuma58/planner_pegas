// Экран «🤝 CRM» (группа планирования и анализа) и «💳 К оплате»
// (бухгалтерия) — замыкаем деньги клиента (решение руководителя 07.11.2026).
// Договор → срок оплаты рейса (выгрузка + отсрочка) → дебиторка → оплата.
// Нет договора — срок неизвестен, так и пишем («нет договора»); константу
// не подставляем. Деньги без НДС — канон src/money.mjs (считает сервер).
// Полная карточка клиента — существующая customer-card.js (не дублируем).
import { api, escapeHtml, money, toast, renderInto } from './api.js';
import { customerCardDialog } from './customer-card.js';

const TABS = [['clients', 'Клиенты'], ['debt', 'Дебиторка'], ['funnel', 'Воронка'], ['contracts', 'Договоры']];
const STATUS_LABEL = { plan: 'план', run: 'в пути', unloaded: 'выгружен', done: 'закрыт', paid: 'оплачен' };
const CLAIM_LABEL = { new: 'ждёт выставления', billed: 'выставлена' };

const rub = value => value == null ? '—' : money(value);
const ruDay = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '—';
const attr = value => escapeHtml(value ?? '');

// Срок оплаты рейса: дата, «нет договора» или «из карточки».
function dueCell(row) {
  if (!row.dueDay) return '<span class="bi-tag warn" title="Нет договора и отсрочки в карточке — срок оплаты неизвестен">нет договора</span>';
  const src = row.source === 'profile' ? ' <small class="muted" title="Отсрочка из карточки клиента — договор в CRM не заведён">карточка</small>'
    : row.contractOutOfTerm ? ' <small class="muted" title="На дату выгрузки договор не действовал — взяты его условия">вне срока</small>' : '';
  return `${ruDay(row.dueDay)} <small class="muted">${row.paymentDays} дн</small>${src}`;
}
function overdueCell(row) {
  if (!row.dueDay) return '<span class="muted">—</span>';
  return row.overdue ? `<span class="bi-tag neg">${row.overdueDays} дн</span>` : '<span class="bi-tag pos">в срок</span>';
}
const termsLabel = customer => customer.contract
  ? `№ ${escapeHtml(customer.contract.number || 'б/н')} · ${customer.contract.paymentDays != null ? `${customer.contract.paymentDays} дн` : 'отсрочка не указана'}${customer.contract.outOfTerm ? ' <span class="bi-tag warn">истёк</span>' : ''}`
  : customer.profileDays != null
    ? `<span class="muted" title="Договор в CRM не заведён — отсрочка из карточки клиента">карточка · ${customer.profileDays} дн</span>`
    : '<span class="bi-tag warn">нет договора</span>';

// Реестр рейсов к оплате — общий для «Дебиторки» и «К оплате».
function registryTable(rows, { canPay, showCustomer = true }) {
  if (!rows.length) return '<div class="bi-empty">Рейсов к оплате нет</div>';
  return `<div class="bi-scroll"><table class="bi-table crm-registry"><thead><tr>
      <th>Заявка</th>${showCustomer ? '<th>Клиент</th>' : ''}<th>Маршрут</th><th>ТС</th><th>Статус</th>
      <th>Выгрузка</th><th>Срок оплаты</th><th>Просрочка</th><th class="r">Без НДС</th>${canPay ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows.map(row => `<tr class="${row.overdue ? 'crm-overdue' : ''}">
      <td class="mono">${escapeHtml(row.orderNo || row.id.slice(0, 8))}</td>
      ${showCustomer ? `<td><a href="#" data-crm-open="${attr(row.customer)}">${escapeHtml(row.customer)}</a></td>` : ''}
      <td>${escapeHtml(row.route)}</td><td class="mono">${escapeHtml(row.plate)}</td>
      <td>${STATUS_LABEL[row.status] || escapeHtml(row.status)}</td>
      <td>${ruDay(row.unloadDay)}</td><td>${dueCell(row)}</td><td>${overdueCell(row)}</td>
      <td class="num">${rub(row.net)}</td>
      ${canPay ? `<td><button type="button" class="button small ghost" data-crm-pay="${attr(row.id)}"
        data-crm-pay-label="${attr(`${row.orderNo || row.id.slice(0, 8)} · ${row.customer}`)}">✓ Оплачено</button></td>` : ''}
    </tr>`).join('')}</tbody></table></div>`;
}

function totalsKpis(t, money_) {
  return `<div class="bi-kpis">
    <div class="metric dept-staff hero"><span class="l">К оплате</span><span class="v">${money_ ? rub(t.net) : t.count}</span>
      <span class="d">${t.count} рейсов выгружено, не оплачено</span></div>
    <div class="metric ${t.overdueCount ? 'neg' : 'pos'}"><span class="l">Просрочено</span><span class="v">${money_ ? rub(t.overdueNet) : t.overdueCount}</span>
      <span class="d">${t.overdueCount} рейсов${t.maxOverdueDays ? ` · до ${t.maxOverdueDays} дн` : ''}</span></div>
    <div class="metric ${t.noTermsCount ? 'warn' : ''}"><span class="l">Срок неизвестен</span><span class="v">${money_ ? rub(t.noTermsNet) : t.noTermsCount}</span>
      <span class="d">${t.noTermsCount} рейсов без договора</span></div>
    <div class="metric"><span class="l">Самый старый долг</span><span class="v">${ruDay(t.oldestDay)}</span>
      <span class="d">дата выгрузки</span></div>
  </div>`;
}

async function payTrip(id, label, after, context) {
  if (!confirm(`Отметить рейс ${label} оплаченным?`)) return;
  try {
    await api(`/api/trips/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'paid' }) });
    toast('Рейс отмечен оплаченным');
    after();
    context.onReload?.();
  } catch (error) { toast(error.message, 'error'); }
}

// ── Сводная CRM-карточка клиента (окно): договор, долг, рейсы, претензии, контакты ──
async function customerDialog(name, context) {
  let data;
  try { data = await api(`/api/crm/customer?name=${encodeURIComponent(name)}`); } catch (error) { toast(error.message, 'error'); return; }
  const c = data.contract;
  const t = data.totals;
  context.showModal(`<div class="crm-modal"><h2>${escapeHtml(name)}</h2>
    <div class="bi-kpis">
      <div class="metric dept-staff"><span class="l">К оплате</span><span class="v">${data.money ? rub(t.net) : t.count}</span><span class="d">${t.count} рейсов</span></div>
      <div class="metric ${t.overdueCount ? 'neg' : 'pos'}"><span class="l">Просрочено</span><span class="v">${data.money ? rub(t.overdueNet) : t.overdueCount}</span>
        <span class="d">${t.overdueCount} рейсов${t.maxOverdueDays ? ` · до ${t.maxOverdueDays} дн` : ''}</span></div>
      <div class="metric"><span class="l">Самый старый долг</span><span class="v">${ruDay(t.oldestDay)}</span></div>
      ${data.money ? `<div class="metric ${data.claims.newSum ? 'warn' : ''}"><span class="l">Простой: ждёт выставления</span><span class="v">${rub(data.claims.newSum)}</span>
        <span class="d">выставлено ${rub(data.claims.billedSum)}</span></div>` : ''}
    </div>
    <section class="section"><div class="sec-h"><span class="st">Договор</span>
      <div class="sec-actions"><button type="button" class="button small ghost" id="crmCardFull">📇 Карточка</button></div></div>
      <div class="sec-b">${c ? `<div class="bi-row"><span class="k">Номер</span><span class="v">${escapeHtml(c.number || 'б/н')}</span></div>
        <div class="bi-row"><span class="k">Подписан · действует до</span><span class="v">${ruDay(c.signed_on)} · ${ruDay(c.valid_to)}${c.outOfTerm ? ' <span class="bi-tag warn">не действует</span>' : ''}</span></div>
        <div class="bi-row"><span class="k">Отсрочка оплаты</span><span class="v">${c.payment_days != null ? `${c.payment_days} дн` : 'не указана'}</span></div>
        ${c.tariff_note ? `<div class="bi-row"><span class="k">Тарифы</span><span class="v crm-note">${escapeHtml(c.tariff_note)}</span></div>` : ''}
        ${c.demurrage_note ? `<div class="bi-row"><span class="k">Простой</span><span class="v crm-note">${escapeHtml(c.demurrage_note)}</span></div>` : ''}`
    : `<div class="bi-empty">Договор в CRM не заведён${data.profileDays != null ? ` — отсрочка из карточки клиента: ${data.profileDays} дн` : ' — срок оплаты рейсов неизвестен'}</div>`}</div></section>
    <section class="section"><div class="sec-h"><span class="st">Рейсы к оплате</span><span class="hint">${t.count}</span></div>
      <div class="sec-b flush">${registryTable(data.receivables, { canPay: false, showCustomer: false })}</div></section>
    <section class="section"><div class="sec-h"><span class="st">Последние рейсы</span></div><div class="sec-b flush">
      ${data.lastTrips.length ? `<table class="bi-table"><thead><tr><th>Заявка</th><th>Маршрут</th><th>ТС</th><th>Статус</th><th>Выгрузка</th><th class="r">Без НДС</th></tr></thead>
        <tbody>${data.lastTrips.map(row => `<tr><td class="mono">${escapeHtml(row.orderNo || row.id.slice(0, 8))}</td><td>${escapeHtml(row.route)}</td>
          <td class="mono">${escapeHtml(row.plate)}</td><td>${STATUS_LABEL[row.status] || escapeHtml(row.status)}</td><td>${ruDay(row.unloadDay)}</td>
          <td class="num">${rub(row.net)}</td></tr>`).join('')}</tbody></table>` : '<div class="bi-empty">Рейсов не было</div>'}</div></section>
    <section class="section"><div class="sec-h"><span class="st">Претензии за простой</span></div><div class="sec-b flush">
      ${data.claims.rows.length ? `<table class="bi-table"><thead><tr><th>День</th><th>Заявка</th><th>Точка</th><th class="r">Часы</th><th>Статус</th><th class="r">Сумма</th></tr></thead>
        <tbody>${data.claims.rows.map(row => `<tr><td>${ruDay(row.created_day)}</td><td class="mono">${escapeHtml(row.order_no)}</td>
          <td>${row.stop_kind === 'load' ? 'погрузка' : 'выгрузка'} · ${escapeHtml(row.point)}</td><td class="num">${row.paid_hours}</td>
          <td>${CLAIM_LABEL[row.status] || escapeHtml(row.status)}</td><td class="num">${rub(row.amount)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="bi-empty">Претензий нет</div>'}</div></section>
    <section class="section"><div class="sec-h"><span class="st">Контакты</span></div><div class="sec-b">
      ${data.contacts.map(row => `<div class="bi-row"><span class="k">${escapeHtml(row.full_name)}${row.position ? ` <small class="muted">${escapeHtml(row.position)}</small>` : ''}</span>
        <span class="v">${escapeHtml([row.phone, row.email].filter(Boolean).join(' · ') || '—')}</span></div>`).join('')
      || '<div class="bi-empty">Контактов нет — добавьте в «📇 Карточке»</div>'}</div></section>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div></div>`);
  document.querySelector('#crmCardFull').onclick = () => { context.closeModal(); customerCardDialog(name, context); };
}

// ── Договор: форма ──
function contractDialog(context, contract, customers, after) {
  const c = contract || {};
  context.showModal(`<form id="crmContractForm"><h2>${contract ? 'Договор клиента' : 'Новый договор'}</h2>
    <label class="field">Клиент <input name="customerName" list="crmCustomerList" required value="${attr(c.customer_name)}"></label>
    <datalist id="crmCustomerList">${customers.map(name => `<option value="${attr(name)}">`).join('')}</datalist>
    <label class="field">Номер договора <input name="number" value="${attr(c.number)}"></label>
    <label class="field">Подписан <input type="date" name="signedOn" value="${attr(c.signed_on)}"></label>
    <label class="field">Действует до <input type="date" name="validTo" value="${attr(c.valid_to)}"></label>
    <label class="field">Отсрочка оплаты, дней <input type="number" min="0" step="1" name="paymentDays" value="${c.payment_days ?? ''}"
      placeholder="пусто — срок оплаты неизвестен"></label>
    <label class="field">Тарифы <textarea name="tariffNote" rows="2">${escapeHtml(c.tariff_note || '')}</textarea></label>
    <label class="field">Условия простоя <textarea name="demurrageNote" rows="2">${escapeHtml(c.demurrage_note || '')}</textarea></label>
    <label class="field">Примечание <textarea name="note" rows="2">${escapeHtml(c.note || '')}</textarea></label>
    <div class="form-error" id="crmContractErr"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      ${contract ? '<button type="button" class="button danger" id="crmContractDel">Удалить</button>' : ''}
      <button class="button primary">Сохранить</button></div></form>`);
  const form = document.querySelector('#crmContractForm');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const body = Object.fromEntries(['customerName', 'number', 'signedOn', 'validTo', 'paymentDays', 'tariffNote', 'demurrageNote', 'note']
      .map(key => [key, form[key].value]));
    try {
      await api(contract ? `/api/crm/contracts/${encodeURIComponent(contract.id)}` : '/api/crm/contracts',
        { method: contract ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      context.closeModal(); toast('Договор сохранён'); after();
    } catch (error) { document.querySelector('#crmContractErr').textContent = error.message; }
  });
  const del = document.querySelector('#crmContractDel');
  if (del) {
    del.onclick = async () => {
      if (!confirm(`Удалить договор ${c.number || 'б/н'} клиента ${c.customer_name}?`)) return;
      try {
        await api(`/api/crm/contracts/${encodeURIComponent(contract.id)}`, { method: 'DELETE' });
        context.closeModal(); toast('Договор удалён'); after();
      } catch (error) { document.querySelector('#crmContractErr').textContent = error.message; }
    };
  }
}

// ── Лид: форма ──
function leadDialog(context, lead, data, after, presetStage = '') {
  const l = lead || { stage: presetStage || 'new' };
  const nextLocal = l.next_at ? String(l.next_at).slice(0, 10) : '';
  context.showModal(`<form id="crmLeadForm"><h2>${lead ? escapeHtml(l.company) : 'Новый потенциальный клиент'}</h2>
    <label class="field">Компания <input name="company" required value="${attr(l.company)}"></label>
    <label class="field">Контакт <input name="contact" value="${attr(l.contact)}"></label>
    <label class="field">Телефон <input name="phone" type="tel" value="${attr(l.phone)}"></label>
    <label class="field">Почта <input name="email" type="email" value="${attr(l.email)}"></label>
    <label class="field">Источник <input name="source" value="${attr(l.source)}" placeholder="звонок, сайт, рекомендация…"></label>
    <label class="field">Стадия <select name="stage">${data.stages.map(([id, label]) =>
    `<option value="${id}" ${l.stage === id ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>
    <label class="field">Следующий шаг <input name="nextStep" value="${attr(l.next_step)}"></label>
    <label class="field">Когда <input type="date" name="nextAt" value="${attr(nextLocal)}"></label>
    ${data.money ? `<label class="field">Оценка сделки, ₽/мес <input type="number" min="0" step="1000" name="amountEstimate" value="${l.amount_estimate ?? ''}"></label>` : ''}
    <label class="field">Ответственный <input name="ownerName" value="${attr(l.owner_name)}"></label>
    <label class="field crm-lost-field">Причина отказа <input name="lostReason" value="${attr(l.lost_reason)}" placeholder="обязательно для «Отказ»"></label>
    <label class="field crm-won-field">Клиент планера <input name="wonCustomerName" list="crmLeadCustomers" value="${attr(l.won_customer_name)}"
      placeholder="связать с клиентом в планере"></label>
    <datalist id="crmLeadCustomers">${data.customers.map(name => `<option value="${attr(name)}">`).join('')}</datalist>
    <div class="form-error" id="crmLeadErr"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button><button class="button primary">Сохранить</button></div></form>`);
  const form = document.querySelector('#crmLeadForm');
  const sync = () => {
    form.querySelector('.crm-lost-field').hidden = form.stage.value !== 'lost';
    form.querySelector('.crm-won-field').hidden = form.stage.value !== 'won';
    form.lostReason.required = form.stage.value === 'lost';
  };
  form.stage.onchange = sync;
  sync();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const body = Object.fromEntries(['company', 'contact', 'phone', 'email', 'source', 'stage', 'nextStep', 'ownerName', 'lostReason', 'wonCustomerName']
      .map(key => [key, form[key].value]));
    body.nextAt = form.nextAt.value || null;
    if (form.amountEstimate) body.amountEstimate = form.amountEstimate.value;
    try {
      await api(lead ? `/api/crm/leads/${encodeURIComponent(lead.id)}` : '/api/crm/leads',
        { method: lead ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      context.closeModal(); toast('Сохранено'); after();
    } catch (error) { document.querySelector('#crmLeadErr').textContent = error.message; }
  });
}

// ── Вкладки ──
function clientsTab(data, filter) {
  const q = filter.trim().toLowerCase();
  const list = data.customers.filter(item => !q || item.name.toLowerCase().includes(q));
  const cov = data.coverage;
  return `${totalsKpis(data.totals, data.money)}
    <div class="bi-grid"><section class="section s12"><div class="sec-h"><span class="st">Клиенты</span>
      <span class="hint">договор есть у ${cov.withContract} из ${cov.withTrips} клиентов с рейсами · срок оплаты известен у ${cov.withTerms}</span>
      <div class="sec-actions"><input type="search" id="crmSearch" class="block-search" placeholder="Поиск клиента" value="${attr(filter)}"></div></div>
      <div class="sec-b flush">${list.length ? `<div class="bi-scroll"><table class="bi-table"><thead><tr>
        <th>Клиент</th><th>Договор · отсрочка</th><th class="r">Рейсов</th><th>Последний рейс</th>
        <th class="r">К оплате</th><th class="r">Просрочено</th><th>Старейший долг</th><th class="r">Простой к выставлению</th><th class="r">Контакты</th><th></th></tr></thead>
        <tbody>${list.map(item => `<tr>
          <td><a href="#" data-crm-open="${attr(item.name)}">${escapeHtml(item.name)}</a></td>
          <td>${termsLabel(item)}</td><td class="num">${item.trips}</td><td>${ruDay(item.lastTripAt)}</td>
          <td class="num">${item.debt ? (data.money ? rub(item.debt.net) : item.debt.count) : '—'}</td>
          <td class="num">${item.debt?.overdueCount ? `<span class="crm-bad">${data.money ? rub(item.debt.overdueNet) : item.debt.overdueCount}</span>` : '—'}</td>
          <td>${item.debt ? `${ruDay(item.debt.oldestDay)}${item.debt.maxOverdueDays ? ` <small class="muted">просрочка ${item.debt.maxOverdueDays} дн</small>` : ''}` : '—'}</td>
          <td class="num">${item.claims?.newCount ? (data.money ? rub(item.claims.newSum) : item.claims.newCount) : '—'}</td>
          <td class="num">${item.contacts || '—'}</td>
          <td><button type="button" class="button small ghost" data-crm-card="${attr(item.name)}">📇 Карточка</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="bi-empty">Клиентов не найдено</div>'}</div></section></div>`;
}

function debtTab(data) {
  return `${totalsKpis(data.totals, data.money)}
    <div class="bi-grid">
      <section class="section s12 dept-staff"><div class="sec-h"><span class="st">Свод по клиентам</span>
        <span class="hint">рейс к оплате — выгружен или закрыт, не оплачен; срок = дата выгрузки + отсрочка договора</span></div>
        <div class="sec-b flush">${data.byCustomer.length ? `<div class="bi-scroll"><table class="bi-table"><thead><tr><th>Клиент</th>
          <th class="r">Рейсов</th><th class="r">К оплате</th><th class="r">Просрочено</th><th class="r">Без договора</th>
          <th>Старейший долг</th><th>Ближайший срок</th></tr></thead><tbody>${data.byCustomer.map(item => `<tr>
          <td><a href="#" data-crm-open="${attr(item.customer)}">${escapeHtml(item.customer)}</a></td><td class="num">${item.count}</td>
          <td class="num">${rub(item.net)}</td>
          <td class="num">${item.overdueCount ? `<span class="crm-bad">${rub(item.overdueNet)}</span> <small class="muted">${item.overdueCount} р · до ${item.maxOverdueDays} дн</small>` : '—'}</td>
          <td class="num">${item.noTermsCount ? `${rub(item.noTermsNet)} <small class="muted">${item.noTermsCount} р</small>` : '—'}</td>
          <td>${ruDay(item.oldestDay)}</td><td>${ruDay(item.nextDueDay)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="bi-empty">Долгов нет</div>'}</div></section>
      <section class="section s12"><div class="sec-h"><span class="st">Реестр рейсов к оплате</span><span class="hint">по сроку оплаты</span></div>
        <div class="sec-b flush">${registryTable(data.rows, { canPay: data.canPay })}</div></section>
    </div>`;
}

function funnelTab(data) {
  const s = data.stats;
  const byStage = new Map(data.stages.map(([id]) => [id, []]));
  for (const lead of data.leads) byStage.get(lead.stage)?.push(lead);
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="bi-kpis">
      <div class="metric dept-log"><span class="l">В работе</span><span class="v">${s.open}</span><span class="d">потенциальных клиентов</span></div>
      <div class="metric pos"><span class="l">Стали клиентами</span><span class="v">${s.byStage.won.count}</span></div>
      <div class="metric"><span class="l">Конверсия</span><span class="v">${s.winRate == null ? '—' : `${Math.round(s.winRate * 100)}<small>%</small>`}</span>
        <span class="d">${s.closed ? `из ${s.closed} закрытых` : 'закрытых сделок ещё нет'}</span></div>
      <div class="metric ${s.overdueSteps ? 'warn' : ''}"><span class="l">Шаг просрочен</span><span class="v">${s.overdueSteps}</span></div>
      ${s.lostReasons.length ? `<div class="metric neg"><span class="l">Частая причина отказа</span><span class="v crm-reason">${escapeHtml(s.lostReasons[0].reason)}</span>
        <span class="d">${s.lostReasons[0].count} из ${s.byStage.lost.count}</span></div>` : ''}
    </div>
    <div class="bi-board crm-board">${data.stages.map(([id, label]) => `<section class="section crm-col crm-st-${id}">
      <div class="sec-h"><span class="st">${escapeHtml(label)}</span><span class="hint">${byStage.get(id).length}${data.money && s.byStage[id].amount ? ` · ${rub(s.byStage[id].amount)}` : ''}</span>
        ${data.canWrite && !['won', 'lost'].includes(id) ? `<div class="sec-actions"><button type="button" class="button small ghost" data-crm-lead-new="${id}">＋</button></div>` : ''}</div>
      <div class="sec-b crm-cards">${byStage.get(id).map(lead => `<div class="crm-lead ${lead.next_at && lead.next_at.slice(0, 10) < today && !['won', 'lost'].includes(lead.stage) ? 'late' : ''}" data-crm-lead="${attr(lead.id)}">
        <b>${escapeHtml(lead.company)}</b>
        ${lead.contact || lead.phone ? `<small class="muted">${escapeHtml([lead.contact, lead.phone].filter(Boolean).join(' · '))}</small>` : ''}
        ${lead.next_step ? `<small>→ ${escapeHtml(lead.next_step)}${lead.next_at ? ` · ${ruDay(lead.next_at)}` : ''}</small>` : ''}
        ${lead.stage === 'lost' ? `<small class="crm-bad">${escapeHtml(lead.lost_reason)}</small>` : ''}
        ${lead.stage === 'won' && lead.won_customer_name ? `<small>📇 ${escapeHtml(lead.won_customer_name)}</small>` : ''}
        <span class="crm-lead-foot">${lead.owner_name ? `<span class="muted">${escapeHtml(lead.owner_name)}</span>` : ''}
          ${data.money && lead.amount_estimate ? `<span class="mono">${rub(lead.amount_estimate)}</span>` : ''}</span>
      </div>`).join('') || '<div class="bi-empty">пусто</div>'}</div></section>`).join('')}</div>`;
}

function contractsTab(data) {
  return `<div class="bi-grid"><section class="section s12"><div class="sec-h"><span class="st">Договоры и тарифы</span>
      <span class="hint">отсрочка оплаты договора задаёт срок оплаты каждого рейса</span>
      ${data.canWrite ? '<div class="sec-actions"><button type="button" class="button small primary" id="crmContractNew">＋ Договор</button></div>' : ''}</div>
    <div class="sec-b flush">${data.contracts.length ? `<div class="bi-scroll"><table class="bi-table"><thead><tr><th>Клиент</th><th>Номер</th>
      <th>Подписан</th><th>Действует до</th><th class="r">Отсрочка</th><th>Тарифы</th><th>Простой</th><th></th></tr></thead>
      <tbody>${data.contracts.map(row => `<tr class="${row.valid_to && row.valid_to < data.today ? 'crm-expired' : ''}">
        <td><a href="#" data-crm-open="${attr(row.customer_name)}">${escapeHtml(row.customer_name)}</a></td><td>${escapeHtml(row.number || 'б/н')}</td>
        <td>${ruDay(row.signed_on)}</td><td>${ruDay(row.valid_to)}${row.valid_to && row.valid_to < data.today ? ' <span class="bi-tag warn">истёк</span>' : ''}</td>
        <td class="num">${row.payment_days != null ? `${row.payment_days} дн` : '<span class="muted">не указана</span>'}</td>
        <td class="crm-note">${escapeHtml(row.tariff_note)}</td><td class="crm-note">${escapeHtml(row.demurrage_note)}</td>
        <td>${data.canWrite ? `<button type="button" class="button small ghost" data-crm-contract="${attr(row.id)}">Изменить</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="bi-empty">Договоров пока нет — без договора срок оплаты рейсов неизвестен</div>'}</div></section></div>`;
}

const TAB_URL = { clients: '/api/crm/summary', debt: '/api/crm/receivables', funnel: '/api/crm/leads', contracts: '/api/crm/contracts' };

export async function renderCrm(container, context) {
  const { state } = context;
  const tab = TAB_URL[state.crmTab] ? state.crmTab : 'clients';
  let data;
  try { data = await api(TAB_URL[tab]); } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const reload = () => renderCrm(container, context);
  const draw = () => {
    const body = tab === 'clients' ? clientsTab(data, state.crmFilter || '') : tab === 'debt' ? debtTab(data)
      : tab === 'funnel' ? funnelTab(data) : contractsTab(data);
    renderInto(container, `<div class="bi-page crm-page">
      <div class="bi-sub"><h2>CRM · деньги клиента</h2>
        <p>Договор → срок оплаты рейса → дебиторка. Суммы без НДС. Нет договора — срок неизвестен.</p>
        <div class="bi-actions"><span class="segmented">${TABS.map(([id, label]) =>
    `<button type="button" data-crm-tab="${id}" class="${id === tab ? 'active' : ''}">${label}</button>`).join('')}</span>
          ${tab === 'funnel' && data.canWrite ? '<button type="button" class="button small primary" id="crmLeadNew">＋ Лид</button>' : ''}</div></div>
      ${body}</div>`);
  };
  draw();
  const search = container.querySelector('#crmSearch');
  if (search) search.oninput = event => { state.crmFilter = event.currentTarget.value; draw(); };
  container.onclick = event => {
    const el = event.target.closest('[data-crm-tab],[data-crm-open],[data-crm-card],[data-crm-pay],[data-crm-lead],[data-crm-lead-new],[data-crm-contract],#crmLeadNew,#crmContractNew');
    if (!el) return;
    event.preventDefault();
    if (el.dataset.crmTab) { state.crmTab = el.dataset.crmTab; reload(); return; }
    if (el.dataset.crmOpen) { customerDialog(el.dataset.crmOpen, context); return; }
    if (el.dataset.crmCard) { customerCardDialog(el.dataset.crmCard, context); return; }
    if (el.dataset.crmPay) { payTrip(el.dataset.crmPay, el.dataset.crmPayLabel, reload, context); return; }
    if (el.id === 'crmLeadNew' || el.dataset.crmLeadNew) { leadDialog(context, null, data, reload, el.dataset.crmLeadNew || 'new'); return; }
    if (el.dataset.crmLead) {
      if (!data.canWrite) return;
      leadDialog(context, data.leads.find(lead => lead.id === el.dataset.crmLead), data, reload);
      return;
    }
    if (el.id === 'crmContractNew') { contractDialog(context, null, data.customers, reload); return; }
    if (el.dataset.crmContract) contractDialog(context, data.contracts.find(row => row.id === el.dataset.crmContract), data.customers, reload);
  };
}

// ── «💳 К оплате» (бухгалтерия): реестр по сроку, кнопка «Оплачено» ──
export async function renderPayments(container, context) {
  const { state } = context;
  let data;
  try { data = await api('/api/crm/receivables'); } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const reload = () => renderPayments(container, context);
  const filters = [['', `Все ${data.totals.count}`], ['overdue', `Просрочено ${data.totals.overdueCount}`],
    ['noterms', `Нет договора ${data.totals.noTermsCount}`]];
  const draw = () => {
    const mode = state.payFilter || '';
    const who = state.payCustomer || '';
    const rows = data.rows.filter(row => (mode === 'overdue' ? row.overdue : mode === 'noterms' ? !row.dueDay : true)
      && (!who || row.customer === who));
    const sum = rows.reduce((acc, row) => acc + (row.net || 0), 0);
    renderInto(container, `<div class="bi-page crm-page crm-pay">
      <div class="bi-sub"><h2>Рейсы к оплате</h2>
        <p>Выгружен или закрыт, не оплачен. Срок = дата выгрузки + отсрочка договора; суммы без НДС.</p>
        <div class="bi-actions"><span class="segmented">${filters.map(([id, label]) =>
    `<button type="button" data-pay-filter="${id}" class="${id === mode ? 'active' : ''}">${label}</button>`).join('')}</span>
          <select id="payCustomer"><option value="">Все клиенты</option>${data.byCustomer.map(item =>
    `<option value="${attr(item.customer)}" ${item.customer === who ? 'selected' : ''}>${escapeHtml(item.customer)} · ${item.count}</option>`).join('')}</select></div></div>
      ${totalsKpis(data.totals, data.money)}
      <div class="bi-grid"><section class="section s12 dept-staff"><div class="sec-h"><span class="st">Реестр</span>
        <span class="hint">${rows.length} рейсов${data.money ? ` · ${rub(sum)}` : ''}</span></div>
        <div class="sec-b flush">${registryTable(rows, { canPay: data.canPay })}</div></section></div></div>`);
    const select = container.querySelector('#payCustomer');
    select.onchange = event => { state.payCustomer = event.currentTarget.value; draw(); };
  };
  draw();
  container.onclick = event => {
    const el = event.target.closest('[data-pay-filter],[data-crm-pay],[data-crm-open]');
    if (!el) return;
    event.preventDefault();
    if (el.dataset.payFilter !== undefined) { state.payFilter = el.dataset.payFilter; draw(); return; }
    if (el.dataset.crmPay) { payTrip(el.dataset.crmPay, el.dataset.crmPayLabel, reload, context); return; }
    if (el.dataset.crmOpen) customerDialog(el.dataset.crmOpen, context);
  };
}
