/**
 * An independently implemented on/off control inspired by T3 Code's provider switches: a pill
 * filled with the accent when on, its thumb sliding to the right. See
 * apps/web/THIRD_PARTY_NOTICES.md for the design reference.
 *
 * A `button` with `role="switch"` rather than a checkbox, so a screen reader announces "on" and
 * "off" rather than "checked", and Space and Enter both toggle it without any handler of ours.
 */

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The accessible name. There is no visible one; the row beside it says what it switches. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-accent" : "bg-line-strong"}`}
    >
      <span
        aria-hidden="true"
        className={`size-3.5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-[16px]" : "translate-x-[2px]"}`}
      />
    </button>
  );
}
