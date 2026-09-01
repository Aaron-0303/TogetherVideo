(() => {
  const nativeIo = window.io;
  if (typeof nativeIo !== 'function') return;

  let currentSocket = null;
  let participantId = '';
  let messages = [];

  function $(id) { return document.getElementById(id); }

  function setSidebarTab(name) {
    const room = name !== 'playlist';
    const roomButton = $('roomTabBtn');
    const playlistButton = $('playlistTabBtn');
    const roomPanel = $('roomTabPanel');
    const playlistPanel = $('playlistTabPanel');
    if (!roomButton || !playlistButton || !roomPanel || !playlistPanel) return;

    roomButton.classList.toggle('active', room);
    playlistButton.classList.toggle('active', !room);
    roomButton.setAttribute('aria-selected', room ? 'true' : 'false');
    playlistButton.setAttribute('aria-selected', room ? 'false' : 'true');
    roomPanel.classList.toggle('active', room);
    playlistPanel.classList.toggle('active', !room);
    roomPanel.setAttribute('aria-hidden', room ? 'false' : 'true');
    playlistPanel.setAttribute('aria-hidden', room ? 'true' : 'false');
  }

  function formatTime(value) {
    const date = new Date(Number(value) || Date.now());
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderChat() {
    const root = $('chatMessages');
    if (!root) return;
    root.replaceChildren();

    if (!messages.length) {
      const empty = document.createElement('div');
      empty.id = 'chatEmpty';
      empty.className = 'chat-empty';
      empty.textContent = '还没有消息，和 TA 说句话吧。';
      root.appendChild(empty);
      return;
    }

    for (const message of messages) {
      const self = participantId && message.participantId === participantId;
      const item = document.createElement('div');
      item.className = `chat-message ${self ? 'self' : 'peer'}`;

      const avatar = document.createElement('div');
      avatar.className = 'chat-avatar';
      avatar.textContent = self ? '你' : 'TA';

      const main = document.createElement('div');
      main.className = 'chat-message-main';

      const meta = document.createElement('div');
      meta.className = 'chat-meta';
      const name = document.createElement('span');
      name.textContent = self ? '你' : (message.nickname || 'TA');
      const time = document.createElement('time');
      time.textContent = formatTime(message.sentAt);
      meta.append(name, time);

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.textContent = message.text || '';

      main.append(meta, bubble);
      item.append(avatar, main);
      root.appendChild(item);
    }
    root.scrollTop = root.scrollHeight;
  }

  function showSettingsNotice(text) {
    const notice = $('settingsNotice');
    if (!notice) return;
    notice.textContent = text;
    notice.classList.remove('error');
  }

  async function refreshIdentity() {
    try {
      const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (data?.authenticated && data.participantId) {
        participantId = String(data.participantId);
        renderChat();
      }
    } catch {}
  }

  function attachSocket(socket) {
    currentSocket = socket;
    refreshIdentity();

    socket.on('chat:history', (history) => {
      messages = Array.isArray(history) ? history.slice(-80) : [];
      renderChat();
    });

    socket.on('chat:message', (message) => {
      if (!message || !message.id) return;
      if (messages.some((item) => item.id === message.id)) return;
      messages.push(message);
      if (messages.length > 80) messages = messages.slice(-80);
      renderChat();
    });

    socket.on('chat:cleared', (payload = {}) => {
      messages = [];
      renderChat();
      showSettingsNotice(payload.clearedBy
        ? `聊天记录已由 ${payload.clearedBy} 清空。`
        : '聊天记录已清空。');
    });
  }

  function wrappedIo(...args) {
    const socket = nativeIo.apply(this, args);
    attachSocket(socket);
    return socket;
  }
  Object.assign(wrappedIo, nativeIo);
  window.io = wrappedIo;

  document.addEventListener('DOMContentLoaded', () => {
    $('roomTabBtn')?.addEventListener('click', () => setSidebarTab('room'));
    $('playlistTabBtn')?.addEventListener('click', () => setSidebarTab('playlist'));
    $('libraryToggle')?.addEventListener('click', () => setSidebarTab('playlist'));

    const onlineBadge = $('onlineBadge');
    const roomTabCount = $('roomTabCount');
    if (onlineBadge && roomTabCount) {
      const mirrorCount = () => {
        roomTabCount.textContent = onlineBadge.textContent.replace('在线', '').trim();
      };
      mirrorCount();
      new MutationObserver(mirrorCount).observe(onlineBadge, { childList: true, subtree: true, characterData: true });
    }

    $('chatForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('chatInput');
      const text = String(input?.value || '').replace(/\s+/g, ' ').trim();
      if (!text || !currentSocket?.connected) return;
      currentSocket.emit('chat:send', { text });
      input.value = '';
      input.focus();
    });

    $('clearChatBtn')?.addEventListener('click', () => {
      if (!currentSocket?.connected) {
        showSettingsNotice('当前未连接房间，无法清空聊天记录。');
        return;
      }
      if (!window.confirm('确定清空当前房间的全部聊天记录吗？此操作会同时清空双方看到的历史记录。')) return;
      currentSocket.emit('chat:clear');
    });

    setSidebarTab('room');
  }, { once: true });
})();
