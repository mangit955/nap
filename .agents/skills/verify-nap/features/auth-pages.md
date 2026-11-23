# Sign in and sign up

`/sign-in` and `/sign-up` are one form in two modes, drawn in the landing page's dark, serif style.
On a wide screen the form sits beside a photograph, with the nap mark top left and the mode switch
("Have an account? Sign in" or "No account yet? Create one") top right. On a phone the photograph
is a strip above the form and the switch sits under it.

## Sub-features

- Switching mode in place: the heading, the fields and the address bar change, and typed text stays.
- Email sign-up and sign-in.
- Google and GitHub buttons, shown only when `/auth/providers` lists them. The fixture has no
  OAuth apps, so it offers neither.
- The guest door, "or try it without an account", when the deployment allows guests.
- The expired-session notice (`/sign-in?expired=1`) and the error a refused sign-in shows.

## How to get to it (user POV)

- "Get started" or "Sign in" on the front page.
- An API request that comes back 401 on any other page redirects to `/sign-in?expired=1`. On
  `/sign-in` itself a 401 is a refused sign-in: it shows the error and stays put.

## Driving it with verify-nap

Preconditions: signed **out**. A fresh fixture starts signed out, so run these before `signin`.
Signed in, both routes redirect to `/dashboard`, and the driver has no sign-out command.

```bash
goto /sign-up
click --role button --name "Sign in"        # the mode switch, top right at the driver's 1440 width
wait  --role heading --name "Welcome back."
url                                          # /sign-in
click --role button --name "Create one"
wait  --role heading --name "Start a nap."
shot  --label "auth: sign-up"

# A refused sign-in, then the expired-session notice. Neither signs anybody in.
goto /sign-in
fill  --role textbox --name Email --value "verify@nap.test"
fill  --role textbox --name Password --value "not-the-password"
click --role button --name "Sign in"
wait  --text "Invalid email or password"
goto "/sign-in?expired=1"
wait  --text "Your session expired"
```

**Run sign-up last, or on a fixture you will throw away.** It signs the driver's browser in as
the new account. After that, every `/sign-in` visit redirects, and `signin` reports "already
signed in" and keeps the new account, so no later recipe sees **Seeded notes app**.

```bash
goto /sign-up
fill  --role textbox --name Name --value "Ada Lovelace"
fill  --role textbox --name Email --value "ada-<unique>@nap.test"
fill  --role textbox --name Password --value "a-long-test-password-123"
click --role button --name "Create account"  # to /welcome, the key step; see welcome.md
```

## Gotchas

- **Click the mode switch at desktop width, don't just find it.** The logo link once stretched
  across the header and covered it. The switch was still in the ARIA tree and component tests
  still passed, but every click went to the logo. Only a real click caught it.
- The form's controls stay hidden until `/auth/providers` answers (or 4 s pass), because the
  answer moves them. The driver waits for a control to be visible before acting, so no extra
  `wait` is needed. Only the heading shows straight away.
- The fields have no visible labels. The textboxes are named by visually hidden labels, so
  `--name Email` works.
- The driver's window is 1440 wide. To check the phone layout, connect to the fixture's Chrome
  over CDP with a 390-wide viewport.
