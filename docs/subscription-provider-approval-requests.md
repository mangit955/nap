# Subscription provider approval requests

These are unsent drafts for the owner's review. On 2026-10-24, the owner chose integrated Nap
chat and provider approval before production login drivers. Neither provider approval is
confirmed. A terminal-only release is not the selected product.

## Applicant details awaiting confirmation

| Field | Value |
| --- | --- |
| Applicant first and last name | Awaiting owner |
| Work email | Awaiting owner |
| Company or individual applicant name | Awaiting owner |
| Website | `https://nap-tawny.vercel.app`, awaiting confirmation |
| Public repository | https://github.com/mangit955/nap |
| Job title | Optional, awaiting owner |

Do not invent a legal entity, privacy-policy URL, user count, or commercial terms. No provider
form has been submitted and no provider has been contacted for these requests.

## Anthropic request

The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) requires prior
approval for third-party subscription integration. The linked
[contact-sales route](https://claude.com/contact-sales) currently offers a buying agent that can
escalate requests. It does not identify a dedicated SDK subscription approval form. Ask for
routing to the team that can grant this specific approval. Buying API credits or seats would
not establish that permission.

Subject: Request for Claude Agent SDK subscription integration approval for Nap

> I develop Nap, a remotely hosted app builder. Users describe an application in chat, and an
> agent edits their project in an E2B workspace. Nap streams progress, shows a live preview,
> runs verification, and manages repair turns and project commits.
>
> We request approval for users to authenticate their own eligible Claude subscriptions and
> use those subscriptions through the Claude Agent SDK inside Nap's integrated chat. This is
> a third-party hosted product. We are not treating local Claude Code authentication or the
> stock CLI hosting conditions as approval for this SDK integration.
>
> Our offline prototype keeps subscription execution separate from API-key execution. A turn
> selects an owned provider account and model explicitly, with no automatic fallback to API
> billing. The proposed deployment separates the native authenticated agent from arbitrary
> project code and gives it access to Nap's workspace tools through a scoped channel. Private
> credential state would remain outside project files and public chat events. Revocation,
> process containment, and durable recovery are release requirements still being completed.
>
> Production subscription login remains disabled. We have not authenticated a subscription or
> made subscription-backed model requests for this prototype. Its current checks use scripted
> protocol fixtures, with separate limited E2B process-containment probes.
>
> Could you route this request to the team responsible for third-party Agent SDK subscription
> approvals? We would like written confirmation of whether this hosted integration is eligible,
> the supported authentication and credential-storage approach, and any required security,
> commercial, or branding review before a pilot.
>
> Repository: https://github.com/mangit955/nap
>
> Website and applicant contact: to be confirmed before sending.

## OpenAI request

The [ChatGPT plan-use documentation](https://developers.openai.com/siwc/token-sharing-open-source)
directs paid or remotely hosted applications to the partner route. Use the official
[Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).
Select **Sign in and ChatGPT plan use for AI requests**. The form also requires the applicant's
work email, first and last name, company name, and website URL. Job title is optional.

Product-description field:

> Nap is a remotely hosted app builder. Users describe an application in chat, and a coding
> agent edits their project in an isolated E2B workspace. Nap streams progress, shows a live
> preview, runs verification and repair turns, and manages project commits.
>
> We request partner access to Sign in with ChatGPT and eligible ChatGPT plan use for AI
> requests inside Nap's integrated chat. We intend to integrate Codex native execution through
> the supported hosted partner authentication and token-handoff route. Please confirm whether
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

## Record the response before enabling a driver

Keep the written response and the approved product, deployment, authentication method, and
conditions together in the private operating record. Record only a non-secret reference in
the implementation tracker. Approval for one provider or one deployment does not open the
other provider's gate. Verify any remaining conditions before a live pilot.

Implementation status and offline verification commands live in
[Native subscription execution](native-subscription-runtime.md).
