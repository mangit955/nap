/**
 * The shape of the system, and the rule that keeps the shape.
 *
 * The component table here is the same one `CLAUDE.md` holds for contributors, minus the columns
 * that only mean something with the code open. It is repeated rather than linked because a
 * reader who cannot see the boundaries cannot evaluate any of the sections after this one — every
 * later argument is about which component owns a decision.
 */

import { REPO_URL } from "../landing/github-button.tsx";
import { Code, Figure, Lede, P, Source, Sub, Term } from "./prose.tsx";

const PLANES = `Browser (Next.js)                       ← presentation
   │ HTTPS + WebSocket
API server (Hono on Bun)                ← gateway · sessions · streaming hub
   │
   └── Runtime  (turn orchestration)    ← intelligence
         ├── ContextEngine ──► MemoryProvider
         ├── AgentService  ──► LLMProvider
         ├── SandboxManager ────────────► E2B sandbox      ← execution
         ├── EventStore (Postgres)         /workspace (git repo)
         ├── Verifier (@nap/verify)        vite dev :5173 → preview URL
         └── EventBus (in-process)`;

const DIRECTION = `runtime ──► context · agent · sandbox · storage · capture · db · verify ──► shared

bench ──► verify · shared          (NapBench's pure half — tasks, scoring, reports)
apps/napbench ──► bench            (the shell: Playwright, real infrastructure)

the edge that must never exist:    runtime ──► bench`;

const OWNERSHIP = [
  {
    component: "Runtime",
    owns: "The turn lifecycle: acquire sandbox, build context, run agent, persist, publish, commit, verify, snapshot, photograph. Budgets, cancellation, recovery. Opening and closing the job a turn belongs to.",
    never: "Prompt content, model parameters, tool implementations. Deciding which checks exist.",
  },
  {
    component: "ContextEngine",
    owns: "Assembling context, and owning the token budget and the order things are truncated in.",
    never: "Calling the model; deciding when a turn ends.",
  },
  {
    component: "AgentService",
    owns: "Driving the model loop for one turn, executing the proxy tools, emitting typed events.",
    never: "Persistence, git, sandbox lifecycle, prompt assembly.",
  },
  {
    component: "LLMProvider",
    owns: "Model policy — effort, thinking configuration, refusal and fallback, retries, usage accounting.",
    never: "Deciding which models a caller may reach. That is the route's.",
  },
  {
    component: "SandboxManager",
    owns: "Sandbox lifecycle, filesystem, exec, preview URL.",
    never: "Knowing what an agent or a turn is.",
  },
  {
    component: "EventStore / EventBus",
    owns: "Durable append, then fanout — in that order.",
    never: "Business logic.",
  },
] as const;

export function Architecture() {
  return (
    <>
      <Lede>
        A thin vertical slice through five planes, with one component owning each thing and the
        boundaries between them doing the real work.
      </Lede>

      <Figure label="The planes, and what sits in each.">{PLANES}</Figure>

      <Sub>Who owns what</Sub>

      <div className="mt-5 max-w-2xl overflow-x-auto">
        <table className="w-full border-collapse text-left text-[14px]">
          <thead>
            <tr className="border-[var(--s-border-1)] border-b">
              <th className="py-2 pr-4 font-medium text-[var(--s-text-primary)]">Component</th>
              <th className="py-2 pr-4 font-medium text-[var(--s-text-primary)]">Owns</th>
              <th className="py-2 font-medium text-[var(--s-text-primary)]">Never does</th>
            </tr>
          </thead>
          <tbody className="text-[var(--s-text-muted)]">
            {OWNERSHIP.map((row) => (
              <tr key={row.component} className="border-[var(--s-border-1)] border-b align-top">
                <td className="py-3 pr-4 font-medium text-[var(--s-text-body)] leading-[1.6]">
                  {row.component}
                </td>
                <td className="py-3 pr-4 leading-[1.6]">{row.owns}</td>
                <td className="py-3 leading-[1.6]">{row.never}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Sub>The dependency direction is enforced by a test, not by discipline</Sub>

      <Figure label="Which package may import which.">{DIRECTION}</Figure>

      <P>
        <Code>agent</Code> imports the <Term>SandboxManager</Term> interface and never the E2B
        adapter, which is what makes swapping E2B for something else a one-package change rather
        than an audit. <Code>verify</Code> sits below both the runtime and the benchmark: the
        runtime uses it to arbitrate a turn&rsquo;s claim, the benchmark uses it to build a score,
        and the edge that must never exist is the system under test importing the thing that grades
        it.
      </P>

      <P>
        None of that holds by vigilance. A test reads every package&rsquo;s manifest and then the
        specifiers its source actually imports — type-only ones included, because the runtime hoists
        workspace packages and an undeclared import would otherwise resolve, typecheck and ship.
        Adding a violating import turns the suite red; adding a new workspace package fails it until
        its rule is declared.{" "}
        <Source href={`${REPO_URL}/blob/main/test/architecture.ts`}>test/architecture.ts</Source>
      </P>
    </>
  );
}
