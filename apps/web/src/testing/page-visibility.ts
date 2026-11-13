/**
 * Whether the page is visible, as a test says it is.
 *
 * jsdom reports `visible` and never changes its mind, so a loop that parks in a background tab
 * cannot be seen to park without this. Installed as an own property over jsdom's prototype getter,
 * and `restore` deletes it, which puts jsdom's own back — call it in `afterEach`, or one hidden
 * test leaves every later one in the file looking at a background tab.
 */
export function pageVisibility(initial: DocumentVisibilityState = "visible") {
  let state = initial;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  return {
    /** Changes the state and fires `visibilitychange`, as a browser does on a tab switch. */
    set(next: DocumentVisibilityState) {
      state = next;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    restore() {
      Reflect.deleteProperty(document, "visibilityState");
    },
  };
}
