'use strict';

// Browser-only payloads for visually checking the real reader window. Electron
// replaces this object with preload-reader.js in the app.
const readerFlow = new URLSearchParams(window.location.search).get('flow') || 'complete';
const foxBuddy = {
  kind: 'sheet',
  sheet: {
    frameWidth: 192,
    frameHeight: 208,
    columns: 8,
    rows: 9,
    fps: 6,
    poses: {
      excited: { file: 'assets/themes/fox/spritesheet.webp', row: 3, frames: 4 },
      idle: { file: 'assets/themes/fox/spritesheet.webp', row: 0, frames: 6 },
    },
  },
  color: '#6cbf6c',
  label: 'Fox',
};
const payloads = {
  complete: {
    title: 'Claude Finished',
    where: 'billing-api · Claude · VS Code',
    prompt: 'Make invoice posting resilient to transient failures and add coverage for retries.',
    text:
      'Added `withRetry()` around `postInvoice()` with three attempts and exponential ' +
      'backoff. A 409 is treated as success, retry activity includes the invoice id, and ' +
      'both success and exhaustion paths are covered. All 42 tests pass.',
    canOpenSource: true,
    sourceName: 'VS Code',
    review: true,
    buddy: foxBuddy,
  },
  failure: {
    title: 'Bash failed · npm test',
    where: 'billing-api · Claude · VS Code',
    prompt: '',
    text:
      '$ npm test\n\nFAIL test/webhook.test.js\n' +
      'Expected retry count: 3\nReceived retry count: 1\n\n' +
      'The webhook stopped after the first 503 response. Add retry handling before rerunning the suite.',
    canOpenSource: true,
    sourceName: 'VS Code',
    review: false,
    buddy: foxBuddy,
  },
};

window.readerAPI = {
  onText: (fn) => setTimeout(() => fn(payloads[readerFlow] || payloads.complete), 0),
  openSource: () => {},
  minimize: () => {},
  decide: () => {},
};
