import { Welcome } from "../../account/welcome.tsx";

/**
 * Where a new account lands, once, before the dashboard.
 *
 * It asks one optional question — bring a key, or run on the free models — and sends everybody
 * on either way. Anyone who already has a key never sees it.
 */
export default function Page() {
  return <Welcome />;
}
