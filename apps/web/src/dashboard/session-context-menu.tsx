"use client";

import { ChevronRight } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { MenuItem, MenuItemId } from "./session-menu.ts";
import { MENU_EDGE, placeSubmenu } from "./submenu-placement.ts";

/**
 * A session's context menu, opened by right-click, the Context Menu key or Shift+F10.
 *
 * One instance for the whole list rather than one per row, so a row carries no menu state and a
 * re-render of the menu touches no row. It is drawn into `document.body` at the pointer, or at
 * the row for the keyboard, and pulled back inside the viewport once it can be measured.
 *
 * The keyboard follows the WAI-ARIA menu pattern: arrows move, Home and End jump, Right or Enter
 * opens a submenu and Left or Escape closes it, and Escape on the top level closes the menu and
 * gives focus back to the row it was opened from. Tab closes it as well, since a menu is not a
 * stop in the page's tab order.
 */
export function SessionContextMenu({
  label,
  items,
  at,
  onSelect,
  onClose,
}: {
  label: string;
  items: readonly MenuItem[];
  /** Where the top-left corner goes before it is kept on screen. */
  at: { x: number; y: number };
  onSelect: (id: MenuItemId) => void;
  /** `restoreFocus` is false when focus is about to go somewhere on purpose. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);
  const [submenu, setSubmenu] = useState<MenuItemId>();

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    // The layout size, not the drawn one: the menu grows in from 98%, and a box measured
    // mid-animation is clamped as if it were smaller than it is about to be.
    setPosition({
      x: Math.max(MENU_EDGE, Math.min(at.x, window.innerWidth - element.offsetWidth - MENU_EDGE)),
      y: Math.max(MENU_EDGE, Math.min(at.y, window.innerHeight - element.offsetHeight - MENU_EDGE)),
    });
    element.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [at]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      onClose(false);
    };
    const away = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", away);
    window.addEventListener("scroll", away, true);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", away);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("blur", away);
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = document.activeElement;
    if (!(current instanceof HTMLElement)) return;
    const level = current.closest<HTMLElement>("[role='menu']");
    if (!level) return;
    // A submenu's owner sits in a wrapper beside its menu, so "this level's items" is every item
    // whose nearest menu is this one, not this menu's direct children.
    const siblings = [...level.querySelectorAll<HTMLElement>("[role='menuitem']")].filter(
      (item) => item.closest("[role='menu']") === level,
    );
    const index = siblings.indexOf(current);
    const nested = level !== menu.current;
    const move = (to: number) => siblings[(to + siblings.length) % siblings.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(siblings.length - 1);
        break;
      case "ArrowRight": {
        const id = current.dataset.submenu as MenuItemId | undefined;
        if (!id) return;
        setSubmenu(id);
        break;
      }
      case "ArrowLeft":
        if (!nested) return;
        setSubmenu(undefined);
        level.parentElement?.querySelector<HTMLElement>(":scope > [role='menuitem']")?.focus();
        break;
      case "Escape":
        if (nested) {
          setSubmenu(undefined);
          level.parentElement?.querySelector<HTMLElement>(":scope > [role='menuitem']")?.focus();
        } else onClose(true);
        break;
      case "Tab":
        onClose(true);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className="composer-surface nap-float fixed z-50 w-60 rounded-[10px] p-1 [--float-origin:top_left]"
    >
      {items.map((item) =>
        item.children ? (
          <WithSeparator key={item.id} separator={item.separatorBefore}>
            <div
              role="none"
              className="relative"
              onPointerEnter={() => setSubmenu(item.id)}
              // A finger "leaves" everything as it lifts, before the click its tap becomes; shutting
              // the submenu then would hand that click to whatever menu item lies under it.
              onPointerLeave={(event) => {
                if (event.pointerType !== "touch") setSubmenu(undefined);
              }}
            >
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={submenu === item.id}
                data-submenu={item.id}
                // Opens rather than toggles: the pointer that clicks has already opened it on the
                // way in, and a tap opens it on touch, so a toggle would shut it under the finger.
                onClick={() => setSubmenu(item.id)}
                className={ITEM}
              >
                <span className="flex-1">{item.label}</span>
                <ChevronRight aria-hidden className="size-3.5 text-muted" />
              </button>
              {submenu === item.id && (
                <Submenu label={item.label} items={item.children} onSelect={onSelect} />
              )}
            </div>
          </WithSeparator>
        ) : (
          <WithSeparator key={item.id} separator={item.separatorBefore}>
            <Item item={item} onSelect={onSelect} onPointerEnter={() => setSubmenu(undefined)} />
          </WithSeparator>
        ),
      )}
    </div>,
    document.body,
  );
}

/**
 * A nested menu, drawn where `placeSubmenu` says: beside its owner item, or below it where
 * neither side has room. It stays a DOM child of the owner's wrapper wherever it is drawn, so
 * moving onto it is never a pointer leave.
 */
function Submenu({
  label,
  items,
  onSelect,
}: {
  label: string;
  items: readonly MenuItem[];
  onSelect: (id: MenuItemId) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const node = element.current;
    const owner = node?.parentElement;
    if (!node || !owner) return;
    setOffset(
      placeSubmenu(
        owner.getBoundingClientRect(),
        { width: node.offsetWidth, height: node.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    node.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, []);
  return (
    <div
      ref={element}
      role="menu"
      aria-label={label}
      style={offset}
      className={`composer-surface nap-float absolute z-50 w-56 rounded-[10px] p-1 ${offset ? "" : "top-[-4px] left-full"}`}
    >
      {items.map((item) => (
        <WithSeparator key={item.id} separator={item.separatorBefore}>
          <Item item={item} onSelect={onSelect} />
        </WithSeparator>
      ))}
    </div>
  );
}

function Item({
  item,
  onSelect,
  onPointerEnter,
}: {
  item: MenuItem;
  onSelect: (id: MenuItemId) => void;
  onPointerEnter?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onSelect(item.id)}
      onPointerEnter={onPointerEnter}
      className={`${ITEM} ${item.destructive ? "text-danger hover:text-danger focus-visible:text-danger" : ""}`}
    >
      <span className="flex-1">{item.label}</span>
      {/* The space keeps "In 1 hour" and "1:00 PM" apart in the accessible name. */}
      {item.detail && " "}
      {item.detail && <span className="text-xs text-muted tabular-nums">{item.detail}</span>}
    </button>
  );
}

/** An item, with the hairline that opens its group when it opens one. */
function WithSeparator({
  separator,
  children,
}: {
  separator?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <>
      {separator && <hr className="mx-1.5 my-1 border-edge" />}
      {children}
    </>
  );
}

const ITEM =
  "flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink";
