import { Welcome } from "../../account/welcome.tsx";

/**
 * Where a new account lands, once, before the dashboard.
 *
 * It offers a key form and a way to browse the dashboard. Running without a key depends on the
 * deployment's free-tier policy. Anyone who already has a key never sees it.
 */
export default function Page() {
  return <Welcome />;
}
