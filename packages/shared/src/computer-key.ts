/**
 * A key chord as a model writes it, made into the chord it means.
 *
 * Models write select-all as `CTRL+A` as often as `ctrl+a`. The desktop maps modifier names in any
 * case, but hands the final key to xdotool as written, and xdotool reads an uppercase letter as
 * Shift plus that letter — so `CTRL+A` arrives as Ctrl+Shift+A, which is not select-all, and the
 * action still reports success. Measured in docs/computer-use-reliability.md.
 *
 * Done here, before the desktop, rather than in the desktop's own key map: that map is part of the
 * desktop build, and changing it would leave every running machine outdated until the template is
 * republished. A chord that means Shift names it (`ctrl+shift+a`), so nothing is lost. A lone
 * letter is left alone, since `A` on its own is a request for a capital A.
 */
export function normalizeKeyChord(chord: string): string {
  const parts = chord.split("+");
  const last = parts.at(-1) ?? "";
  if (parts.length < 2 || !/^[A-Z]$/.test(last)) return chord;
  return [...parts.slice(0, -1), last.toLowerCase()].join("+");
}
