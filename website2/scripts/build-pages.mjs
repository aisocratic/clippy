import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "pages-dist");
const workerPath = path.join(root, "dist/server/index.js");
const workerUrl = pathToFileURL(workerPath);
workerUrl.searchParams.set("build", `${Date.now()}`);

const { default: worker } = await import(workerUrl.href);
const response = await worker.fetch(
  new Request("https://aisocratic.github.io/clippy/", {
    headers: {
      accept: "text/html",
      host: "aisocratic.github.io",
      "x-forwarded-proto": "https",
    },
  }),
  {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  },
  {
    waitUntil() {},
    passThroughOnException() {},
  },
);

if (!response.ok) {
  throw new Error(`Unable to render GitHub Pages HTML: ${response.status}`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "dist/client"), output, { recursive: true });
await writeFile(path.join(output, "index.html"), await response.text());
await writeFile(path.join(output, ".nojekyll"), "");

console.log(`GitHub Pages bundle created at ${output}`);
