/**
 * Setup for the `web` test project.
 *
 * Kept to this project rather than the whole suite: `@testing-library/jest-dom` and the
 * automatic cleanup below only make sense in a DOM, and loading them into the hundred-odd
 * Node tests would cost time and blur where the browser boundary is.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without this, a component from one test is still mounted during the next, so
// `getByRole` finds two matches and fails in a way that points at the wrong test.
afterEach(cleanup);
