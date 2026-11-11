const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const score = require('../inc/light-score.js');
const root = path.resolve(__dirname, '..');
const rhythmV6 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rhythm-v6.json'), 'utf8'));
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'inc/catalog.js'), 'utf8'), context);

// Compare the complete ordered sequences, including main strength/side and
// cadence period/stride. Sorting object keys keeps formatting irrelevant.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
}
function rhythmHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

test('the complete catalog retains its approved v6 rhythm baseline', () => {
  const ids = context.window.DemeritCatalog.flatMap(album => album.tracks.map(track => track.id));
  assert.deepEqual(Array.from(ids).sort(), Object.keys(rhythmV6.tracks).sort(),
    'every published track needs its original rhythm baseline');
  assert.equal(rhythmV6.version, 6);
  assert.match(rhythmV6.sourceCommit, /^[a-f0-9]{40}$/);
});

for (const album of context.window.DemeritCatalog) for (const track of album.tracks) {
  test(`${album.title} / ${track.title}: score matches the exact audio source and supports seeking`, () => {
    assert.ok(track.cues, 'every song, including the live album, has a score');
    const audio = fs.readFileSync(path.join(root, track.src));
    const cues = JSON.parse(fs.readFileSync(path.join(root, track.cues.split('?')[0]), 'utf8'));
    assert.equal(cues.analysis.sourceSha256, createHash('sha256').update(audio).digest('hex'));
    const baseline = rhythmV6.tracks[track.id];
    assert.ok(baseline, 'this song has an approved v6 rhythm baseline');
    assert.equal(cues.analysis.sourceSha256, baseline.sourceSha256,
      'the rhythm baseline belongs to the exact same audio recording');
    for (const field of ['beats', 'downbeats', 'cadence', 'accents']) {
      assert.ok(Array.isArray(cues[field]), `${field} remains an ordered sequence`);
      assert.equal(cues[field].length, baseline[field].count,
        `${field}: detail and context layers must not add or remove main rhythm events`);
      assert.equal(rhythmHash(cues[field]), baseline[field].sha256,
        `${field}: detail and context layers must preserve every v6 rhythm value and position`);
    }
    assert.equal(cues.analysis.arrangement, 7);
    assert.equal(cues.analysis.meter.model, 'Beat This! final0');
    assert.match(cues.analysis.meter.checkpointSha256, /^[a-f0-9]{64}$/);
    for (let index = 0; index < cues.accents.length; index++) {
      const accent = cues.accents[index];
      assert.equal(accent.side, -1, 'the main cadence reaches both heads together');
      assert.ok(cues.cadence.some(slot => Math.abs(slot.time - accent.time) <= .055),
        'a real drum attack may only refine the planned meter slot');
      if (index) assert.ok(accent.time - cues.accents[index - 1].time >= .42,
        'fills and phase corrections cannot insert a burst of extra flashes');
    }
    const fills = new Map();
    for (const detail of cues.details) {
      assert.ok(['fill', 'backbeat', 'cymbal', 'cymbal-texture'].includes(detail.type));
      assert.ok(detail.time >= 0 && detail.time <= cues.duration);
      assert.ok(detail.strength >= 0 && detail.strength <= 1);
      if (!detail.type.startsWith('cymbal')) {
        assert.ok([0, 1].includes(detail.side));
        assert.ok(cues.accents.every(accent => Math.abs(accent.time - detail.time) >= .15),
          'a quiet side answer leaves the main drum impact readable');
      }
      if (detail.type === 'fill') {
        const key = `${detail.windowStart}/${detail.windowEnd}`;
        fills.set(key, (fills.get(key) || 0) + 1);
        assert.ok(detail.time >= detail.windowStart && detail.time < detail.windowEnd);
        assert.ok(fills.get(key) <= 3, 'a fill is a short gesture, never a continuous flash roll');
      }
    }
    assert.ok(Math.abs(cues.duration - track.duration) < .06);
    const count = Math.ceil(cues.duration * cues.fps) + 1;
    for (const values of Object.values(cues.channels)) assert.equal(Buffer.from(values, 'base64').length, count);
    for (let time = 0; time < cues.duration; time += .673) {
      const value = score.read(cues, time);
      assert.equal(value.version, 3);
      for (const level of [...value.levels, value.haze]) assert.ok(level >= 0 && level <= 1);
      for (const angle of value.angles) assert.ok(angle >= 115 && angle <= 150);
    }
    const before = score.read(cues, 10);
    score.read(cues, cues.duration - 1);
    assert.deepEqual(score.read(cues, 10), before, 'seeking does not replay earlier light events');
  });
}
