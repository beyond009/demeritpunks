/* The PNG pixels stay intact. Only a few composited sprite transforms change. */
(() => {
  const clamp = value => Math.max(0, Math.min(1, value));
  const ease = (low, high, value) => {
    const x = clamp((value - low) / (high - low));
    return x * x * (3 - 2 * x);
  };
  function pose(seconds) {
    const roomCycle = ((seconds % 88) + 88) % 88;
    const cycle = roomCycle % 16;
    // Long exhalations fill the room; the source then rests as the air clears.
    const source = 1 - ease(70, 78, roomCycle);
    const openness = source * ease(.25, 1.4, cycle) * (1 - ease(10.8, 12.4, cycle));
    const breath = source * ease(.9, 1.5, cycle) * (1 - ease(9.8, 11.5, cycle));
    const letters = [0, .8, 1.55, 2.1, 2.8, 3.65].map((offset, index) => {
      const wave = Math.sin(seconds * (Math.PI * 2 / (6.2 + index * .35)) + offset);
      const exhale = Math.sin(seconds * 1.65 + offset * .3) * breath;
      return { y: wave * (index === 2 ? .55 : .95) - breath * (index === 2 ? .22 : .38) + exhale * .10,
        rotation: wave * .22 + exhale * .05 };
    });
    const articulation = Math.sin(seconds * 1.85) * breath;
    return { openness, breath, jaw: { x: -.45 * openness, y: 4.35 * openness + articulation * .38,
      rotation: -.8 * openness + articulation * .065 }, letters };
  }
  const api = { pose };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  window.DemeritLogoMotion = api;
  const rig = document.querySelector('.logo-rig');
  if (!rig) return;
  const parts = [...rig.querySelectorAll('.logo-part')];
  const jaw = rig.querySelector('[data-part="jaw"]');
  const letters = ['D', 'e', 'M', 'E', 'Ri', 'T'].map(name => rig.querySelector(`[data-part="${name}"]`));
  const atmosphere = window.DemeritStageAtmosphere;
  atmosphere?.setEmission({ active: false });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, last = 0, lastDraw = -Infinity, clock = 0, loaded = false;
  let compact = false, bounds = null;

  function measure() {
    bounds = rig.getBoundingClientRect();
    compact = innerWidth < 700 || matchMedia('(pointer: coarse)').matches;

    lastDraw = -Infinity;
    schedule();
  }
  function reset() {
    for (const image of parts) image.style.transform = '';
    rig.dataset.openness = '0';
    atmosphere?.setEmission({ active: false });
  }
  function draw(timestamp) {
    frame = 0;
    const dt = Math.min(.05, (timestamp - (last || timestamp)) / 1000 || 1 / 60);
    last = timestamp;
    if (reduce.matches) { reset(); return; }
    clock += dt;
    const value = pose(clock);
    // CSS pixel offsets are derived from the original 510px source canvas.
    const scale = bounds.width / 510;
    if (timestamp - lastDraw >= (compact ? 40 : 30)) {
      jaw.style.transform = `translate(${(value.jaw.x * scale).toFixed(3)}px,${(value.jaw.y * scale).toFixed(3)}px) rotate(${value.jaw.rotation.toFixed(3)}deg)`;
      letters.forEach((image, index) => {
        const movement = value.letters[index];
        image.style.transform = `translateY(${(movement.y * scale).toFixed(3)}px) rotate(${movement.rotation.toFixed(3)}deg)`;
      });
      rig.dataset.openness = value.openness.toFixed(3);
      rig.dataset.motionTime = clock.toFixed(2);
      lastDraw = timestamp;
    }
    // Exhalation starts inside the existing black mouth opening, below M.
    // Birth positions follow the mouth; existing wisps move in room space.
    const radians = value.jaw.rotation * Math.PI / 180;
    const dx = 190 - 356, dy = 402 - 380;
    const x = 356 + dx * Math.cos(radians) - dy * Math.sin(radians) + value.jaw.x;
    const y = 380 + dx * Math.sin(radians) + dy * Math.cos(radians) + value.jaw.y;
    atmosphere?.setEmission( { x: bounds.left + x * scale, y: bounds.top + y * scale,
      openness: value.openness, breath: value.breath, scale: bounds.width / 420, active: loaded });
    schedule();
  }
  function schedule() {
    if (frame || !loaded || document.hidden) return;
    if (reduce.matches) { reset(); return; }
    frame = requestAnimationFrame(draw);
  }
  function stop() {
    cancelAnimationFrame(frame); frame = 0; last = 0;
    atmosphere?.setEmission({ active: false });
  }
  Promise.all(parts.map(image => image.complete && image.naturalWidth ? Promise.resolve() :
    new Promise((resolve, reject) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', reject, { once: true });
    }))).then(() => {
      loaded = true; rig.classList.add('is-loaded'); measure();
    }).catch(reset);
  addEventListener('resize', measure, { passive: true });
  addEventListener('scroll', () => { bounds = rig.getBoundingClientRect(); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else measure(); });
  reduce.addEventListener('change', () => { stop(); measure(); });
})();
