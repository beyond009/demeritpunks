(() => {
  const audio = document.getElementById('music');
  const player = document.querySelector('.player');
  const play = document.getElementById('play');
  const seek = document.getElementById('seek');
  const status = document.getElementById('player-status');
  const queue = document.getElementById('queue');
  const queueToggle = document.getElementById('queue-toggle');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const albums = window.DemeritCatalog;
  const albumSelect = document.getElementById('album-select');
  const playlist = queue.querySelector('.playlist');
  const cueCache = new Map();
  let album = albums[0];
  let queueAlbum = album;
  let index = 0;
  let cues = null;
  let buffering = false;
  let scrubbing = false;
  let previewTime = null;
  let pendingSeek = null;

  const time = value => `${Math.floor((value || 0) / 60)}:${String(Math.floor((value || 0) % 60)).padStart(2, '0')}`;
  const track = () => album.tracks[index];
  const trackStatus = () => `Demerit · ${album.title}`;

  function renderQueue() {
    albumSelect.value = queueAlbum.id;
    const count = queueAlbum.tracks.length;
    queue.querySelector('.player-kicker').textContent = `${queueAlbum.title.toUpperCase()} · ${count} ${count === 1 ? 'TRACK' : 'TRACKS'}`;
    playlist.setAttribute('aria-label', `${queueAlbum.title} tracks`);
    playlist.replaceChildren(...queueAlbum.tracks.map((item, position) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.track = String(position);
      if (item === track()) button.setAttribute('aria-current', 'true');
      for (const [className, text] of [
        ['track-number', String(position + 1).padStart(2, '0')],
        ['track-name', item.title], ['track-duration', time(item.duration)],
      ]) {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        button.append(span);
      }
      button.addEventListener('click', () => {
        if (item === track()) { if (audio.paused) start(); }
        else selectTrack(position, true, queueAlbum);
      });
      li.append(button);
      return li;
    }));
  }

  function signal() {
    const playing = !audio.paused && !audio.ended;
    const advancing = playing && !buffering && !audio.seeking;
    player.classList.toggle('is-playing', playing);
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const animated = !reduce.matches;
    window.dispatchEvent(new CustomEvent('demerit:playback', { detail: { playing, advancing, cues, lights: animated } }));
  }

  function progress() {
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : track().duration;
    const position = Math.max(0, Math.min(duration, previewTime ?? pendingSeek ?? audio.currentTime));
    seek.max = duration;
    seek.value = position;
    seek.disabled = !Number.isFinite(audio.duration) || audio.duration <= 0;
    seek.style.setProperty('--progress', `${100 * position / duration}%`);
    seek.setAttribute('aria-valuetext', `${time(position)} of ${time(duration)}`);
    document.getElementById('elapsed').textContent = time(position);
    document.getElementById('duration').textContent = time(duration);
  }

  function seekTo(value) {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0 || !Number.isFinite(value)) return;
    const target = Math.max(0, Math.min(audio.duration, value));
    previewTime = null;
    if (!audio.seeking && Math.abs(audio.currentTime - target) < .001) {
      pendingSeek = null;
      progress();
      return;
    }
    if (pendingSeek !== target) {
      // Keep the requested position visible while the browser fetches/decode
      // catches up. Stale timeupdate events must not pull the thumb backwards.
      pendingSeek = target;
      try { audio.currentTime = target; }
      catch { pendingSeek = null; }
    }
    progress();
  }

  function finishScrub() {
    if (!scrubbing) return;
    scrubbing = false;
    if (previewTime !== null) seekTo(previewTime);
  }

  async function loadCues(selectedTrack) {
    if (!selectedTrack.cues) return;
    const url = selectedTrack.cues;
    if (!cueCache.has(url)) {
      cueCache.set(url, fetch(url).then(response => {
        if (!response.ok) throw new Error('Cue data unavailable');
        return response.json();
      }).catch(() => { cueCache.delete(url); return null; }));
    }
    const result = await cueCache.get(url);
    if (track() === selectedTrack) { cues = result; signal(); }
  }

  async function start() {
    try {
      // Direct user gesture starts playback, including on mobile Safari.
      window.DemeritAudio?.start();
      const promise = audio.play();
      status.textContent = 'Loading…';
      await promise;
    } catch (error) {
      if (error.name !== 'AbortError') status.textContent = 'Playback unavailable. Tap play to retry.';
      signal();
    }
  }

  function selectTrack(nextIndex, autoplay, nextAlbum = album) {
    album = nextAlbum;
    index = (nextIndex + album.tracks.length) % album.tracks.length;
    cues = null;
    buffering = true;
    scrubbing = false;
    previewTime = pendingSeek = null;
    audio.src = track().src;
    audio.load();
    document.getElementById('track-title').textContent = track().title;
    document.querySelector('.album-thumb').src = album.cover;
    queueAlbum = album;
    renderQueue();
    status.textContent = trackStatus();
    progress();
    signal();
    loadCues(track());
    if (autoplay) start();
  }

  play.addEventListener('click', () => audio.paused ? start() : audio.pause());
  albumSelect.addEventListener('change', () => {
    queueAlbum = albums.find(item => item.id === albumSelect.value) || album;
    renderQueue();
  });
  document.getElementById('previous').addEventListener('click', () => {
    if (audio.currentTime > 3) { scrubbing = false; seekTo(0); }
    else selectTrack(index - 1, !audio.paused);
  });
  document.getElementById('next').addEventListener('click', () => selectTrack(index + 1, !audio.paused));
  seek.addEventListener('pointerdown', () => {
    if (seek.disabled) return;
    scrubbing = true;
    previewTime = Number(seek.value);
  });
  seek.addEventListener('input', () => {
    previewTime = Number(seek.value);
    if (scrubbing) progress();
    else seekTo(previewTime);
  });
  // Native range controls also commit through change (keyboard, touch and
  // accessibility actions). Pointer drags preview first and seek once released.
  seek.addEventListener('change', () => { scrubbing = false; seekTo(Number(seek.value)); });
  document.addEventListener('pointerup', finishScrub);
  document.addEventListener('pointercancel', () => {
    scrubbing = false;
    previewTime = null;
    progress();
  });
  seek.addEventListener('blur', finishScrub);
  function setQueue(open) {
    queue.hidden = !open;
    queueToggle.setAttribute('aria-expanded', String(open));
    queueToggle.setAttribute('aria-label', open ? 'Close playlist' : 'Open playlist');
  }
  queueToggle.addEventListener('click', () => setQueue(queue.hidden));
  document.getElementById('queue-close').addEventListener('click', () => { setQueue(false); queueToggle.focus(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !queue.hidden) { setQueue(false); queueToggle.focus(); } });
  document.addEventListener('pointerdown', event => { if (!player.contains(event.target)) setQueue(false); });
  reduce.addEventListener('change', signal);
  audio.addEventListener('timeupdate', progress);
  audio.addEventListener('loadedmetadata', progress);
  audio.addEventListener('playing', () => { buffering = false; status.textContent = trackStatus(); signal(); });
  audio.addEventListener('play', signal);
  audio.addEventListener('pause', () => { status.textContent = trackStatus(); signal(); });
  audio.addEventListener('waiting', () => { buffering = true; status.textContent = 'Buffering…'; signal(); });
  audio.addEventListener('seeking', signal);
  audio.addEventListener('seeked', () => {
    pendingSeek = null;
    buffering = audio.readyState < 3;
    progress();
    signal();
  });
  audio.addEventListener('ended', () => selectTrack(index + 1, true));
  audio.addEventListener('error', () => {
    scrubbing = false;
    previewTime = pendingSeek = null;
    progress();
    status.textContent = 'Track unavailable. Try another song.';
    signal();
  });
  audio.volume = .8;
  player.classList.add('is-enhanced');
  audio.controls = false;
  renderQueue();
  loadCues(track());
  progress();
  signal();
})();
