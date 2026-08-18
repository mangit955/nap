#!/usr/bin/env bash
#
# One recording, two presentations.
#
# `apps/web/src/docs/how-nap-works.tsx` shows the whole run and the README shows a ~22s cut of it,
# and the two must never be different recordings — a reader who watches the long one after the
# short one has to be watching the same session, or the short one stops being evidence. So both
# artefacts are derived here, from one master, by this script.
#
# The master is a 1920x1080 screen recording and is deliberately **not** in git: it is 20MB, it is
# never served, and every byte of it that matters is in the two derived files. It lives at
# .scratch/demo-master.mp4 (gitignored). Re-recording means dropping a new one there and running
# this — and re-reading the cut points below, because they are timestamps into that recording and
# nothing checks them.
#
#   bash scripts/demo-cuts.sh
#
# Needs ffmpeg (`brew install ffmpeg`).

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
master="$root/.scratch/demo-master.mp4"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ ! -f "$master" ]]; then
  echo "no master recording at $master — see the comment at the top of this script" >&2
  exit 1
fi

# --- the long one: the whole session, for /docs -------------------------------------------------
#
# 720p rather than the master's 1080p, because it is a static asset Vercel serves on a docs page
# and 20MB of it is not worth the second row of pixels. `faststart` moves the index to the front so
# the browser can begin playing before the whole file has arrived.
ffmpeg -y -v error -i "$master" \
  -vf "scale=1280:-2" -c:v libx264 -crf 26 -preset slow -profile:v high -pix_fmt yuv420p \
  -movflags +faststart -an \
  "$root/apps/web/public/demo.mp4"

# The poster: the frame the video shows before it is played. The generated app, because a black
# first frame reads as a broken embed.
ffmpeg -y -v error -ss 82 -i "$master" -frames:v 1 -vf "scale=1280:-2" -q:v 4 \
  "$root/apps/web/public/demo-poster.jpg"

# --- the short one: the thesis, for the README --------------------------------------------------
#
# Five beats, in the order that makes the argument rather than the order that fills the time. The
# long stretches of ordinary generation are what got cut: anybody can show a model producing a
# dashboard, and the part of this recording that is *Nap* is the agent's work being checked.
#
#   1. the prompt          a sentence, and a model picker
#   2. the agent working   thinking, then a tool call against the sandbox
#   3. verification        `npm run typecheck && npm run build`, running, in the transcript
#   4. the verdict         "Verified successfully with both ..." — the claim, arbitrated
#   5. the app             what it built
#
# Beat 3 is cropped to the transcript's bottom corner: the master frames the whole browser there,
# and the command line is unreadable once the frame is 820px wide. Beat 4 is slowed, because the
# recording pans off the verdict about two seconds after it lands and it is the one sentence on
# screen a reader has to actually read.
cut() { # start duration [filter]
  ffmpeg -y -v error -ss "$1" -t "$2" -i "$master" \
    -vf "${3:-null},scale=900:-2,setsar=1,fps=15" -c:v libx264 -crf 18 -preset slow -an \
    "$work/$4.mp4"
}

cut 21.8 4.7 "" 1-prompt
cut 31.5 5.3 "" 2-working
cut 66.0 3.5 "crop=960:540:0:540" 3-verifying
cut 74.6 2.6 "setpts=PTS/0.62" 4-verdict
cut 80.0 4.4 "" 5-app

for part in 1-prompt 2-working 3-verifying 4-verdict 5-app; do
  echo "file '$work/$part.mp4'"
done >"$work/parts.txt"

ffmpeg -y -v error -f concat -safe 0 -i "$work/parts.txt" -c copy "$work/short.mp4"

# GIF rather than MP4 for the README, because GitHub autoplays a GIF the moment the repository page
# loads and will not play a relative MP4 at all. `palettegen` over the whole clip and then
# `paletteuse` is the difference between 8MB and 30MB: one 256-colour palette chosen from every
# frame beats ffmpeg's per-frame default, and these frames are mostly flat dark UI.
ffmpeg -y -v error -i "$work/short.mp4" \
  -vf "fps=10,scale=820:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 "$root/docs/demo.gif"

printf '\n%s\n' "wrote:"
ls -lh "$root/apps/web/public/demo.mp4" "$root/apps/web/public/demo-poster.jpg" "$root/docs/demo.gif" |
  awk '{ printf "  %-6s %s\n", $5, $9 }'
