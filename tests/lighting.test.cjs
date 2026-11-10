const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const score = require('../inc/light-score.js');
const path = require('node:path');
const slugs = ['walking-out-of-fog', 'barefaced-lies', 'childhood-nightmare', 'bye-bye-my-country'];

for (const slug of slugs) test(`${slug}: valid percussion score and low base light between accents`, () => {
  const cues = JSON.parse(fs.readFileSync(path.join(__dirname, '../audio', `${slug}.json`)));
  assert.equal(cues.version, 2);
  assert.ok(cues.accents.length > 100);
  for (let i = 0; i < cues.accents.length; i++) {
    const accent = cues.accents[i];
    assert.equal(score.read(cues, accent.time).mode, 'drums');
    assert.ok(score.pulse(.05, accent.strength) >= .8);
    assert.equal(score.pulse(.21, accent.strength), .34);
    assert.ok(score.pulse(.12, accent.strength) > .34);
    if (i) assert.ok(accent.time - cues.accents[i - 1].time >= .419);
  }
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
  let sources = 0, outputRoutes = 0, db = -80;
  const analyser = { fftSize: 2048, frequencyBinCount: 1024,
    getFloatFrequencyData: out => out.fill(db),
    getFloatTimeDomainData: out => out.fill(db === -80 ? .002 : .1) };
  class AudioContext {
    state = 'running'; sampleRate = 44100; outputLatency = .02; destination = {};
    createAnalyser() { return analyser; }
    createMediaElementSource(audio) {
      assert.equal(audio, element); sources++;
      return { connect: target => { if (target === this.destination) outputRoutes++; }, disconnect() {} };
    }
    resume() { return Promise.resolve(); }
  }
  const context = { window: { AudioContext }, document: {
    getElementById: () => element, addEventListener() {},
  }, Float32Array, Math };
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
});

test('render loop: actual track changes from continuous narrow sweep, percussion crossfade and base light; pause/seek/reduced motion', () => {
  const cues = JSON.parse(fs.readFileSync(path.join(__dirname, '../audio/childhood-nightmare.json')));
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
