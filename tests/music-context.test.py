"""Broad full-mix context must stay separate from beat/accent detection."""
import base64
import copy
import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('music_context', Path(__file__).resolve().parents[1] / 'scripts/music_context.py')
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)
RATE, FPS = 22050, 50


def tone(duration, frequency, gain=.2):
    return gain * np.sin(2 * np.pi * frequency * np.arange(round(duration * RATE)) / RATE)


class MusicContextTest(unittest.TestCase):
    def test_energy_follows_a_sustained_rise_in_the_full_mix(self):
        mix = np.r_[tone(8, 330, .025), tone(8, 330, .25)]
        result = context.analyze_context(mix)
        self.assertGreater(np.mean(result['energy'][11 * FPS:14 * FPS]) - np.mean(result['energy'][3 * FPS:5 * FPS]), .5)
        self.assertEqual(set(result), {'energy', 'brightness', 'texture'})

    def test_equal_rms_high_and_low_tones_have_different_brightness(self):
        low = context.analyze_context(tone(10, 150))
        high = context.analyze_context(tone(10, 6000))
        keep = slice(3 * FPS, 7 * FPS)
        self.assertGreater(high['brightness'][keep].mean() - low['brightness'][keep].mean(), .65)
        self.assertLess(abs(high['energy'][keep].mean() - low['energy'][keep].mean()), .015)

    def test_texture_distinguishes_broadband_noise_from_a_steady_tone(self):
        rng = np.random.default_rng(10)
        steady = context.analyze_context(tone(12, 440))
        noise = context.analyze_context(rng.normal(0, .2 / np.sqrt(2), RATE * 12))
        keep = slice(3 * FPS, 9 * FPS)
        self.assertGreater(noise['texture'][keep].mean() - steady['texture'][keep].mean(), .3)

    def test_an_isolated_transient_cannot_create_a_sharp_context_flash(self):
        mix = np.zeros(RATE * 12)
        mix[6 * RATE] = 1
        result = context.analyze_context(mix)
        for values in result.values():
            self.assertLess(np.max(np.abs(np.diff(values))), .02)
        self.assertLess(result['energy'].max(), .1)
        self.assertGreater(np.count_nonzero(result['energy'] > result['energy'].max() * .5), FPS)

    def test_empty_silent_short_and_fractional_lengths_are_finite_and_aligned(self):
        for mix in [np.array([]), np.zeros(100), np.array([.3]), tone(.073, 330), tone(1.037, 880)]:
            with self.subTest(samples=len(mix)):
                result = context.analyze_context(mix)
                expected = int(np.ceil(len(mix) / RATE * FPS)) + 1
                for values in result.values():
                    self.assertEqual(len(values), expected)
                    self.assertTrue(np.isfinite(values).all())
                    self.assertTrue(((values >= 0) & (values <= 1)).all())
                if not np.any(mix):
                    self.assertTrue(all(not np.any(values) for values in result.values()))

    def test_custom_sample_rate_and_frame_rate_preserve_score_length(self):
        samples = np.sin(2 * np.pi * 500 * np.arange(12345) / 16000)
        result = context.analyze_context(samples, sample_rate=16000, fps=37)
        self.assertTrue(all(len(values) == int(np.ceil(12345 / 16000 * 37)) + 1 for values in result.values()))

    def test_score_context_changes_the_slow_bed_without_moving_main_or_detail_attacks(self):
        spec = importlib.util.spec_from_file_location('context_score_analysis', Path(__file__).resolve().parents[1] / 'scripts/analyze_music.py')
        analysis = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(analysis)
        duration = 24
        mix = np.r_[tone(12, 180, .035), tone(12, 4500, .25)]
        features = {'mix_rms': np.full(int(duration * RATE / analysis.HOP) + 1, .2)}
        with_context = {**features, 'context': context.analyze_context(mix)}
        phrases = [{'start': 0, 'end': duration, 'kind': 'groove', 'style': 0,
                    'energy': .8, 'density': 3}]
        accents = [{'time': t, 'type': 'kick', 'strength': .55, 'side': -1}
                   for t in [5., 10., 15., 20.]]
        details = [{'time': 7.3, 'type': 'backbeat', 'strength': .5, 'side': 0},
                   {'time': 17.3, 'type': 'cymbal', 'strength': .5, 'side': -1}]
        original_accents, original_details = copy.deepcopy(accents), copy.deepcopy(details)

        def bake(f, main=accents, detail=details):
            packed = analysis.bake_score(f, phrases, main, [], [], 200, duration, detail)
            return {name: np.frombuffer(base64.b64decode(data), dtype=np.uint8).astype(float) / 255
                    for name, data in packed.items()}

        plain, enriched = bake(features), bake(with_context)
        bed = bake(with_context, [], [])
        self.assertEqual(accents, original_accents, 'Full-mix context must not alter the main cadence input.')
        self.assertEqual(details, original_details, 'Full-mix context must not alter the detail gestures.')
        for name in ['left', 'right', 'haze']:
            delta = enriched[name] - plain[name]
            self.assertGreater(np.max(np.abs(delta)), .01, f'{name}: context should have a visible but slow effect')
            self.assertLessEqual(np.max(np.abs(np.diff(delta))), 3 / 255 + 1e-10,
                                 f'{name}: context must not introduce another sharp pulse')
        for event in accents:
            center = round(event['time'] * FPS)
            # Compare the sharp attack edge rather than a quantized hold
            # plateau, whose tied maximum can move by one sample of rounding.
            lo, hi = center - 3, center + 4
            for name in ['left', 'right']:
                self.assertEqual(np.argmax(np.diff(plain[name][lo:hi])),
                                 np.argmax(np.diff(enriched[name][lo:hi])))
                pulse = enriched[name][center] - bed[name][center]
                context_increment = abs(enriched[name][center] - plain[name][center])
                self.assertGreater(pulse, .4)
                self.assertGreater(pulse, context_increment * 4,
                                   'The main pulse must dominate full-mix context modulation.')
        detail_frame = round(details[0]['time'] * FPS)
        self.assertEqual(np.argmax(np.diff(plain['left'][detail_frame-3:detail_frame+4])),
                         np.argmax(np.diff(enriched['left'][detail_frame-3:detail_frame+4])))
        for name in ['angleLeft', 'angleRight']:
            # U8 quantization can add one .137-degree step to the baked limit.
            velocity = np.abs(np.diff(enriched[name])) * 35 * FPS
            self.assertLessEqual(velocity.max(), 14)


if __name__ == '__main__':
    unittest.main()
