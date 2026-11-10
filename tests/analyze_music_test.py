"""Signal-level regression: sustained guitar-like tone, then kick/snare attacks."""
import importlib.util
import pathlib
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location(
    'music_analysis', pathlib.Path(__file__).resolve().parents[1] / 'scripts/analyze_music.py')
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


class PercussionTest(unittest.TestCase):
    def test_harmonic_intro_then_drums(self):
        rng = np.random.default_rng(12)
        t = np.arange(analysis.RATE * 12) / analysis.RATE
        samples = (.012 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        for beat in np.arange(6, 11.9, .5):
            i = int(beat * analysis.RATE)
            n = int(.12 * analysis.RATE)
            u = np.arange(n) / analysis.RATE
            samples[i:i+n] += (.32 * np.sin(2*np.pi*65*u) * np.exp(-u*35) +
                               .13 * rng.standard_normal(n) * np.exp(-u*60)).astype(np.float32)
        cues = analysis.analyze(samples)
        self.assertFalse(any(s['start'] < 5.7 for s in cues['sections']))
        self.assertTrue(any(s['start'] < 6.6 and s['end'] > 11 for s in cues['sections']))
        self.assertGreaterEqual(len(cues['accents']), 8)
        for accent in cues['accents']:
            self.assertLess(min(abs(accent['time'] - beat) for beat in np.arange(6, 11.9, .5)), .09)


if __name__ == '__main__':
    unittest.main()
