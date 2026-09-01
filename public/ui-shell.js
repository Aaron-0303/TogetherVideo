(() => {
  const sidebarTypography = document.createElement('link');
  sidebarTypography.rel = 'stylesheet';
  sidebarTypography.href = '/sidebar-readable.css?v=4.1';
  document.head.appendChild(sidebarTypography);

  const settingsStyles = document.createElement('link');
  settingsStyles.rel = 'stylesheet';
  settingsStyles.href = '/settings-center.css?v=4.1';
  document.head.appendChild(settingsStyles);

  const STORAGE_KEY = 'togethervideo-theme';
  const THEMES = new Set(['light', 'dark']);
  let activeSettingsTab = 'webdav';

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

  function settingsDefinition(card) {
    const sections = Array.from(card.children).filter((node) => node.classList?.contains('settings-section'));
    const webdav = sections.find((section) => section.querySelector('#webdavUrl'));
    const site = sections.find((section) => section.querySelector('#newSitePassword'));
    const chat = sections.find((section) => section.querySelector('#clearChatBtn'));
    return [
      { key: 'webdav', title: 'WebDAV', subtitle: '媒体来源', icon: '☁', section: webdav },
      { key: 'site', title: '站点设置', subtitle: '访问与安全', icon: '⌁', section: site },
      { key: 'chat', title: '聊天设置', subtitle: '聊天记录', icon: '✦', section: chat },
    ].filter((item) => item.section);
  }

  function setSettingsTab(key) {
    const card = document.querySelector('#settingsModal .settings-center-card');
    if (!card) return;
    const available = Array.from(card.querySelectorAll('[data-settings-tab]')).map((button) => button.dataset.settingsTab);
    activeSettingsTab = available.includes(key) ? key : (available[0] || 'webdav');

    for (const button of card.querySelectorAll('[data-settings-tab]')) {
      const active = button.dataset.settingsTab === activeSettingsTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    }
    for (const panel of card.querySelectorAll('[data-settings-panel]')) {
      const active = panel.dataset.settingsPanel === activeSettingsTab;
      panel.classList.toggle('active', active);
      panel.setAttribute('aria-hidden', active ? 'false' : 'true');
    }
  }

  function buildSettingsCenter() {
    const card = document.querySelector('#settingsModal .settings-card');
    if (!card || card.dataset.settingsCenterReady === '1') return;

    const head = card.querySelector('.settings-head');
    const notice = document.getElementById('settingsNotice');
    const items = settingsDefinition(card);
    if (!head || !items.length) return;

    card.dataset.settingsCenterReady = '1';
    card.classList.add('settings-center-card');

    const body = document.createElement('div');
    body.className = 'settings-center-body';

    const nav = document.createElement('aside');
    nav.className = 'settings-nav';
    nav.setAttribute('aria-label', '设置分类');

    const navIntro = document.createElement('div');
    navIntro.className = 'settings-nav-intro';
    navIntro.innerHTML = '<strong>设置</strong><span>TogetherVideo 4.1</span>';
    nav.appendChild(navIntro);

    const navList = document.createElement('div');
    navList.className = 'settings-nav-list';
    navList.setAttribute('role', 'tablist');
    nav.appendChild(navList);

    const content = document.createElement('div');
    content.className = 'settings-content';

    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-nav-item';
      button.dataset.settingsTab = item.key;
      button.setAttribute('role', 'tab');
      button.innerHTML = `<span class="settings-nav-icon">${item.icon}</span><span class="settings-nav-copy"><strong>${item.title}</strong><small>${item.subtitle}</small></span><span class="settings-nav-arrow">›</span>`;
      navList.appendChild(button);

      item.section.classList.add('settings-pane');
      item.section.dataset.settingsPanel = item.key;
      item.section.setAttribute('role', 'tabpanel');
      content.appendChild(item.section);
    }

    if (notice) {
      notice.classList.add('settings-center-notice');
      content.appendChild(notice);
    }

    body.append(nav, content);
    card.appendChild(body);
    setSettingsTab(activeSettingsTab);
  }

  applyTheme(preferredTheme());
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(document.documentElement.dataset.theme || preferredTheme());
    buildSettingsCenter();
  }, { once: true });

  document.addEventListener('click', (event) => {
    const themeButton = event.target.closest('[data-theme-toggle]');
    if (themeButton) {
      const current = document.documentElement.dataset.theme || preferredTheme();
      applyTheme(current === 'dark' ? 'light' : 'dark', { persist: true });
      return;
    }

    const settingsTab = event.target.closest('[data-settings-tab]');
    if (settingsTab) {
      setSettingsTab(settingsTab.dataset.settingsTab);
      return;
    }

    if (event.target.closest('#settingsBtn')) {
      setSettingsTab('webdav');
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
