#!/usr/bin/env python3
"""Create a labelled state illustration from the saved ChatPane fixture captures.
Run through God's Hand scripts/run_check.py --timeout 60 -- python3 <this file>.
"""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
states = [
    ('before/before-e1b53de3-composer-running.png', 'BEFORE e1b53de3 - composer disabled'),
    ('after/after-b35dbbab-composer-typed.png', 'AFTER b35dbbab - read, waiting, composing'),
    ('after/after-b35dbbab-pending-optimistic.png', 'AFTER b35dbbab - pending submission'),
    ('after/after-b35dbbab-queued.png', 'AFTER b35dbbab - queued fallback'),
    ('after/after-b35dbbab-stopped-send-again.png', 'AFTER b35dbbab - stopped, Send again'),
    ('after/after-b35dbbab-undelivered.png', 'AFTER b35dbbab - unread after idle, Send again'),
]
manifest = root / 'animation-frames.txt'
manifest.write_text(''.join(f"file '{root / path}'\nduration 3\n" for path, _ in states) + f"file '{root / states[-1][0]}'\n")
# The local ffmpeg build has no drawtext filter. Captions live in the PR and report.
filters = [
    'scale=960:600:force_original_aspect_ratio=decrease',
    'pad=960:600:(ow-iw)/2:(oh-ih)/2:black',
    'fps=2',
    'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer',
]
subprocess.run([
    '/opt/homebrew/bin/ffmpeg', '-hide_banner', '-loglevel', 'warning', '-y', '-threads', '1',
    '-f', 'concat', '-safe', '0', '-i', str(manifest), '-filter_complex_threads', '1',
    '-filter_complex', ','.join(filters), '-t', '18', '-loop', '0', str(root / 'steering-states.gif'),
], check=True)
print(root / 'steering-states.gif')
print((root / 'steering-states.gif').stat().st_size, 'bytes')
