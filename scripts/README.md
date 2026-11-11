# Offline music and light scores

The browser samples a deterministic 50 Hz score against the audible media
timeline. Audio files are kept intact. Models, separated stems and cached
inference results stay offline; the static site only receives the small score.

Install `requirements-audio.txt` and optionally `requirements-meter.txt` in an
isolated Python environment. FFmpeg must be on the path. From the repository:

```sh
python scripts/separate_drums.py --all --device cpu --work work
python scripts/track_meter.py --all --checkpoint final0 --output work/meter
python scripts/analyze_music.py --all --stems work/drum-stems --meter work/meter
```

See `separate_drums.py --help` for separation options. Existing matching stems
can be reused; neither source audio nor drum separation needs to be regenerated
when changing light choreography. Cache entries are checked against the source
SHA256 and duration before they are used.

## Rhythm policy

- [Beat This!](https://github.com/CPJKU/beat_this) `final0` estimates beats and
  downbeat probabilities from the original mix, including local tempo changes.
- Four-state Viterbi decoding maintains the position within a four-beat bar.
  A strong transition penalty keeps isolated false downbeats from restarting
  the pattern. This is an estimate of meter, not exact drum transcription.
- Main light pulses use beats 1/3 in fast passages and each beat when the model
  already follows a slower beat level. Separate tempo thresholds and changes
  only at bar boundaries prevent subdivision from switching back and forth.
- Each planned pulse must match a real separated kick/snare attack within
  55 ms. Choose by proximity before strength. Missing attacks are skipped. The score enforces
  at least 420 ms between main pulses, including meter corrections. Both heads
  share the main cadence while their motion and continuous bed remain independent.
- A separate `details` layer restores musical answers at a lower dynamic range:
  recurring snare attacks on beats 2/4 can answer on one side, with at least
  180 ms of clearance from a main accent. Very fast passages do not enable a
  constant stream of these answers.
- Fill detection checks every bar ending, counts both low and mid-band attacks,
  and requires a short run and a density increase over actual recent playing.
  Missing history is not treated as silence. At most three true attacks form a
  fill gesture; the main cadence is unchanged.
- Strong sustained cymbals with sufficient absolute band prominence receive a
  small, velocity-bounded beam opening and diffuse haze. A brief shared bloom
  reinforces an existing main hit only when it falls within 80 ms, aligned to
  that main hit to avoid a double flash. Repeated sustained open-cymbal estimates
  can add a softer beat-related texture, at most .04 above the continuous bed.
- Full-mix energy, spectral brightness and texture are smoothed over roughly
  two seconds. They gently vary the continuous bed, sweep range and haze only;
  they cannot schedule pulses or change their timing, subdivision or phase.
  These are acoustic proxies for musical development, not emotion labels.
- Arrangement 7 preserves all 15 tracks' main accents, beat and cadence data
  exactly from arrangement 6. A checked-in fingerprint guards this boundary.

The beat/bar distinction and continuity constraint follow established
[joint beat/downbeat tracking practice](https://madmom.readthedocs.io/en/v0.16.1/modules/features/downbeats.html).
We use the maintained Beat This! model instead of requiring the older madmom
runtime. The official model uses minimal peak postprocessing; the meter and
visual cadence constraints above are applied afterwards.

## Verification

```sh
node --test tests/*.test.cjs
python tests/analyze_music_test.py
python tests/phrase-dynamics.test.py
python tests/rhythm-cadence.test.py
python tests/drum-details.test.py
python tests/music-context.test.py
npm run build
```

Preview audio with a server that supports HTTP byte ranges (206 responses).
Python's basic `http.server` ignores Range and can make media seeking reset to
zero even when the production audio and player are correct.
