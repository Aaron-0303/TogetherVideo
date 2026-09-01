(() => {
  const sidebarTypography = document.createElement('link');
  sidebarTypography.rel = 'stylesheet';
  sidebarTypography.href = '/sidebar-readable.css?v=4.1';
  document.head.appendChild(sidebarTypography);

  const STORAGE_KEY = 'togethervideo-theme';
  const THEMES = new Set(['light', 'dark']);

  function preferredTheme() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (THEMES.has(saved)) return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme, { persist = false } = {}) {
    const next = THEMES.has(theme) ? theme : preferredTheme();
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      next === 'dark' ? '#0d1017' : '#f3f5f8',
    );

    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      const dark = next === 'dark';
      button.setAttribute('aria-label', dark ? '切换到明亮主题' : '切换到黑暗主题');
      button.setAttribute('title', dark ? '切换到明亮主题' : '切换到黑暗主题');
      const icon = button.querySelector('[data-theme-icon]');
      const label = button.querySelector('[data-theme-label]');
      if (icon) icon.textContent = dark ? '☀' : '☾';
      if (label) label.textContent = dark ? '明亮' : '黑暗';
    }

    if (persist) localStorage.setItem(STORAGE_KEY, next);
  }

  applyTheme(preferredTheme());
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(document.documentElement.dataset.theme || preferredTheme());
  }, { once: true });

  document.addEventListener('click', (event) => {
    const themeButton = event.target.closest('[data-theme-toggle]');
    if (themeButton) {
      const current = document.documentElement.dataset.theme || preferredTheme();
      applyTheme(current === 'dark' ? 'light' : 'dark', { persist: true });
      return;
    }

    if (event.target.closest('[data-open-settings]')) {
      document.getElementById('settingsBtn')?.click();
    }
  });

  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', (event) => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    applyTheme(event.matches ? 'dark' : 'light');
  });
})();
