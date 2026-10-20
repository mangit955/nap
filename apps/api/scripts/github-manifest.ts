import { parseArgs } from "node:util";
import { z } from "zod";
import { githubAppManifest } from "../src/github/config.ts";

const { values } = parseArgs({
  options: { "api-url": { type: "string" }, "web-origin": { type: "string" } },
});
const input = z.object({ "api-url": z.url(), "web-origin": z.url() }).safeParse(values);
if (!input.success) {
  process.stderr.write(
    "Usage: bun run github:manifest --api-url=https://api.example.com --web-origin=https://nap.example.com\nSee docs/github-integration.md for registration and secret configuration.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify(githubAppManifest(input.data["api-url"], input.data["web-origin"]), null, 2)}\n`,
  );
}
