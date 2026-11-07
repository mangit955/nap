# Native Safari acceptance

Observed on 2026-11-07 using the installed Safari 27.0.1 through native accessibility controls. No privacy settings or browser protections were changed.

Production was independently confirmed on release `37113cf146db83f9b870858553d351b2beb2b3da`, not the current PR candidate. This is deployment-topology acceptance evidence; candidate code is additionally covered by the regression suites.

1. Opened `https://nap-tawny.vercel.app/sign-in` in a new Safari tab.
2. Clicked **Try for free**. The UI navigated to `/dashboard`, with the session composer and authenticated account menu visible.
3. Reloaded the page. It remained on `/dashboard` and rendered the session list and composer. This establishes that the anonymous session survived navigation and reload in real Safari.
4. Opened Settings. It identified the session as Guest. Signed that disposable guest session out, without creating a project, sandbox or model turn.
5. Clicked **Continue with GitHub**. GitHub displayed its sign-in form for the existing Nap OAuth app. The authorization request's redirect URI was `https://nap-tawny.vercel.app/backend/api/auth/callback/github`.

The provider round trip could not be completed without GitHub authentication. Safari's existing stored credential required Touch ID. A login page with the expected redirect URI does not prove the configured provider callback or its state-cookie round trip succeeds. Email sign-in, Brave, repository connection and a live event stream were not exercised in this native session.

Earlier Safari WebDriver and native-access attempts failed before this successful native retry; those failures are not evidence that the application failed. The run ledger retains the distinction. No screenshots containing the browser's saved account identity are published.
