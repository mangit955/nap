import { LiveSignIn } from "../../auth/live-sign-in.tsx";

/**
 * Making an account, at a URL somebody can type.
 *
 * The same form as `/sign-in`, opened on its other half — not a second copy of it. Signing up
 * and signing in differ by a name field and a verb, and two pages would mean two of everything
 * for that; what a separate route buys is a link that can be shared, typed, or put in a post,
 * which `/sign-in?mode=sign-up` cannot. That query parameter still works, so nothing already
 * pointed at it breaks.
 *
 * No `expired` notice here, unlike `/sign-in`: a session that ends always lands there, and
 * offering to create a *new* account to somebody who has just been interrupted answers a
 * question they did not ask.
 */
export default function Page() {
  return <LiveSignIn initialMode="sign-up" />;
}
