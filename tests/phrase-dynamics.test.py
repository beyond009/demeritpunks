"""Musical phrase dynamics and genuine entrance regressions.

These feature-level fixtures keep the drum attacks and section energy explicit,
so phrase arrangement can be checked independently of source separation.
"""
import base64
import importlib.util
import pathlib
import unittest

import numpy as np


spec = importlib.util.spec_from_file_location(
    'phrase_dynamics_analysis',
    pathlib.Path(__file__).resolve().parents[1] / 'scripts/analyze_music.py',
)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


def features(duration, events, active_from=0, energy_before=.65,
             energy_after=None, change_at=None):
    times = np.arange(int(np.ceil(duration * a.RATE / a.HOP)) + 1) * a.HOP / a.RATE
    energy = np.full(len(times), energy_before, dtype=float)
    if change_at is not None:
        energy[times >= change_at] = energy_after
    return {
        'activity': (times >= active_from).astype(float),
        'mix_rms': energy,
        'events': sorted(events, key=lambda event: event['time']),
    }


def drums(times, strength=.8):
    return [
        {'time': round(float(time), 4), 'type': 'kick' if i % 2 == 0 else 'snare',
         'strength': strength}
        for i, time in enumerate(times)
    ]


def arrange(f, duration):
    beats = np.arange(0, duration, .5).tolist()
    phrases = a.make_phrases(f, beats, duration, 120)
    accents = a.arrange_accents(f['events'], phrases, beats)
    return phrases, accents


def values(channel):
    return np.frombuffer(base64.b64decode(channel), dtype=np.uint8).astype(float) / 255


class PhraseDynamicsTest(unittest.TestCase):
    def test_quiet_passage_recedes_below_strong_section(self):
        duration = 32
        f = features(duration, [], energy_before=.16, energy_after=.9, change_at=12)
        # Give both samples room to settle away from transition smoothing.
        phrases = [
            {'start': 0, 'end': 12, 'kind': 'quiet', 'style': 0},
            {'start': 12, 'end': 32, 'kind': 'dense', 'style': 2,
             'energy': 1, 'density': 5},
        ]
        channels = a.bake_score(f, phrases, [], [], [], 120, duration)
        for name in ['left', 'right']:
            light = values(channels[name])
            quiet = np.median(light[3 * a.FPS:9 * a.FPS])
            strong = np.median(light[18 * a.FPS:27 * a.FPS])
            self.assertGreater(strong - quiet, .065, name)
            self.assertGreater(quiet, .15, 'The quiet stage must remain visible.')

    def test_similar_phrases_keep_a_consistent_lighting_motif(self):
        duration = 40
        f = features(duration, drums(np.arange(0, duration, .5)))
        phrases, _ = arrange(f, duration)
        active = [p for p in phrases if p['kind'] != 'quiet']
        self.assertGreaterEqual(len(active), 4)
        self.assertEqual(len({p['style'] for p in active}), 1,
                         'Unchanged music should not cycle through all four motifs.')

    def test_small_energy_fluctuations_keep_motif_but_a_large_rise_can_change_it(self):
        duration = 40
        f = features(duration, drums(np.arange(0, duration, .5)))
        times = np.arange(len(f['mix_rms'])) * a.HOP / a.RATE
        for start, end, energy in [(0, 8, .59), (8, 16, .63),
                                   (16, 24, .61), (24, 40, .9)]:
            f['mix_rms'][(times >= start) & (times < end)] = energy
        phrases, _ = arrange(f, duration)
        self.assertEqual(len({p['style'] for p in phrases[:3]}), 1)
        self.assertNotEqual(phrases[0]['style'], phrases[-1]['style'],
                            'Stable motifs should still respond to a clear section change.')

    def test_cymbals_without_real_drums_cannot_create_an_entrance(self):
        duration = 20
        crashes = [
            {'time': time, 'type': 'cymbal', 'strength': .95, 'crash': True}
            for time in [4.2, 8.2, 12.2, 16.2]
        ]
        f = features(duration, crashes, active_from=4)
        phrases, accents = arrange(f, duration)
        self.assertFalse(any(p.get('entrance') is not None for p in phrases))
        self.assertFalse(any(e['type'] == 'impact' for e in accents))

    def test_quiet_to_drums_entrance_uses_the_real_off_grid_attack(self):
        duration = 24
        entrance = 4.2  # Outside the .15-second beat selection radius.
        events = drums(np.arange(entrance, duration, .5))
        f = features(duration, events, active_from=4,
                     energy_before=.12, energy_after=.8, change_at=4)
        phrases, accents = arrange(f, duration)
        entries = [p['entrance'] for p in phrases if p.get('entrance') is not None]
        self.assertEqual(len(entries), 1)
        self.assertAlmostEqual(entries[0], entrance, places=4)
        impacts = [event for event in accents if event['type'] == 'impact']
        self.assertEqual(len(impacts), 1)
        self.assertAlmostEqual(impacts[0]['time'], entrance, places=4)
        self.assertEqual(impacts[0]['side'], -1, 'An entrance opens both beams.')

    def test_ordinary_phrase_boundaries_do_not_add_impacts(self):
        duration = 40
        f = features(duration, drums(np.arange(0, duration, .5)))
        phrases, accents = arrange(f, duration)
        self.assertGreaterEqual(len(phrases), 4)
        self.assertFalse(any(p.get('entrance') is not None for p in phrases))
        self.assertFalse(any(event['type'] == 'impact' for event in accents))

    def test_energy_jump_needs_a_crash_and_still_lands_on_a_real_drum(self):
        duration = 36
        entrance = 16.08
        events = drums([0, *np.arange(.08, duration, .5)])
        for has_crash in [False, True]:
            with self.subTest(crash=has_crash):
                cymbal = {'time': 16.06, 'type': 'cymbal', 'strength': .9,
                          'crash': has_crash}
                f = features(duration, [*events, cymbal], energy_before=.28,
                             energy_after=.9, change_at=16)
                phrases, accents = arrange(f, duration)
                entries = [p['entrance'] for p in phrases
                           if p.get('entrance') is not None]
                impacts = [event for event in accents if event['type'] == 'impact']
                if has_crash:
                    self.assertEqual(len(entries), 1)
                    self.assertAlmostEqual(entries[0], entrance, places=4)
                    self.assertEqual(len(impacts), 1)
                    self.assertAlmostEqual(impacts[0]['time'], entrance, places=4)
                else:
                    self.assertEqual(entries, [])
                    self.assertEqual(impacts, [])

    def test_recorded_fade_settles_smoothly_without_dimming_the_last_drum(self):
        duration = 16
        last_hit = 15.1
        accent = {'time': last_hit, 'type': 'kick', 'strength': .5, 'side': -1}

        def render(f, length, accents):
            phrases = [{'start': 0, 'end': length, 'kind': 'dense',
                        'style': 0, 'energy': 1, 'density': 5}]
            return a.bake_score(f, phrases, accents, [], [], 120, length)

        hard = features(duration, [], energy_before=.9)
        extended = features(duration + 8, [], energy_before=.9)
        fade = features(duration, [], energy_before=.9)
        times = np.arange(len(fade['mix_rms'])) * a.HOP / a.RATE
        fade['mix_rms'] *= np.clip((15.5 - times) / 3.5, 0, 1)
        hard_bed = render(hard, duration, [])
        extended_bed = render(extended, duration + 8, [])
        fade_bed = render(fade, duration, [])
        hard_hit = render(hard, duration, [accent])
        fade_hit = render(fade, duration, [accent])
        hit_index = round(last_hit * a.FPS)

        for name in ['left', 'right']:
            stable = values(hard_bed[name])
            longer = values(extended_bed[name])
            fading = values(fade_bed[name])
            # A hard ending must match the same scene continuing past the end;
            # the duration alone cannot trigger a premature lighting fade.
            np.testing.assert_array_equal(stable[12 * a.FPS:],
                                          longer[12 * a.FPS:16 * a.FPS + 1])
            self.assertGreater(stable[-1] - fading[-1], .10)
            self.assertLessEqual(np.max(np.abs(np.diff(fading[12 * a.FPS:]))),
                                 2 / 255 + 1e-8,
                                 'The recorded fade must not create a new flash or step.')
            hard_pulse = values(hard_hit[name]) - stable
            fade_pulse = values(fade_hit[name]) - fading
            self.assertGreater(fade_pulse[hit_index], .4)
            self.assertAlmostEqual(fade_pulse[hit_index], hard_pulse[hit_index],
                                   delta=2 / 255,
                                   msg='The tail may dim the bed, not the last drum pulse.')
            near = fade_pulse[hit_index - 5:hit_index + 6]
            first_flash = (hit_index - 5 + np.flatnonzero(near > .4)[0]) / a.FPS
            self.assertLessEqual(abs(first_flash - last_hit), 1 / a.FPS)


if __name__ == '__main__':
    unittest.main()
