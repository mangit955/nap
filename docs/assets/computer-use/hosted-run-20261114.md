# Hosted desktop run: sanitized evidence

The original run used the public web origin's `/backend` path and the deployed API WebSocket on 2026-11-14. The driver used `openai/gpt-5.6-luna`, the production worker, E2B and R2. It built and tested one small kanban application.

The original operator recorded production revision `f9b123e9cda2f357f3be3a8aefec326f466c0790`. Archived artifacts inspected during this review establish the deployed-endpoint workflow and template publication below; they do not contain Render deployment metadata independently confirming that all three services ran that revision.

## Template publication

Sanitized output from the archived `template-build.log`:

```json
{"alias":"nap-vite-react","templateId":"uz50ssm54r8rc9n6isll","buildId":"5429d9bf-4738-49ce-8f79-c6f4f6ef6e5c","manifestSha256":"da097d673e2fcfb629084f5c4a706cf06767f2cd4b1d58b3a6ad61650647cc64","desktopBuild":"a89efce587a2f872025b53c0b26ca2300af3a114491989ffa92296b0b065502c"}
```

The publication log shows cached uploads and layers. `DESKTOP_BUILD` was unchanged, so the documented reservation-drain procedure for a desktop-build change did not apply.

## Recorded results

The following is an allowlisted extraction of `state.json`, with user, project, session, sandbox instance and credential-bearing data removed. These are original run results, not a repeat of the hosted experiment during review.

```json
{
  "startedAt": "2026-11-14T17:44:06.153Z",
  "finishedAt": "2026-11-14T17:47:06.979Z",
  "sandbox": {
    "name": "nap-vite-react",
    "cpuCount": 2,
    "memoryMB": 2048
  },
  "build": {
    "outcome": "verified",
    "durationMs": 92207,
    "usage": {
      "inputTokens": 117510,
      "outputTokens": 3809,
      "cacheWriteTokens": 12637,
      "cacheReadTokens": 104834
    }
  },
  "test": {
    "durationMs": 48107,
    "counts": {
      "passed": 4,
      "failed": 0,
      "untested": 0
    },
    "usage": {
      "inputTokens": 80180,
      "outputTokens": 1805,
      "cacheWriteTokens": 15304,
      "cacheReadTokens": 64852
    },
    "screenshots": 6,
    "annotationTimeRangeMs": [
      14625,
      44750
    ]
  },
  "checks": {
    "screenshotRoute": {
      "status": 200,
      "type": "image/jpeg",
      "bytes": 72641,
      "jpeg": true
    },
    "recordingRange": {
      "status": 206,
      "contentRange": "bytes 0-1023/164994",
      "type": "video/mp4"
    },
    "recordingFull": {
      "status": 200,
      "bytes": 164994
    },
    "streamRoute": {
      "status": 200,
      "hasUrl": true,
      "hasPassword": true
    },
    "rfb": "RFB 003.008",
    "controlGrant": {
      "status": 200,
      "hasGrant": true
    },
    "ownerInput": {
      "status": 200,
      "body": {
        "applied": 3
      }
    }
  },
  "sampledPeak": {
    "memUsedMiB": 973,
    "memTotalMiB": 1983,
    "at": "2026-11-14T17:46:35.000Z",
    "samples": 33
  },
  "estimatedModelUsd": 0.01573132,
  "cleanup": {
    "deleteStatus": 200,
    "r2Present": 0,
    "r2Checked": 6,
    "vmGone": true
  }
}
```

Additional sanitized cleanup output from the archived log:

```text
2026-11-14T17:47:45.908Z r2 before delete {"keys":6,"present":6}
2026-11-14T17:47:49.595Z delete {"status":200,"body":"{\"deleted\":true,\"objectsDeleted\":10,\"sandboxDestroyed\":true}"}
2026-11-14T17:47:55.989Z cleanup {"deleteStatus":200,"r2Present":0,"r2Checked":6,"vmGone":true}
```

The delete endpoint reported ten objects removed. The independent follow-up checked the test turn's six screenshot keys and found none present. The build turn's screenshot and the recording were not among the checked keys, so their removal rests only on the delete endpoint's count of ten. The follow-up's E2B sandbox lookup failed after the kill, which the driver records as `vmGone: true`; it did not inspect the error. This evidence does not establish that a full object-prefix listing was empty.

## Memory and cost limits

E2B sampled every five seconds. The largest recorded sample was 973 MiB used of 1,983 MiB, across 33 samples. The nearby guest reading was 972 MiB used, 1,009 MiB available and 1,982 MiB total. This is a sampled peak, not an instantaneous maximum.

973 MiB is **3 MiB below** the old 1-GiB guest's observed 976 MiB total. This 2-GiB experiment cannot establish whether the same workload would fit or fail at 1 GiB. The template remains at 2 GiB; larger applications were not exercised.

The driver's price constants were US$0.20 per million uncached input tokens, US$0.02 per million cache-read tokens and US$1.20 per million output tokens. Applied to captured usage, the final model estimate was US$0.01573132. This is an estimate, not a provider invoice. E2B VM time was under four minutes, estimated at roughly another US$0.01. The review did not rerun paid infrastructure.

## Local recording probe during review

On 2026-11-14 the verification worker checked the retained recording on macOS arm64. Both
commands ran serially with a 60-second deadline under the shared resource runner and exited 0.
This checked the archived media, without repeating a paid hosted run or checking current endpoint
availability. The source `recording.mp4` SHA-256 was
`98615b5389505f7c20d6788acfab4ea893fe473c5a93eb3830654912a1dbc74f`.

The metadata command and its output were:

```sh
ffprobe -v error -show_entries stream=codec_name,width,height -show_entries format=duration -of json recording.mp4
```

```json
{
  "programs": [],
  "stream_groups": [],
  "streams": [{"codec_name": "h264", "width": 1024, "height": 768}],
  "format": {"duration": "50.125000"}
}
```

The seek command decoded one frame at 25 seconds:

```sh
ffmpeg -hide_banner -loglevel info -ss 25 -i recording.mp4 -frames:v 1 -update 1 recording-midpoint.png
```

Relevant output, with local paths removed:

```text
Duration: 00:00:50.13, start: 0.000000, bitrate: 26 kb/s
Stream #0:0[0x1](und): Video: h264 (Constrained Baseline) (avc1 / 0x31637661), yuv420p(progressive), 1024x768, 25 kb/s, 8 fps, 8 tbr, 16384 tbn (default)
Stream mapping:
  Stream #0:0 -> #0:0 (h264 (native) -> png (native))
frame=    1 fps=0.0 q=-0.0 Lsize=N/A time=00:00:00.12 bitrate=N/A speed=4.12x elapsed=0:00:00.03
```
