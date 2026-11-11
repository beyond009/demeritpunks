const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../inc/smoke-physics.js');
const { pose } = require('../inc/logo-motion.js');

const mouth = { x: 190, y: 400, scale: .85, active: true, openness: 1, breath: 1 };
function simulator(width = 390, height = 844) {
  const fluid = create(); fluid.resize(width, height); return fluid;
}
function advance(fluid, seconds, emission = { active: false }, hz = 15) {
  fluid.setEmission(emission);
  for (let frame = 0; frame < Math.ceil(seconds * hz); frame++) fluid.step(1 / hz);
}
function distribution(field, viewWidth = 390, viewHeight = 844) {
  let total = 0, x = 0, y = 0, xx = 0, yy = 0, occupied = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let row = 0; row < field.height; row++) {
    for (let column = 0; column < field.width; column++) {
      const value = field.pixels[row * field.width + column];
      const px = (column + .5) / field.width * viewWidth;
      const py = (row + .5) / field.height * viewHeight;
      total += value; x += value * px; y += value * py;
      xx += value * px * px; yy += value * py * py;
      if (value > 2) {
        occupied++; minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
    }
  }
  return { x: x / total, y: y / total, sigmaX: Math.sqrt(xx / total - (x / total) ** 2),
    sigmaY: Math.sqrt(yy / total - (y / total) ** 2), occupied,
    width: maxX - minX, height: maxY - minY };
}

test('empty room has no smoke; closed mouth or a breath hold cannot create density', () => {
  const fluid = simulator();
  assert.equal(fluid.field.pixels.length, fluid.field.width * fluid.field.height);
  for (const emission of [{ ...mouth, openness: 0 }, { ...mouth, breath: 0 }, { ...mouth, active: false }]) {
    advance(fluid, 3, emission);
    assert.equal(fluid.field.mass, 0);
    assert.equal(fluid.field.peak, 0);
    assert.ok(fluid.field.pixels.every(value => value === 0));
  }
});

test('actual long-exhalation profile fills the room to a bounded peak, then gradually clears', () => {
  const fluid = simulator();
  const peaks = Array(5).fill(0), sourceSeconds = Array(5).fill(0), snapshots = new Map();
  const observeAt = new Set([12, 44, 78, 88, 98, 118]);
  for (let frame = 0; frame < 120 * 15; frame++) {
    const time = frame / 15, value = pose(time), cycle = Math.floor(time / 16);
    fluid.setEmission({ ...mouth, openness: value.openness, breath: value.breath, active: time < 78 });
    fluid.step(1 / 15);
    if (cycle < 5) {
      peaks[cycle] = Math.max(peaks[cycle], fluid.field.mass);
      if (value.breath > .5) sourceSeconds[cycle] += 1 / 15;
    }
    assert.ok(Number.isFinite(fluid.field.mass) && Number.isFinite(fluid.field.peak));
    assert.ok(fluid.field.peak <= 4.5 && fluid.field.peak >= 0);
    if (observeAt.has(time)) snapshots.set(time, { mass: fluid.field.mass, ...distribution(fluid.field) });
  }
  assert.ok(sourceSeconds.every(seconds => seconds > 8), sourceSeconds);
  assert.ok(Math.max(...peaks.slice(1)) > peaks[0] * 1.15, { peaks });
  assert.ok(peaks.slice(2).every(mass => mass > peaks[0] && mass < peaks[0] * 1.5), { peaks });
  const first = snapshots.get(12), full = snapshots.get(44), stopped = snapshots.get(78);
  assert.ok(first.mass > 150000, 'the wider source produces visibly more smoke in the first breath');
  assert.ok(full.occupied > first.occupied * 1.3, { first, full });
  assert.ok(full.occupied > fluid.field.width * fluid.field.height * .6, full);
  assert.ok(full.width > 350 && full.height > 550, full);
  assert.ok(full.y < mouth.y - 70, full);
  // Dense smoke exits the left/top boundary. Once the source stops, the
  // remaining cloud's centroid may move right; monotonic leftward centroid
  // motion would incorrectly reject a room-wide advected, dissipating cloud.
  const afterTen = snapshots.get(88), afterTwenty = snapshots.get(98), later = snapshots.get(118);
  assert.ok(afterTen.mass > stopped.mass * .2 && afterTen.mass < stopped.mass * .65,
    { stopped, afterTen });
  assert.ok(afterTwenty.mass < afterTen.mass * .6 && afterTwenty.mass > 0,
    { afterTen, afterTwenty });
  assert.ok(later.mass < stopped.mass * .06 && later.mass > 0, { stopped, later });
  // The thicker plume remains visible longer, while its mass still falls
  // below 6% after forty seconds with no emission.
  assert.ok(later.occupied < full.occupied * .75, { full, later });
});

test('a long exhalation quickly carries smoke away from the mouth before buoyancy takes over', () => {
  const fluid = simulator();
  for (let frame = 0; frame < 2 * 15; frame++) {
    const value = pose(frame / 15);
    fluid.setEmission({ ...mouth, openness: value.openness, breath: value.breath });
    fluid.step(1 / 15);
  }
  const plume = distribution(fluid.field);
  assert.ok(plume.x < mouth.x - 30, plume);
  assert.ok(plume.width > 170 && plume.occupied > 250, plume);
  assert.ok(Math.abs(plume.y - mouth.y) < 20, plume);
});

test('emitted smoke belongs to room coordinates after the mouth moves', () => {
  const first = simulator(), second = simulator();
  advance(first, 2, mouth); advance(second, 2, mouth);
  advance(first, 2, { ...mouth, active: false });
  advance(second, 2, { ...mouth, x: 1000, y: -500, active: false });
  assert.deepEqual(first.field.pixels, second.field.pixels);
  assert.equal(first.field.mass, second.field.mass);
  const cloud = distribution(first.field);
  assert.ok(cloud.x < mouth.x - 25, cloud);
});

test('room circulation lets part of an emitted cloud sink while the main cloud still rises', () => {
  const fluid = simulator();
  advance(fluid, 10, mouth);
  advance(fluid, 6);
  const flow = fluid.transport();
  const movingMass = flow.risingMass + flow.sinkingMass;
  assert.ok(flow.sinkingMass > movingMass * .15 && flow.sinkingMass < movingMass * .45, flow);
  assert.ok(flow.upwardFlux > flow.downwardFlux * 2 && flow.downwardFlux > 50000, flow);
  assert.ok(movingMass > fluid.field.mass * .8, flow);
  assert.ok(Math.hypot(flow.risingCenter.x - flow.sinkingCenter.x,
    flow.risingCenter.y - flow.sinkingCenter.y) > 12, flow);
  // Opposite velocities coexist after emission has stopped: the effect is
  // a room-space return current, not the whole smoke layer changing direction.
  assert.ok(flow.risingCenter.y < mouth.y && flow.sinkingCenter.y < mouth.y, flow);
});

test('resizing preserves smoke, same-size resize is a no-op, and clear resets all density', () => {
  const fluid = simulator(); advance(fluid, 2, mouth);
  const before = fluid.field.mass, pixels = fluid.field.pixels;
  fluid.resize(390, 844);
  assert.equal(fluid.field.pixels, pixels);
  assert.equal(fluid.field.mass, before);
  fluid.resize(780, 844);
  assert.ok(fluid.field.mass > before * 1.5 && fluid.field.mass < before * 2.5);
  assert.ok(fluid.field.pixels.some(value => value > 0));
  fluid.clear();
  assert.equal(fluid.field.mass, 0); assert.equal(fluid.field.peak, 0);
  assert.ok(fluid.field.pixels.every(value => value === 0));
});

test('fluid budgets and invalid input handling stay bounded on phones and wide windows', () => {
  for (const [width, height, budget] of [[390, 844, 6500], [320, 1000, 6500], [700, 700, 10000], [2560, 900, 10000]]) {
    const fluid = simulator(width, height), field = fluid.field;
    assert.ok(field.width * field.height <= budget);
    assert.ok(field.width >= 40 && field.height >= 40);
    const pixels = field.pixels;
    advance(fluid, .5, { ...mouth, x: width * .5, y: height * .5, scale: 20, openness: 100, breath: 100 });
    fluid.step(Number.NaN); fluid.step(Number.POSITIVE_INFINITY); fluid.step(-5);
    fluid.setEmission({ ...mouth, x: Number.NaN }); fluid.step(1000);
    assert.equal(fluid.field.pixels, pixels, 'normal stepping reuses the texture array');
    assert.ok(Number.isFinite(field.mass) && Number.isFinite(field.peak));
    assert.ok(field.peak >= 0 && field.peak <= 4.5);
    assert.ok(field.pixels.every(value => value >= 0 && value <= 255));
  }
});

test('time subdivision keeps a delayed frame near the same physical trajectory', () => {
  const regular = simulator(), delayed = simulator();
  regular.setEmission(mouth); delayed.setEmission(mouth);
  for (let frame = 0; frame < 40; frame++) regular.step(.05);
  for (let frame = 0; frame < 10; frame++) delayed.step(.2);
  assert.deepEqual(regular.field.pixels, delayed.field.pixels);
  assert.equal(regular.field.mass, delayed.field.mass);
});
