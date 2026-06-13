'use strict';

/**
 * Evaluate a JS expression in the Clippy renderer via the Chrome DevTools
 * Protocol. Dev/test helper — requires the app to be started with
 * --remote-debugging-port=<port>.
 *
 *   node scripts/cdp-eval.js <port> "<expression>"
 */

const [port, expr] = process.argv.slice(2);
if (!port || !expr) {
  console.error('usage: node scripts/cdp-eval.js <port> "<expression>"');
  process.exit(1);
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error(`no renderer page found among ${targets.length} targets`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const reply = new Promise((resolve, reject) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) {
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr } }));

  const result = await reply;
  console.log(JSON.stringify(result.result?.value ?? result.result));
  ws.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
