/* One media source for the lifetime of the player; same-origin audio only.
   Offline HPSS supplies musical context. This analyser measures the signal
   actually playing, so transients can refine cue timing and intensity. */
(() => {
  const audio = document.getElementById('music');
  let context, analyser, source, frequency, waveform;
  let failed = false, previous = null, history = [], lastHit = -Infinity, warming = 0;
  let hits = 0;

  function reset() {
    previous = null;
    history = [];
    lastHit = -Infinity;
    warming = 0;
  }

  function start() {
    if (failed) return;
    try {
      if (!context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        context = new AudioContext({ latencyHint: 'interactive' });
        analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        frequency = new Float32Array(analyser.frequencyBinCount);
        waveform = new Float32Array(analyser.fftSize);
        source = context.createMediaElementSource(audio);
        // Exactly one audible route; analysis is a separate silent branch.
        source.connect(context.destination);
        source.connect(analyser);
      }
      context.resume().catch(() => {});
    } catch (error) {
      // If setup failed after binding the element, keep the audible route.
      if (source && context) {
        source.disconnect();
        source.connect(context.destination);
      }
      failed = true;
    }
  }

  function sample(time) {
    if (failed || !analyser || context.state !== 'running') return { ready: false, hit: 0, hits };
    analyser.getFloatFrequencyData(frequency);
    analyser.getFloatTimeDomainData(waveform);
    const bands = [[40, 180], [180, 2000], [2000, 8000]];
    const values = bands.map(([low, high]) => {
      const from = Math.max(1, Math.ceil(low * analyser.fftSize / context.sampleRate));
      const to = Math.min(frequency.length, Math.ceil(high * analyser.fftSize / context.sampleRate));
      let sum = 0;
      for (let i = from; i < to; i++) sum += 10 ** (frequency[i] / 20);
      return Math.log1p(100 * sum / Math.max(1, to - from));
    });
    let sum = 0;
    for (const value of waveform) sum += value * value;
    const rms = Math.sqrt(sum / waveform.length);
    const flux = previous ? values.map((value, i) => Math.max(0, value - previous[i])) : [0, 0, 0];
    previous = values;
    const novelty = flux[0] * .45 + flux[1] * .4 + flux[2] * .15;
    const mean = history.length ? history.reduce((a, b) => a + b, 0) / history.length : 0;
    const deviation = history.length ? Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length) : 0;
    const threshold = Math.max(.012, mean + deviation * 1.65);
    const transient = novelty > threshold && rms > .006 && warming > 5 && time - lastHit > .16;
    let hit = 0;
    if (transient) {
      hit = Math.min(1, novelty / Math.max(.04, threshold * 2));
      lastHit = time;
      hits++;
    }
    history.push(novelty);
    if (history.length > 90) history.shift();
    warming++;
    return { ready: true, rms, hit, hits, novelty, latency: Math.min(.2, context.outputLatency || context.baseLatency || 0) };
  }

  ['seeking', 'emptied', 'pause', 'waiting', 'playing'].forEach(event => audio.addEventListener(event, reset));
  document.addEventListener('visibilitychange', reset);
  window.DemeritAudio = { start, sample, reset };
})();
