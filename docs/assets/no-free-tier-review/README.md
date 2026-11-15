# API-key copy review

The before images render the real `ApiKeyPanel` and `ApiKeyForm` components at
`31c2d0f771dbf769cdcae55eaa083dd42e751949`, with the application Tailwind styles.
A local fixture supplies empty or configured key state and mocked callbacks, with no live
account, saved credential or production API. One headless Chrome captured each state.
These images cover the key dialog and removal copy, not a full onboarding session.

- [Before, no key](before-empty.png)
- [Before, configured key](before-configured.png)

The after images render the same fixture at the repaired candidate, snapshot
`55a8262156018ae946363d03cf9b5a053d18ec5b` (tree `994256cc220408936cdb63cc3e7184bd72fb170f`).
Later copy edits touched the providers page and source comments, not `ApiKeyPanel` or
`ApiKeyForm`, so these images show the panel's final copy.

- [After, no key](after-empty.png)
- [After, configured key](after-configured.png)
