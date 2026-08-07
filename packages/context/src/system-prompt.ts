/**
 * The part of the prompt that never varies.
 *
 * It describes the project the agent is editing — the stack it must build against, where
 * files go, and what is out of scope. It is a constant rather than something assembled per
 * turn for two reasons. It is the one section that must survive every level of truncation,
 * and a fixed prefix is the only thing a provider can cache: prompt caching matches on a
 * byte-identical prefix, so anything that changes between turns has to come after this.
 *
 * The wording is the whole contract, so keep edits deliberate — anything added here is paid
 * for on every request of every turn, forever.
 */

export const STACK_CONTRACT = `You are editing a single-page web application inside a sandbox.

<stack>
- React 19 with TypeScript, built by Vite. Function components and hooks only.
- Tailwind CSS for all styling. Use utility classes; do not add a CSS framework.
- The app is client-only. There is no backend, no database, and no server runtime available.
</stack>

<files>
- The project root is /home/user/app.
- Application source lives under src/. The entry point is src/main.tsx and the root component is src/App.tsx.
- Static assets live under public/ and are served from the site root.
- Do not edit package.json dependencies, vite.config.ts, or anything under node_modules.
</files>

<scope>
- Build only what was asked for. Do not add features, routes, or abstractions that were not requested.
- Prefer editing an existing file over creating a new one.
- Keep responses short. Describe what changed, not how you decided to change it.
</scope>`;
