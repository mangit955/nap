/** How far from the viewport's edges a menu keeps. */
export const MENU_EDGE = 8;

type Box = { left: number; right: number; top: number; bottom: number };
type Size = { width: number; height: number };

/**
 * Where a submenu goes, as an offset from its owner item, given the owner's box in the viewport.
 *
 * Beside the owner — on the right, else on the left — it rises by the menu's padding, so its
 * first item lines up with the owner, and moves up further if it would run off the bottom. Where
 * neither side has room (on a phone the menu alone is most of the width) it drops below the
 * owner, over the rest of the menu, or ends at the owner's top when there is no room under it.
 * Every placement touches the owner, so a pointer crossing from one to the other never passes
 * over nothing on the way.
 */
export function placeSubmenu(owner: Box, size: Size, viewport: Size) {
  const clamp = (value: number, span: number, room: number) =>
    Math.max(MENU_EDGE, Math.min(value, room - span - MENU_EDGE));
  const fits = (x: number) => x >= MENU_EDGE && x + size.width <= viewport.width - MENU_EDGE;
  const beside = fits(owner.right)
    ? owner.right
    : fits(owner.left - size.width)
      ? owner.left - size.width
      : undefined;
  if (beside !== undefined)
    return {
      left: beside - owner.left,
      top: clamp(owner.top - 4, size.height, viewport.height) - owner.top,
    };
  const under = owner.bottom + size.height <= viewport.height - MENU_EDGE;
  return {
    left: clamp(owner.left, size.width, viewport.width) - owner.left,
    top:
      clamp(under ? owner.bottom : owner.top - size.height, size.height, viewport.height) -
      owner.top,
  };
}
