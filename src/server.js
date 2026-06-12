'use strict';

const http = require('node:http');

const MAX_BODY = 1024 * 1024; // 1 MB

/**
 * Tiny dependency-free HTTP server that receives Claude Code hook events.
 *
 * Hooks POST their stdin JSON to:  POST /hook/<EventName>[?kind=<matcher>]
 * Debugging endpoint:              GET  /status
 *
 * Binds to 127.0.0.1 only — this never listens on the network.
 *
 * @param {object} opts
 * @param {(eventName: string, kind: string|null, payload: object) => void} opts.onEvent
 * @param {() => object} [opts.getStatus]  Returns JSON for GET /status
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 */
function createHookServer({ onEvent, getStatus, port = 43117, host = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStatus ? getStatus() : { ok: true }));
      return;
    }

    const match = req.method === 'POST' && url.pathname.match(/^\/hook\/([A-Za-z]+)$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }

    const eventName = match[1];
    const kind = url.searchParams.get('kind');
    let body = '';
    let tooBig = false;

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });

    req.on('end', () => {
      if (tooBig) return;
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        // Hook payloads should always be JSON, but never punish the sender.
      }
      try {
        onEvent(eventName, kind, payload);
      } catch (err) {
        console.error('clippy: error handling hook event', eventName, err);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  server.listenOn = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address()));
    });

  return server;
}

module.exports = { createHookServer };
