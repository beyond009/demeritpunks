const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const listeners = new Map();
  const styles = new Map();
  function element() {
    return {
      value: '0', disabled: false, paused: true, ended: false, readyState: 4,
      dataset: {}, children: [], attributes: {},
      style: { setProperty(name, value) { styles.set(name, value); } },
      classList: { add() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) {
        const events = listeners.get(this) || new Map();
        events.set(name, [...(events.get(name) || []), callback]);
        listeners.set(this, events);
      },
      append(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      contains() { return true; }, focus() {},
    };
  }
  const ids = Object.fromEntries(['music', 'play', 'seek', 'player-status', 'queue',
    'queue-toggle', 'album-select', 'elapsed', 'duration', 'track-title',
    'previous', 'next', 'queue-close'].map(id => [id, element()]));
  const playlist = element();
  const kicker = element();
  const player = element();
  ids.queue.querySelector = name => name === '.playlist' ? playlist : kicker;
  const document = Object.assign(element(), {
    getElementById: id => ids[id],
    querySelector: name => name === '.player' ? player : element(),
    createElement: element,
  });
  const audio = ids.music;
  let actual = 7;
  const requests = [];
  Object.defineProperty(audio, 'currentTime', {
    get: () => actual,
    // The media element can acknowledge a seek asynchronously. Returning the
    // old clock reproduces the browser race that used to reset the range.
    set: value => { requests.push(value); audio.seeking = true; },
  });
  audio.duration = 200;
  audio.load = () => { audio.duration = NaN; actual = 0; };
  audio.play = async () => {};
  audio.pause = () => {};
  const tracks = [
    { title: 'First', src: '/audio/first.mp3', duration: 200 },
    { title: 'Second', src: '/audio/second.mp3', duration: 180 },
  ];
  const window = {
    DemeritCatalog: [{ id: 'album', title: 'Album', cover: '/cover.jpg', tracks }],
    dispatchEvent() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../inc/player.js'), 'utf8'), {
    window, document, matchMedia: () => Object.assign(element(), { matches: false }),
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  function emit(target, event) {
    for (const callback of listeners.get(target)?.get(event) || []) callback({ target });
  }
  return {
    audio, seek: ids.seek, ids, document, requests, styles, emit,
    settle(value) { actual = value; audio.seeking = false; emit(audio, 'seeked'); },
    advance(value) { actual = value; emit(audio, 'timeupdate'); },
  };
}

test('pointer seeking previews without old playback updates moving the thumb', () => {
  const f = fixture();
  f.emit(f.seek, 'pointerdown');
  f.seek.value = '90';
  f.emit(f.seek, 'input');
  f.advance(8);
  assert.equal(Number(f.seek.value), 90);
  assert.equal(f.ids.elapsed.textContent, '1:30');
  assert.deepEqual(f.requests, [], 'Dragging should not start repeated network seeks.');
  f.emit(f.document, 'pointerup');
  assert.deepEqual(f.requests, [90]);
  f.advance(8.2);
  assert.equal(Number(f.seek.value), 90, 'Keep the target until media acknowledges it.');
  f.settle(90);
  f.advance(90.5);
  assert.equal(Number(f.seek.value), 90.5);
});

test('keyboard input and change-only accessibility commits both seek', () => {
  const f = fixture();
  f.seek.value = '12.1';
  f.emit(f.seek, 'input');
  assert.deepEqual(f.requests, [12.1]);
  f.advance(7);
  assert.equal(Number(f.seek.value), 12.1);
  f.emit(f.seek, 'change');
  assert.deepEqual(f.requests, [12.1], 'The matching change must not seek twice.');
  f.settle(12.1);
  f.seek.value = '145';
  f.emit(f.seek, 'change');
  assert.deepEqual(f.requests, [12.1, 145]);
  assert.equal(f.ids.elapsed.textContent, '2:25');
});

test('cancelled pointer gestures restore actual playback and do not seek', () => {
  const f = fixture();
  f.emit(f.seek, 'pointerdown');
  f.seek.value = '120';
  f.emit(f.seek, 'input');
  f.advance(8);
  f.emit(f.document, 'pointercancel');
  assert.deepEqual(f.requests, []);
  assert.equal(Number(f.seek.value), 8);
});

test('a no-op seek does not leave a pending target freezing progress', () => {
  const f = fixture();
  f.seek.value = '7';
  f.emit(f.seek, 'change');
  assert.deepEqual(f.requests, []);
  f.advance(8);
  assert.equal(Number(f.seek.value), 8);
});

test('a pending seek is cleared when selecting another track', () => {
  const f = fixture();
  f.seek.value = '140';
  f.emit(f.seek, 'change');
  f.emit(f.ids.next, 'click');
  assert.equal(Number(f.seek.value), 0);
  assert.equal(f.seek.disabled, true);
  assert.equal(f.ids['track-title'].textContent, 'Second');
});

test('unknown metadata and zero duration keep seeking disabled', () => {
  const f = fixture();
  for (const duration of [NaN, Infinity, 0]) {
    f.audio.duration = duration;
    f.emit(f.audio, 'loadedmetadata');
    assert.equal(f.seek.disabled, true);
    f.seek.value = '50';
    f.emit(f.seek, 'change');
  }
  assert.deepEqual(f.requests, []);
});
