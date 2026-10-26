import { ArrowRightIcon } from "../ui/icons.tsx";
import { REPO_URL } from "./github-button.tsx";
import { Reveal } from "./parts.tsx";

const TOOLS = [
  { name: "React", icon: "react.svg" },
  { name: "TypeScript", icon: "typescript.svg" },
  { name: "Vite", icon: "vite.svg" },
  { name: "Tailwind", icon: "tailwindcss.svg" },
  { name: "GitHub", icon: "github-w.svg" },
];

export function Measurements() {
  return (
    <section id="measured" aria-labelledby="measured-title" className="lp-proof lp-container">
      <Reveal className="lp-proof-heading">
        <div>
          <span className="lp-eyebrow">TESTED BEYOND THE DEMO.</span>
          <h2 id="measured-title" className="lp-serif">
            Built to keep going.
          </h2>
        </div>
        <a
          href={`${REPO_URL}/blob/main/docs/scaling-cluster.md`}
          target="_blank"
          rel="noreferrer"
          className="lp-text-link"
        >
          Read the cluster report <ArrowRightIcon className="size-4" />
        </a>
      </Reveal>
      <Reveal>
        <dl className="lp-proof-grid">
          <div>
            <dt>Turns completed</dt>
            <dd>
              2,422<span>turns</span>
            </dd>
            <p>100 running at the same time.</p>
          </div>
          <div>
            <dt>Completion rate</dt>
            <dd>
              100<span>%</span>
            </dd>
            <p>Across jobs, turns, and verification.</p>
          </div>
          <div>
            <dt>Lost or duplicate events</dt>
            <dd>
              0<span>events</span>
            </dd>
            <p>Through 231 mid-turn reconnects.</p>
          </div>
        </dl>
        <p className="lp-proof-source">
          Measured in the 24 August 2026 infrastructure load test using simulated model and sandbox
          workloads. Full methodology and scope in the report.
        </p>
      </Reveal>
      <div id="stack" className="lp-stack-strip">
        <span>
          Familiar tools.
          <br />
          <b>Code you can keep.</b>
        </span>
        <ul aria-label="Project tools">
          {TOOLS.map((tool) => (
            <li key={tool.name}>
              {/* biome-ignore lint/performance/noImgElement: small local brand assets */}
              <img src={`/landing/stack/${tool.icon}`} alt="" width="22" height="22" />
              {tool.name}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
