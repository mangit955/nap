# The key step after sign-up

`/welcome` is the screen a new account lands on after email sign-up, drawn in the sign-up page's
dark, serif style without its photograph: one column centred on a dark screen, the nap mark top
left. It holds the heading "Bring your own API key.", a line on free tiers, the key form, and
"Continue to dashboard" under it.

## Sub-features

- Saving a key: the form checks it with the API, then sends the person to `/dashboard`.
- A refused key: the API's sentence appears under the field and the page stays put.
- Skipping: "Continue to dashboard" goes to `/dashboard` and is remembered in this browser.
- Shown once: an account with a saved key, or a browser that skipped, is sent straight on to
  `/dashboard`.

## How to get to it (user POV)

- Email sign-up on `/sign-up` ("Create account").
- A social sign-in returns to `/welcome` too. The fixture has no OAuth apps, so it cannot be driven.
- Not from the guest door: "try it without an account" goes straight to `/dashboard`.

## Driving it with verify-nap

Preconditions: signed **out**, on a fixture you will throw away. Signing up signs the driver's
browser in as the new account, and the driver has no sign-out command. Run this after the other
recipes, or start a new fixture.

```bash
goto /sign-up
fill  --role textbox --name Name --value "Ada Lovelace"
fill  --role textbox --name Email --value "ada-<unique>@nap.test"
fill  --role textbox --name Password --value "a-long-test-password-123"
click --role button --name "Create account"
wait  --role textbox --name "API key"          # url: /welcome
shot  --label "welcome: empty"

# A refused key. The fixture accepts exactly one key; any other gets this sentence.
fill  --role textbox --name "API key" --value "sk-or-v1-not-the-fixture-key"
click --role button --name "Save key"
wait  --text "Real API keys are disabled in the verify-nap fixture."
shot  --label "welcome: save error"

# The key the fixture accepts.
fill  --role textbox --name "API key" --value "sk-or-v1-verify-nap-fixture-key-FAKE"
click --role button --name "Save key"
wait  --role textbox --name "Describe the app you want"  # /dashboard; the model reads Sol
goto  /welcome                                 # sent straight back to /dashboard
```

The skip path needs a second new account, so a second fixture (or the first one before saving):
after `Create account`, `click --role button --name "Continue to dashboard"`, then
`wait --role textbox --name "Describe the app you want"`. The composer's model reads `Scripted`,
since no key was saved, and `goto /welcome` sends this browser straight back to `/dashboard`.

## Gotchas

- **The page is only reachable once per account and browser.** A saved key or a skip sends every
  later visit to `/dashboard`, so capture every state you need before saving or skipping.
- Wait for the dashboard's composer ("Describe the app you want"), not "New session": at 390 wide
  the sidebar holding "New session" is hidden, so that wait fails on a save that worked.
- Sign-up used to skip this page in the fixture: the sign-in page's "already signed in" redirect
  caught the new session after sign-up had already set off for `/welcome`. If `Create account`
  lands on `/dashboard` again, that race is back (`auth/live-sign-in.test.tsx`).
