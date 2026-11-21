import { EXAMPLE_APPS } from "./example-apps.ts";

/**
 * Three example apps, each beside the prompt that describes it, each one click from being used.
 *
 * The thumbnails are screenshots rather than the live pages in frames: three iframes would load
 * three apps' worth of script for a row of pictures. The link opens the real thing.
 */
export function BuiltWithNap() {
  return (
    <section id="built" aria-labelledby="built-title" className="lp-section lp-container">
      <h2 id="built-title" className="lp-heading">
        Built with nap
      </h2>
      <p className="lp-lede">
        Three example apps and the prompts that describe them. Open any of them and use it.
      </p>
      <ul className="lp-gallery">
        {EXAMPLE_APPS.map((app) => (
          <li key={app.id} className="lp-example">
            {/* biome-ignore lint/performance/noImgElement: a static screenshot, sized by its card */}
            <img src={app.thumbnail} alt="" width="960" height="600" loading="lazy" />
            <div>
              <q>{app.prompt}</q>
              <div className="lp-example-meta">
                <span>{app.category}</span>
                <a href={app.href} target="_blank" rel="noreferrer">
                  Open app<span className="sr-only">: {app.category.toLowerCase()} example</span>{" "}
                  <span aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
