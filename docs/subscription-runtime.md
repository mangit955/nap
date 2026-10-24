# Subscription execution status

The implementation is tracked in [the subscription runtime map](https://github.com/mangit955/nap/issues/165).
Production still uses the API agent. A subscription account listed in settings does not establish
that a native runtime, authenticated subscription, or model entitlement is available.

## Account authorization

`provider_accounts` contains public identity metadata. `provider_credentials` contains only sealed
credential bytes and revisions. The application must encrypt and verify identity before calling
`completeSignIn`; the database never accepts plaintext provider tokens through an HTTP route.
Public account reads do not join credentials.

A successful login advances both generation and version. Logout, delete and disabling an account
invalidate earlier authorization. Logout advances generation even when a login is still pending.
Refresh compares both revisions and advances version, so concurrent workers cannot overwrite each
other's credential writes. Parent-account row locks cover the first credential write as well as
updates. Re-enabling an account does not restore its login.

Managed token exchange now uses a separate durable claim. Exactly one worker receives the sealed
refresh grant; other readers see a credential-free `refreshing` result. The claim is bound to the
current generation and version and stores a hash of its private completion capability. Only that
owner may commit a replacement. A direct credential CAS cannot bypass a running managed refresh.
Login, logout, disable and deletion fence its late result.

A managed claim expires after thirty seconds and is never taken over. An expired claim or ambiguous
provider response advances the generation, clears the unusable grant, marks the account expired,
and requires user-driven reconnection. This deliberately does not promise recovery of a refresh
token lost between provider rotation and database commit. The coordinator bounds provider calls
below the claim lifetime, checks ciphertext scope before contacting the provider, and does not
return plaintext tokens. Provider-specific adapters still own token validation and must be approved
before configuration. No production managed refresh adapter is configured.

This claim is not a protocol for native CLI refresh. Native clients may mutate credentials in the
background and must be serialized and terminated with proof before replacement or checkpoint.
A database lease cannot prevent an old client from contacting the provider.

## Durable sign-in attempts

The private sign-in store binds each attempt to a provider account and a live, permanent Nap
session. Other sessions of the same user cannot read its interaction or claim its callback.
Starting another attempt supersedes the earlier one; the database allows only one active attempt
per account. Expiry uses the database clock. A claim moves waiting to verifying once, and returns
a private completion token whose hash is stored. Verification cannot return to waiting after a
worker crash. A lost exchange response therefore needs reconciliation or a new user-driven attempt.

A verified completion requires that token, the initiating session, an unchanged account generation
and an unexpired attempt. Authorization, public identity and successful completion commit in one
transaction. Logout and disable invalidate pending attempts in that same account transaction.
Terminal transitions erase private state, callback hashes and interactions. Deleting the Nap
session or provider account cascades the attempt. Session expiry denies access; materializing an
expired attempt clears its state, but a background retention sweep is not implemented yet.

`ProviderSecretBox` authenticates scope inside the encrypted envelope before returning a value.
Pending state is bound to owner, account, Nap session and challenge hash; a grant is bound to owner,
account, driver and authorization generation. Copying ciphertext to another scope fails. This
uses the existing AES-GCM utility but does not rely on opaque encryption alone for ownership.
The DB receives sealed envelopes only and never holds the encryption key.

HTTP authentication supplies the verified cookie-session ID to the sign-in runner; request
headers and bodies cannot select that ID. Interactions are scoped to that session. The browser
coordinator now connects the durable store and scoped sealer: it creates a private challenge,
persists pending state, consumes the callback claim once, bounds provider requests, then seals
and commits the verified grant atomically. Provider exceptions produce fixed public messages.
A lost exchange response is terminal and cannot trigger another automatic exchange.

`POST /providers/accounts/:accountId/sign-in/complete` accepts a browser handoff only from the
trusted web Origin and initiating Nap session. Its body contains the flow ID and callback URL,
never an account label or claimed identity. The configured provider adapter must validate its exact
registered redirect URI and protocol-specific PKCE, nonce, issuer, audience and scope requirements.
The settings page offers callback handoff only while its browser flow is waiting, clears the
input on submission or flow replacement, and sends it in the POST body, not a Nap navigation URL.

Availability is now `signInDrivers`, a list of configured providers, rather than one global
boolean. Both the API and settings page check the selected driver. The API and web must deploy
together for this response-contract change. Production still configures no driver and keeps
`UNAVAILABLE_SIGN_IN`. The browser coordinator is exercised with a local provider fixture; it is
not an implemented OpenAI OAuth client or a Claude terminal-login driver. Database cancellation
also does not prove a native process stopped; its supervisor and credential owner must coordinate
that before reuse.

## Execution targets

Every queued request contains one validated target:

- `api` pins the model and whether the caller's API key pays.
- `subscription` pins the provider driver, account ID, model and authentication generation.

The subscription variant contains no billing fallback and no credential. Queue reads parse the
persisted target, and the worker refuses subscription execution until its native integration is
installed. Runtime turn and continuation settings preserve the target through verifier repairs;
the API agent separately refuses subscription targets before constructing an API client.
Unsupported explicit targets at current HTTP admission boundaries are rejected rather
than silently stripped into an API request.

Migration `0015_execution_targets` backfills existing requests with their original API model and
payer before replacing the two columns. It changes the worker contract, so deployment must drain
old API and worker processes before applying it and starting the new version. No production
migration has been run. Existing API keys retain their existing storage and execution path.

## Remaining release gates

[The process transport proof](native-process-host.md) has local pipe and PTY coverage. A second,
separately approved [E2B probe](e2b-native-process-probe-20261024.md) passed privilege checks,
confirmed cgroup termination and detached-child cancellation, then destroyed its sandbox.
Live PTY, reconnect and worker-loss expiry remain unverified. Provider-specific login adapters,
native refresh fencing, account checks during execution, native Claude/Codex adapters,
recovery archives and UI selection are still required. No provider has been enabled.

Project code running under the same UID as a native agent can inspect that agent's credential
home, environment and accessible helper interfaces. Putting credentials outside git is not an
isolation boundary. Production requires a supported credential broker that passes adversarial
checks, or an isolated authenticated runtime with enforceable remote tool routing. If neither
works for a provider, hosted subscription execution stays unavailable.

OpenAI's [token-sharing guidance](https://developers.openai.com/siwc/token-sharing-open-source)
requires the supported partner route for hosted or paid products. Built-in app-server login is
not a hosted fallback. Anthropic's [hosting terms](https://code.claude.com/docs/en/legal-and-compliance)
and [SDK subscription restriction](https://code.claude.com/docs/en/agent-sdk/overview) require a
provider-specific release decision. The [headless CLI documentation](https://code.claude.com/docs/en/headless)
now describes `claude -p` as SDK use and says bare mode skips subscription credentials. Merely
launching the stock binary does not settle whether a particular hosted integration is approved.
Two separately approved E2B allocations ran and were destroyed. No authentication, subscription
model call or template publication has run here.
