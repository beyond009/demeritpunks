"""Decode stable four-beat meter and a restrained visual cadence offline.

Beat This! supplies beat positions and downbeat probabilities. A downbeat is
evidence for the meter, never an instruction to restart the light pattern.
The final renderer still matches these slots to real separated drum attacks.
"""
import numpy as np


def decode_meter(beats, downbeat_probability, fps=50, transition_penalty=8.0):
    beats = np.asarray(beats, dtype=float)
    probability = np.asarray(downbeat_probability, dtype=float)
    count = len(beats)
    if not count:
        return {'phases': [], 'barstarts': [], 'phaseChanges': []}
    if (not len(probability) or fps <= 0 or not np.all(np.isfinite(beats))
            or not np.all(np.isfinite(probability)) or np.any(np.diff(beats) <= 0)):
        raise ValueError('Meter requires increasing beats and finite probabilities')
    evidence = np.empty(count)
    for i, time in enumerate(beats):
        lo = max(0, int(np.floor((time - .06) * fps)))
        hi = min(len(probability), int(np.ceil((time + .06) * fps)) + 1)
        if hi > lo:
            evidence[i] = np.max(probability[lo:hi])
        else:
            evidence[i] = probability[min(len(probability) - 1, max(0, round(time * fps)))]
    evidence = np.clip(evidence, .03, .97)
    emissions = np.repeat(np.log1p(-evidence)[:, None], 4, axis=1)
    emissions[:, 0] = np.log(evidence)
    score = np.empty((count, 4))
    back = np.zeros((count, 4), dtype=np.uint8)
    score[0] = emissions[0]
    transitions = np.full((4, 4), -float(transition_penalty))
    for previous in range(4):
        transitions[previous, (previous + 1) % 4] = 0
    for i in range(1, count):
        candidates = score[i - 1, :, None] + transitions
        back[i] = np.argmax(candidates, axis=0)
        score[i] = candidates[back[i], np.arange(4)] + emissions[i]
    phases = np.empty(count, dtype=int)
    phases[-1] = np.argmax(score[-1])
    for i in range(count - 1, 0, -1):
        phases[i - 1] = back[i, phases[i]]
    changes = np.flatnonzero((phases[1:] - phases[:-1]) % 4 != 1) + 1
    return {'phases': phases.tolist(),
            'barstarts': np.round(beats[phases == 0], 4).tolist(),
            'phaseChanges': changes.tolist()}


def meter_pulses(beats, phases):
    """Use beats 1/3 for fast music, each beat when already at half tempo.

    Change subdivision only on a decoded bar boundary, with separate thresholds
    to prevent toggling near the cutoff. A phase correction or a spurious model
    beat may remove a flash; it cannot insert a burst of closely spaced flashes.
    """
    beats = np.asarray(beats, dtype=float)
    phases = np.asarray(phases, dtype=int)
    if len(beats) != len(phases):
        raise ValueError('Each beat needs a decoded meter phase')
    if len(beats) < 2:
        return []
    intervals = np.diff(beats)
    valid = intervals[(intervals >= .18) & (intervals <= 1.2)]
    initial = float(np.median(valid[:16])) if len(valid) else .5
    stride = 2 if initial < .48 else 1
    pulses = []
    for i, time in enumerate(beats):
        local = intervals[max(0, i - 6):min(len(intervals), i + 7)]
        local = local[(local >= .18) & (local <= 1.2)]
        period = float(np.median(local)) if len(local) else initial
        if phases[i] == 0:
            if stride == 1 and period < .43:
                stride = 2
            elif stride == 2 and period > .54:
                stride = 1
        if phases[i] % stride:
            continue
        light_period = period * stride
        if pulses and time - pulses[-1]['time'] < max(.42, light_period * .70):
            continue
        pulses.append({'time': round(float(time), 4), 'period': round(light_period, 4),
                       'phase': int(phases[i]), 'stride': stride})
    return pulses
