(() => {
  const player = window.TogetherMediaPlayer;
  const video = player?.video || document.getElementById('video');
  const overlay = document.getElementById('resumeOverlay');
  if (!player || !video || !overlay || player.__togetherUnlockPatched) return;

  player.__togetherUnlockPatched = true;
  const originalPlay = player.play.bind(player);

  function isAutoplayBlock(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'NotAllowedError' || /autoplay|user gesture|not allowed|interaction/i.test(message);
  }

  function showSoundUnlock() {
    overlay.textContent = '点击开启声音并加入同步播放';
    overlay.classList.remove('hidden');
  }

  // A late viewer may not have interacted with the page yet. Keep the native
  // Artplayer video decoding/range pipeline alive by retrying muted, then let one
  // explicit tap unlock sound inside the browser's user-gesture boundary.
  player.play = async (...args) => {
    try {
      return await originalPlay(...args);
    } catch (error) {
      if (player.mode !== 'native' || !isAutoplayBlock(error)) throw error;

      video.muted = true;
      video.defaultMuted = true;
      try {
        await originalPlay(...args);
        showSoundUnlock();
      } catch (mutedError) {
        video.muted = false;
        video.defaultMuted = false;
        throw mutedError;
      }

      throw error;
    }
  };

  overlay.addEventListener('click', (event) => {
    if (!video.muted) return;
    video.muted = false;
    video.defaultMuted = false;
    overlay.classList.add('hidden');
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();
