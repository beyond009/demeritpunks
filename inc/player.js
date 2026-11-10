(() => {
  const audio = document.getElementById('music');
  const player = document.querySelector('.player');
  const play = document.getElementById('play');
  const seek = document.getElementById('seek');
  const status = document.getElementById('player-status');
  const queue = document.getElementById('queue');
  const queueToggle = document.getElementById('queue-toggle');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const titles = ['Walking Out of Fog', 'Barefaced Lies & Bullshit Peace', 'Childhood Nightmare', 'Bye Bye My Country'];
  const slugs = ['walking-out-of-fog', 'barefaced-lies', 'childhood-nightmare', 'bye-bye-my-country'];
  const durations = [258.463, 235.787, 239.227, 193.654];
  const buttons = [...document.querySelectorAll('[data-track]')];
  const cueCache = new Map();
  let index = 0;
  let cues = null;
  let buffering = false;

  const time = value => `${Math.floor((value || 0) / 60)}:${String(Math.floor((value || 0) % 60)).padStart(2, '0')}`;
  function signal() {
    const playing = !audio.paused && !audio.ended;
    const advancing = playing && !buffering && !audio.seeking;
    player.classList.toggle('is-playing', playing);
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const animated = !reduce.matches;
    window.dispatchEvent(new CustomEvent('demerit:playback', { detail: { playing, advancing, cues, lights: animated } }));
  }

  function progress() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : durations[index];
    seek.max = duration;
    seek.value = audio.currentTime;
    seek.disabled = !Number.isFinite(audio.duration);
    seek.style.setProperty('--progress', `${100 * audio.currentTime / duration}%`);
    seek.setAttribute('aria-valuetext', `${time(audio.currentTime)} of ${time(duration)}`);
    document.getElementById('elapsed').textContent = time(audio.currentTime);
    document.getElementById('duration').textContent = time(duration);
  }

  async function loadCues(trackIndex) {
    const slug = slugs[trackIndex];
    if (!cueCache.has(slug)) {
      cueCache.set(slug, fetch(`/audio/${slug}.json?v=3`).then(response => {
        if (!response.ok) throw new Error('Cue data unavailable');
        return response.json();
      }).catch(() => { cueCache.delete(slug); return null; }));
    }
    const result = await cueCache.get(slug);
    if (index === trackIndex) { cues = result; signal(); }
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

  function selectTrack(nextIndex, autoplay) {
    index = (nextIndex + slugs.length) % slugs.length;
    cues = null;
    buffering = true;
    audio.src = `/audio/${slugs[index]}.mp3`;
    audio.load();
    document.getElementById('track-title').textContent = titles[index];
    buttons.forEach((button, i) => {
      if (i === index) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    status.textContent = 'Demerit';
    progress();
    signal();
    loadCues(index);
    if (autoplay) start();
  }

  play.addEventListener('click', () => audio.paused ? start() : audio.pause());
  buttons.forEach((button, i) => button.addEventListener('click', () => {
    if (i === index) { if (audio.paused) start(); }
    else selectTrack(i, true);
  }));
  document.getElementById('previous').addEventListener('click', () => {
    if (audio.currentTime > 3) { audio.currentTime = 0; progress(); }
    else selectTrack(index - 1, !audio.paused);
  });
  document.getElementById('next').addEventListener('click', () => selectTrack(index + 1, !audio.paused));
  seek.addEventListener('input', () => { audio.currentTime = Number(seek.value); progress(); });
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
  audio.addEventListener('playing', () => { buffering = false; status.textContent = 'Demerit'; signal(); });
  audio.addEventListener('play', signal);
  audio.addEventListener('pause', () => { status.textContent = 'Demerit'; signal(); });
  audio.addEventListener('waiting', () => { buffering = true; status.textContent = 'Buffering…'; signal(); });
  audio.addEventListener('seeking', signal);
  audio.addEventListener('seeked', () => { buffering = audio.readyState < 3; signal(); });
  audio.addEventListener('ended', () => selectTrack(index + 1, true));
  audio.addEventListener('error', () => { status.textContent = 'Track unavailable. Try another song.'; signal(); });
  audio.volume = .8;
  player.classList.add('is-enhanced');
  audio.controls = false;
  loadCues(index);
  progress();
  signal();
})();
