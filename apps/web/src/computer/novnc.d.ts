/// <reference types="novnc__novnc" />

// The published RFB types omit this module. This signature follows the installed
// noVNC 1.5 lib/util/logging.js, including its supported "none" level.
declare module "@novnc/novnc/lib/util/logging" {
  export function initLogging(level?: "debug" | "info" | "warn" | "error" | "none"): void;
}
