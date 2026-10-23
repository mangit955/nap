# Third-party notices

Code in `apps/web` adapted from other projects, and the licences it came under. A file containing
adapted code says so in its header comment and points here.

## T3 Code

The chat pane's timeline is a clone of T3 Code's chat timeline:

- the work-log rows, the group summaries and the turn folds (`src/chat/work-log.ts`,
  `src/chat/work-log-rows.tsx`, `src/chat/timeline.ts`, `src/chat/tool-body.tsx`)
- the markdown renderer and its lazy highlighting (`src/chat/chat-markdown.tsx`,
  `src/chat/highlight.tsx`)
- the changed-files card (`src/chat/changed-files-card.tsx`)
- the visible-animation observer (`src/chat/visible-animation.ts`)
- the drop overlay, attachment tiles and composer buttons (`src/chat/use-file-drop.ts`,
  `src/chat/chat-input.tsx`, `src/chat/composer-controls.tsx`)
- the live-tool shine, the live-activity spotlight and the `.chat-markdown` styles
  (`src/app/globals.css`)
- the popovers and the composer's icon controls: the popup shadow and its scale-and-fade, and
  the square ghost button (`.nap-float` in `src/app/globals.css`,
  `src/chat/composer-controls.tsx`, `src/chat/composer-add-menu.tsx`,
  `src/chat/context-control.tsx`)
- the compaction divider and its short token counts (`src/chat/compaction-row.tsx`)

The provider settings — the list beside its editor, the Account sign-in row, the three-step
"Add provider" wizard, and the OpenAI and Claude marks (`src/providers/`) — follow T3 Code at
commit `71a283aed253f23be1860a31d4ea48f1c06e0b1c`.

The menu and popover glass, floating surface, dialog glass, and dialog and sheet backdrops
(`.composer-surface`, `.glass-popover`, `.surface-glass`, `.dialog-glass`, `.sheet-backdrop` in
`src/app/globals.css`) are adapted from T3 Code at commit
`71a283aed253f23be1860a31d4ea48f1c06e0b1c`. The switch in `src/ui/switch.tsx` is an independent
implementation inspired by the provider switches at that commit.

The right-panel shell, tabs, toolbar dimensions, dark palette, and Pierre diff theme
(`src/workspace/right-panel.css`, `src/workspace/workbench.tsx`, `src/workspace/diff-theme.ts`)
follow T3 Code at commit `51273020db3245f4ec29514a419d29b5dcb012dc`. The panel uses
`@pierre/diffs` 1.5.2 under its Apache-2.0 license; its notices ship with that package.

The chat adaptations below use the earlier reference commit.

Source: <https://github.com/pingdotgg/t3code>, at commit
`e64766c56ac6fc1678e6107052feb0047a35337f`.

```
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
```
