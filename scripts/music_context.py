"""Slow acoustic context from the full mix, not semantic emotion classification.

Energy, spectral brightness and texture are acoustic proxies for broad changes
in intensity and timbre. They contain no beat positions or accent triggers and
are intended only for the lighting bed, motion and haze.
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter1d


def analyze_context(mix, sample_rate=22050, fps=50):
    """Return three bounded, roughly two-second-smoothed arrays at ``fps``.

    ``mix`` is a mono waveform. Each channel has exactly
    ``ceil(len(mix) / sample_rate * fps) + 1`` samples, including the end point.
    Relative RMS measures energy, centroid measures brightness, and spectral
    flatness/change measures texture; none claims to identify musical mood.
    """
    if sample_rate <= 0 or fps <= 0 or not np.isfinite([sample_rate, fps]).all():
        raise ValueError('sample_rate and fps must be positive finite numbers')
    samples = np.asarray(mix, dtype=np.float32)
    if samples.ndim != 1:
        raise ValueError('mix must be a mono waveform')
    samples = np.nan_to_num(samples, nan=0, posinf=0, neginf=0)
    count = int(np.ceil(len(samples) / sample_rate * fps)) + 1
    empty = {name: np.zeros(count) for name in ['energy', 'brightness', 'texture']}
    if not len(samples) or not np.any(samples):
        return empty

    # Center every frame on its exact score timestamp. Chunking bounds FFT
    # memory even for long recordings and handles short inputs identically.
    window = max(32, 2 ** int(np.ceil(np.log2(sample_rate * .06))))
    centers = np.rint(np.arange(count) * sample_rate / fps).astype(int)
    padded = np.pad(samples, (window // 2, window // 2 + int(np.ceil(sample_rate / fps))))
    frames = np.lib.stride_tricks.sliding_window_view(padded, window)
    taper = np.hanning(window)
    frequencies = np.fft.rfftfreq(window, 1 / sample_rate)
    rms, centroid, flatness, flux = [np.zeros(count) for _ in range(4)]
    previous = None
    for start in range(0, count, 512):
        end = min(count, start + 512)
        block = frames[centers[start:end]]
        spectrum = np.abs(np.fft.rfft(block * taper, axis=1))
        power = spectrum ** 2
        total = spectrum.sum(axis=1)
        rms[start:end] = np.sqrt(np.mean(block ** 2, axis=1))
        centroid[start:end] = spectrum @ frequencies / np.maximum(total, 1e-12)
        mean_power = power.mean(axis=1)
        flatness[start:end] = np.exp(np.mean(np.log(np.maximum(power, 1e-20)), axis=1)) / np.maximum(mean_power, 1e-20)
        # Compare normalized spectra so a volume rise does not alone masquerade
        # as a change in texture. Carry the preceding frame across chunk edges.
        normalized = spectrum / np.maximum(total[:, None], 1e-12)
        prior = np.vstack([normalized[:1] if previous is None else previous, normalized[:-1]])
        flux[start:end] = np.maximum(0, normalized - prior).sum(axis=1)
        previous = normalized[-1:]

    reference = max(float(np.percentile(rms, 95)), float(rms.max()) * .25, 1e-9)
    energy = np.clip(rms / reference, 0, 1) ** .7
    active = rms > max(reference * .004, 1e-9)
    # Weight the centroid by actual sound level; near-silent spectral leakage
    # cannot make an otherwise quiet passage look bright.
    weight = np.where(active, rms, 0)
    sigma = max(.1, .85 * fps)
    smoothed_weight = gaussian_filter1d(weight, sigma, mode='nearest')
    brightness = gaussian_filter1d(centroid * weight, sigma, mode='nearest') / np.maximum(smoothed_weight, 1e-12)
    brightness = np.clip(np.log(np.maximum(brightness, 100) / 100) / np.log(8000 / 100), 0, 1)
    brightness *= np.clip(smoothed_weight / max(reference * .05, 1e-9), 0, 1)
    flux_reference = max(float(np.percentile(flux[active], 90)) if np.any(active) else 0, .12)
    texture = (.65 * np.clip(flatness, 0, 1) + .35 * np.clip(flux / flux_reference, 0, 1)) * active
    return {
        'energy': np.clip(gaussian_filter1d(energy, sigma, mode='nearest'), 0, 1),
        'brightness': np.clip(gaussian_filter1d(brightness, max(.1, .6 * fps), mode='nearest'), 0, 1),
        'texture': np.clip(gaussian_filter1d(texture, max(.1, 1.1 * fps), mode='nearest'), 0, 1),
    }
