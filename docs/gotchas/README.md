# Gotchas

Learned the hard way; don't rediscover them. One file per area, because most of them do not apply
to most sessions: read the file for whatever you are about to touch, not all of them.

| Touching… | Read |
|---|---|
| package layout, imports, `bun`, turbo, Biome, Next config | [workspace.md](workspace.md) |
| types, schemas, the event contract, env parsing | [contracts.md](contracts.md) |
| `packages/agent`, prompts, caching, streaming, OpenRouter, cost | [model.md](model.md) |
| `packages/sandbox`, `packages/storage`, snapshots, the desktop, the reaper | [sandbox.md](sandbox.md) |
| `apps/api` — routes, auth, limits, logging, `/health`; the turn queue and leases; the three entrypoints | [api.md](api.md) |
| `apps/web` — components, the landing page, browser checks | [web.md](web.md) |
| writing tests, fakes, mutation checks | [testing.md](testing.md) |
| `packages/loadgen`, `apps/api/k6`, `infra/k8s`, a ramp — frozen | [docs/scaling-baseline.md](../scaling-baseline.md#gotchas-from-running-the-ramp) |

An entry earns its place by having cost somebody a session. One that a test now enforces, with the
reason in the test, belongs in the test instead.
