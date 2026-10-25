#!/bin/bash
set -euo pipefail
mkdir -p /home/user/.nap-desktop
export DISPLAY=:99
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!
for attempt in {1..100}; do xdpyinfo >/dev/null 2>&1 && break; sleep .1; done
xdpyinfo >/dev/null
xmessage -title 'Nap smoke' -geometry 600x300+100+100 -buttons 'Close:0' -default Close 'Nap recording smoke' >/tmp/app.log 2>&1 &
app_pid=$!
for attempt in {1..40}; do xdotool search --name '^Nap smoke$' windowfocus --sync >/dev/null 2>&1 && break; sleep .05; done
recording=72a3e710-65bf-420e-8cea-d4aa8e0b2f7d
invoke() {
  local payload
  payload=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({id:require("crypto").randomUUID(),op:process.argv[1],recordingId:process.argv[2]})).toString("base64"))' "$1" "$recording")
  timeout 20s node /usr/local/lib/nap-desktop/driver.mjs "$payload"
}
invoke recording_begin >/tmp/begin.json
sleep .5
invoke recording_timestamp >/tmp/time.json
payload=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({id:require("crypto").randomUUID(),op:"act",scopeId:"b794eab7-a529-4210-b37a-dcf016357cf5",sandboxId:"standalone-smoke",action:{action:"left_click",coordinate:[120,120]}})).toString("base64"))')
node /usr/local/lib/nap-desktop/driver.mjs "$payload" >/tmp/input.json
payload=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({id:require("crypto").randomUUID(),op:"act",scopeId:"b794eab7-a529-4210-b37a-dcf016357cf5",sandboxId:"standalone-smoke",action:{action:"key",text:"Return"}})).toString("base64"))')
node /usr/local/lib/nap-desktop/driver.mjs "$payload" >/tmp/key.json
for attempt in {1..40}; do kill -0 "$app_pid" 2>/dev/null || break; sleep .05; done
if kill -0 "$app_pid" 2>/dev/null; then exit 1; fi
wait "$app_pid"
sleep .5
payload=$(node -e 'process.stdout.write(Buffer.from(JSON.stringify({id:require("crypto").randomUUID(),op:"close_scope",scopeId:"b794eab7-a529-4210-b37a-dcf016357cf5",sandboxId:"standalone-smoke"})).toString("base64"))')
node /usr/local/lib/nap-desktop/driver.mjs "$payload" >/tmp/drain.json
invoke recording_finish >/tmp/clip.json
node <<'JS'
const fs = require('fs');
const assert = require('assert/strict');
const read = path => JSON.parse(fs.readFileSync(path));
assert.equal(read('/tmp/begin.json').ok, true);
assert.equal(read('/tmp/input.json').ok, true);
assert.ok(read('/tmp/time.json').value.timeMs > 0);
const clip = read('/tmp/clip.json');
assert.equal(clip.ok, true);
assert.equal(clip.value.width, 1024);
assert.equal(clip.value.height, 768);
assert.ok(clip.value.durationMs > 500);
const bytes = Buffer.from(clip.value.data, 'base64');
assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
fs.writeFileSync('/tmp/recording.mp4', bytes);
const report = {encoderTimeMs:read('/tmp/time.json').value.timeMs,durationMs:clip.value.durationMs,videoBytes:bytes.length,width:clip.value.width,height:clip.value.height,nodeVersion:process.version,physicalInputClosedWindow:true};
fs.writeFileSync('/tmp/report.json', JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
JS
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames -of json /tmp/recording.mp4
# Decode every frame, rather than accepting an MP4 header alone.
ffmpeg -v error -i /tmp/recording.mp4 -f null -
invoke recording_finish >/tmp/repeat.json
cmp /tmp/clip.json /tmp/repeat.json
invoke recording_discard >/tmp/discard.json
# Cancellation preceding lock dispatch must prevent all subsequent physical input.
node <<'JS'
const {spawnSync} = require('child_process');
const assert = require('assert/strict');
const id = require('crypto').randomUUID();
const run = request => spawnSync('node',['/usr/local/lib/nap-desktop/driver.mjs',Buffer.from(JSON.stringify({id,...request})).toString('base64')],{encoding:'utf8'});
assert.equal(run({op:'cancel'}).status, 0);
const input = run({op:'act',action:{action:'type',text:'must never type'}});
assert.equal(input.status, 1);
assert.equal(JSON.parse(input.stdout).error.code, 'cancelled');
console.log(JSON.stringify({cancelBeforeDispatch:true,repeatFinish:true,decodeAllFrames:true}));
JS

node /forced-cleanup.mjs "$xvfb_pid"
