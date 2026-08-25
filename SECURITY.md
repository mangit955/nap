# Security policy

## Reporting a vulnerability

Report it privately through GitHub's
**[Report a vulnerability](https://github.com/mangit955/nap/security/advisories/new)** form, not as a
public issue. That opens a draft advisory only you and I can see.

Nap is a solo project and has no support commitment behind it: expect a first reply within a week,
and take silence past that as a reason to send a reminder rather than as disinterest. If a report is
valid I will credit you in the advisory unless you would rather I did not.

There is one supported version and it is `main`. There are no releases and no backported fixes.

## What is most worth looking at

Nap runs model-written code and spends other people's money, so the interesting surfaces are the
ones where those two meet:

- **Sealed user API keys.** A user may store an OpenRouter key so their turns bill to them. Keys are
  sealed with AES-256-GCM under `NAP_KEY_ENCRYPTION_SECRET`, a fresh 12-byte IV per seal, tag
  appended — [`apps/api/src/account/secret-box.ts`](apps/api/src/account/secret-box.ts). Anything
  that opens a key it should not, returns a key to the wrong user, or gets one into a log or an
  event payload is the highest-value finding here.
- **Turn admission.** Which models a caller may reach and whose account pays are decided by
  `resolveTurnAccess`, not by the agent. A path that reaches a paid model on the deployment's key
  without going through it is a direct financial bug.
- **The ceilings.** Per-user turn rate limits, per-user and deployment-wide sandbox quotas, a token
  budget per turn and a step budget per agent loop. A way to exceed any of them is in scope; an
  unattended agent past its ceiling is an unbounded bill.
- **Session and sandbox ownership.** Reaching another user's project, transcript, preview URL or
  sandbox filesystem.
- **The event log.** Events are appended before fanout and replayed by `seq`. A way to make a client
  receive events for a session it does not own is in scope.

## What is already known, and by design

Please do not report these as vulnerabilities:

- **The agent executes model-written code, including shell commands.** That is the product. It runs
  in an isolated E2B sandbox that holds no Nap credential, and the six tools in
  `packages/agent/src/tools/` are the only ones that exist — all of them proxy to `SandboxManager`,
  so there is no reachable filesystem but the sandbox's. Findings about what the *agent* can do
  inside its own sandbox are expected; findings about escaping it into Nap's processes are not.
- **A user's preview URL is public if you have it.** An E2B preview is unauthenticated by design so
  the browser can load it.
- **Rotating `NAP_KEY_ENCRYPTION_SECRET` makes every stored key stop opening.** That is the intended
  behaviour of a rotation, not data loss — everyone falls back to the free tier until they paste
  theirs again.
- **The hosted demo signs you out on Safari and Brave.** The app and its API are on two different
  sites, so the session cookie is third-party and those browsers block it. Tracked as
  [#86](https://github.com/mangit955/nap/issues/86).

The hosted demo at [nap-tawny.vercel.app](https://nap-tawny.vercel.app) is a portfolio deployment
running on free tiers. Please do not load-test it, and do not use it to store anything you care
about — an idle project's sandbox is destroyed on a schedule.
