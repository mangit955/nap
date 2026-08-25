# Design brief

This project is not a blank Vite app. It ships a token layer, a set of accessible primitives
and a point of view. Read this before writing UI; it is shorter than the time it takes to
rebuild any of it badly.

## The one thing to do first

**Restyle the tokens.** They are all in `src/index.css`, in one `@theme` block: palette, type
scale, spacing unit, radii, shadows, fonts. Changing `--color-canvas`, `--color-accent` and the
three ink tones is the difference between an app that looks like this template and an app that
looks like the thing that was asked for. A finance dashboard and a children's reading list must
not share a palette.

Restyle by editing the tokens, not by scattering literal colours through components. If a
value needs to appear twice, it is a token.

## The palette is one accent, deliberately

Three text tones (`ink`, `ink-muted`, `ink-subtle`), three surfaces (`canvas`, `surface`,
`surface-muted`), two borders, one accent and the status colours. That is enough for almost
every application, and every pair of them clears WCAG AA. A second accent hue is a decision
you should be able to justify; adding a gradient is one you almost never can.

Use `--color-accent-soft` for tinted backgrounds. A badge or a highlighted row painted in the
full accent shouts louder than what it is labelling.

## Type and spacing already carry hierarchy

The scale steps gently through the body sizes and jumps hard at display sizes, with line height
and tracking tightening as size grows. Use the steps — `text-sm` for secondary text, `text-2xl`
or larger for a page title — rather than reaching for a one-off `text-[27px]`.

Spacing utilities are all multiples of 4px. Hold to the rhythm 4 / 8 / 12 / 16 / 24 / 32 / 48 /
64. Consistent gaps are most of what reads as considered; an arbitrary `mt-[13px]` is most of
what does not.

Two shadows exist, `shadow-raised` and `shadow-overlay`. If something needs to feel more
important than its neighbours, that is a job for size, weight and space, not a third shadow.

## Use the primitives in `src/components/ui`

`Button`, `Input`, `Textarea`, `Label`, `Card`, `Badge`, `Separator`, `Checkbox`, `Tabs`,
`Dialog`, `Select`. They are yours — copied in, not installed — so edit them freely to fit the
design. What you get by using them instead of hand-rolling:

- `Dialog` traps focus, closes on Escape, locks background scroll and is announced as a dialog.
- `Select` supports arrow keys and type-ahead, portals out of `overflow: hidden` ancestors and
  returns focus to its trigger.
- `Checkbox` toggles on Space and can express an indeterminate state.
- Every control has a visible focus ring, defined once in `index.css` as a `:focus-visible`
  outline. Do not remove an outline without replacing it.

A native `<select>` is still right for a plain list of short options.

## Icons only where they carry meaning text cannot

`lucide-react` is installed because the primitives need three glyphs: a chevron that says a
select opens, a tick that says an item is chosen, a cross that closes a dialog. It is not a
decoration budget.

The rule: an icon earns its place when it says something the words do not, or when there are no
words — a close button, a sort direction, a status that must be scannable down a column. It does
not earn its place beside a label that already says the same thing. A heading with an icon glued
to its left, a nav where every item has a pictogram, a feature grid of tinted circles: these are
the signature of generated UI, and they make an interface look less finished, not more.

When in doubt, ship the words.

## Restraint, generally

Every visual decision should be answering a question about this application. Rounded corners, a
card, a shadow, a gradient, an icon — each is sometimes right. What is never right is applying
one because it was available. Prefer fewer, larger, better-aligned pieces to many small
decorated ones, and let whitespace do the separating before a border does.

Design the small viewport as its own layout rather than letting the wide one squash.
