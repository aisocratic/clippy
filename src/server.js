'use strict';

const http = require('node:http');

const MAX_BODY = 1024 * 1024; // 1 MB

// Agents allowed to tag themselves via ?source=. Anything else (including a
// missing param, i.e. hooks from an older install) is treated as Claude.
const KNOWN_SOURCES = new Set(['claude', 'codex', 'openclaw']);

/**
 * Tiny dependency-free HTTP server that receives Claude Code, Codex, and
 * OpenClaw hook events.
 *
 * Hooks POST their stdin JSON to:  POST /hook/<EventName>[?kind=<matcher>]
 * Statusline hook:                 POST /statusline?cols=N  (body: Claude
 *                                  Code's statusline JSON; response: the line)
 * Click-through from the terminal: GET  /focus?session=<id>
 * Debugging endpoint:              GET  /status
 *
 * Binds to 127.0.0.1 only — this never listens on the network.
 *
 * `onEvent` may return (a promise of) a JSON-serializable object; it becomes
 * the response body, which interactive hooks echo to stdout as their decision.
 * Returning nothing sends {"ok":true}. The promise may resolve much later
 * (e.g. after the user clicks a button) — the response is held open until
 * then. `ctx.onClose(fn)` fires if the hook's curl gives up first.
 *
 * @param {object} opts
 * @param {(eventName: string, kind: string|null, payload: object, ctx: {onClose: (fn: () => void) => void, headers: object, source: string}) => (object|void|Promise<object|void>)} opts.onEvent
 * @param {() => object} [opts.getStatus]  Returns JSON for GET /status
 * @param {(payload: object, cols: number) => string} [opts.onStatusline]  Returns the line for POST /statusline
 * @param {(sessionId: string) => void} [opts.onFocus]  Reveal a session's buddy for GET /focus
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 */
function createHookServer({ onEvent, getStatus, onStatusline, onFocus, port = 43117, host = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStatus ? getStatus() : { ok: true }));
      return;
    }

    // The OSC 8 hyperlink on the statusline's 📎 lands here: a browser opens
    // the link, the buddy comes to the front, and the tab says so.
    if (req.method === 'GET' && url.pathname === '/focus') {
      try {
        if (onFocus) onFocus(url.searchParams.get('session') || '');
      } catch (err) {
        console.error('clippy: error focusing session', err);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<title>Clippy</title>Your buddy is on screen — you can close this tab.');
      return;
    }

    const statusline = req.method === 'POST' && url.pathname === '/statusline';
    const match = req.method === 'POST' && url.pathname.match(/^\/hook\/([A-Za-z]+)$/);
    if (!match && !statusline) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }

    const eventName = match ? match[1] : null;
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

      if (statusline) {
        // Claude Code renders this response verbatim under its input box, so
        // it is plain text (with ANSI colour), not JSON. Empty means "show
        // nothing", which is also what the terminal gets if we're not running.
        let line = '';
        try {
          const cols = Number(url.searchParams.get('cols')) || 0;
          line = (onStatusline && onStatusline(payload, cols)) || '';
        } catch (err) {
          console.error('clippy: error building statusline', err);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String(line));
        return;
      }

      const closeHandlers = [];
      // `headers` carries the terminal context the hook shipped (X-Clippy-*),
      // which is how the app finds the window a session is running in.
      const requested = url.searchParams.get('source');
      const source = KNOWN_SOURCES.has(requested) ? requested : 'claude';
      const ctx = { onClose: (fn) => closeHandlers.push(fn), headers: req.headers, source };
      res.on('close', () => {
        for (const fn of closeHandlers) {
          try {
            fn();
          } catch {}
        }
      });

      let result;
      try {
        result = onEvent(eventName, kind, payload, ctx);
      } catch (err) {
        console.error('clippy: error handling hook event', eventName, err);
      }

      Promise.resolve(result)
        .catch((err) => {
          console.error('clippy: error handling hook event', eventName, err);
          return undefined;
        })
        .then((reply) => {
          if (res.writableEnded || res.destroyed) return; // curl already gave up
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // No reply object -> plain ack. Interactive hooks treat the body as
          // their stdout decision; "{}" / {"ok":true} both mean "no decision".
          res.end(reply && typeof reply === 'object' ? JSON.stringify(reply) : '{"ok":true}');
        });
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
