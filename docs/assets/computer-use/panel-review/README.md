# Computer tab evidence

Actual `ComputerPane` from `apps/web/src/computer/computer-pane.tsx`, rendered by the test-only `ComputerReview` fixture. This is the stored-screenshot milestone in [#148](https://github.com/mangit955/nap/issues/148). It follows new screenshot events through the workspace's existing log. It does not connect to VNC.

Compare `nap-computer-live.png` with the passive [Devin live reference](../review/devin-computer-live.png). Both show an idle computer at the live end of the timeline. The reference was captured at 2400×1584; Nap desktop captures are 1440×1100. The fixture has a plain tab header. Actual Workbench tab opening and persistence are covered by `workbench.test.tsx`, and AppShell supplies the real Computer pane without adding an event subscription.

Captured 2026-10-24 using Chrome 153.0.8010.54 on macOS and Node 26.12.0. The media inventory records the committed bytes.

Seven screenshots cover live, history, missing history, waiting, desktop starting, failed image load, and phone layout. The phone is 390×844 with reduced motion and transparency, without touch or OS keyboard emulation. Only the live state has a matching passive Devin capture. Other states implement the approved copy and still need reference captures if exact visual matching is in question.

`fixture-desktop.jpg` is a 1024×768 screenshot of Nap's synthetic sign-in HTML from the standalone mockup. No Devin assets or pixels appear in the rendered application. The review browser intercepts screenshot HTTP requests and supplies this image locally. The failed state returns 404. This proves rendering and interaction, not real cookies, a live sandbox, or image transport to a model. Owner authorization and storage failure behavior are tested through the API's unit suite.

The Live pill means follow new screenshots. Stream quality remains disabled until the live VNC ticket. Pop-out opens the current authenticated screenshot. Native full screen works for this pane. Live input and take control are separate later tickets.

## Reproduce

Start the static mockup server and a dedicated headless Chrome as described in [the mockup review](../review/README.md). Create this temporary Next route:

```sh
mkdir -p apps/web/src/app/computer-review
cat > apps/web/src/app/computer-review/page.tsx <<'TS'
import { ComputerReview } from "../../testing/computer-review.tsx";
export default ComputerReview;
TS
```

From `apps/web`, run `bunx next dev --port 4320`. Then run from the repository root:

```sh
node docs/assets/computer-use/panel-review/check.mjs
```

The script uses Chrome at port 9337, refuses the passive Devin port 9223, opens its own tab, captures the mockup desktop, intercepts only local screenshot image requests, and closes the tab. It asserts state changes, native full screen through trusted pointer input, reduced transparency, and no horizontal overflow at 390px. It also fails on browser runtime exceptions. Remove the temporary route afterward; it must not ship.

The real-browser check first caught a server/client locale mismatch in the timestamp, then an image that completed before hydration attached its load listener. The caption now names UTC explicitly and the image ref handles already-complete loads. The cache race has a component regression test that was observed failing before its fix. A browser ratio assertion also failed against a frame whose maximum height had distorted its border. Container sizing now keeps the bordered screen at 4:3 at both widths. Stale loads cannot settle a newer frame. Removing the image key or credential attribute is also checked by component tests.

The screenshots include Next's development indicator. No product error overlay was hidden. The initial failed captures were replaced after the browser ran without runtime exceptions.

All source and fixture files are within the existing web TypeScript and lint gates. New `.test.tsx` files are collected by the web Vitest project. The review script is documentation tooling, checked by Biome and run explicitly. No dependency or architecture table change is needed. The temporary route is removed before committing.
