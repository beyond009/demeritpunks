"""Offline percussion/phrase analysis. Requires only NumPy and FFmpeg.

Median HPSS follows Fitzgerald (DAFx 2010). Cues are measured onsets,
not a free-running BPM oscillator. No audio leaves the machine.
"""
import json
import pathlib
import subprocess
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
RATE, HOP, WINDOW = 11025, 220, 2048
FPS = RATE / HOP


def normalize(values, percentile=95):
    return np.clip(values / max(float(np.percentile(values, percentile)), 1e-7), 0, 1)


def smooth(values, seconds):
    n = min(len(values), max(1, int(seconds * FPS)))
    return np.convolve(values, np.ones(n) / n, mode='same')


def percussion_spectrum(spectrum):
    """Horizontal sustained tones vs vertical broadband percussive events."""
    harmonic, percussive = np.empty_like(spectrum), np.empty_like(spectrum)
    for col in range(0, spectrum.shape[1], 64):
        part = np.pad(spectrum[:, col:col + 64], ((15, 15), (0, 0)), mode='edge')
        harmonic[:, col:col + 64] = np.median(
            np.lib.stride_tricks.sliding_window_view(part, 31, axis=0), axis=-1)
    for row in range(0, len(spectrum), 256):
        part = np.pad(spectrum[row:row + 256], ((0, 0), (8, 8)), mode='edge')
        percussive[row:row + 256] = np.median(
            np.lib.stride_tricks.sliding_window_view(part, 17, axis=1), axis=-1)
    # Wider margin suppresses guitar harmonics leaking into the drum channel.
    mask = percussive ** 2 / (percussive ** 2 + (harmonic * 2) ** 2 + 1e-9)
    return spectrum * mask


def analyze(samples):
    frames = np.lib.stride_tricks.sliding_window_view(
        np.pad(samples, (WINDOW // 2, WINDOW // 2)), WINDOW)[::HOP]
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    spectrum = np.abs(np.fft.rfft(frames * np.hanning(WINDOW), axis=1)).astype(np.float32)
    perc = percussion_spectrum(spectrum)
    frequencies = np.fft.rfftfreq(WINDOW, 1 / RATE)
    flux = np.maximum(0, np.diff(perc, axis=0, prepend=perc[:1]))
    kick = np.mean(flux[:, (frequencies >= 40) & (frequencies < 180)], axis=1)
    snare = np.mean(flux[:, (frequencies >= 180) & (frequencies < 4500)], axis=1)
    onset = normalize(kick, 97) * .45 + normalize(snare, 97) * .55
    percussion = np.sqrt(np.mean(perc ** 2, axis=1))
    # Absolute track-relative activity prevents a quiet guitar intro from being
    # normalized up to the same confidence as a full drum kit.
    activity = smooth(onset, 1.2)
    energy_gate = normalize(smooth(percussion, .6), 80)
    activity_gate = normalize(activity, 70)
    confidence = np.minimum(activity_gate, energy_gate)
    confidence[rms < .003] = 0
    active = confidence > .24
    # Hysteresis: avoid changing scene on every gap between drum hits.
    state, hold, sections = False, 0, []
    for i, value in enumerate(active):
        if value:
            hold += 1
            if not state and hold >= int(.18 * FPS):
                state = True
                start = max(0, i - hold + 1)
                sections.append({'start': round(start / FPS, 3), 'end': None, 'mode': 'drums'})
        else:
            hold = 0
            if state and not np.any(active[max(0, i - int(.85 * FPS)):i + 1]):
                state = False
                sections[-1]['end'] = round((i - int(.6 * FPS)) / FPS, 3)
    duration = len(samples) / RATE
    if state:
        sections[-1]['end'] = round(duration, 3)

    local = smooth(onset, .8)
    candidates = np.where((onset[1:-1] > onset[:-2]) & (onset[1:-1] >= onset[2:]) &
                          (onset[1:-1] > local[1:-1] * 1.15 + .065))[0] + 1
    candidates = [int(i) for i in candidates if confidence[i] > .2 and rms[i] > .008]

    # Autocorrelation estimates a local quarter-note grid. Octave ambiguity is
    # acceptable for lighting: choose a spacious 75–150 BPM accent cadence.
    accents, tempos = [], []
    last = -100.0
    for start in range(0, len(onset), int(8 * FPS)):
        stop = min(len(onset), start + int(8 * FPS))
        env = onset[max(0, start - int(4 * FPS)):min(len(onset), stop + int(4 * FPS))]
        env = np.maximum(0, env - np.mean(env))
        lags = np.arange(int(FPS * .4), int(FPS * .8) + 1)
        corr = np.array([np.dot(env[:-lag], env[lag:]) for lag in lags])
        lag = int(lags[int(np.argmax(corr))])
        period = lag / FPS
        tempos.append({'time': round(start / FPS, 3), 'bpm': round(60 / period, 1)})
        points = [i for i in candidates if start <= i < stop]
        if not points:
            continue
        # Pick the beat phase supported by actual percussion attacks.
        phase_scores = []
        for phase in range(lag):
            distances = np.abs((np.asarray(points) - phase + lag / 2) % lag - lag / 2)
            phase_scores.append(float(np.sum(onset[points] * np.exp(-.5 * (distances / 3) ** 2))))
        phase = int(np.argmax(phase_scores))
        used = set()
        for tick in np.arange(start - lag, stop + lag, lag):
            grid = tick + ((phase - start) % lag)
            nearby = [i for i in points if abs(i - grid) <= FPS * .13 and i not in used]
            if not nearby:
                continue  # Never invent beats in a silent gap.
            i = max(nearby, key=lambda j: onset[j] * np.exp(-.5 * ((j - grid) / (FPS * .09)) ** 2))
            # Backtrack spectral-flux peak to the leading edge of the attack.
            edge = i
            while edge > max(0, i - 3) and onset[edge - 1] > onset[i] * .4:
                edge -= 1
            t = max(0, edge / FPS - .015)
            if t - last < .42:
                continue
            if not any(s['start'] <= t < s['end'] for s in sections):
                continue
            accents.append({'time': round(t, 3), 'strength': round(float(.55 + .45 * onset[i]), 3)})
            used.add(i)
            last = t
    return {
        'version': 2, 'analysis': 'median-hpss/percussion-onset/local-tempo',
        'duration': round(duration, 3), 'fps': round(FPS, 5),
        'energy': np.round(normalize(rms ** .7) * 255).astype(int).tolist(),
        'percussion': np.round(np.clip(confidence, 0, 1) * 255).astype(int).tolist(),
        'sections': sections, 'tempo': tempos, 'accents': accents,
        'beats': [a['time'] for a in accents],
    }


def main():
    for name in ['walking-out-of-fog', 'barefaced-lies', 'childhood-nightmare', 'bye-bye-my-country']:
        raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(ROOT / 'audio' / f'{name}.mp3'),
                                      '-f', 'f32le', '-ac', '1', '-ar', str(RATE), '-'])
        cues = analyze(np.frombuffer(raw, dtype='<f4'))
        (ROOT / 'audio' / f'{name}.json').write_text(json.dumps(cues, separators=(',', ':')) + '\n')
        print(f'{name}: {cues["duration"]}s, {len(cues["accents"])} accents, sections: {cues["sections"]}', flush=True)


if __name__ == '__main__':
    main()
