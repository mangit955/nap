import { REPO_URL } from "./github-button.tsx";

/** A seeded generator, so the pile is the same blocks on every render and every visit. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const COLUMNS = 12;
const ROWS = 9;

/** The pile in the closing band: a staircase of blocks rising to the right, still being built. */
export function pileCells(): ("on" | "ac" | "gh" | undefined)[] {
  const random = seeded(4);
  const cells: ("on" | "ac" | "gh" | undefined)[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLUMNS; x++) {
      const height = Math.min(
        ROWS,
        Math.max(0, Math.round((x / (COLUMNS - 1)) * ROWS * 0.95 + (random() - 0.5) * 2)),
      );
      const filled = ROWS - y <= height;
      const edge = ROWS - y === height + 1 && random() < 0.18;
      const tone = random();
      cells.push(filled ? (tone < 0.1 ? "ac" : "on") : edge ? "gh" : undefined);
    }
  }
  return cells;
}

const PILE = pileCells();

/** The last word before the footer, on a dark band: the same two ways in as the hero. */
export function StartNow() {
  return (
    <section id="start" aria-labelledby="start-title" className="n1-close">
      <div className="n1-pile" aria-hidden="true">
        {PILE.map((cell, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid; a cell is its position.
          <i key={index} className={cell} />
        ))}
      </div>
      <div className="n1-wrap">
        <div className="n1-label">
          <b>[ ready ]</b>&nbsp; waiting for a task
        </div>
        <h2 id="start-title" className="n1-dot">
          Build your
          <br />
          <span>first app.</span>
        </h2>
        <p>Describe it in a sentence. Num1 does the rest on its own computer.</p>
        <div className="n1-cta">
          <a href="/sign-up" className="n1-btn n1-btn-dark">
            Start building
          </a>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="n1-btn">
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
