// Мини-приложение водителя — его рабочее место (АРМ, Э5 07.11): тот же
// каркас, что у всех, — шапка и четыре зоны (Анализ, План, Выполнение,
// Задачи). «Выполнение» — прежний «Мой рейс»: карточка рейса, этапность
// кнопкой, прогноз прибытия. Открывается из Telegram-бота (web_app-кнопка).
/* global Telegram */
import { localTimeHint } from './tz.js';
(() => {
  const tg = window.Telegram && Telegram.WebApp;
  const initData = tg ? tg.initData : '';
  if (tg) { tg.ready(); tg.expand(); }
  const app = document.getElementById('app');
  let etaAskStop = null;
  let arm = null;
  const num = value => value == null ? '—' : Number(value).toLocaleString('ru-RU');
  const zone = (icon, title, inner) => `<div class="zone"><div class="zone-h">${icon} ${esc(title)}</div>${inner}</div>`;
  const armZones = () => {
    if (!arm) return { head: '', analysis: '', plan: '', tasks: '' };
    const metric = item => `<div class="metric"><div class="l">${esc(item.label)}</div><div class="v">${num(item.value)}</div>
      ${item.note ? `<div class="d">${esc(item.note)}</div>` : ''}</div>`;
    const row = item => `<div class="row ${item.tone || ''}"><span>${esc(item.label)}</span>${item.note ? `<small>${esc(item.note)}</small>` : ''}</div>`;
    const ACT = { take: '▶ Беру', done: '✓ Сделано', fail: '✗ Не сделано' };
    const task = item => `<div class="task ${item.tone || ''}"><div><b>${esc(item.label)}</b>${item.about ? ` · ${esc(item.about)}` : ''}</div>
      ${item.body ? `<small>${esc(item.body)}</small>` : ''}<small>${esc(item.tag || '')}</small>
      ${(item.actions || []).length ? `<div class="etarow">${item.actions.map(action =>
    `<button data-task="${esc(item.id)}" data-act="${action}">${ACT[action]}</button>`).join('')}</div>` : ''}</div>`;
    const p = arm.person;
    return {
      head: `<div class="card head"><h1>${esc(p.name)}</h1><div class="muted">${esc(p.position)}${p.vehicle ? ` · ${esc(p.vehicle)}` : ''}</div></div>`,
      analysis: zone('◔', arm.zoneTitles.analysis, `<div class="card metrics">${arm.zones.analysis.map(metric).join('')}</div>`),
      plan: zone('▦', arm.zoneTitles.plan, `<div class="card">${arm.zones.plan.map(row).join('') || '<span class="muted">Ничего не истекает, следующий рейс не назначен</span>'}</div>`),
      tasks: zone('☑', arm.zoneTitles.tasks, `<div class="card">${arm.zones.tasks.map(task).join('') || '<span class="muted">Задач нет</span>'}</div>`)
    };
  };

  const esc = value => String(value ?? '').replace(/[&<>"]/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const msk = iso => iso
    ? new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ')
    : '';

  const api = async (path, payload = {}) => {
    const response = await fetch(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, ...payload }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Ошибка связи');
    return data;
  };

  const render = (state, note = '', isError = false) => {
    const z = armZones();
    if (!state.trip) {
      app.innerHTML = `${z.head || `<div class="card"><h1>Здравствуйте, ${esc(state.driver.name.split(' ')[0])}!</h1></div>`}
        ${zone('▶', 'Выполнение', `<div class="card"><p class="muted">Активного рейса сейчас нет — задание появится здесь и в чате бота при назначении.</p></div>`)}
        ${z.tasks}${z.plan}${z.analysis}
        ${note ? `<div class="note${isError ? ' err' : ''}">${esc(note)}</div>` : ''}
        <div class="refresh"><button id="reload">Обновить</button></div>`;
      wire(state);
      return;
    }
    const trip = state.trip;
    const stopsHtml = state.stops.map(stop => {
      const done = Boolean(stop.actual_departure);
      const here = Boolean(stop.actual_arrival) && !done;
      const mark = done ? '✅' : here ? '📍' : '⬜';
      const facts = [
        stop.actual_arrival ? `прибыл ${msk(stop.actual_arrival)}`
          : (stop.planned_arrival
            ? `план ${msk(stop.planned_arrival)} МСК${localTimeHint(stop.point, stop.planned_arrival)}` : ''),
        stop.actual_departure ? `убыл ${msk(stop.actual_departure)}` : '',
        !stop.actual_arrival && stop.driver_eta ? `ваш прогноз ${msk(stop.driver_eta)} МСК` : ''
      ].filter(Boolean).join(' · ');
      return `<div class="stop"><div class="mark">${mark}</div><div class="body">
        <div class="pt">${stop.kind === 'P' ? '📦' : '📥'} ${esc(stop.point)}</div>
        ${facts ? `<small>${esc(facts)}</small>` : ''}
      </div></div>`;
    }).join('');
    const showEta = etaAskStop || (state.next && state.next.phase === 'arr'
      && !state.stops.find(stop => stop.id === state.next.stopId)?.driver_eta);
    const etaStop = etaAskStop || (state.next && state.next.phase === 'arr' ? state.next.stopId : null);
    app.innerHTML = `${z.head}<div class="zone"><div class="zone-h">▶ Выполнение</div>
      <div class="card">
        <h1>Рейс ${trip.orderNo ? '№' + esc(trip.orderNo) : ''}</h1>
        <div class="muted">${esc(state.driver.name)} · ${esc(trip.plate)}${trip.trailer ? ' + ' + esc(trip.trailer) : ''}${trip.temperature ? ' · 🌡 ' + esc(trip.temperature) : ''}</div>
        <div class="route">${esc(trip.from)} → ${esc(trip.to)}</div>
        <div class="muted">погрузка ${msk(trip.startsAt)} МСК${localTimeHint(trip.from, trip.startsAt)}
          · выгрузка план ${msk(trip.endsAt)} МСК${localTimeHint(trip.to, trip.endsAt)}</div>
      </div>
      <div class="card">${stopsHtml}</div>
      ${state.next ? `<button class="bigbtn" id="stepBtn"
        data-stop="${esc(state.next.stopId)}" data-phase="${esc(state.next.phase)}">${esc(state.next.label)}</button>` : ''}
      ${showEta && etaStop ? `<div class="card"><b>⏱ Когда будете на следующей точке?</b>
        <div class="etarow">${[1, 2, 4, 6, 12].map(hours =>
    `<button data-eta="${hours}" data-stop="${esc(etaStop)}">${hours} ч</button>`).join('')}</div></div>` : ''}
      ${note ? `<div class="note${isError ? ' err' : ''}">${esc(note)}</div>` : ''}</div>
      ${z.tasks}${z.plan}${z.analysis}
      <div class="refresh"><button id="reload">Обновить</button>
        <div class="muted">Вопрос диспетчеру — напишите текстом в чате бота</div></div>`;
    wire(state);
  };

  const wire = () => {
    const stepBtn = document.getElementById('stepBtn');
    if (stepBtn) {
      stepBtn.onclick = async () => {
        stepBtn.disabled = true;
        try {
          const result = await api('/api/driver-app/step',
            { stopId: stepBtn.dataset.stop, phase: stepBtn.dataset.phase });
          etaAskStop = result.askEta ? result.askEta.stopId : null;
          if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
          render(result.state, result.message);
        } catch (error) { stepBtn.disabled = false; showError(error); }
      };
    }
    document.querySelectorAll('[data-eta]').forEach(button => {
      button.onclick = async () => {
        try {
          const result = await api('/api/driver-app/eta',
            { stopId: button.dataset.stop, hours: Number(button.dataset.eta) });
          etaAskStop = null;
          render(result.state, result.message);
        } catch (error) { showError(error); }
      };
    });
    document.querySelectorAll('[data-task]').forEach(button => {
      button.onclick = async () => {
        let result = '';
        if (button.dataset.act === 'fail') {
          result = window.prompt('Почему не сделано?') || '';
          if (!result.trim()) return;
        }
        button.disabled = true;
        try {
          const data = await api('/api/driver-app/task', { id: button.dataset.task, action: button.dataset.act, result });
          arm = data;
          if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
          render(data.state, { take: 'Взял в работу', done: 'Отмечено: сделано — руководитель увидит', fail: 'Отмечено: не сделано' }[button.dataset.act]);
        } catch (error) { button.disabled = false; showError(error); }
      };
    });
    const reload = document.getElementById('reload');
    if (reload) reload.onclick = load;
  };

  const showError = error => {
    const note = document.createElement('div');
    note.className = 'note err';
    note.textContent = error.message;
    app.appendChild(note);
  };

  const load = async () => {
    try {
      const data = await api('/api/driver-app/arm');
      arm = data;
      render(data.state);
    } catch (error) {
      app.innerHTML = `<div class="card"><b>Не получилось открыть рейс</b>
        <p class="muted">${esc(error.message)}</p></div>`;
    }
  };

  load();
  setInterval(load, 90_000);
})();
