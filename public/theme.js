(() => {
  let theme;
  try { theme = localStorage.getItem('health-theme'); } catch {}
  document.documentElement.dataset.theme = theme === 'dark' || theme === 'light' ? theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();
