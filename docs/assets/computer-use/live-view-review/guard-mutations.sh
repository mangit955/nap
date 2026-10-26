#!/bin/bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
python3 - <<'PY'
from pathlib import Path
import subprocess
cases=[
('idle-prefix','apps/web/src/computer/computer-activity.ts','const idleThroughSeq = observed?.idleThroughSeq ?? 0;','const idleThroughSeq = 0;','unit','apps/web/src/computer/computer-activity.test.ts','retires legacy'),
('capture-busy','apps/web/src/computer/computer-activity.ts','return history.some(','return false && history.some(','unit','apps/web/src/computer/computer-activity.test.ts','keeps a new capture'),
('activity-session','apps/web/src/computer/computer-activity.ts','activity && activity.sessionId === sessionId ? activity : null','activity','unit','apps/web/src/computer/computer-activity.test.ts','retires legacy'),
('shared-activity','apps/web/src/components/chat-pane.tsx','onActivity?.(activity)','undefined','web','apps/web/src/components/live-chat-pane.test.tsx','shares reconciled legacy'),
('idle-shift-escape','apps/web/src/computer/computer-input-surface.tsx','if (event.key === "Escape" && event.shiftKey) {\n            event.stopPropagation();','if (event.key === "Escape" && event.shiftKey) {','web','apps/web/src/computer/computer-input-surface.test.tsx','driving=false'),
('credential-parse','apps/web/src/computer/use-desktop-stream.ts','ComputerStreamSchema.parse(await response.json())','await response.json()','web','apps/web/src/computer/use-desktop-stream.test.tsx','safe failure'),
('credential-abort','apps/web/src/computer/use-desktop-stream.ts','controller.abort();','void 0;','web','apps/web/src/computer/use-desktop-stream.test.tsx','loads owner credentials'),
('retry-credentials','apps/web/src/computer/computer-pane.tsx','onRetry={stream.retry}','','web','apps/web/src/computer/computer-pane.test.tsx','connects live view'),
('recording-status','apps/web/src/computer/app-test-cards.tsx','const playable = test.status !== "running" && ','const playable = ','web','apps/web/src/computer/app-test-cards.test.tsx','completed available recording'),
('recording-download','apps/web/src/computer/recording-viewer.tsx','href={recording.downloadUrl}','href={recording.videoUrl}','web','apps/web/src/computer/recording-viewer.test.tsx','renders counts'),
('control-busy','apps/web/src/computer/computer-pane.tsx','    connected,\n    busy,','    connected,\n    busy: false,','web','apps/web/src/computer/computer-pane.test.tsx','owner control only'),
('history-disconnect','apps/web/src/computer/computer-pane.tsx','active && selectedSeq === null &&','active &&','web','apps/web/src/computer/computer-pane.test.tsx','connects live view'),
('vnc-readonly','apps/web/src/computer/live-desktop-frame.tsx','rfb.viewOnly = true;','rfb.viewOnly = false;','web','apps/web/src/computer/live-desktop-frame.test.tsx','named, view-only'),
]
for name,file,old,new,project,suite,expected in cases:
 p=Path(file); original=p.read_text(); assert original.count(old)==1,(name,original.count(old))
 try:
  p.write_text(original.replace(old,new))
  r=subprocess.run(['bunx','--no-install','vitest','run','--project',project,suite,'--maxWorkers=1'],capture_output=True,text=True,timeout=65)
  output=r.stdout+r.stderr
  Path('/tmp/nap-parent-ui-mutation-'+name+'.log').write_text(output)
  if r.returncode!=1 or expected not in output or 'failed' not in output:raise RuntimeError('Guard did not fail as expected: '+name+'\n'+output[-2500:])
  print(name+': observed failing',flush=True)
 finally:p.write_text(original)

PY
