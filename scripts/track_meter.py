"""Analyze catalog beats and downbeats offline with the official Beat This! model.

Example: python scripts/track_meter.py --all --output work/meter
Only JSON analysis is produced; model weights stay in the PyTorch cache or at
the explicitly supplied checkpoint path.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

from audio_tracks import catalog_tracks


def main():
    sources = catalog_tracks()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', default='final0',
                        help='Local checkpoint path or official model name (default: final0)')
    parser.add_argument('--output', type=Path, required=True,
                        help='Directory for per-track meter JSON files')
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument('--all', action='store_true', help='Analyze every catalog track')
    selection.add_argument('--track', choices=list(sources), action='append',
                           help='Catalog track ID; may be repeated')
    parser.add_argument('--threads', type=int, default=4, help='CPU thread count (default: 4)')
    args = parser.parse_args()
    if args.threads < 1:
        parser.error('--threads must be at least 1')

    # Delayed imports keep --help usable before the offline dependencies are
    # installed, and avoid importing the score analyzer when this module loads.
    import torch
    from beat_this.inference import Audio2Frames
    from beat_this.model.postprocessor import Postprocessor
    from analyze_music import RATE, decode

    torch.set_num_threads(args.threads)
    predictor = Audio2Frames(checkpoint_path=args.checkpoint, device='cpu')
    postprocess = Postprocessor(type='minimal')
    checkpoint = Path(args.checkpoint).expanduser()
    if not checkpoint.is_file():
        checkpoint = Path(torch.hub.get_dir()) / 'checkpoints' / f'beat_this-{args.checkpoint}.ckpt'
    checkpoint_sha = hashlib.sha256(checkpoint.read_bytes()).hexdigest() if checkpoint.is_file() else None
    args.output.mkdir(parents=True, exist_ok=True)

    for slug in (list(sources) if args.all else args.track):
        source = sources[slug]
        samples = decode(source)
        started = time.perf_counter()
        beat_logits, downbeat_logits = predictor(samples, RATE)
        beats, downbeats = postprocess(beat_logits, downbeat_logits)
        elapsed = round(time.perf_counter() - started, 3)
        result = {
            'model': f'Beat This! {checkpoint.stem.removeprefix("beat_this-") if checkpoint.is_file() else args.checkpoint}',
            'method': 'official-minimal', 'device': 'cpu', 'fps': 50,
            'checkpoint': str(args.checkpoint), 'seconds': elapsed,
            'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'duration': len(samples) / RATE,
            'beats': beats.tolist(), 'downbeats': downbeats.tolist(),
            'beatProbability': torch.sigmoid(beat_logits).tolist(),
            'downbeatProbability': torch.sigmoid(downbeat_logits).tolist(),
        }
        if checkpoint_sha:
            result['checkpointSha256'] = checkpoint_sha
        output = args.output / f'{slug}.json'
        output.write_text(json.dumps(result, separators=(',', ':')) + '\n')
        print(json.dumps({'track': slug, 'seconds': elapsed, 'beats': len(beats),
                          'downbeats': len(downbeats), 'output': str(output)}), flush=True)


if __name__ == '__main__':
    main()
