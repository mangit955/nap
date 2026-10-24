# Devin's browser and computer use: primary-source research

Researched 2026-10-24. Scope: public first-party documentation, Cognition engineering posts, and Cognition's own example code. No application code changed. This is a research note, not a claim that Devin's private implementation has been inspected or reproduced.

## What the public evidence establishes

Devin Cloud operates an application it can run and inspect, rather than relying only on code edits and completion messages. Its introductory documentation describes browsing documentation, testing web applications, and uploading or downloading information. These are product descriptions, not measurements of success rates. The same page explicitly says behavior can differ from the documentation. [Introducing Devin](https://docs.devin.ai/get-started/devin-intro)

There are separate mechanisms worth keeping distinct: an interactive browser, desktop computer use, scripted browser automation, and a testing workflow that produces reviewable artifacts. The following sections separate documented behavior from implementation details the sources do not establish.

## Browser control and full desktop control

Current documentation describes a full desktop on Linux, Windows, and macOS, including desktop apps and terminal UIs. It gives a 1024×768 display size. Its loop is screenshot, identify a target, act, wait, screenshot again, and repeat. Actions include clicking, typing, scrolling, dragging, and keyboard shortcuts. It names a `computer` tool in the Outposts discussion. Computer Use can be selected autonomously when appropriate. [Computer Use](https://docs.devin.ai/work-with-devin/computer-use)

The same page documents a second route: Playwright can connect to the already-running Chrome through CDP at `http://localhost:29229`, including when Desktop mode is disabled. Scripts can fill forms, follow redirects, and change browser state. Cookies, localStorage, and authentication tokens remain available after the script exits because it attaches to the existing browser. Credentials can come from secret environment variables, with reusable scripts in `.agents/skills/`. The browser can then continue through either browser tools or Computer Use. [Computer Use, scripted browser use](https://docs.devin.ai/work-with-devin/computer-use#scripted-browser-use-via-playwright)

This supports a shared authenticated Chrome instance accessible through multiple interaction methods. It does not establish that every browser action is Playwright-based, or that desktop control is merely a wrapper around DOM selectors.

Cognition's February 24, 2026 release announcement dates the expansion to full Linux desktop testing. It says browser-based testing and recording already existed. New-user desktop support was enabled by default at that release, while existing users could enable it in Settings. Treat these as historical rollout facts. [Introducing Devin 2.2](https://cognition.com/blog/introducing-devin-2-2)

The February 2025 update separately documents support for auto-opening tabs, multiple tabs, and optimistic batches mixing browser views, shell commands, and file reads. This establishes historical capability, not today's exact tab or scheduling API. [February 2025 product update](https://cognition.com/blog/devin-february-25-product-update)

## What is public about the agent loop and tool descriptions

Cognition described Devin in September 2024 as a compound system using multiple model inferences to plan, act, evaluate, and use tools. That account also describes evaluator agents using browsing, shell, and editing tools, while preferring deterministic checks where available. This is evidence about their approach at that time, not proof of the present production model graph. [Evaluating coding agents](https://cognition.com/blog/evaluating-coding-agents)

The Outposts documentation provides a concrete execution split: inference and planning stay in Devin's cloud; commands, file edits, and repository access run on the customer's machines. Outposts workers serve sessions through an outbound connection. This supports separating the reasoning service from the execution machine, without revealing the internal planning implementation. [Outposts overview](https://docs.devin.ai/cloud/outposts/overview)

Public sources disclose some names and operations, but not a complete current browser/computer tool schema:

- `computer` is named in the Computer Use documentation cited above.
- `save_browser_profile` is explicitly named in the authentication documentation below.
- The first-party QA example contains historical prompt syntax such as `<view_browser>` and `navigate_browser`. Its README is an example test instruction, not the authoritative schema for current Devin tools. [QA-Devin README](https://github.com/CognitionAI/qa-devin/blob/86b769b0dcf14b18e4685b3e3248d29bc289fc51/README.md)

The public Devin MCP server documents session creation, interaction, event inspection, gathering results, and management of knowledge, playbooks, and schedules. Its published catalog is not a direct click/type/screenshot browser-control API. Do not confuse an external client delegating a session with the private tools that session uses. [Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp)

Unknown from these sources: the full JSON schemas, current browser DOM or accessibility representation, element-ID strategy, coordinate conversion, observation caching, action batching rules, retry policy, exact action-to-model-message format, and complete production model routing. Leaked prompt repositories were excluded as authority.

## Machine lifetime and browser persistence

For managed environments, every session boots a fresh copy of a prebuilt snapshot containing repositories, tools, and dependencies. Session changes do not update the baseline snapshot. Configuration changes build a new snapshot; the current environment page describes one active snapshot per configured platform. [Environment setup](https://docs.devin.ai/onboard-devin/environment)

Blueprints define setup and knowledge. `initialize` runs during builds, and its results enter the snapshot. `maintenance` runs during builds and is supplied as context at session start rather than automatically executed then. `knowledge` supplies reference commands. The blueprint guide says changes are discarded when the session ends. Persisting work therefore requires an explicit durable destination; a session filesystem should not be described as an indefinitely shared machine. [Environment blueprints](https://docs.devin.ai/onboard-devin/environment/blueprints)

Within a session, manual browser interactions retain cookies and session data. Across sessions, a separate profile-saving operation is required, described next. These are different persistence guarantees. [Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)

The sources reviewed do not establish the exact retention or restoration guarantees for RAM, running processes, Chrome tabs, or uncommitted files after sleeping, VM reclamation, or long inactivity. The public MCP catalog exposes sleep as a session action, but that is not a machine-state durability specification. Do not fill that gap with claims about an always-running VM.

Outposts differ from managed snapshot environments. Their worker reference says repositories already present under the worker's `repos` directory are reused. Lifecycle behavior on customer-managed infrastructure should therefore be described separately. [Outposts reference](https://docs.devin.ai/cloud/outposts/reference)

## Human takeover and authentication

Users can view and operate the same browser or desktop through the session UI. The Session Tools page calls the tab Browser or Computer depending on settings, while the newer authentication page calls it Desktop. The docs identify MFA, CAPTCHAs, OAuth, complex navigation, and local testing as reasons to intervene. They advise pausing Devin before taking over the IDE to avoid competing edits and telling it about changes before resuming. Shell commands, code edits, and browser activity appear together in the Progress view. [Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)

For durable authentication, a user manually completes login, including SSO, MFA, or CAPTCHA, and asks Devin to save the browser profile. The documented `save_browser_profile` tool archives Chrome profile data, including cookies and localStorage, and proposes an organization blueprint update. The user approves the update once. New organization sessions restore it. Refreshing expired authentication replaces the existing restore step. The tool requires Manage Org Blueprints permission. Saved profiles are organization-wide, not repository-specific; the docs recommend accounts the whole organization may use. This is an explicit credential-sharing scope. [Browser authentication](https://docs.devin.ai/work-with-devin/browser-auth)

There is also a Secrets mechanism for credentials, site cookies, and TOTP. The docs explain exporting cookies into Devin and configuring TOTP from the service's setup information. These are alternatives to requiring a person to log in during every run, with scope and access decisions that Nap would need to make for itself. [Secrets and site cookies](https://docs.devin.ai/product-guides/secrets)

Cloud computer use does not imply control of the user's personal desktop. Local Hands retains the cloud VM and adds approved local command/file tools. Its docs explicitly say it has no local screen, keyboard, or mouse control. That distinction also prevents confusing the Devin Desktop application with the cloud session's desktop. [Local Hands](https://docs.devin.ai/work-with-devin/local-hands)

## Testing, recordings, and known failure modes

The documented testing workflow can follow PR creation through Test the app, run automatically with Pre-approve testing, or start on request. It prepares services and access, reads the diff and source, writes a focused test plan, then executes and records. Relevant `.agents/skills/` instructions guide setup. The plan targets a primary end-to-end flow and adds only critical edge cases. The guide places execution after green CI and addressed review comments. [Testing and video recordings](https://docs.devin.ai/work-with-devin/testing-and-recordings)

Recordings have annotations, automatic zoom, idle-time compression, and message attachments in the web app or Slack. The guide describes these as focused sanity checks and directs exhaustive coverage to test suites and CI. A video shows what was exercised; it does not establish coverage beyond that flow. [Testing and video recordings](https://docs.devin.ai/work-with-devin/testing-and-recordings)

Cognition's May 29, 2026 engineering account explains why this structure exists. Earlier test runs drifted into unrelated behavior, stalled in setup, or missed the PR's core change. Grounding plans in source helped. Repeated login work moved into deterministic skill scripts to reduce time, token cost, and flakiness. Assertions are annotated before actions to reduce rationalizing unexpected results as passes. The team was experimenting with different models for testing. [Verifying agentic development at scale](https://cognition.com/blog/testing-development)

That account describes labeled screenshot reports and a video player with chapters and chronological assertions. It also names two unresolved problems: screenshots can miss transient toasts, and models sometimes execute JavaScript to reach states instead of using the UI. These are concrete limits on what a passing visual test establishes. They also mean the recording path may include programmatic actions. [Verifying agentic development at scale](https://cognition.com/blog/testing-development)

The first-party [QA-Devin example](https://github.com/CognitionAI/qa-devin/tree/86b769b0dcf14b18e4685b3e3248d29bc289fc51) supplies executable integration evidence: prompts direct browser QA of Devin, Slack integration, secrets, and PR sleep/wake behavior. The repository's inspected HEAD was dated December 16, 2024, so it is historical evidence. Its [runner](https://github.com/CognitionAI/qa-devin/blob/86b769b0dcf14b18e4685b3e3248d29bc289fc51/run_qa_devin.py) starts sessions and reads `structured_output.success`; that is an agent-reported result, not an independent browser assertion engine. The repository is not Devin's browser implementation.

## Implications for Nap

These are design inferences, not descriptions of Devin internals or a completed audit of Nap's source. Nap's [glossary](../../CONTEXT.md) currently limits production verification to sandbox commands and a preview probe. [ADR-0001](../adr/0001-napbench-splits-into-a-pure-package-and-an-app.md) assigns Playwright to NapBench. Giving the production agent browser tools would change that boundary and needs an explicit design decision.

1. Give the agent observations from the app it just built. A preview shown only to a human cannot drive the agent's next action. A first useful increment for Nap is a sandbox-associated browser with navigation, screenshot, click, typing, and bounded waits. Full OS desktop support is a separate requirement.
2. Keep deterministic setup separate from visual verification. Use reusable scripts for login and service startup. Exercise the behavior under review through visible UI interactions, and disclose any JavaScript state injection in the evidence.
3. Tie evidence to the exact work and environment. Record the commit, URL, viewport, test steps, expectations, screenshots, and whether each assertion passed, failed, or was untested. A completion message or edited video alone should not advance Nap's checkpoint.
4. Model machine, browser, and credential lifetime explicitly. Reusing a project snapshot, retaining session cookies, and copying a profile into future sessions are different operations. Nap must define project/user scope rather than copying Devin's organization-wide profile policy by default.
5. Support human takeover with one active controller. An authentication intervention needs a visible pause, ownership transfer, and explicit resume. Reconnection should not silently produce two writers.
6. Preserve the distinction between agent testing and independent evaluation. Production UI testing could improve the repair loop while NapBench remains an external evaluator. Share narrow command/result types where useful; do not let the system under test select its own benchmark pass result.

No live Devin session, private MCP tool catalog, internal source, or controlled benchmark was accessed for this note. The public sources establish capabilities and some implementation details, but not comparative reliability, latency, cost, or success rates against Nap.
