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
# Needs ffmpeg and gifsicle (`brew install ffmpeg gifsicle`).

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
master="$root/.scratch/demo-master.mp4"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for tool in ffmpeg gifsicle; do
  command -v "$tool" >/dev/null || {
    echo "$tool is not installed — brew install ffmpeg gifsicle" >&2
    exit 1
  }
done

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
# Six beats, in the order that makes the argument rather than the order that fills the time. The
# long stretches of ordinary generation are what got cut: anybody can show a model producing a
# dashboard, and the part of this recording that is *Nap* is the agent's work being checked.
#
#   1. the prompt          a sentence, and a model picker
#   2. the agent working   thinking, then a tool call against the sandbox
#   3. verification        `npm run typecheck && npm run build`, running, in the transcript
#   4. the verdict         "Verified successfully with both ..." — the claim, arbitrated
#   5. the app             what it built, close enough to read
#   6. its own URL         the same app on the sandbox's hostname, not a mock in a panel
#
# **Every beat has to be legible at 800px wide, which is the whole difficulty.** The master is a
# 1920px screen recording and zooms in and out on its own as it goes, so a beat is only usable
# where the recording happens to be close: hence beat 1 starting inside its zoom rather than at the
# keystroke, and beat 5 coming from the second pass over the dashboard rather than the first. Beat
# 3 is the exception and is cropped 2x by hand, because the transcript line naming the commands is
# the point of it and the master is framed wide there. Beat 4 is slowed, because the recording pans
# off the verdict about two seconds after it lands and it is the one sentence a reader must read.
cut() { # start duration [filter]
  ffmpeg -y -v error -ss "$1" -t "$2" -i "$master" \
    -vf "${3:-null},scale=1000:-2,setsar=1,fps=25" -c:v libx264 -crf 16 -preset medium -an \
    "$work/$4.mp4"
}

cut 23.2 3.4 "" 1-prompt
cut 31.6 4.8 "" 2-working
cut 66.0 3.3 "crop=960:540:0:540" 3-verifying
cut 74.6 2.6 "setpts=PTS/0.62" 4-verdict
cut 103.6 3.4 "" 5-app
cut 111.6 2.4 "" 6-url

for part in 1-prompt 2-working 3-verifying 4-verdict 5-app 6-url; do
  echo "file '$work/$part.mp4'"
done >"$work/parts.txt"

ffmpeg -y -v error -f concat -safe 0 -i "$work/parts.txt" -c copy "$work/short.mp4"

# GIF rather than MP4 for the README, because GitHub autoplays a GIF the moment the repository page
# loads and will not play a relative MP4 at all. Three settings here are not the obvious ones, and
# each was measured on this clip rather than reasoned about:
#
# - **12.5fps, not 12 or 15.** A GIF frame delay is an integer number of centiseconds, so only
#   rates that divide 100 play evenly: 12.5 is 8cs exactly, where 15 is 6.67 and gets rounded
#   frame by frame into visible unevenness. 10 (10cs) is even too, and was simply too slow.
# - **`dither=none`.** Dithering a mostly-flat dark UI buys nothing and costs twice: it shimmers
#   between frames, and the noise it adds is per-pixel change that defeats the inter-frame delta.
# - **No denoise before the palette.** Tried, and it made the file *larger* — smoothing nudges
#   every background pixel by a little every frame, so regions that were byte-identical between
#   frames, and therefore free, stop being.
ffmpeg -y -v error -i "$work/short.mp4" \
  -vf "fps=12.5,scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 "$work/demo.gif"

# ffmpeg will not do this part: gifsicle re-optimises across frames and, with --lossy, will merge
# colours that are nearly the same into runs that compress. A third off, for nothing anybody can
# see at this size. Past --lossy=30 the curve flattens, so it stops there.
gifsicle -O3 --lossy=30 "$work/demo.gif" -o "$root/docs/demo.gif"

printf '\n%s\n' "wrote:"
ls -lh "$root/apps/web/public/demo.mp4" "$root/apps/web/public/demo-poster.jpg" "$root/docs/demo.gif" |
  awk '{ printf "  %-6s %s\n", $5, $9 }'
