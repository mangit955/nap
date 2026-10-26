#!/bin/bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
python3 - <<'PY'
from pathlib import Path
import re, subprocess
cases = [
 ('reservation','packages/runtime/src/app-test-recording.ts','await options.beforeCapture();','', 'packages/runtime/src/app-test-recording.test.ts','does not capture or run'),
 ('upload-await','packages/runtime/src/app-test-recording.ts','await options.objects.put(key, clip.value.bytes)','options.objects.put(key, clip.value.bytes)', 'packages/runtime/src/app-test-recording.test.ts','waits for video storage'),
 ('clock','packages/runtime/src/app-test-recording.ts','else if (lostClock)','else if (false)', 'packages/runtime/src/app-test-recording.test.ts','annotation clock was lost'),
 ('lease-before','packages/runtime/src/app-test-recording.ts','if (leaseLost())','if (false)', 'packages/runtime/src/app-test-recording.test.ts','before_upload'),
 ('lease-after','packages/runtime/src/app-test-recording.ts','recording = leaseLost()','recording = false', 'packages/runtime/src/app-test-recording.test.ts','during_upload'),
 ('delete-index','packages/runtime/src/delete-project.ts','if (event.type === "test.started")','if (false)', 'packages/runtime/src/delete-project.test.ts','reserved by a test start'),
 ('pointer-release','packages/runtime/src/single-agent-runtime.ts','usedComputer && !lostLease &&','false && !lostLease &&', 'packages/runtime/src/app-test-runtime.test.ts','releases held pointer'),
 ('pointer-fence','packages/runtime/src/single-agent-runtime.ts','usedComputer && !lostLease &&','usedComputer && true &&', 'packages/runtime/src/app-test-runtime.test.ts','losing the session lease'),
 ('orphan-discard','packages/runtime/src/janitor.ts','if (options.computer) {','if (false) {', 'packages/runtime/src/janitor.test.ts','discards an orphaned test'),
 ('media-owner','apps/api/src/computer/recordings.ts','c.get("userId")','(await deps.sessions.get(c.req.param("sessionId")))?.userId ?? ""', 'apps/api/src/computer/recordings.test.ts','other-owner'),
 ('media-range','apps/api/src/computer/recordings.ts','start < length','true', 'apps/api/src/computer/recordings.test.ts','bytes=32-40'),
 ('media-suffix','apps/api/src/computer/recordings.ts','Number.isSafeInteger(suffix)','true', 'apps/api/src/computer/recordings.test.ts','bytes=-9007199254740992'),
]
for name, file, old, new, suite, expected in cases:
 p=Path(file); original=p.read_text()
 assert original.count(old)==1, (name, original.count(old))
 try:
  p.write_text(original.replace(old,new))
  r=subprocess.run(['bunx','--no-install','vitest','run','--project','unit',suite,'--maxWorkers=1'],capture_output=True,text=True,timeout=45)
  output=r.stdout+r.stderr
  Path('/tmp/nap-recording-pipeline-mutation-'+name+'.log').write_text(output)
  if r.returncode!=1 or expected not in output or 'failed' not in output: raise RuntimeError('Mutation was not caught as expected: '+name)
  print(name+': observed failing',flush=True)
 finally: p.write_text(original)
p=Path('apps/api/src/computer/recordings.ts'); original=p.read_text()
try:
 mutated,count=re.subn(r'const key = computerRecordingKey\(\{[\s\S]*?\}\);','const key = last.payload.recording.key;',original,count=1)
 assert count==1
 p.write_text(mutated)
 r=subprocess.run(['bunx','--no-install','vitest','run','--project','unit','apps/api/src/computer/recordings.test.ts','--maxWorkers=1'],capture_output=True,text=True,timeout=45)
 output=r.stdout+r.stderr
 Path('/tmp/nap-recording-pipeline-mutation-media-key.log').write_text(output)
 assert r.returncode==1 and 'foreign clip' in output
 print('media-key: observed failing',flush=True)
finally: p.write_text(original)

PY
