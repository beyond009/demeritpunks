const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pose } = require('../inc/logo-motion.js');
const controller = fs.readFileSync(require.resolve('../inc/logo-motion.js'), 'utf8');

function fixture({ loaded = true, reduced = false, width = 1000, coarse = false } = {}) {
  const events = {}, windowEvents = {}, preferenceEvents = {}, callbacks = new Map();
  let nextFrame = 1, transformWrites = 0;
  const parts = ['jaw', 'D', 'e', 'M', 'E', 'Ri', 'T', 'head'].map(name => {
    const listeners = {};
    return { name, complete: loaded, naturalWidth: loaded ? 510 : 0, listeners,
      addEventListener: (type, fn) => { listeners[type] = fn; },
      style: new Proxy({}, { set(target, key, value) { if (key === 'transform') transformWrites++; target[key] = value; return true; } }),
    };
  });
  const classes = new Set(), rig = { dataset: {},
    classList: { add: value => classes.add(value) },
    getBoundingClientRect: () => ({ left: 100, top: 40, width: 420, height: 437.3 }),
    querySelectorAll: () => parts,
    querySelector: selector => parts.find(p => selector === `[data-part="${p.name}"]`),
  };
  const canvas = {}, updates = [];
  const atmosphere = { setEmission: value => updates.push(value) };
  const preference = { matches: reduced, addEventListener: (name, fn) => preferenceEvents[name] = fn };
  const document = { hidden: false, querySelector: selector => selector === '.logo-rig' ? rig : canvas,
    getElementById: () => ({ currentTime: 0 }), addEventListener: (name, fn) => events[name] = fn };
  const window = { DemeritStageAtmosphere: atmosphere,
    addEventListener: (name, fn) => windowEvents[name] = fn };
  const context = { window, document, innerWidth: width, innerHeight: 844,
    matchMedia: query => query.includes('reduced-motion') ? preference : { matches: coarse },
    requestAnimationFrame: fn => { const id = nextFrame++; callbacks.set(id, fn); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
    addEventListener: (name, fn) => events[name] = fn,
  };
  vm.runInNewContext(controller, context);
  async function settle() { for (let i = 0; i < 4; i++) await Promise.resolve(); }
  function tick(timestamp) {
    const next = callbacks.entries().next().value;
    assert.ok(next, 'expected scheduled animation frame');
    callbacks.delete(next[0]); next[1](timestamp);
  }
  function loadedPart(index) { parts[index].naturalWidth = 510; parts[index].listeners.load?.(); }
  return { parts, rig, canvas, classes, updates, callbacks,
    preference, preferenceEvents, document, events, windowEvents, settle, tick, loadedPart,
    get writes() { return transformWrites; } };
}

test('fallback remains until every sprite loads; a failed sprite keeps fallback and smoke off', async () => {
  const f = fixture({ loaded: false });
  await f.settle();
  assert.equal(f.classes.has('is-loaded'), false);
  assert.equal(f.callbacks.size, 0);
  for (let i = 0; i < f.parts.length - 1; i++) f.loadedPart(i);
  await f.settle();
  assert.equal(f.classes.has('is-loaded'), false);
  assert.equal(f.callbacks.size, 0);
  f.loadedPart(f.parts.length - 1);
  await f.settle();
  assert.equal(f.classes.has('is-loaded'), true);
  assert.equal(f.callbacks.size, 1);
  f.tick(1000);
  assert.equal(f.updates.at(-1).active, true);

  const failed = fixture({ loaded: false });
  failed.parts[0].listeners.error(new Error('asset missing'));
  for (let i = 1; i < failed.parts.length; i++) failed.loadedPart(i);
  await failed.settle();
  assert.equal(failed.classes.has('is-loaded'), false);
  assert.equal(failed.callbacks.size, 0);
  assert.ok(failed.updates.every(e => !e.active));
});

test('reduced motion performs zero movement or smoke, including live preference changes', async () => {
  const f = fixture({ reduced: true }); await f.settle();
  assert.equal(f.callbacks.size, 0);
  assert.ok(f.updates.every(e => !e.active));
  assert.ok(f.parts.every(part => part.style.transform === ''));
  assert.equal(f.rig.dataset.openness, '0');
  f.preference.matches = false; f.preferenceEvents.change();
  assert.equal(f.callbacks.size, 1); f.tick(1000);
  assert.equal(f.updates.at(-1).active, true);
  f.preference.matches = true; f.preferenceEvents.change();
  assert.equal(f.callbacks.size, 0);
  assert.equal(f.rig.dataset.openness, '0');
  assert.ok(f.parts.every(part => part.style.transform === ''));
});

test('hidden document cancels RAF and stops emission; resume advances only a short step', async () => {
  const f = fixture(); await f.settle();
  for (let i = 0; i < 105; i++) f.tick(1000 + i * 1000 / 60);
  const before = Number(f.rig.dataset.openness);
  const previousUpdates = f.updates.length;
  f.document.hidden = true; f.events.visibilitychange();
  assert.equal(f.callbacks.size, 0); assert.equal(f.updates.at(-1).active, false);
  f.document.hidden = false; f.events.visibilitychange();
  assert.equal(f.callbacks.size, 1); f.tick(600000);
  const after = Number(f.rig.dataset.openness);
  assert.ok(Math.abs(after - before) < .04, { before, after });
  assert.equal(f.updates.length, previousUpdates + 2);
  assert.equal(f.updates.at(-1).active, true);
});

test('pose is bounded and continuous through cycle boundaries; breath requires an open jaw', () => {
  let previous = pose(0);
  for (let frame = 1; frame < 60 * 181; frame++) {
    const current = pose(frame / 60);
    assert.ok(current.openness >= 0 && current.openness <= 1);
    assert.ok(current.breath >= 0 && current.breath <= 1);
    assert.ok(current.breath <= current.openness + 1e-9, 'airflow fades before the jaw closes');
    assert.ok(Math.abs(current.openness - previous.openness) < .023);
    assert.ok(Math.abs(current.jaw.x) <= .45 && current.jaw.y >= 0 && current.jaw.y <= 4.73);
    assert.ok(Math.abs(current.jaw.rotation) <= .865);
    assert.ok(Math.abs(current.jaw.y - previous.jaw.y) < .11);
    for (let i = 0; i < current.letters.length; i++) {
      assert.ok(Math.abs(current.letters[i].y) <= 1.43);
      assert.ok(Math.abs(current.letters[i].rotation) <= .27);
      assert.ok(Math.abs(current.letters[i].y - previous.letters[i].y) < .04);
    }
    previous = current;
  }
});

test('short frames throttle sprite writes; elapsed delta is bounded and smoke origin stays at mouth', async () => {
  const f = fixture({ width: 390, coarse: true }); await f.settle();
  f.tick(1000); const initialWrites = f.writes;
  f.tick(1005); f.tick(1010); f.tick(1020); f.tick(1030);
  assert.equal(f.writes, initialWrites);
  f.tick(1040); assert.equal(f.writes - initialWrites, 7);
  assert.equal(f.callbacks.size, 1);
  const beforeGap = Number(f.rig.dataset.openness);
  f.tick(10000); assert.ok(Math.abs(Number(f.rig.dataset.openness) - beforeGap) < .07);
  for (let i = 0; i < 120; i++) f.tick(10040 + i * 40);
  const emission = f.updates.find(value => value.breath > .8);
  assert.ok(emission, 'full exhalation should occur');
  assert.ok(emission.x > 250 && emission.x < 265, emission);
  assert.ok(emission.y > 370 && emission.y < 379, emission);
  assert.equal(emission.scale, 1);
  assert.ok(f.updates.every(e => !e.active || (Number.isFinite(e.x) && Number.isFinite(e.y))));
});


test('long breath gently articulates the jaw and letters, and the next cycle returns sooner', () => {
  const during = pose(2.8), later = pose(5.2);
  assert.equal(during.openness, 1); assert.equal(later.openness, 1);
  assert.equal(during.breath, 1); assert.equal(later.breath, 1);
  assert.notEqual(during.jaw.y, later.jaw.y, 'an open jaw keeps a gentle breathing motion');
  assert.notEqual(during.jaw.rotation, later.jaw.rotation);
  assert.equal(pose(80).breath, 0);
  assert.equal(pose(90).breath, 1, 'the next breath begins after the shorter rest');
  assert.ok(during.letters.every(letter => Math.abs(letter.y) < 1.43));
});
