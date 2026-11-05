// Тема до первой отрисовки. Раньше жила инлайн-скриптом в <head>, но
// CSP (script-src 'self') инлайн блокирует — тема из кеша не применялась,
// страница мигала светлой. Внешний файл того же источника CSP пропускает.
// Отдел пользователя (цвет навигатора и каскада) — из кеша прошлого входа.
document.documentElement.dataset.theme = localStorage.getItem('pl_theme') || 'light';
const cachedDept = localStorage.getItem('pl_dept');
if (cachedDept) document.documentElement.dataset.dept = cachedDept;
if (localStorage.getItem('pl_nav') === 'collapsed') document.documentElement.dataset.nav = 'collapsed';
// Тон интерфейса (05.11, сравнение для руководителя): «Спокойный» —
// приглушённые цвета и меньше акцентов, «Яркий» — прежняя бренд-подача.
// По умолчанию спокойный; выбор живёт в браузере.
const savedTone = localStorage.getItem('pl_tone') || 'calm';
if (savedTone === 'calm') document.documentElement.dataset.tone = 'calm';
document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('toneToggle');
  if (!button) return;
  const label = () => {
    button.textContent = document.documentElement.dataset.tone === 'calm' ? 'Тон: спокойный' : 'Тон: яркий';
  };
  label();
  button.onclick = () => {
    const calm = document.documentElement.dataset.tone !== 'calm';
    if (calm) document.documentElement.dataset.tone = 'calm';
    else delete document.documentElement.dataset.tone;
    try { localStorage.setItem('pl_tone', calm ? 'calm' : 'bright'); } catch { /* приватный режим */ }
    label();
  };
});
