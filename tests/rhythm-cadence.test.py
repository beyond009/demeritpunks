"""Regression checks for one stable beam cadence through busy percussion."""
import base64
import importlib.util
import pathlib
import unittest

import numpy as np


spec = importlib.util.spec_from_file_location(
    'rhythm_cadence_analysis',
    pathlib.Path(__file__).resolve().parents[1] / 'scripts/analyze_music.py',
)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


def decode(data):
    return np.frombuffer(base64.b64decode(data), dtype=np.uint8).astype(float) / 255


class RhythmCadenceTest(unittest.TestCase):
    def test_isolated_and_two_consecutive_false_downbeats_do_not_reset_meter(self):
        beats = np.arange(1, 33, .5)
        expected_phases = np.arange(len(beats)) % 4
        for false_indices in [[17], [25, 26]]:
            with self.subTest(false_downbeats=false_indices):
                probability = np.full(round((beats[-1] + 1) * 50), .03)
                for index, time in enumerate(beats):
                    if expected_phases[index] == 0 or index in false_indices:
                        frame = round(time * 50)
                        probability[frame - 1:frame + 2] = .97
                meter = a.decode_meter(beats, probability)
                np.testing.assert_array_equal(meter['phases'], expected_phases)
                np.testing.assert_allclose(meter['barstarts'], beats[::4], atol=.0001)
                self.assertEqual(meter['phaseChanges'], [])

    def test_fast_and_model_half_tempo_keep_the_same_cadence_through_fills_and_entrances(self):
        physical_beats = np.array([round(1 + i * .3, 4) for i in range(40)])
        events = []
        for index, time in enumerate(physical_beats):
            events.append({'time': round(time + .008, 4),
                           'type': 'kick' if index % 2 == 0 else 'snare',
                           'strength': .55 if index % 2 == 0 else 1})
            if 4.6 <= time < 7.6:
                events.append({'time': round(time + .15, 4), 'type': 'snare',
                               'strength': 1})
        events.sort(key=lambda event: event['time'])
        phrases = [
            {'start': 0, 'end': 4.6, 'kind': 'groove', 'style': 1},
            {'start': 4.6, 'end': 7.6, 'kind': 'fill', 'style': 3, 'entrance': 4.75},
            {'start': 7.6, 'end': 14, 'kind': 'groove', 'style': 2},
        ]
        outputs = []
        for period, stride in [(.3, 2), (.6, 1)]:
            with self.subTest(model_beat_period=period):
                beats = physical_beats if period == .3 else physical_beats[::2]
                phases = (np.arange(len(beats)) % 4).tolist()
                pulse_grid = a.meter_pulses(beats, phases)
                self.assertTrue(all(slot['stride'] == stride for slot in pulse_grid))
                np.testing.assert_allclose(np.diff([slot['time'] for slot in pulse_grid]),
                                           .6, atol=.0001)
                accents = a.arrange_accents(events, phrases, beats.tolist(), pulse_grid)
                times = [event['time'] for event in accents]
                np.testing.assert_allclose(times, physical_beats[::2] + .008,
                                           atol=.0001)
                self.assertTrue(all(event['side'] == -1 for event in accents),
                                'The two beams share one rhythmic landing.')
                self.assertTrue(any(event['type'] == 'fill' for event in accents))
                self.assertFalse(any(abs(time - 4.75) < .055 for time in times),
                                 'An off-grid entrance must not restart the pulse.')
                outputs.append(times)
        np.testing.assert_allclose(outputs[0], outputs[1], atol=.0001)

    def test_empty_meter_slots_are_skipped_without_fabricating_or_shifting_hits(self):
        beats = [round(1 + i * .3, 4) for i in range(40)]
        pulse_grid = a.meter_pulses(beats, (np.arange(len(beats)) % 4).tolist())
        missing = {5, 11}
        events = []
        expected = []
        for index, slot in enumerate(pulse_grid):
            time = slot['time']
            if index in missing:
                # Neither a cymbal on the slot nor a loud late snare counts as
                # the missing real kick/snare attack for that rhythmic landing.
                events.extend([
                    {'time': time, 'type': 'cymbal', 'strength': 1, 'crash': True},
                    {'time': round(time + .15, 4), 'type': 'snare', 'strength': 1},
                ])
            else:
                expected.append(round(time + .01, 4))
                events.append({'time': expected[-1], 'type': 'kick', 'strength': .7})
        events.sort(key=lambda event: event['time'])
        phrases = [{'start': 0, 'end': 14, 'kind': 'groove', 'style': 1}]
        accents = a.arrange_accents(events, phrases, beats, pulse_grid)
        np.testing.assert_allclose([event['time'] for event in accents], expected,
                                   atol=.0001)
        self.assertEqual(len(accents), len(pulse_grid) - len(missing))

    def test_fallback_fill_does_not_add_intervening_fast_beats(self):
        beats = np.arange(0, 12, 1 / 3).tolist()
        events = [{'time': time, 'type': 'snare', 'strength': .8} for time in beats]
        phrases = [{'start': 0, 'end': 8, 'kind': 'groove', 'style': 1},
                   {'start': 8, 'end': 12, 'kind': 'fill', 'style': 3}]
        accents = a.arrange_accents(events, phrases, beats)
        times = [event['time'] for event in accents]
        np.testing.assert_allclose(times, beats[::2], atol=.0001)
        np.testing.assert_allclose(np.diff(times), 2 / 3, atol=.0001)
        self.assertTrue(any(event['type'] == 'fill' for event in accents),
                        'The fill may change gesture while keeping the same cadence.')

    def test_unselected_snare_roll_only_softens_the_room_light(self):
        duration = 12
        features = {'mix_rms': np.ones(int(duration * a.RATE / a.HOP) + 1)}
        phrases = [{'start': 0, 'end': duration, 'kind': 'dense', 'style': 2,
                    'energy': 1, 'density': 7}]
        accents = [{'time': time, 'type': 'kick', 'strength': .7, 'side': -1}
                   for time in [2, 4, 6, 8, 10]]
        # These real but off-cadence attacks must never introduce a second
        # direct-beam rhythm between the selected main accents.
        rolls = [{'time': round(float(time), 4), 'type': 'snare', 'strength': .9}
                 for time in np.arange(1.17, 11, .12)]
        baseline = a.bake_score(features, phrases, accents, [], [], 180, duration)
        busy = a.bake_score(features, phrases, accents, rolls, [], 180, duration)
        for name in ['left', 'right', 'angleLeft', 'angleRight']:
            self.assertEqual(busy[name], baseline[name], name)
        wash = decode(busy['haze']) - decode(baseline['haze'])
        self.assertGreater(np.max(wash), .015)
        self.assertLess(np.max(wash), .05)
        self.assertLessEqual(np.max(np.abs(np.diff(wash))), 2 / 255 + 1e-8,
                             'Unselected percussion should add a smooth room wash.')

    def test_near_grid_credible_attack_beats_a_louder_off_grid_attack(self):
        beats = np.arange(1, 8, .5).tolist()
        phrases = [{'start': 0, 'end': 9, 'kind': 'groove', 'style': 0}]
        for late_offset in [.07, .09]:
            with self.subTest(louder_late_attack_offset=late_offset):
                events = []
                for time in beats:
                    events.extend([
                        {'time': round(time + .01, 4), 'type': 'kick', 'strength': .45},
                        {'time': round(time + late_offset, 4), 'type': 'snare', 'strength': 1},
                    ])
                accents = a.arrange_accents(events, phrases, beats)
                self.assertEqual(len(accents), len(beats))
                np.testing.assert_allclose([event['time'] for event in accents],
                                           np.array(beats) + .01, atol=.0001)
                self.assertTrue(all(event['type'] == 'kick' for event in accents))


if __name__ == '__main__':
    unittest.main()
