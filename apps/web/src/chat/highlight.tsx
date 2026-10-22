"use client";

/**
 * Syntax highlighting for the chat pane, loaded only when something needs it.
 *
 * Shiki is large — a regex engine and a grammar per language — and most conversations never show
 * a code block, so none of it is in the page's bundle: the first code block or expanded command
 * asks for it with a dynamic `import()`, and each language's grammar arrives as a chunk of its own
 * the first time it is used. Until then a block renders as plain text in exactly the layout the
 * highlighted version will have, so the colours arriving moves nothing.
 *
 * The theme is Shiki's CSS-variables theme: tokens carry `var(--shiki-token-keyword)` rather than
 * colours, and `globals.css` maps those onto the frame's own tokens. The JavaScript regex engine
 * rather than the default WebAssembly one, so nothing here depends on how the bundler serves
 * `.wasm`.
 *
 * T3 Code highlights its chat the same way, lazily and with Shiki (MIT — see
 * `apps/web/THIRD_PARTY_NOTICES.md`); this is a smaller version of the idea.
 */

import { Fragment, useEffect, useState } from "react";
import type { ThemedToken } from "shiki";

const THEME = "nap-chat";

type Shiki = typeof import("shiki");
type Highlighter = Awaited<ReturnType<Shiki["createHighlighter"]>>;

type Theme = ReturnType<Shiki["createCssVariablesTheme"]>;

let loading: Promise<{ shiki: Shiki; highlighter: Highlighter; theme: Theme }> | undefined;

function load() {
  loading ??= import("shiki").then(async (shiki) => {
    // Passed by value rather than by name: the highlighter's types know only Shiki's own themes.
    const theme = shiki.createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-" });
    const highlighter = await shiki.createHighlighter({
      themes: [theme],
      langs: [],
      engine: shiki.createJavaScriptRegexEngine(),
    });
    return { shiki, highlighter, theme };
  });
  return loading;
}

/**
 * Finished blocks, so scrolling back past one does not highlight it again. Only finished ones: a
 * block still streaming is a new prefix on every chunk, and caching each would fill this with
 * copies of one block and push out the blocks it exists for.
 */
const cache = new Map<string, ThemedToken[][]>();
const CACHE_LIMIT = 200;

async function highlight(
  code: string,
  language: string,
  streaming: boolean,
): Promise<ThemedToken[][] | undefined> {
  const key = `${language}\u0000${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const { shiki, highlighter, theme } = await load();
  const lang = language.toLowerCase();
  // Own keys only: `"constructor" in` a plain object is true, and Shiki would try to load it.
  if (!Object.hasOwn(shiki.bundledLanguages, lang)) return undefined;
  const bundled = lang as keyof Shiki["bundledLanguages"];
  if (!highlighter.getLoadedLanguages().includes(bundled)) await highlighter.loadLanguage(bundled);

  const tokens = highlighter.codeToTokensBase(code, { lang: bundled, theme });
  if (streaming) return tokens;
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, tokens);
  return tokens;
}

/**
 * The code, highlighted once the grammar is in, and plain until then.
 *
 * While a block is still streaming its code changes on every chunk, and highlighting starts over
 * each time. Rather than dropping back to plain text whenever it does — which flickers the whole
 * block on every chunk — the last highlighted version is kept and the text that arrived since is
 * appended to it plain, so only the newest characters wait for their colour.
 */
export function HighlightedCode({
  code,
  language,
  streaming = false,
}: {
  code: string;
  language: string;
  /** Still being written, so this version of it is not worth keeping. */
  streaming?: boolean;
}) {
  const [done, setDone] = useState<{ code: string; tokens: ThemedToken[][] } | undefined>(() => {
    const tokens = cache.get(`${language}\u0000${code}`);
    return tokens === undefined ? undefined : { code, tokens };
  });

  useEffect(() => {
    let cancelled = false;
    highlight(code, language, streaming)
      .then((tokens) => {
        if (!cancelled && tokens !== undefined) setDone({ code, tokens });
      })
      // A grammar that fails to load leaves the code plain, which is what it was already.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code, language, streaming]);

  if (done === undefined || !code.startsWith(done.code)) return code;
  const rest = code.slice(done.code.length);

  return (
    <>
      {done.tokens.map((line, index) => (
        // Lines of one block, rebuilt together and never reordered.
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's position is its identity
        <Fragment key={index}>
          {index > 0 && "\n"}
          {line.map((token) => (
            <span
              key={token.offset}
              style={{
                color: token.color,
                fontStyle: (token.fontStyle ?? 0) & 1 ? "italic" : undefined,
                fontWeight: (token.fontStyle ?? 0) & 2 ? 600 : undefined,
              }}
            >
              {token.content}
            </span>
          ))}
        </Fragment>
      ))}
      {rest}
    </>
  );
}
