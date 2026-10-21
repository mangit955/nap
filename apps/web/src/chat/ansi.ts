/**
 * Terminal output, as runs of text with the styles its escape codes asked for.
 *
 * `run_command` streams exactly what the program printed, and build tools colour their output:
 * printed raw, a Vite banner is half `[32m`. This reads the SGR codes — colour, weight — and drops
 * every other escape, since nothing here is a terminal a cursor could move around in.
 *
 * The colours are class names, not values. The stylesheet maps each one to a token of the frame's
 * own palette (`globals.css`), so a program asking for red gets the frame's `danger` and one
 * asking for green gets ordinary ink — success stays unmarked here too.
 */

export type AnsiSpan = { text: string; classes: string[] };

const COLOURS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

// Every CSI sequence, and OSC sequences ended by BEL or ST — the window-title kind.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point.
const ESCAPES = /\u001b\[([0-9;?]*)([A-Za-z])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * A line a progress bar redrew with carriage returns, reduced to what a terminal would still be
 * showing: the text after the last `\r`. A `\r\n` is an ordinary line ending.
 */
function lastFrames(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      const at = trimmed.lastIndexOf("\r");
      return at === -1 ? trimmed : trimmed.slice(at + 1);
    })
    .join("\n");
}

export function ansiSpans(raw: string): AnsiSpan[] {
  const text = lastFrames(raw);
  const spans: AnsiSpan[] = [];
  let bold = false;
  let dim = false;
  let colour: (typeof COLOURS)[number] | undefined;
  let cursor = 0;

  const push = (chunk: string) => {
    if (chunk === "") return;
    const classes = [
      ...(bold ? ["ansi-bold"] : []),
      ...(dim ? ["ansi-dim"] : []),
      ...(colour === undefined ? [] : [`ansi-${colour}`]),
    ];
    const last = spans.at(-1);
    if (last !== undefined && last.classes.join() === classes.join()) last.text += chunk;
    else spans.push({ text: chunk, classes });
  };

  for (const match of text.matchAll(ESCAPES)) {
    push(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[2] !== "m") continue;

    const codes = (match[1] ?? "").split(";").map((code) => (code === "" ? 0 : Number(code)));
    for (const code of codes) {
      if (code === 0) {
        bold = false;
        dim = false;
        colour = undefined;
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 39) colour = undefined;
      else if (code >= 30 && code <= 37) colour = COLOURS[code - 30];
      else if (code >= 90 && code <= 97) colour = COLOURS[code - 90];
    }
  }
  push(text.slice(cursor));

  return spans;
}
