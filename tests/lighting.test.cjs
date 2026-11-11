const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const score = require('../inc/light-score.js');
const path = require('node:path');
const slugs = ['walking-out-of-fog', 'barefaced-lies', 'childhood-nightmare', 'bye-bye-my-country'];

const encode = values => Buffer.from(values).toString('base64');
function makeV3() {
  const count = 101;
  return {
    version: 3, duration: 2, fps: 50, encoding: 'u8-base64',
    channels: {
      left: encode(Array.from({ length: count }, (_, index) => 90 + index)),
      right: encode(Array.from({ length: count }, (_, index) => 205 - index)),
      haze: encode(Array(count).fill(166)),
      angleLeft: encode(Array.from({ length: count }, (_, index) => 40 + index)),
      angleRight: encode(Array.from({ length: count }, (_, index) => 200 - index)),
    },
    beats: [.5, 1, 1.5],
    phrases: [{ start: 0, end: 1, kind: 'quiet' }, { start: 1, end: 2, kind: 'groove' }],
    accents: [{ time: 1, type: 'kick', strength: .9, side: 0 }],
    analysis: { separator: 'htdemucs' },
  };
}
function makeV2() {
  return { version: 2, duration: 45, fps: 50, energy: Array(2251).fill(100),
    sections: [{ start: 30.2, end: 45, mode: 'drums' }],
    accents: Array.from({ length: 29 }, (_, index) => ({ time: 30.4 + index * .5, strength: .8 })),
  };
}

for (const slug of slugs) test(`${slug}: valid playable score`, () => {
  const cues = JSON.parse(fs.readFileSync(path.join(__dirname, '../audio', `${slug}.json`)));
  assert.ok([2, 3].includes(cues.version));
  assert.ok(cues.accents.length > 50);
  let previous = -Infinity;
  for (const accent of cues.accents) {
    assert.ok(accent.time >= 0 && accent.time <= cues.duration);
    assert.ok(accent.time > previous);
    assert.ok(accent.strength >= 0 && accent.strength <= 1);
    if (cues.version === 2) {
      assert.equal(score.read(cues, accent.time).mode, 'drums');
      assert.ok(accent.time - previous >= .419);
    } else {
      assert.ok(['kick', 'snare', 'fill', 'impact'].includes(accent.type));
      assert.ok([-1, 0, 1].includes(accent.side));
    }
    previous = accent.time;
  }
  if (cues.version === 3) {
    assert.equal(cues.encoding, 'u8-base64');
    assert.equal(cues.fps, 50);
    assert.equal(cues.analysis.separator, 'htdemucs');
    const count = Math.ceil(cues.duration * cues.fps) + 1;
    for (const channel of ['left', 'right', 'haze', 'angleLeft', 'angleRight']) {
      assert.equal(Buffer.from(cues.channels[channel], 'base64').length, count);
    }
    for (let time = 0; time < cues.duration; time += .137) {
      const value = score.read(cues, time);
      assert.equal(value.version, 3);
      for (const level of [...value.levels, value.haze]) assert.ok(level >= 0 && level <= 1);
      for (const angle of value.angles) assert.ok(angle >= 115 && angle <= 150);
    }
  }
});

test('v3: independent baked channels interpolate, clamp and seek without event state', () => {
  const cues = makeV3();
  const at = score.read(cues, .37);
  assert.equal(at.scene, 'quiet');
  assert.ok(Math.abs(at.levels[0] - 108.5 / 255) < 1e-10);
  assert.ok(Math.abs(at.levels[1] - 186.5 / 255) < 1e-10);
  assert.ok(Math.abs(at.angles[0] - (115 + 35 * 58.5 / 255)) < 1e-10);
  assert.notEqual(at.angles[0], at.angles[1]);
  assert.equal(score.read(cues, 1).scene, 'groove');
  score.read(cues, 1.9); score.read(cues, 0); score.read(cues, 1.2);
  assert.deepEqual(score.read(cues, .37), at);
  assert.deepEqual(score.read(cues, -5), score.read(cues, 0));
  assert.deepEqual(score.read(cues, 20), score.read(cues, 2));
  assert.ok(Math.abs(at.haze - 166 / 255) < 1e-10);
});

test('v3: channels decode once, and malformed score gracefully falls back', () => {
  let decodes = 0;
  const context = { window: {}, Uint8Array, WeakMap,
    atob: value => { decodes++; return Buffer.from(value, 'base64').toString('binary'); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../inc/light-score.js'), 'utf8'), context);
  const cues = makeV3();
  for (let index = 0; index < 100; index++) context.window.DemeritScore.read(cues, index / 50);
  assert.equal(decodes, 5);
  const broken = makeV3(); broken.channels.haze = encode([1, 2]);
  assert.equal(context.window.DemeritScore.read(broken, 1).version, 0);
  const attempts = decodes;
  context.window.DemeritScore.read(broken, .5);
  assert.equal(decodes, attempts);
});

test('legacy accent keeps base light and a short release', () => {
  assert.ok(score.pulse(.05, .8) >= .8);
  assert.equal(score.pulse(.21, .8), .34);
  assert.ok(score.pulse(.12, .8) > .34);
});

test('Childhood Nightmare: guitar intro sweeps, drum entrance flashes, seeking back restores sweep', () => {
  const cues = JSON.parse(fs.readFileSync(path.join(__dirname, '../audio/childhood-nightmare.json')));
  for (const time of [0, 5, 15, 25, 29]) assert.equal(score.read(cues, time).mode, 'sweep');
  for (const time of [31, 40, 80, 150]) assert.equal(score.read(cues, time).mode, 'drums');
  assert.equal(score.read(cues, 12).mode, 'sweep');
  assert.equal(score.read(cues, 12).previous, null);
});

test('slow sweep always points down and has smooth velocity', () => {
  let previous = score.sweepAngle(0);
  for (let time = .016; time < 240; time += .016) {
    const angle = score.sweepAngle(time);
    assert.ok(angle >= 115 && angle <= 150);
    assert.ok(Math.abs(angle - previous) < .31);
    previous = angle;
  }
  assert.equal(score.read(null, 0).mode, 'sweep');
});

test('Web Audio: one audible route across tracks; real transients; reset and fallback', () => {
  const listeners = {};
  const element = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  let sources = 0, outputRoutes = 0, db = -80, outputStamp = null;
  const analyser = { fftSize: 2048, frequencyBinCount: 1024,
    getFloatFrequencyData: out => out.fill(db),
    getFloatTimeDomainData: out => out.fill(db === -80 ? .002 : .1) };
  class AudioContext {
    state = 'running'; sampleRate = 44100; outputLatency = .02; baseLatency = .01; currentTime = 10; destination = {};
    getOutputTimestamp() { return outputStamp; }
    createAnalyser() { return analyser; }
    createMediaElementSource(audio) {
      assert.equal(audio, element); sources++;
      return { connect: target => { if (target === this.destination) outputRoutes++; }, disconnect() {} };
    }
    resume() { return Promise.resolve(); }
  }
  const context = { window: { AudioContext }, document: {
    getElementById: () => element, addEventListener() {},
  }, Float32Array, Math, performance: { now: () => 10000 } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../inc/audio-analysis.js'), 'utf8'), context);
  const api = context.window.DemeritAudio;
  assert.equal(api.sample(0).ready, false);
  api.start(); api.start(); api.start();
  assert.equal(sources, 1); assert.equal(outputRoutes, 1);
  for (let i = 0; i < 30; i++) api.sample(i / 60);
  db = -15;
  assert.ok(api.sample(.52).hit > 0);
  assert.equal(api.sample(.54).hit, 0);
  listeners.seeking();
  assert.equal(api.sample(45).hit, 0);
  listeners.emptied(); api.start();
  assert.equal(sources, 1); assert.equal(outputRoutes, 1);
  assert.equal(api.sample(0).hit, 0);
  assert.ok(Math.abs(api.sample(.1).latency - .03) < 1e-8, 'fallback includes render and device buffering');
  outputStamp = { contextTime: 9.84, performanceTime: 9980 };
  assert.ok(Math.abs(api.sample(.2).latency - .14) < 1e-8, 'timestamp delay is extrapolated to this display frame without double counting');
  outputStamp = { contextTime: 9, performanceTime: 8000 };
  assert.ok(Math.abs(api.sample(.3).latency - .03) < 1e-8, 'stale timestamps use the fallback');
});

test('render loop: actual track changes from continuous narrow sweep, percussion crossfade and base light; pause/seek/reduced motion', () => {
  const cues = makeV2();
  const makeNode = () => ({ dataset: {}, style: {}, classList: { add() {} },
    attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
  const beams = [makeNode(), makeNode()];
  for (const beam of beams) {
    const parts = {};
    beam.querySelector = name => parts[name] ||= makeNode();
    beam.querySelectorAll = () => [makeNode(), makeNode()];
  }
  const stage = makeNode(), glow = makeNode();
  stage.querySelectorAll = selector => selector === '.beam' ? beams : [];
  const hazeParts = {};
  stage.querySelector = selector => hazeParts[selector] ||= makeNode();
  glow.querySelectorAll = () => [makeNode(), makeNode()];
  const audio = { currentTime: 0, playbackRate: 1 };
  const airFrames = [];
  const air = { resize() {}, render: (...values) => airFrames.push(values) };
  const logo = { complete: true, getBoundingClientRect: () => ({ left: 100, top: 50, width: 300, height: 300 }) };
  const elements = { '.searchlights': stage, '.eye-lights': glow, '.logo': logo };
  const listeners = {};
  const reduce = { matches: false, addEventListener() {} };
  let callback;
  const context = { window: { DemeritScore: score, DemeritAtmosphere: { create: () => air }, addEventListener: (name, fn) => listeners[name] = fn },
    document: { hidden: false, querySelector: s => elements[s], getElementById: () => audio, addEventListener() {} },
    matchMedia: () => reduce, addEventListener() {}, innerWidth: 1280, innerHeight: 800,
    requestAnimationFrame: fn => { callback = fn; return 1; }, cancelAnimationFrame() {}, Math };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../inc/searchlights.js'), 'utf8'), context);
  listeners['demerit:playback']({ detail: { playing: true, advancing: true, cues } });
  let base = 0, bright = 0, sweeps = 0, lastAngle = 145;
  for (let frame = 0; frame < 45 * 60; frame++) {
    audio.currentTime = frame / 60;
    callback(frame * 1000 / 60);
    const renderedAngle = Number(beams[0].attributes.transform.match(/rotate\((.*?)\)/)[1]);
    assert.ok(Math.abs(renderedAngle - lastAngle) < .13);
    lastAngle = renderedAngle;
    if (audio.currentTime < 29) {
      assert.equal(stage.dataset.pattern, 'sweep');
      assert.ok(Number(stage.style.opacity) > .4);
      const angle = Number(beams[0].attributes.transform.match(/rotate\((.*?)\)/)[1]);
      assert.ok(angle >= 115 && angle <= 150);
      sweeps++;
    }
    if (audio.currentTime > 31) {
      assert.equal(stage.dataset.pattern, 'sweep+percussion');
      const angle = Number(beams[0].attributes.transform.match(/rotate\((.*?)\)/)[1]);
      assert.ok(angle >= 115 && angle <= 150);
      if (Number(stage.style.opacity) === .34) base++;
      else { assert.ok(Number(stage.style.opacity) > .34); bright++; }
    }
  }
  assert.ok(sweeps > 1000 && base > 150 && bright > 60, { sweeps, base, bright });
  assert.ok(airFrames.length > 600);
  for (let i = 1; i < airFrames.length; i++) {
    assert.ok(airFrames[i][0] > airFrames[i-1][0], 'air has an independent monotonic clock');
    assert.ok(Math.abs(airFrames[i][2] - airFrames[i-1][2]) < .3, 'scattered light has a smooth response');
  }
  const beforeSeek = airFrames.at(-1)[0];
  audio.currentTime = 10; callback(45016);
  assert.ok(Number(stage.style.opacity) >= .34);
  for (let i = 0; i < 200; i++) { audio.currentTime = 10 + i / 60; callback(45032 + i * 1000 / 60); }
  assert.equal(stage.dataset.pattern, 'sweep');
  assert.ok(airFrames.at(-1)[0] > beforeSeek, 'seeking does not reset the fog field');
  listeners['demerit:playback']({ detail: { playing: false, advancing: false, cues } });
  callback(49000); assert.equal(stage.dataset.pattern, 'idle');
  const pausedAirTime = airFrames.at(-1)[0];
  for (let i = 0; i < 120; i++) callback(49016 + i * 1000 / 60);
  assert.ok(airFrames.at(-1)[0] > pausedAirTime + 1.5, 'fog keeps drifting while audio is paused');
  reduce.matches = true;
  listeners['demerit:playback']({ detail: { playing: true, advancing: true, cues } });
  audio.currentTime = 40; callback(52000);
  assert.equal(stage.dataset.pattern, 'still');
  assert.equal(stage.style.opacity, '0.900');
});

test('v3 renderer: per-eye levels/angles, independent haze, exact seeks and no live onset retiming', () => {
  const node = () => ({ dataset: {}, style: {}, attributes: {}, classList: { add() {} },
    setAttribute(name, value) { this.attributes[name] = value; } });
  const beams = [node(), node()], glows = [node(), node()];
  beams.forEach(beam => { const parts = {}; beam.querySelector = name => parts[name] ||= node(); });
  const stage = node(), glowLayer = node();
  stage.querySelectorAll = name => name === '.beam' ? beams : [];
  glowLayer.querySelectorAll = () => glows;
  const logo = { complete: true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 300 }) };
  const audio = { currentTime: 0, playbackRate: 1 };
  const reduce = { matches: false, addEventListener() {} };
  const document = { hidden: false, querySelector: name => ({ '.searchlights': stage, '.eye-lights': glowLayer, '.logo': logo })[name],
    getElementById: () => audio, addEventListener(name, listener) { events[name] = listener; } };
  const events = {}, airFrames = [];
  let callback, liveCalls = 0, rms = .1, latency = 0;
  const context = { window: { DemeritScore: score,
    DemeritAudio: { sample: () => { liveCalls++; return { ready: true, rms, hit: 1, hits: liveCalls, latency }; } },
    DemeritAtmosphere: { create: () => ({ resize() {}, render: (...values) => airFrames.push(values) }) },
    addEventListener: (name, listener) => { events[name] = listener; } }, document,
    matchMedia: () => reduce, addEventListener() {}, innerWidth: 1280, innerHeight: 800,
    requestAnimationFrame: listener => { callback = listener; return 1; }, cancelAnimationFrame() {}, Math };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../inc/searchlights.js'), 'utf8'), context);
  const cues = makeV3();
  events['demerit:playback']({ detail: { playing: true, advancing: true, cues } });
  callback(0);
  audio.currentTime = .5; callback(100);
  const expected = score.read(cues, .5);
  assert.equal(stage.style.opacity, '1');
  assert.equal(glowLayer.style.opacity, '1');
  assert.notEqual(beams[0].style.opacity, beams[1].style.opacity);
  assert.deepEqual(Array.from(airFrames.at(-1)[1]), expected.angles, 'fog receives both scored head angles');
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(Number(beams[i].style.opacity) - expected.levels[i]) < .001);
    assert.equal(glows[i].style.opacity, beams[i].style.opacity);
    const angle = Number(beams[i].attributes.transform.match(/rotate\((.*?)\)/)[1]);
    assert.ok(Math.abs(angle - expected.angles[i]) < .001);
  }
  audio.currentTime = 1.75; callback(200);
  const later = score.read(cues, 1.75);
  assert.ok(Math.abs(Number(beams[0].style.opacity) - later.levels[0]) < .001);
  assert.equal(stage.dataset.pattern, 'score-groove');
  const airBeforeSeek = airFrames.at(-1)[0];
  audio.currentTime = .2; callback(300);
  const earlier = score.read(cues, .2);
  assert.ok(Math.abs(Number(beams[0].style.opacity) - earlier.levels[0]) < .001);
  assert.equal(stage.dataset.pattern, 'score-quiet');
  assert.ok(airFrames.at(-1)[0] > airBeforeSeek);
  for (let i = 1; i <= 60; i++) {
    audio.currentTime = .2 + i / 60;
    callback(300 + i * 1000 / 60);
  }
  assert.ok(Math.abs(airFrames.at(-1)[2] - 166 / 255) < .001, 'haze follows its channel, not the beam average');
  assert.ok(liveCalls < 45, 'live analysis runs below display frame rate');
  rms = 0;
  audio.currentTime = 1.8; callback(1500);
  assert.ok(Number(beams[0].style.opacity) <= .34 && Number(beams[1].style.opacity) <= .34);
  reduce.matches = true;
  callback(1550);
  assert.equal(beams[0].style.opacity, '0.900');
  assert.deepEqual(Array.from(airFrames.at(-1)[1]), [145, 145]);
  assert.ok(beams[0].attributes.transform.endsWith('rotate(145.000)'));
  reduce.matches = false;
  rms = .1; latency = .12; audio.playbackRate = 2;
  events['demerit:playback']({ detail: { playing: true, advancing: true, cues } });
  audio.currentTime = .8; callback(1700);
  assert.ok(Math.abs(Number(beams[0].style.opacity) - score.read(cues, .56).levels[0]) < .001,
    'device output delay is converted into media seconds at the current playback rate');
  audio.currentTime = .9; callback(1950);
  assert.ok(Math.abs(Number(beams[0].style.opacity) - score.read(cues, .66).levels[0]) < .001,
    'a delayed display frame samples the media clock directly without accumulating drift');
  events['demerit:playback']({ detail: { playing: false, advancing: false, cues: makeV2() } });
  callback(1600);
  assert.equal(beams[0].style.opacity, '1', 'legacy score cannot inherit compiled per-eye levels');
  assert.equal(glows[0].style.opacity, '1');
  assert.notEqual(stage.style.opacity, '1');
});

test('atmosphere: two head directions reach both shader variants, scalar compatibility and context restoration', () => {
  const uniforms = new Map(), shaders = [], events = {};
  let draws = 0, prevented = 0;
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, HIGH_FLOAT: 3, COMPILE_STATUS: 4, LINK_STATUS: 5,
    ARRAY_BUFFER: 6, STATIC_DRAW: 7, FLOAT: 8, TRIANGLES: 9,
    TEXTURE0: 10, TEXTURE_2D: 11, UNPACK_ALIGNMENT: 12, UNPACK_FLIP_Y_WEBGL: 13,
    TEXTURE_WRAP_S: 14, TEXTURE_WRAP_T: 15, CLAMP_TO_EDGE: 16, TEXTURE_MIN_FILTER: 17,
    TEXTURE_MAG_FILTER: 18, LINEAR: 19, LUMINANCE: 20, UNSIGNED_BYTE: 21,
    getShaderPrecisionFormat: () => ({ precision: 23 }),
    createShader: type => ({ type }), shaderSource(shader, code) { shader.code = code; shaders.push(shader); },
    compileShader() {}, getShaderParameter: () => true, deleteShader() {},
    createProgram: () => ({}), attachShader() {}, bindAttribLocation() {}, linkProgram() {},
    getProgramParameter: () => true, getUniformLocation: (_, name) => name, useProgram() {},
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, enableVertexAttribArray() {}, vertexAttribPointer() {}, viewport() {},
    createTexture: () => ({}), activeTexture() {}, bindTexture() {}, pixelStorei() {},
    texParameteri() {}, texImage2D() {}, texSubImage2D() {},
    uniform1i(name, ...values) { uniforms.set(name, values); },
    uniform1f(name, ...values) { uniforms.set(name, values); },
    uniform2f(name, ...values) { uniforms.set(name, values); },
    uniform4f(name, ...values) { uniforms.set(name, values); },
    drawArrays() { draws++; },
  };
  const canvas = { dataset: {}, hidden: false, getContext: () => gl,
    addEventListener(name, listener) { events[name] = listener; } };
  const context = { window: {}, matchMedia: () => ({ matches: false }), Float32Array, Uint8Array, Math };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../inc/atmosphere.js'), 'utf8'), context);
  const atmosphere = context.window.DemeritAtmosphere.create(canvas);
  atmosphere.resize(1280, 800, [[100, 150], [200, 160]]);
  atmosphere.render(10, [120, 147], .6, [.4, .9]);
  assert.deepEqual(uniforms.get('headLevels'), [.4, .9]);
  const directions = uniforms.get('directions');
  for (const [index, degrees] of [120, 147].entries()) {
    assert.ok(Math.abs(directions[index * 2] - Math.cos(degrees * Math.PI / 180)) < 1e-10);
    assert.ok(Math.abs(directions[index * 2 + 1] - Math.sin(degrees * Math.PI / 180)) < 1e-10);
  }
  assert.deepEqual(uniforms.get('time'), [10]);
  atmosphere.render(11, 135, .5);
  assert.deepEqual(uniforms.get('headLevels'), [1, 1]);
  const shared = uniforms.get('directions');
  assert.equal(shared[0], shared[2]); assert.equal(shared[1], shared[3]);
  atmosphere.resize(390, 844, [[100, 150], [200, 160]]);
  atmosphere.render(12, [118, 149], .45);
  assert.equal(canvas.dataset.quality, 'compact');
  const fragments = shaders.filter(shader => shader.type === gl.FRAGMENT_SHADER).map(shader => shader.code);
  assert.equal(fragments.length, 2);
  for (const shader of fragments) {
    assert.ok(shader.includes('uniform vec4 directions;'));
    assert.ok(shader.includes('light(p, eyes.xy, directions.xy, 0.0) * headLevels.x + light(p, eyes.zw, directions.zw, 0.0) * headLevels.y'));
    assert.ok(shader.includes('light(p, eyes.xy, directions.xy, depth) * headLevels.x + light(p, eyes.zw, directions.zw, depth) * headLevels.y'));
  }
  assert.ok(fragments.some(shader => shader.startsWith('#define COMPACT')));
  const beforeLoss = draws;
  events.webglcontextlost({ preventDefault() { prevented++; } });
  atmosphere.render(13, [116, 150], .4);
  assert.equal(draws, beforeLoss); assert.equal(prevented, 1); assert.equal(canvas.hidden, true);
  events.webglcontextrestored();
  atmosphere.render(14, [121, 146], .7);
  assert.ok(draws > beforeLoss); assert.equal(canvas.hidden, false);
  const restored = uniforms.get('directions');
  assert.ok(Math.abs(restored[0] - Math.cos(121 * Math.PI / 180)) < 1e-10);
  assert.ok(Math.abs(restored[2] - Math.cos(146 * Math.PI / 180)) < 1e-10);
});
