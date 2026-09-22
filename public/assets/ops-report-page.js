// Клиентский скрипт страницы /ops-report (CSP запрещает инлайн-JS).
// Подключается в <head> без defer: тема из localStorage применяется до
// отрисовки, остальное вешается по DOMContentLoaded.
(() => {
  'use strict';

  // Тема: запомненный выбор пользователя главнее параметра ?theme= из
  // iframe планера (жалоба 22.09: перерисовка главной сбрасывала тёмную
  // тему отчёта). Параметр остаётся стартовым дефолтом до первого выбора.
  try {
    const saved = localStorage.getItem('opsTheme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* приватный режим без localStorage — тема из параметра/системная */ }

  document.addEventListener('DOMContentLoaded', () => {
    // Подсказки у точек и столбцов графиков.
    const tip = document.getElementById('tip');
    if (tip) document.addEventListener('mousemove', e => {
      const t = e.target.closest('[data-tip]');
      if (!t) { tip.style.display = 'none'; return; }
      tip.textContent = t.dataset.tip;
      tip.style.display = 'block';
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = (e.clientY + 16) + 'px';
    });

    // Переключатели «По дням | По неделям»: показываем нужный SVG.
    document.querySelectorAll('.seg[data-tgl]').forEach(seg => {
      seg.addEventListener('click', e => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
        document.querySelectorAll(`[data-chart="${seg.dataset.tgl}"]`)
          .forEach(c => { c.hidden = c.dataset.mode !== btn.dataset.mode; });
      });
    });

    // Переключатель темы: меняет data-theme, запоминает выбор и держит
    // скрытое поле формы в актуальном состоянии (перезагрузка «Показать»
    // не должна откатывать тему).
    const themeBtn = document.getElementById('themeBtn');
    const isDark = () => (document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
    const paintBtn = () => { themeBtn.textContent = isDark() ? '☀️ Светлая' : '🌙 Тёмная'; };
    if (themeBtn) {
      paintBtn();
      themeBtn.addEventListener('click', () => {
        const next = isDark() ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('opsTheme', next); } catch { /* некритично */ }
        const hidden = document.querySelector('.pick input[name="theme"]');
        if (hidden) hidden.value = next;
        paintBtn();
      });
    }

    // Скачивание PDF-файла с сервера (заказ 22.09: сразу файл на
    // компьютер, а не диалог печати); печать по-прежнему через Ctrl+P.
    const pdfBtn = document.getElementById('pdfBtn');
    if (pdfBtn) pdfBtn.addEventListener('click', () => {
      const from = document.querySelector('.pick input[name="from"]')?.value || '';
      const to = document.querySelector('.pick input[name="to"]')?.value || '';
      window.location.assign(`/ops-report/pdf?from=${from}&to=${to}`);
    });
  });
})();
