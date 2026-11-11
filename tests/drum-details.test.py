"""Musical detail gestures must answer, rather than rewrite, the main pulse."""
import base64
import copy
import importlib.util
import pathlib
import unittest

import numpy as np


spec = importlib.util.spec_from_file_location(
    'drum_details_analysis',
    pathlib.Path(__file__).resolve().parents[1] / 'scripts/analyze_music.py',
)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


def decode(channel):
    return np.frombuffer(base64.b64decode(channel), dtype=np.uint8).astype(float) / 255


def phrase(duration):
    # One broad scene deliberately spans several bar endings.
    return [{'start': 0, 'end': duration, 'kind': 'groove', 'style': 0,
             'energy': .7, 'density': 2.5}]


def grid(duration=16, period=.4):
    beats = np.round(np.arange(0, duration, period), 4).tolist()
    phases = (np.arange(len(beats)) % 4).tolist()
    return beats, phases, a.meter_pulses(beats, phases)


def main_accents(slots, strength=.65, offset=0):
    return [{'time': round(slot['time'] + offset, 4), 'type': 'kick',
             'strength': strength, 'side': -1} for slot in slots]


def fill_fixture():
    beats, phases, slots = grid()
    events = [{'time': time, 'type': 'kick', 'strength': .65} for time in beats]
    events.extend({'time': round(6.84 + i * .13, 4),
                   'type': 'snare' if i % 2 else 'kick', 'strength': .9}
                  for i in range(9))
    return sorted(events, key=lambda event: event['time']), beats, phases, slots


class DrumDetailsTest(unittest.TestCase):
    def test_constant_driving_kicks_are_not_fills_even_at_the_track_start(self):
        beats, phases, slots = grid()
        for period in [.25, .15, .125]:
            with self.subTest(kick_period=period):
                events = [{'time': round(float(time), 4), 'type': 'kick', 'strength': .8}
                          for time in np.arange(0, 16, period)]
                details = a.arrange_details(events, phrase(16), beats, phases, slots, [])
                self.assertFalse(any(detail['type'] == 'fill' for detail in details),
                                 'A constant kick pattern has no local density rise.')

    def test_local_density_rise_finds_an_internal_bar_ending_with_at_most_three_hits(self):
        events, beats, phases, slots = fill_fixture()
        accents = main_accents(slots)
        details = a.arrange_details(events, phrase(16), beats, phases, slots, accents)
        fills = [detail for detail in details if detail['type'] == 'fill']
        self.assertGreaterEqual(len(fills), 2)
        self.assertLessEqual(len(fills), 3)
        self.assertEqual({detail['windowEnd'] for detail in fills}, {8.0},
                         'The bar ending is inside the broad four-bar scene.')
        real_times = {event['time'] for event in events}
        for detail in fills:
            self.assertIn(detail['time'], real_times)
            self.assertIn(detail['side'], [0, 1])
            self.assertGreaterEqual(min(abs(detail['time'] - event['time'])
                                        for event in accents), .15)
        self.assertGreaterEqual(len({detail['side'] for detail in fills}), 2)

    def test_fill_gestures_are_lower_level_single_side_and_leave_main_accents_intact(self):
        events, beats, phases, slots = fill_fixture()
        accents = main_accents(slots)
        snapshot = copy.deepcopy(accents)
        details = a.arrange_details(events, phrase(16), beats, phases, slots, accents)
        self.assertEqual(accents, snapshot)
        features = {'mix_rms': np.ones(int(16 * a.RATE / a.HOP) + 1)}
        baseline = a.bake_score(features, phrase(16), accents, events, beats, 150, 16)
        decorated = a.bake_score(features, phrase(16), accents, events, beats, 150, 16, details)
        self.assertEqual(accents, snapshot)
        differences = {name: decode(decorated[name]) - decode(baseline[name])
                       for name in ['left', 'right']}
        self.assertGreater(max(np.max(channel) for channel in differences.values()), .1)
        self.assertLessEqual(max(np.max(channel) for channel in differences.values()),
                             .24 + 1 / 255)
        for detail in details:
            sample = round(detail['time'] * a.FPS)
            answering = 'left' if detail['side'] == 0 else 'right'
            other = 'right' if detail['side'] == 0 else 'left'
            self.assertGreater(differences[answering][sample], .08)
            self.assertEqual(differences[other][sample], 0)
        for event in accents:
            sample = round(event['time'] * a.FPS)
            for name in ['left', 'right']:
                self.assertAlmostEqual(decode(decorated[name])[sample],
                                       decode(baseline[name])[sample], delta=1 / 255)
        for name, data in decorated.items():
            values = decode(data)
            self.assertTrue(np.all((values >= 0) & (values <= 1)), name)

    def test_recurring_odd_phase_snare_answers_return_only_in_moderate_passages(self):
        for period in [.4, .25]:
            with self.subTest(beat_period=period):
                beats, phases, slots = grid(12, period)
                events = [{'time': round(time + .008, 4),
                           'type': 'kick' if i % 2 == 0 else 'snare', 'strength': .8}
                          for i, time in enumerate(beats)]
                details = a.arrange_details(events, phrase(12), beats, phases, slots,
                                            main_accents(slots, .8, .008))
                answers = [detail for detail in details if detail['type'] == 'backbeat']
                if period == .4:
                    np.testing.assert_allclose([detail['time'] for detail in answers],
                                               np.array(beats[1::2]) + .008, atol=.0001)
                    self.assertEqual([detail['side'] for detail in answers[:4]], [0, 1, 0, 1])
                else:
                    self.assertEqual(answers, [], 'Fast passages must not refill every offbeat.')

    def test_isolated_odd_phase_snare_does_not_establish_a_recurring_backbeat(self):
        beats, phases, slots = grid(12, .4)
        events = [{'time': .408, 'type': 'snare', 'strength': .9}]
        details = a.arrange_details(events, phrase(12), beats, phases, slots,
                                    main_accents(slots))
        self.assertFalse(any(detail['type'] == 'backbeat' for detail in details))

    def test_only_strong_sustained_prominent_cymbal_adds_a_symmetric_bloom(self):
        beats, phases, slots = grid(12, .4)
        events = [
            {'time': 2, 'type': 'cymbal', 'strength': 1, 'crash': True,
             'prominence': .30, 'sustain': .3},
            {'time': 4.06, 'type': 'cymbal', 'strength': .8, 'crash': True,
             'prominence': 1.2, 'sustain': .3},
            {'time': 6, 'type': 'cymbal', 'strength': 1, 'crash': True,
             'prominence': 1.5, 'sustain': .1},
            {'time': 8, 'type': 'cymbal', 'strength': .3, 'crash': True,
             'prominence': 1.5, 'sustain': .3},
        ]
        accents = [{'time': 4, 'type': 'kick', 'strength': .2, 'side': -1}]
        snapshot = copy.deepcopy(accents)
        details = a.arrange_details(events, phrase(12), beats, phases, slots, accents)
        self.assertEqual([(detail['time'], detail['type']) for detail in details], [(4.06, 'cymbal')])
        self.assertEqual(accents, snapshot, 'A cymbal bloom must not add a main accent.')
        features = {'mix_rms': np.ones(int(12 * a.RATE / a.HOP) + 1)}
        baseline = a.bake_score(features, phrase(12), accents, events, beats, 150, 12)
        decorated = a.bake_score(features, phrase(12), accents, events, beats, 150, 12, details)
        gain = {name: decode(decorated[name]) - decode(baseline[name])
                for name in ['left', 'right']}
        self.assertEqual(gain['left'][2 * a.FPS], 0)
        np.testing.assert_array_equal(gain['left'], gain['right'])
        self.assertGreater(gain['left'][4 * a.FPS], .1)
        self.assertLess(np.max(gain['left']), .17)
        self.assertAlmostEqual(np.argmax(gain['left']) / a.FPS, 4, delta=1 / a.FPS,
                               msg='The shared bloom lands on the nearby main hit, not the later cymbal.')
        for name in ['angleLeft', 'angleRight']:
            self.assertLessEqual(np.max(np.abs(np.diff(decode(decorated[name])))),
                                 2 / 255 + 1e-8)

    def test_off_main_cymbal_only_changes_the_room_or_slow_beam_opening(self):
        beats, phases, slots = grid(12, .4)
        events = [{'time': 4.06, 'type': 'cymbal', 'strength': .8, 'crash': True,
                   'prominence': 1.2, 'sustain': .3}]
        details = a.arrange_details(events, phrase(12), beats, phases, slots, [])
        self.assertEqual([(detail['time'], detail['type']) for detail in details],
                         [(4.06, 'cymbal')])
        features = {'mix_rms': np.ones(int(12 * a.RATE / a.HOP) + 1)}
        baseline = a.bake_score(features, phrase(12), [], events, beats, 150, 12)
        decorated = a.bake_score(features, phrase(12), [], events, beats, 150, 12, details)
        for name in ['left', 'right']:
            self.assertEqual(decorated[name], baseline[name],
                             'An off-main cymbal cannot insert a shared direct flash.')
        self.assertTrue(any(decorated[name] != baseline[name]
                            for name in ['haze', 'angleLeft', 'angleRight']),
                        'A sustained cymbal still gets room light or slow beam opening.')

    def test_repeated_open_cymbal_texture_is_quiet_and_rejects_unreliable_hits(self):
        beats, phases, slots = grid(12, .4)
        events = [
            {'time': time, 'type': 'cymbal', 'strength': .6, 'crash': False,
             'prominence': .5, 'sustain': .3}
            for time in [1, 4, 4.2, 4.4, 4.6, 4.8, 7.31, 7.71]
        ]
        events.extend([
            {'time': 6, 'type': 'cymbal', 'strength': .8, 'crash': False,
             'prominence': .65, 'sustain': .1},
            {'time': 9.2, 'type': 'cymbal', 'strength': .8, 'crash': False,
             'prominence': .30, 'sustain': .3},
            {'time': 9.6, 'type': 'cymbal', 'strength': .8, 'crash': False,
             'prominence': .30, 'sustain': .3},
        ])
        events.sort(key=lambda event: event['time'])
        accents = []
        details = a.arrange_details(events, phrase(12), beats, phases, slots, accents)
        self.assertEqual([(detail['time'], detail['type']) for detail in details],
                         [(4, 'cymbal-texture'), (4.4, 'cymbal-texture'),
                          (4.8, 'cymbal-texture')])
        # The isolated 1-second hit, closed 6-second hat, off-grid pair and
        # low-prominence pair cannot create direct flashes. Close reliable
        # midpoint hits are rate-limited rather than filling every half beat.
        self.assertEqual(accents, [])
        features = {'mix_rms': np.ones(int(12 * a.RATE / a.HOP) + 1)}
        baseline = a.bake_score(features, phrase(12), accents, events, beats, 150, 12)
        decorated = a.bake_score(features, phrase(12), accents, events, beats, 150, 12, details)
        gains = {name: decode(decorated[name]) - decode(baseline[name])
                 for name in ['left', 'right']}
        np.testing.assert_array_equal(gains['left'], gains['right'])
        self.assertGreater(np.max(gains['left']), .015)
        self.assertLess(np.max(gains['left']), .045)
        self.assertEqual(gains['left'][a.FPS], 0)
        for name in ['angleLeft', 'angleRight']:
            self.assertEqual(decorated[name], baseline[name],
                             'Open-cymbal texture must not add crash beam opening.')

if __name__ == '__main__':
    unittest.main()
