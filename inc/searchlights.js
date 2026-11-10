(() => {
  const stage = document.querySelector('.searchlights');
  const glowLayer = document.querySelector('.eye-lights');
  const beams = [...stage.querySelectorAll('.beam')];
  const glows = [...glowLayer.querySelectorAll('[data-glow]')];
  const mistCanvas = document.querySelector('.atmosphere-canvas');
  const atmosphere = window.DemeritAtmosphere?.create(mistCanvas);
  if (mistCanvas && !atmosphere) mistCanvas.hidden = true;
  const logo = document.querySelector('.logo');
  const audio = document.getElementById('music');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0;
  let lastFrame = 0;
  let clock = 0;
  let angle = 145;
  let percussionMix = 0;
  let mistTime = 0;
  let mistLight = .6;
  let lastMistFrame = -Infinity;
  let mistInterval = 40;
  let lastBeamFrame = -Infinity;
  let compact = false;
  let drawnAngle = NaN;
  let drawnLevel = NaN;
  let lastAudioTime = 0;
  let liveFlash = { time: -Infinity, cue: -Infinity, strength: 0 };
  let lastRefinement = -Infinity;
  let ready = false;
  let sound = { playing: false, advancing: false, cues: null };

  function draw(timestamp) {
    frame = 0;
    const dt = Math.min(.05, (timestamp - (lastFrame || timestamp)) / 1000 || 1 / 60);
    lastFrame = timestamp;
    const animate = !reduce.matches;
    const rawTime = audio?.currentTime || 0;
    const jumped = Math.abs(rawTime - lastAudioTime) > .35;
    lastAudioTime = rawTime;
    if (!sound.advancing || jumped) clock = rawTime;
    else {
      clock += dt * (audio.playbackRate || 1);
      clock += (rawTime - clock) * (1 - Math.exp(-dt * 12));
    }
    if (jumped || !sound.advancing) {
      liveFlash = { time: -Infinity, cue: -Infinity, strength: 0 };
      lastRefinement = -Infinity;
    }
    const live = sound.advancing ? window.DemeritAudio?.sample(clock) : null;
    // Audio output buffers can trail the media element. Match the audible head.
    const audibleTime = Math.max(0, clock - (live?.latency || 0));
    const score = window.DemeritScore.read(sound.cues, audibleTime);
    const drums = score.mode === 'drums';
    percussionMix += ((drums ? 1 : 0) - percussionMix) * (1 - Math.exp(-dt * 2));
    if (sound.advancing && animate) {
      // One continuous, narrow lower sweep throughout the song. Percussion
      // changes the intensity envelope, never the movement or its phase.
      const target = window.DemeritScore.sweepAngle(audibleTime);
      angle += (target - angle) * (1 - Math.exp(-dt * 2.5));
    }
    let brightness, pattern;
    if (!animate) {
      brightness = .9;
      angle = 145;
      pattern = 'still';
    } else if (!sound.playing) {
      brightness = .88 + Math.sin(timestamp / 1800) * .1;
      angle = 145;
      pattern = 'idle';
    } else if (!sound.advancing) {
      brightness = .34;
      pattern = 'waiting';
    } else {
      pattern = drums || percussionMix > .05 ? 'sweep+percussion' : 'sweep';
      // A measured live attack may bring the next scored accent forward by
      // at most 90 ms. No random extra flashes between the scored drum hits.
      const next = score.next;
      if (live?.hit && next && next.time - audibleTime < .09 &&
          next.time !== liveFlash.cue && audibleTime - lastRefinement >= .42) {
        liveFlash = { time: audibleTime, cue: next.time, strength: live.hit };
        lastRefinement = audibleTime;
      }
      const previous = score.previous;
      const refined = liveFlash.cue === previous?.time ||
        (liveFlash.cue === next?.time && audibleTime >= liveFlash.time);
      const age = refined ? audibleTime - liveFlash.time : previous ? audibleTime - previous.time : Infinity;
      const strength = refined ? liveFlash.strength : previous?.strength || 0;
      const quiet = .55 + score.energy * .16;
      const accent = live?.ready && live.rms < .0005 ? .34 : window.DemeritScore.pulse(age, strength);
      // Crossfade over the phrase boundary instead of snapping between looks.
      brightness = quiet * (1 - percussionMix) + accent * percussionMix;
    }
    if (Math.abs(angle - drawnAngle) > .015 || !Number.isFinite(drawnAngle)) {
      if (!compact || timestamp - lastBeamFrame >= 30) {
        beams.forEach(beam => {
          beam.setAttribute('transform', `translate(${beam.dataset.x} ${beam.dataset.y}) rotate(${angle.toFixed(3)})`);
        });
        drawnAngle = angle;
        lastBeamFrame = timestamp;
      }
    }
    // Air density has its own clock. Playback, angle, beat and track changes
    // only affect illumination; a cloud never rotates with the light source.
    if (animate) mistTime += dt;
    mistLight += (brightness - mistLight) * (1 - Math.exp(-dt * (brightness > mistLight ? 10 : 4)));
    if (atmosphere && (!animate || timestamp - lastMistFrame >= mistInterval)) {
      atmosphere.render(mistTime, angle, mistLight);
      lastMistFrame = timestamp;
    }
    if (Math.abs(brightness - drawnLevel) > .002 || !Number.isFinite(drawnLevel)) {
      stage.style.opacity = brightness.toFixed(3);
      glowLayer.style.opacity = brightness.toFixed(3);
      drawnLevel = brightness;
    }
    stage.dataset.mode = sound.playing ? 'music' : 'idle';
    stage.dataset.pattern = pattern;
    stage.dataset.analysis = live?.ready ? 'live-fft+hpss' : 'hpss-score';
    stage.dataset.onsets = String(live?.hits || 0);
    if (animate) schedule();
  }

  function schedule() {
    if (!frame && ready && !document.hidden) frame = requestAnimationFrame(draw);
  }
  function measure() {
    const bounds = logo.getBoundingClientRect();
    compact = innerWidth < 700 || matchMedia('(pointer: coarse)').matches;
    mistInterval = compact ? 55 : 40;
    drawnAngle = NaN;
    lastBeamFrame = -Infinity;
    const reach = Math.hypot(innerWidth, innerHeight) * 1.3;
    for (const layer of [stage, glowLayer]) layer.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
    stage.querySelectorAll('linearGradient').forEach(gradient => gradient.setAttribute('x2', reach));
    [[.275, .245], [.59, .27]].forEach(([rx, ry], i) => {
      const x = bounds.left + bounds.width * rx;
      const y = bounds.top + bounds.height * ry;
      const beam = beams[i];
      beam.dataset.reach = reach;
      beam.dataset.x = x;
      beam.dataset.y = y;
      beam.setAttribute('transform', `translate(${x} ${y}) rotate(145)`);
      const cone = (start, end) => `M 0 ${-start} L ${reach} ${-end} L ${reach} ${end} L 0 ${start} Z`;
      // Retain the broad soft cone, with an additional luminous central volume.
      beam.querySelector('.beam-halo').setAttribute('d', cone(4, reach * .06));
      beam.querySelector('.beam-body').setAttribute('d', cone(2, reach * .028));
      beam.querySelector('.beam-inner').setAttribute('d', cone(1, reach * .012));
      beam.querySelector('.beam-shaft').setAttribute('d', cone(2, reach * .018));
      glows[i].setAttribute('cx', x);
      glows[i].setAttribute('cy', y);
    });
    atmosphere?.resize(innerWidth, innerHeight, beams.map(beam => [Number(beam.dataset.x), Number(beam.dataset.y)]));
    lastMistFrame = -Infinity;
    ready = true;
    stage.classList.add('is-ready');
    glowLayer.classList.add('is-ready');
    schedule();
  }
  window.addEventListener('demerit:playback', event => {
    if (sound.cues !== event.detail.cues) {
      liveFlash = { time: -Infinity, cue: -Infinity, strength: 0 };
      lastRefinement = -Infinity;
      clock = audio.currentTime || 0;
    }
    sound = event.detail;
    schedule();
  });
  addEventListener('resize', measure, { passive: true });
  addEventListener('scroll', measure, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; lastFrame = 0; }
    else measure();
  });
  reduce.addEventListener('change', measure);
  if (logo.complete) measure();
  else logo.addEventListener('load', measure, { once: true });
})();
