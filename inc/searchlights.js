(() => {
  const stage = document.querySelector('.searchlights');
  const glowLayer = document.querySelector('.eye-lights');
  const beams = [...stage.querySelectorAll('.beam')];
  const glows = [...glowLayer.querySelectorAll('[data-glow]')];
  const mistCanvas = document.querySelector('.atmosphere-canvas');
  const atmosphere = window.DemeritAtmosphere?.create(mistCanvas);
  window.DemeritStageAtmosphere = atmosphere;
  if (mistCanvas && !atmosphere) mistCanvas.hidden = true;
  const logo = document.querySelector('.logo');
  const audio = document.getElementById('music');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, lastFrame = 0, clock = 0, lastAudioTime = 0;
  let angle = 145, percussionMix = 0;
  let mistTime = 0, mistLight = .6, lastMistFrame = -Infinity;
  let mistInterval = 40, lastBeamFrame = -Infinity, lastLiveFrame = -Infinity;
  let compact = false, ready = false, liveSample = null;
  let drawnAngles = [NaN, NaN], drawnLevels = [NaN, NaN], drawnCompiled = null;
  let sound = { playing: false, advancing: false, cues: null };

  function setData(name, value) {
    const text = String(value);
    if (stage.dataset[name] !== text) stage.dataset[name] = text;
  }

  function draw(timestamp) {
    frame = 0;
    const dt = Math.min(.05, (timestamp - (lastFrame || timestamp)) / 1000 || 1 / 60);
    lastFrame = timestamp;
    const animate = !reduce.matches;
    const rawTime = audio?.currentTime || 0;
    const jumped = Math.abs(rawTime - lastAudioTime) > .35;
    lastAudioTime = rawTime;
    // The decoded media timeline is authoritative. Integrating clamped frame
    // deltas made lights lag after a busy frame and drift during slow devices.
    clock = rawTime;
    if (jumped || !sound.advancing) {
      liveSample = null;
      lastLiveFrame = -Infinity;
    }
    // Detailed drum/phrase work is offline. Live analysis only checks actual
    // signal level, so guitar attacks cannot move a scored percussion cue.
    if (sound.advancing && timestamp - lastLiveFrame >= (compact ? 50 : 33)) {
      liveSample = window.DemeritAudio?.sample(clock) || null;
      lastLiveFrame = timestamp;
    }
    const live = sound.advancing ? liveSample : null;
    const audibleTime = Math.max(0, clock - (live?.latency || 0) * (audio.playbackRate || 1));
    const score = window.DemeritScore.read(sound.cues, audibleTime);
    const compiled = score.version === 3;
    const drums = score.mode === 'drums';
    let levels, angles, haze, pattern;
    if (!animate) {
      levels = [.9, .9]; angles = [145, 145]; haze = .9; pattern = 'still';
      angle = 145;
    } else if (!sound.playing) {
      const idle = .88 + Math.sin(timestamp / 1800) * .1;
      levels = [idle, idle]; angles = [145, 145]; haze = idle; pattern = 'idle';
      angle = 145;
    } else if (!sound.advancing) {
      levels = [.34, .34]; angles = compiled ? score.angles : [angle, angle];
      haze = .34; pattern = 'waiting';
    } else if (compiled) {
      // The baked channels already contain attack/release, phrase transitions
      // and continuous motion. Sampling them directly also makes seeks exact.
      let gain = 1;
      if (live?.ready && Number.isFinite(live.rms)) gain = .95 + Math.min(1, live.rms / .1) * .05;
      const silent = live?.ready && live.rms < .0005;
      levels = score.levels.map(level => silent ? Math.min(.34, level) : level * gain);
      angles = score.angles;
      haze = silent ? Math.min(.34, score.haze) : score.haze;
      pattern = `score-${score.scene}`;
      angle = (angles[0] + angles[1]) * .5;
    } else {
      percussionMix += ((drums ? 1 : 0) - percussionMix) * (1 - Math.exp(-dt * 2));
      const target = window.DemeritScore.sweepAngle(audibleTime);
      angle += (target - angle) * (1 - Math.exp(-dt * 2.5));
      const previous = score.previous;
      const age = previous ? audibleTime - previous.time : Infinity;
      const quiet = .55 + score.energy * .16;
      const accent = live?.ready && live.rms < .0005 ? .34 : window.DemeritScore.pulse(age, previous?.strength || 0);
      const brightness = quiet * (1 - percussionMix) + accent * percussionMix;
      levels = [brightness, brightness]; angles = [angle, angle]; haze = brightness;
      pattern = drums || percussionMix > .05 ? 'sweep+percussion' : 'sweep';
    }

    if (drawnCompiled !== compiled) {
      stage.style.opacity = compiled ? '1' : '';
      glowLayer.style.opacity = compiled ? '1' : '';
      beams.forEach(beam => { beam.style.opacity = '1'; });
      glows.forEach(glow => { glow.style.opacity = '1'; });
      drawnLevels = [NaN, NaN];
      drawnCompiled = compiled;
    }
    const moved = angles.some((value, index) => !Number.isFinite(drawnAngles[index]) || Math.abs(value - drawnAngles[index]) > .015);
    if (moved && (!compact || timestamp - lastBeamFrame >= 30)) {
      beams.forEach((beam, index) => {
        beam.setAttribute('transform', `translate(${beam.dataset.x} ${beam.dataset.y}) rotate(${angles[index].toFixed(3)})`);
      });
      drawnAngles = angles.slice();
      lastBeamFrame = timestamp;
    }
    if (compiled) {
      levels.forEach((level, index) => {
        if (!Number.isFinite(drawnLevels[index]) || Math.abs(level - drawnLevels[index]) > .002) {
          beams[index].style.opacity = level.toFixed(3);
          glows[index].style.opacity = level.toFixed(3);
          drawnLevels[index] = level;
        }
      });
    } else if (!Number.isFinite(drawnLevels[0]) || Math.abs(levels[0] - drawnLevels[0]) > .002) {
      stage.style.opacity = levels[0].toFixed(3);
      glowLayer.style.opacity = levels[0].toFixed(3);
      drawnLevels = levels.slice();
    }

    // Fog keeps its independent clock/density; only its received light uses
    // the haze channel. It never inherits either direct beam's opacity.
    if (animate) mistTime += dt;
    mistLight += (haze - mistLight) * (1 - Math.exp(-dt * (haze > mistLight ? 10 : 4)));
    if (atmosphere && (!animate || timestamp - lastMistFrame >= mistInterval)) {
      atmosphere.render(mistTime, angles, mistLight, levels);
      lastMistFrame = timestamp;
    }
    setData('mode', sound.playing ? 'music' : 'idle');
    setData('pattern', pattern);
    setData('analysis', compiled ? 'drum-stem-score' : live?.ready ? 'live-fft+hpss' : 'hpss-score');
    setData('onsets', live?.hits || 0);
    setData('syncDelayMs', Math.round((live?.latency || 0) * 1000));
    if (animate) schedule();
  }

  function schedule() {
    if (!frame && ready && !document.hidden) frame = requestAnimationFrame(draw);
  }
  function measure() {
    const bounds = logo.getBoundingClientRect();
    compact = innerWidth < 700 || matchMedia('(pointer: coarse)').matches;
    mistInterval = compact ? 55 : 40;
    drawnAngles = [NaN, NaN];
    lastBeamFrame = -Infinity;
    const reach = Math.hypot(innerWidth, innerHeight) * 1.3;
    for (const layer of [stage, glowLayer]) layer.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
    stage.querySelectorAll('linearGradient').forEach(gradient => gradient.setAttribute('x2', reach));
    [[.275, .245], [.59, .27]].forEach(([rx, ry], index) => {
      const x = bounds.left + bounds.width * rx;
      const y = bounds.top + bounds.height * ry;
      const beam = beams[index];
      beam.dataset.reach = reach; beam.dataset.x = x; beam.dataset.y = y;
      const cone = (start, end) => `M 0 ${-start} L ${reach} ${-end} L ${reach} ${end} L 0 ${start} Z`;
      beam.querySelector('.beam-halo').setAttribute('d', cone(4, reach * .06));
      beam.querySelector('.beam-body').setAttribute('d', cone(2, reach * .028));
      beam.querySelector('.beam-inner').setAttribute('d', cone(1, reach * .012));
      beam.querySelector('.beam-shaft').setAttribute('d', cone(2, reach * .018));
      glows[index].setAttribute('cx', x); glows[index].setAttribute('cy', y);
    });
    atmosphere?.resize(innerWidth, innerHeight, beams.map(beam => [Number(beam.dataset.x), Number(beam.dataset.y)]));
    lastMistFrame = -Infinity;
    ready = true;
    stage.classList.add('is-ready'); glowLayer.classList.add('is-ready');
    schedule();
  }
  window.addEventListener('demerit:playback', event => {
    if (sound.cues !== event.detail.cues) {
      liveSample = null; lastLiveFrame = -Infinity;
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
  if (logo.tagName !== 'IMG' || logo.complete) measure();
  else logo.addEventListener('load', measure, { once: true });
})();
