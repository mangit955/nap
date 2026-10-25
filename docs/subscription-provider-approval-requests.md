# Subscription provider approval requests

These are unsent drafts for the owner's review. On 2026-10-24, the owner chose integrated Nap
chat and provider approval before production login drivers. Neither provider approval is
confirmed. A terminal-only release is not the selected product.

## Applicant details confirmed on 2026-10-25

| Field | Value |
| --- | --- |
| Applicant first and last name | Confirmed, included in the local review copy |
| Work email | Confirmed, included in the local review copy |
| Company or individual applicant name | NAP, independent open-source project, applying as an individual |
| Website | https://nap-tawny.vercel.app |
| Public repository | https://github.com/mangit955/nap |
| Job title | Optional, leave blank |

Do not invent a legal entity, privacy-policy URL, user count, or commercial terms. No provider
form has been submitted and no provider has been contacted for these requests. The owner
requested review before submission. Filled contact details remain outside the public repository.

## Anthropic request

The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) requires prior
approval for third-party subscription integration. The linked
[contact-sales route](https://claude.com/contact-sales) currently offers a buying agent that can
escalate requests. It does not identify a dedicated SDK subscription approval form. Ask for
routing to the team that can grant this specific approval. Buying API credits or seats would
not establish that permission.

Subject: Permitted Claude Pro/Max integration for NAP, an open-source cloud coding agent

> I maintain NAP, an independent open-source cloud coding agent, and am applying as an
> individual. Users describe an application in chat, and an agent edits their project in an
> E2B cloud sandbox. NAP streams progress, shows a live preview, runs verification, and manages
> repair turns and project commits.
>
> We want users to use their existing Claude Pro or Max subscriptions in NAP, subject to
> their plan's eligibility and limits, instead of requiring separate API billing. We are
> seeking guidance and any required approval before enabling this in our hosted product.
>
> Which authentication and integration approaches do you officially permit for this use case?
>
> 1. May NAP preinstall and run the unmodified Claude Code CLI inside user-specific E2B
>    sandboxes, preserving its built-in authentication methods, with each user signing in to
>    their own account? We would not pay for or resell Claude usage on a user's behalf.
> 2. Under that approach, may NAP's chat send prompts to the CLI, display streamed output,
>    and manage conversation continuation, cancellation, and workspace tools? Does this
>    require separate approval from offering a direct CLI terminal?
> 3. If the Claude Agent SDK is the appropriate route, can we obtain approval for third-party
>    Pro/Max subscription login and plan use? What is the application process?
> 4. What browser or code-entry flow, credential storage, refresh, and logout behavior do you
>    support for remote sandboxes? Our planned isolation keeps long-lived credentials away
>    from arbitrary project code and public chat events.
> 5. Which plans are eligible, and what commercial terms, security review, branding rules, or
>    other conditions must NAP satisfy before a pilot?
>
> Production subscription login remains disabled. We have not authenticated a subscription or
> made subscription-backed model requests for this prototype. Its current checks use scripted
> protocol fixtures, with separate limited E2B process-containment probes.
>
> Our prototype keeps subscription execution separate from API-key execution, with no automatic
> fallback to API billing. Native runtime isolation, credential lifecycle, and recovery remain
> release work. We would appreciate written guidance on the permitted route and referral to
> the team responsible for any required approval.
>
> Website: https://nap-tawny.vercel.app
>
> Repository: https://github.com/mangit955/nap

The questions distinguish the [unmodified CLI hosting conditions](https://code.claude.com/docs/en/legal-and-compliance)
from SDK subscription approval. They ask whether those conditions cover NAP's integrated chat
rather than assuming that either route is approved. These source pages were checked on 2026-10-25.

## OpenAI request

The [ChatGPT plan-use documentation](https://developers.openai.com/siwc/token-sharing-open-source)
directs paid or remotely hosted applications to the partner route. Use the official
[Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).
Select **Sign in and ChatGPT plan use for AI requests**. The form also requires the applicant's
work email, first and last name, company name, and website URL. Job title is optional.

Product-description field:

> NAP is an independent open-source cloud coding agent, maintained by an individual. Users
> describe an application in chat, and a coding agent edits their project in an E2B cloud
> sandbox. NAP streams progress, shows a live preview, runs verification and repair turns,
> and manages project commits.
>
> We request partner access to Sign in with ChatGPT and eligible ChatGPT plan use for AI
> requests inside NAP's integrated chat. Users should be able to use their existing eligible
> ChatGPT plans for Codex work instead of requiring separate API billing. We intend to
> integrate Codex native execution through the supported hosted partner authentication and
> token-handoff route. Please confirm whether
> this also permits our proposed Codex app-server integration, and which client registration,
> scopes, refresh, and account-revocation requirements apply.
>
> We understand that the open-source local authentication flow and built-in Codex app-server
> authentication do not authorize this hosted service. We have not enabled a hosted CLI-login
> or device-code fallback. Production subscription login remains disabled pending approval.
>
> The prototype binds turns to an owned provider account and model, separates subscription
> execution from API billing, and never automatically falls back to a paid API model. Our
> proposed deployment isolates native credentials from arbitrary project code. Hosted native
> credential storage, recovery, and provider-specific acceptance checks remain release work.
>
> Repository: https://github.com/mangit955/nap
>
> Website: https://nap-tawny.vercel.app

## Record the response before enabling a driver

Keep the written response and the approved product, deployment, authentication method, and
conditions together in the private operating record. Record only a non-secret reference in
the implementation tracker. Approval for one provider or one deployment does not open the
other provider's gate. Verify any remaining conditions before a live pilot.

Implementation status and offline verification commands live in
[Native subscription execution](native-subscription-runtime.md).
