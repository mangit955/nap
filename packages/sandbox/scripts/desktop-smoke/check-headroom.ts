/** Free local encoder agreement check. Requires ffmpeg and ffprobe on PATH. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DesktopRecorder, type RecordingProcessHost } from "../../src/desktop-recorder.ts";

const directory = mkdtempSync(join(tmpdir(), "nap-encoder-headroom-"));
const id = "72a3e710-65bf-420e-8cea-d4aa8e0b2f7d";
const path = join(directory, id);
mkdirSync(path);
const file = join(path, "capture.mp4");
try {
  execFileSync(
    "ffmpeg",
    [
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1024x768:rate=8",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-bf",
      "0",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-t",
      "600",
      "-fs",
      "14000000",
      "-movflags",
      "+faststart",
      file,
    ],
    { timeout: 120_000, stdio: "ignore" },
  );
  const metadata = z
    .object({
      streams: z
        .array(z.object({ width: z.int(), height: z.int(), nb_frames: z.string() }))
        .length(1),
      format: z.object({ size: z.string(), duration: z.string() }),
    })
    .parse(
      JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,nb_frames:format=size,duration",
            "-of",
            "json",
            file,
          ],
          { encoding: "utf8", timeout: 5000 },
        ),
      ),
    );
  const stream = metadata.streams[0];
  assert.ok(stream);
  writeFileSync(
    join(path, "process.json"),
    JSON.stringify({ pid: 1, startTicks: "fixture-ended" }),
  );
  let probes = 0;
  const host: RecordingProcessHost = {
    start: async () => {
      throw new Error("Capture already ended.");
    },
    running: async () => false,
    stop: async () => {
      throw new Error("Capture already ended.");
    },
    probe: async () => {
      probes++;
      return {
        width: stream.width,
        height: stream.height,
        durationMs: Math.round(Number(metadata.format.duration) * 1000),
      };
    },
  };
  const clip = await new DesktopRecorder({ directory, host }).finish(id);
  assert.ok(statSync(file).size > 14_000_000, "Fixture must exercise finalization overshoot.");
  assert.ok(clip.bytes.length <= 16_000_000);
  assert.equal(probes, 1);
  assert.deepEqual(clip.bytes, Uint8Array.from(readFileSync(file)));
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], {
    timeout: 120_000,
    stdio: "ignore",
  });
  console.log(
    JSON.stringify({
      encoderStopBytes: 14_000_000,
      acceptedBytes: clip.bytes.length,
      durationMs: clip.durationMs,
      frames: Number(stream.nb_frames),
      decodeAllFrames: true,
      recorderAccepted: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
