# Third-party notices

## T3 Code

The native compaction lifecycle and context-restoration code in
`packages/agent/src/native-compaction.ts` adapts behavior from T3 Code's
`CodexAdapterV2.ts`, `ClaudeAdapterV2.ts` and `CodexTurnTokenUsage.ts`. The compaction controls and orchestration
also follow that implementation. Pinned source revision:
[e3b35d1b2440b104f0bc2e357377c348121234dd](https://github.com/pingdotgg/t3code/tree/e3b35d1b2440b104f0bc2e357377c348121234dd).
The API summary/checkpoint implementation is nap-specific.

The circular input-budget meter and popup in `apps/web/src/chat/context-control.tsx`
and the quiet compaction timeline in `apps/web/src/chat/compaction-row.tsx` adapt
`ContextWindowMeter.tsx` and `ContextCompactionTimelineRow`. The attached queued-prompt panel
in `apps/web/src/chat/chat-input.tsx` adapts `QueuedRunsControl.tsx`, `ComposerBanner.tsx`
and `ComposerSurface.tsx`. The scroll-resting composer in `chat-input.tsx`,
`use-composer-scroll.ts` and `chat-pane.tsx` adapts `ChatComposer.tsx`,
`composerScrollGesture.ts`, `timelineScrollTarget.ts` and `composerFooterLayout.ts`.
These components come from T3 Code revision
[67c0fc0cdaf963b103518862dd7b68a9c758ecf2](https://github.com/pingdotgg/t3code/tree/67c0fc0cdaf963b103518862dd7b68a9c758ecf2).
Nap uses its configured input budget, existing event lifecycle and theme tokens.

The upstream license follows in full:

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
