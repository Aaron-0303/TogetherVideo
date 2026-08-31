(() => {
  const player = window.TogetherMediaPlayer;
  const video = document.getElementById('video');
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

  // A viewer who joins an already-playing room has not necessarily interacted
  // with the media element. Safari/Chrome are therefore allowed to reject an
  // unmuted play() call. Falling back to muted playback keeps video decoding and
  // Range loading alive; one explicit tap then unlocks audio.
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

      // Keep the existing app-level interaction flow active. The video is now
      // actually running muted, but app.js should still leave the overlay visible
      // until the viewer explicitly unlocks sound.
      throw error;
    }
  };

  overlay.addEventListener('click', (event) => {
    if (!video.muted) return;

    // This handler runs in capture phase so the browser sees the unmute directly
    // inside the user gesture. If playback is already running, no second play()
    // transaction is needed and app.js must not leave a stale expectedPlay flag.
    video.muted = false;
    video.defaultMuted = false;
    overlay.classList.add('hidden');
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();
