// Инвентаризация ресурса и процессов: снимок «мусора» в данных и внимании —
// дубли прицепов, забытые машины, висящие рейсы, дыры справочника водителей,
// заявки с ошибочными датами. Одна модалка на два входа: «🔍 Ревизия
// ресурса» (Ресурс) и «🧾 Инвентаризация» у руководителя (scope=all).
import { api, escapeHtml } from './api.js';

export async function inventoryDialog(context, scope = 'resource') {
  let snapshot;
  try {
    snapshot = await api(`/api/inventory?scope=${scope}`);
  } catch (error) {
    context.toast ? context.toast(error.message, 'error') : alert(error.message);
    return;
  }
  const problem = snapshot.sections.filter(section => section.count > 0);
  const clean = snapshot.sections.filter(section => !section.count);
  const sectionHtml = section => `
    <details class="inv-section" ${section.count && section.count <= 25 ? 'open' : ''}>
      <summary style="cursor:pointer;padding:6px 0">
        <strong>${section.title}</strong>
        <span class="badge ${section.count ? 'bad' : 'ok'}" style="margin-left:8px">${section.count || '✓'}</span>
        <small class="muted" style="display:block;margin-left:16px">${escapeHtml(section.hint || '')}</small>
      </summary>
      ${section.items.map(item => `<div class="list-item" style="padding:5px 10px;margin-left:12px">
        <span style="flex:1;min-width:0">
          ${item.vehicleId
            ? `<strong class="mono vlink" data-vinfo="${item.vehicleId}">${escapeHtml(item.label)}</strong>`
            : `<strong>${escapeHtml(item.label)}</strong>`}
          ${item.sub ? `<small class="muted" style="display:block">${escapeHtml(item.sub)}</small>` : ''}
        </span>
        ${item.action === 'back-to-plan' ? `<button class="button ghost small" data-inv-plan="${item.tripId}"
          title="Рейс без единой отметки вернётся в «План», шаги «задание водителю» и «на линию» снимутся — диспетчер отметит их в реальный момент выхода">↩ Вернуть в план</button>` : ''}
      </div>`).join('')}
      ${section.count > section.items.length
        ? `<div class="muted" style="margin-left:22px;padding:4px 0">… и ещё ${section.count - section.items.length}</div>` : ''}
    </details>`;
  context.showModal(`
    <h2 style="margin-bottom:2px">${scope === 'all' ? '🧾 Инвентаризация процессов' : '🔍 Ревизия ресурса'}</h2>
    <p class="muted" style="margin:0 0 10px">Снимок на ${new Date(snapshot.generatedAt).toLocaleString('ru-RU')}.
      Всего находок: <strong>${snapshot.total}</strong>. Клик по госномеру — карточка ТС.</p>
    <p style="margin:0 0 10px"><button class="button small" id="invAutoFix"
      title="Чинит то, что не требует решения человека: хвостовые пробелы в закреплениях, уволенных в карточках ТС, пустые геозоны адресов; негеокоженные адреса отправляет геокодеру на новый круг с упрощением запроса">⚙ Исправить автоматически</button></p>
    ${problem.map(sectionHtml).join('')}
    ${clean.length ? `<details class="inv-section"><summary style="cursor:pointer;padding:6px 0" class="muted">
      ✅ Без замечаний: ${clean.length} провер${clean.length === 1 ? 'ка' : 'ок'}</summary>
      ${clean.map(section => `<div class="muted" style="margin-left:16px;padding:2px 0">✓ ${section.title}</div>`).join('')}
    </details>` : ''}`);
  document.querySelectorAll('[data-inv-plan]').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`/api/trips/${button.dataset.invPlan}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'plan' }) });
        inventoryDialog(context, scope);
      } catch (error) { alert(error.message); button.disabled = false; }
    };
  });
  document.getElementById('invAutoFix').onclick = async event => {
    event.currentTarget.disabled = true;
    try {
      const result = await api('/api/inventory/fix', { method: 'POST', body: '{}' });
      const f = result.fixed || {};
      const parts = [
        f.trimmedNames && `пробелы в закреплениях: ${f.trimmedNames}`,
        f.firedUnlinked && `отвязано уволенных: ${f.firedUnlinked}`,
        f.firedNamesCleared && `очищено карточек ТС от уволенных: ${f.firedNamesCleared}`,
        f.zonesFilled && `зоны адресов: ${f.zonesFilled}`,
        f.geocodeRetries && `адресов на повторный геокодинг: ${f.geocodeRetries} (по 1 в 90 с)`
      ].filter(Boolean);
      alert(parts.length ? `Исправлено:\n— ${parts.join('\n— ')}` : 'Автоматически исправимого не нашлось — остальное требует решения человека.');
      inventoryDialog(context, scope);
    } catch (error) {
      alert(error.message);
      event.target.disabled = false;
    }
  };
}
