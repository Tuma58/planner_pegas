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
      </div>`).join('')}
      ${section.count > section.items.length
        ? `<div class="muted" style="margin-left:22px;padding:4px 0">… и ещё ${section.count - section.items.length}</div>` : ''}
    </details>`;
  context.showModal(`
    <h2 style="margin-bottom:2px">${scope === 'all' ? '🧾 Инвентаризация процессов' : '🔍 Ревизия ресурса'}</h2>
    <p class="muted" style="margin:0 0 10px">Снимок на ${new Date(snapshot.generatedAt).toLocaleString('ru-RU')}.
      Всего находок: <strong>${snapshot.total}</strong>. Клик по госномеру — карточка ТС.</p>
    ${problem.map(sectionHtml).join('')}
    ${clean.length ? `<details class="inv-section"><summary style="cursor:pointer;padding:6px 0" class="muted">
      ✅ Без замечаний: ${clean.length} провер${clean.length === 1 ? 'ка' : 'ок'}</summary>
      ${clean.map(section => `<div class="muted" style="margin-left:16px;padding:2px 0">✓ ${section.title}</div>`).join('')}
    </details>` : ''}`);
}
