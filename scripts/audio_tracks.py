"""Resolve the browser catalog without executing JavaScript."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def catalog_tracks():
    source = (ROOT / 'inc/catalog.js').read_text()
    albums = json.loads(source.split('=', 1)[1].strip().rstrip(';'))
    return {track['id']: ROOT / track['src'].lstrip('/')
            for album in albums for track in album['tracks']}
