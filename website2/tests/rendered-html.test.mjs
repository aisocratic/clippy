import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
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
}

test("server-renders the finished Clippy landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Clippy — A tiny teammate for Claude Code \+ Codex<\/title>/i);
  assert.match(html, /Your coding agents have a/);
  assert.match(html, /tiny teammate/);
  assert.match(html, /100% local/);
  assert.match(html, /Give your agents a buddy/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/i);
});
