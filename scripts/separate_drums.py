"""Local aligned drum stems using Demucs 4.1's HuggingFace/safetensors API.

Example (from repository root, using this task's isolated Python):
  ../../work/audio-analysis-env/bin/python scripts/separate_drums.py childhood-nightmare
All downloads and generated audio stay under the task's work/ directory.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import time
from audio_tracks import catalog_tracks

ROOT = Path(__file__).resolve().parents[1]
TASK = ROOT.parent.parent
DEFAULT_WORK = TASK / 'work'
TRACKS = ['childhood-nightmare', 'walking-out-of-fog', 'barefaced-lies', 'bye-bye-my-country']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sources = catalog_tracks()
    parser.add_argument('tracks', nargs='*')
    parser.add_argument('--all', action='store_true', help='Process every track in the site catalog')
    parser.add_argument('--work', type=Path, default=DEFAULT_WORK)
    parser.add_argument('--device', choices=['auto', 'cpu', 'mps'], default='auto')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--segment', type=int, default=7)
    parser.add_argument('--overlap', type=float, default=.25)
    parser.add_argument('--shifts', type=int, default=0)
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    requested = list(sources) if args.all else args.tracks or TRACKS
    if any(track not in sources for track in requested):
        parser.error('Unknown catalog track')
    work = args.work.resolve()
    cache = work / 'model-cache'
    for key, path in {'HF_HOME': cache / 'huggingface', 'HUGGINGFACE_HUB_CACHE': cache / 'huggingface/hub',
                      'TORCH_HOME': cache / 'torch', 'XDG_CACHE_HOME': cache,
                      'TMPDIR': work / 'tmp'}.items():
        path.mkdir(parents=True, exist_ok=True)
        os.environ[key] = str(path)
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_DISABLE_XET'] = '1'
    os.environ['OMP_NUM_THREADS'] = str(args.threads)
    os.environ['MKL_NUM_THREADS'] = str(args.threads)
    os.environ['PYTORCH_ENABLE_MPS_FALLBACK'] = '1'

    # Import after cache and thread environment variables are set.
    import numpy as np
    import torch
    import soundfile as sf
    from demucs.api import Separator

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(0)
    device = args.device
    if device == 'auto':
        device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    if device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('MPS is not available in this runtime; select cpu or auto.')
    print(json.dumps({'event': 'runtime', 'torch': torch.__version__, 'device': device,
                      'mps_built': torch.backends.mps.is_built(), 'mps_available': torch.backends.mps.is_available(),
                      'threads': args.threads, 'cache': str(cache)}, ensure_ascii=False), flush=True)
    loaded = time.perf_counter()
    # Explicit hf:// avoids the legacy pickle/AWS fallback in Demucs 4.1.
    separator = Separator(model='hf://htdemucs', device=device, segment=args.segment,
                          shifts=args.shifts, overlap=args.overlap, split=True, jobs=0, progress=True)
    print(json.dumps({'event': 'model-loaded', 'seconds': round(time.perf_counter()-loaded, 3),
                      'sources': separator.model.sources, 'samplerate': separator.samplerate,
                      'channels': separator.audio_channels}, ensure_ascii=False), flush=True)
    out_dir = work / 'drum-stems'
    out_dir.mkdir(parents=True, exist_ok=True)
    for slug in requested:
        output = out_dir / f'{slug}.wav'
        metadata = out_dir / f'{slug}.json'
        if output.exists() and metadata.exists() and not args.force:
            print(json.dumps({'event': 'skipped-existing', 'path': str(output)}), flush=True)
            continue
        started = time.perf_counter()
        source = sources[slug]
        # The same FFmpeg decoder/sample origin as the browser score pipeline.
        # No silence trim, loudness normalize, time stretch, or stem rescaling.
        raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(source), '-f', 'f32le',
                                       '-ac', str(separator.audio_channels), '-ar', str(separator.samplerate), '-'])
        values = np.frombuffer(raw, dtype='<f4').reshape(-1, separator.audio_channels).T.copy()
        mixture = torch.from_numpy(values)
        print(json.dumps({'event': 'separating', 'track': slug, 'frames': values.shape[1],
                          'seconds': values.shape[1]/separator.samplerate, 'device': device}), flush=True)
        with torch.inference_mode():
            original, stems = separator.separate_tensor(mixture, separator.samplerate)
        drums = stems['drums'].detach().cpu().numpy()
        if drums.shape != values.shape or original.shape != mixture.shape:
            raise RuntimeError(f'Output is not aligned: {drums.shape} != {values.shape}')
        if not np.isfinite(drums).all():
            raise RuntimeError('Non-finite separated samples')
        # Float32 WAV preserves model peaks without clipping or gain changes.
        temp = output.with_suffix('.tmp.wav')
        sf.write(str(temp), drums.T, separator.samplerate, subtype='FLOAT')
        check = sf.info(str(temp))
        result_frames = check.frames
        if result_frames != values.shape[1] or check.samplerate != separator.samplerate:
            raise RuntimeError('Saved WAV frame count/rate mismatch')
        temp.replace(output)
        report = {'model': 'hf://htdemucs', 'demucs': '4.1.0', 'device': device, 'threads': args.threads,
                  'segment': args.segment, 'overlap': args.overlap, 'shifts': args.shifts, 'jobs': 0,
                  'source': str(source), 'path': str(output), 'sample_rate': separator.samplerate,
                  'channels': separator.audio_channels, 'sample_format': 'float32', 'source_decoded_frames': values.shape[1],
                  'stem_frames': result_frames, 'duration': result_frames/separator.samplerate,
                  'alignment': 'same FFmpeg decoded sample origin, exact frame count, no trimming',
                  'peak': float(np.max(np.abs(drums))), 'seconds_elapsed': round(time.perf_counter()-started, 3)}
        metadata.write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps({'event': 'complete', **report}, ensure_ascii=False), flush=True)
        del original, stems, drums, mixture, values
        if device == 'mps':
            torch.mps.empty_cache()


if __name__ == '__main__':
    main()
