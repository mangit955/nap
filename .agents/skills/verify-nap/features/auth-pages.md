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
- Any request that comes back 401 redirects to `/sign-in?expired=1`.

## Driving it with verify-nap

Preconditions: signed **out**. A fresh fixture starts signed out, so run these before `signin`.
Signed in, both routes redirect to `/dashboard`.

```bash
goto /sign-up
click --role button --name "Sign in"        # the mode switch, top right at the driver's 1440 width
wait  --role heading --name "Welcome back."
url                                          # /sign-in
click --role button --name "Create one"
wait  --role heading --name "Start a nap."
shot  --label "auth: sign-up"
fill  --role textbox --name Name --value "Ada Lovelace"
fill  --role textbox --name Email --value "ada-<unique>@nap.test"
fill  --role textbox --name Password --value "a-long-test-password-123"
click --role button --name "Create account"  # lands on /dashboard in the fixture
```

A refused sign-in: on `/sign-in`, fill `Email` with `verify@nap.test` and `Password` with anything
wrong, click `Sign in`, then `wait --text "Invalid email or password"`. The notice:
`goto "/sign-in?expired=1"` and `wait --text "Your session expired"`.

## Gotchas

- **Click the mode switch at desktop width, don't just find it.** The logo link once stretched
  across the header and covered it. The switch was still in the ARIA tree and component tests
  still passed, but every click went to the logo. Only a real click caught it.
- The fields have no visible labels. The textboxes are named by visually hidden labels, so
  `--name Email` works.
- The driver's window is 1440 wide. To check the phone layout, connect to the fixture's Chrome
  over CDP with a 390-wide viewport.
