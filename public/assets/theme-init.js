// Тема до первой отрисовки. Раньше жила инлайн-скриптом в <head>, но
// CSP (script-src 'self') инлайн блокирует — тема из кеша не применялась,
// страница мигала светлой. Внешний файл того же источника CSP пропускает.
// Отдел пользователя (цвет навигатора и каскада) — из кеша прошлого входа.
document.documentElement.dataset.theme = localStorage.getItem('pl_theme') || 'light';
const cachedDept = localStorage.getItem('pl_dept');
if (cachedDept) document.documentElement.dataset.dept = cachedDept;
if (localStorage.getItem('pl_nav') === 'collapsed') document.documentElement.dataset.nav = 'collapsed';
