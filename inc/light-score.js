/* Stateless score lookup: seeks never replay stale flashes or invent beats. */
(() => {
  function sample(values, position) {
    if (!values?.length) return 0;
    const at = Math.max(0, Math.min(values.length - 1, position));
    const i = Math.floor(at);
    return (values[i] + ((values[i + 1] ?? values[i]) - values[i]) * (at - i)) / 255;
  }
  function locate(accents, time) {
    let low = 0, high = accents.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (accents[mid].time <= time) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  function read(cues, time) {
    if (!cues || cues.version !== 2) return { mode: 'sweep', energy: .35, previous: null, next: null };
    const drums = cues.sections.some(section => section.start <= time && time < section.end);
    const index = locate(cues.accents, time);
    return {
      mode: drums ? 'drums' : 'sweep',
      energy: sample(cues.energy, time * cues.fps),
      previous: cues.accents[index - 1] || null,
      next: cues.accents[index] || null,
    };
  }
  function pulse(age, strength) {
    // Leave a low stage wash between accents. A short release makes the
    // return to that base feel like a fixture, rather than a disappearing ray.
    const base = .34;
    if (age < 0 || age >= .2) return base;
    const attack = Math.min(1, age / .035);
    const rise = attack * attack * (3 - 2 * attack);
    const envelope = rise * (age <= .075 ? 1 : Math.exp(-(age - .075) / .035));
    return base + (Math.min(1, .82 + strength * .18) - base) * envelope;
  }
  function sweepAngle(time) {
    // SVG positive y points down: every ray stays below the eye line.
    return 132.5 + 17.5 * Math.sin(time * (Math.PI * 2 / 18) + 1);
  }
  const api = { read, pulse, sweepAngle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.DemeritScore = api;
})();
