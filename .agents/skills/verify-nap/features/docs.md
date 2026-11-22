# Docs

`/docs` is the public documentation, drawn in the landing page's dark theme: a bar with a search
field and the landing page's links, a sidebar of every page in four groups, and the page. `/docs`
itself is the home, with the recorded session and a card per page. Each of the eight sections is a
page at `/docs/<id>`, with an "On this page" list on the right that marks the heading being read,
and previous and next links at the foot. Below 1024px the sidebar and links fold into a menu, and a
bar under the header holds the breadcrumb and an "On this page" button.

## Sub-features

- The sidebar, with the current page marked and opened out into its headings.
- "On this page", on the right at 1280px and wider, as a button in the bar under the header below
  1024px. Both mark the heading being read as the page scrolls.
- Search: ⌘K or Ctrl K, `/`, or any "Search docs…" field. Arrows move, Enter opens, Escape closes.
- Old single-page links: `/docs#<id>` is replaced by `/docs/<id>`.
- The home page's recording, which loads only when its button is pressed.

## How to get to it (user POV)

- "Docs" in the landing page's bar, or the Docs links in its footer.
- A link from the README, including the old `/docs#verification` form.

## Driving it with verify-nap

Preconditions: none. The docs need no session, so this runs signed in or out.

```bash
goto /docs
shot  --label "docs: home"
goto  /docs/verification
press --key Meta+k
fill  --role combobox --name "Search the docs" --value "repair"
press --key ArrowDown
shot  --label "docs: search"
press --key Enter                                 # opens the highlighted result
wait  --role dialog --name "Search the docs" --state hidden
click --role button --name "Search docs…" --loose  # ⌘ K on a Mac, Ctrl K elsewhere
press --key Escape
wait  --role dialog --name "Search the docs" --state hidden

goto  "/docs/verification#repair-is-a-turn-not-a-smaller-thing"
shot  --label "docs: on this page marks the heading"

goto  "/docs#architecture"
wait  --role heading --name "Architecture"
url                                               # /docs/architecture

resize --width 390 --height 844                   # a phone; later commands keep this width
goto  /docs/verification
click --role button --name "On this page"
shot  --label "docs: phone, on this page"
click --role button --name "Menu"
shot  --label "docs: phone, menu"
resize --width 1440 --height 900
```

## Gotchas

- Every subheading is a link to itself, so its name appears twice on the page: once in "On this
  page" and once as the heading. `click --role link` on it fails as ambiguous. Open the list, then
  `press --key Tab` to the entry and `press --key Enter`.
- `resize` sets a viewport that every later command reapplies, because an emulated viewport lapses
  when a command detaches. It also sizes the window as near as headless Chrome allows (500 pixels
  wide at least), so between commands a phone-width page sits at 500, not the fixture's 1440, and
  the menu, which closes when the window widens past 1024, stays open. The brief width change can
  still move the scroll position, so check the "On this page" mark within one command's view (open
  the list after the jump and `shot`). Set it back to 1440×900 before a recipe that expects the
  default width.
- The fixture serves a copy of `apps/web/src` taken at startup. An edit made after `verify-nap:up`
  does not reach it until it is copied into `.scratch/verify-nap-<id>/web/src`.
