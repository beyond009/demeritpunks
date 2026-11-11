const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const score = require('../inc/light-score.js');
const root = path.resolve(__dirname, '..');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'inc/catalog.js'), 'utf8'), context);

for (const album of context.window.DemeritCatalog) for (const track of album.tracks) {
  test(`${album.title} / ${track.title}: score matches the exact audio source and supports seeking`, () => {
    assert.ok(track.cues, 'every song, including the live album, has a score');
    const audio = fs.readFileSync(path.join(root, track.src));
    const cues = JSON.parse(fs.readFileSync(path.join(root, track.cues.split('?')[0]), 'utf8'));
    assert.equal(cues.analysis.sourceSha256, createHash('sha256').update(audio).digest('hex'));
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
