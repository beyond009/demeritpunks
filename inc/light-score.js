/* Pure score sampling. Decoded channel bytes are cached once per cue object;
   seeking never replays old events or depends on the previous render frame. */
(() => {
  const decoded = new WeakMap();
  const channelNames = ['left', 'right', 'haze', 'angleLeft', 'angleRight'];

  function sample(values, position) {
    if (!values?.length) return 0;
    const at = Math.max(0, Math.min(values.length - 1, position));
    const index = Math.floor(at);
    return (values[index] + ((values[index + 1] ?? values[index]) - values[index]) * (at - index)) / 255;
  }

  function locate(values, time, key = 'time') {
    let low = 0, high = values.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (values[mid][key] <= time) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function channels(cues) {
    if (decoded.has(cues)) return decoded.get(cues);
    let result = null;
    try {
      if (cues.encoding !== 'u8-base64' || !Number.isFinite(cues.duration) ||
          cues.duration <= 0 || !Number.isFinite(cues.fps) || cues.fps <= 0) throw new Error('Invalid score');
      const length = Math.ceil(cues.duration * cues.fps) + 1;
      result = {};
      for (const name of channelNames) {
        const binary = atob(cues.channels[name]);
        if (binary.length !== length) throw new Error('Incomplete channel');
        const values = new Uint8Array(length);
        for (let index = 0; index < length; index++) values[index] = binary.charCodeAt(index);
        result[name] = values;
      }
    } catch (error) {
      result = null;
    }
    decoded.set(cues, result);
    return result;
  }

  function fallback() {
    return { version: 0, mode: 'sweep', scene: 'quiet', energy: .35, previous: null, next: null };
  }

  function read(cues, time) {
    if (!cues || typeof cues !== 'object') return fallback();
    const seconds = Number.isFinite(time) ? Math.max(0, time) : 0;
    if (cues.version === 3) {
      const data = channels(cues);
      if (!data) return fallback();
      const at = Math.min(cues.duration, seconds);
      const position = at * cues.fps;
      const left = sample(data.left, position), right = sample(data.right, position);
      const phrases = cues.phrases || [];
      const phrase = phrases[locate(phrases, at, 'start') - 1];
      const scene = phrase && at <= phrase.end ? phrase.kind : 'quiet';
      return {
        version: 3, scene, mode: scene === 'quiet' ? 'sweep' : 'drums',
        levels: [left, right], haze: sample(data.haze, position),
        angles: [115 + 35 * sample(data.angleLeft, position), 115 + 35 * sample(data.angleRight, position)],
        energy: (left + right) * .5,
        previous: null, next: null,
      };
    }
    // Existing v2 scores remain playable while the analyzed tracks migrate.
    if (cues.version !== 2) return fallback();
    const drums = (cues.sections || []).some(section => section.start <= seconds && seconds < section.end);
    const accents = cues.accents || [];
    const index = locate(accents, seconds);
    return {
      version: 2, scene: drums ? 'groove' : 'quiet', mode: drums ? 'drums' : 'sweep',
      energy: sample(cues.energy, seconds * cues.fps),
      previous: accents[index - 1] || null,
      next: accents[index] || null,
    };
  }

  function pulse(age, strength) {
    const base = .34;
    if (age < 0 || age >= .2) return base;
    const attack = Math.min(1, age / .035);
    const rise = attack * attack * (3 - 2 * attack);
    const envelope = rise * (age <= .075 ? 1 : Math.exp(-(age - .075) / .035));
    return base + (Math.min(1, .82 + strength * .18) - base) * envelope;
  }

  function sweepAngle(time) {
    return 132.5 + 17.5 * Math.sin(time * (Math.PI * 2 / 18) + 1);
  }

  const api = { read, pulse, sweepAngle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.DemeritScore = api;
})();
