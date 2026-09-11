// «🧠 Живые нормативы» в блоке руководителя: реестр самообучающихся
// процессов системы — канонические имена, что каждый учит, текущее
// выученное значение, кламп здравого смысла и где смотреть дрейф.
// Руководитель обращается к процессам по этим именам.
import { api, escapeHtml } from './api.js';

export async function selfTuningDialog(context) {
  let registry;
  try {
    registry = await api('/api/self-tuning');
  } catch (error) {
    context.toast ? context.toast(error.message, 'error') : alert(error.message);
    return;
  }
  const rowHtml = item => `
    <div class="list-item" style="padding:8px 10px;align-items:flex-start">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(item.name)}</strong>
        <small class="muted" style="display:block">${escapeHtml(item.learns)}</small>
        <small style="display:block;margin-top:2px">Сейчас: <strong>${escapeHtml(String(item.value))}</strong></small>
        <small class="muted" style="display:block">Кламп: ${escapeHtml(item.clamp)} · Дрейф: ${escapeHtml(item.drift)}</small>
      </span>
    </div>`;
  context.showModal(`
    <h2 style="margin-bottom:2px">🧠 Живые нормативы</h2>
    <p class="muted" style="margin:0 0 10px">Самообучающиеся процессы системы:
      факт → норматив → решение → отчёт о дрейфе. Руками задаются только цели
      (Настройки), остальное выучено из фактов и ограничено клампом здравого
      смысла. Снимок на ${new Date(registry.generatedAt).toLocaleString('ru-RU')}.</p>
    <div style="max-height:64vh;overflow:auto">${registry.items.map(rowHtml).join('')}</div>`);
}
