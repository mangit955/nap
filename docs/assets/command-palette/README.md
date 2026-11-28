# Command palette: evidence

Captured with `verify-nap` (real web app, API, auth and Postgres; scripted model, in-memory sandbox)
in its headless Chrome at 1440×900, signed in as the fixture user, on the seeded session
**Seeded notes app**. Driven by keyboard only: ⌘K, arrows, typing, Enter, Escape.

| File | What it shows |
|---|---|
| `01-before.jpg` | The workspace before ⌘K: the right panel closed, focus in the composer. |
| `02-open.jpg` | ⌘K: the palette over the dimmed, blurred room. Actions first, then sessions (a second session, `Fixture title 001`, was started from the dashboard for the ⌘2 check below); the first row highlighted. |
| `03-filtered.jpg` | After typing `file`: Open Files and Show changed files. |
| `04-files-open.jpg` | After Enter: the right panel open on Files. |
| `05-dashboard-open.jpg` | ⌘K on `/dashboard`: only the commands the dashboard has handlers for. |
| `palette.mp4` | The whole sequence at real speed: open, ↓ ↓, type `file`, Enter, then ⌘K and Escape. |

Measured in the same run, from computed styles (`getComputedStyle`), not from the source:

| Property | Value |
|---|---|
| Popup width, radius | 576px, 16px |
| Backdrop | surface at 64%, `blur(4px)` |
| Row height, radius | 32px, 6px |
| Highlight | ink (`#e5e5e5`) at 9% |
| 90ms into opening | opacity 0.50, scale 0.990: it scales from 0.98 and fades |
| 90ms after Enter | `open` false, still drawn at opacity 0.50: the close fades too |
| Escape | focus back on the composer (`Message`) |
| Focus ring | the search row's outline, 1px ink at 22%; under emulated `forced-colors: active` still a solid 1px outline (a box-shadow ring measured `none` there) |
| Reduced motion | transition 0s; open at opacity 1 and scale 1 at once, gone at once on Escape |

Also driven in that run: **New session** from a workspace goes to `/dashboard`; **Toggle sidebar**
collapses the sidebar and expands it again (`data-sidebar-collapsed`); picking the session by
typing `seeded` opens `/p/<id>`.

Checked in Chrome after review, each against the fix it proves:

| Check | Result |
|---|---|
| ⌘K with the thread details card (a non-modal `<dialog open>`) showing | the palette opens |
| ⌘2 with the palette open, two sessions in the sidebar | URL unchanged; after Escape, ⌘2 switches session |
| Tab in the field | focus stays on the combobox |
| List scrolled by the wheel, closed and reopened | `scrollTop` 12, then 0 |
| 60ms into closing | still drawn, `flex-direction: column`: the footer stays under the list |
