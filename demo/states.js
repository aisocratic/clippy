'use strict';

/**
 * The states page: every state Clippy can be in, on one page, in the *real*
 * renderer.
 *
 * Two halves, both driving iframes of `src/renderer/`:
 *
 *   - the **live tester** on top — one big buddy, a character and size picker,
 *     and every sandbox scenario (`/api/scenarios`) as a button. Click one and
 *     its story is fired into that frame through the same postMessage protocol
 *     the bench uses, so what you are looking at is production markup, CSS and
 *     clippy.js with a stubbed bridge behind it.
 *   - the **lifecycle graph** below — Resting → Prompt running → each flow's
 *     response and outcome, every node a live mini renderer. Hovering lights
 *     the connections it belongs to; clicking one plays that node's event in
 *     the tester above, so the picture doubles as an index.
 *
 * Delays inside a scenario are compressed (`STEP_DELAY_CAP`) — the point of
 * clicking a state is the pose it lands in, not the wait — and held cards are
 * stamped with an hour so nothing counts down to an empty stage.
 */

const HOLD_MS = 60 * 60 * 1000;
const STEP_DELAY_CAP = 400;
const COMPACT_H = 200;

// States whose whole point is the window physically travelling across your
// desktop; an iframe has nothing to move, so they're labelled instead of faked.
const WINDOW_MOTION = new Set(['dock', 'walk-to-prompt']);

// Cards that wait for an answer, and every kind the renderer files as a
// request — which is every kind the tester has to be able to take back off the
// stage when you click the next state.
const HELD_KINDS = ['review', 'approval', 'answer'];
const CARD_KINDS = new Set([...HELD_KINDS, 'failure']);

const frames = []; // every mounted frame, for routing its replies back to it
const playTimers = new Map();
const flowList = document.getElementById('flows');
const scenarioList = document.getElementById('scenario-list');
const nowPlaying = document.getElementById('now-playing');
const pickCharacter = document.getElementById('pick-character');
const pickSize = document.getElementById('pick-size');
let rendererData;
let usagePayload = null;
let graphPaths = new Map();
let currentEdges = [];
let drawFrame = 0;

const base = (overrides = {}) => ({
  sessionId: 'flow-demo',
  name: 'billing-api',
  ...overrides,
});

const idle = () => base({ kind: 'activity', status: 'idle', activity: null });
const working = (tool, label) =>
  base({ kind: 'activity', status: 'working', activity: { tool, label, state: 'start', ok: true } });

// Each flow is a row of the graph: the first two stages are shared (every
// prompt rests and then runs), the rest are what makes this flow itself. Three
// stages means the outcome *is* the response; four means the response opens
// something else.
const flows = {
  complete: {
    stages: [
      stage('Resting', 'Small Clippy', idle()),
      stage('Prompt running', 'Editing and testing', working('Edit', 'Editing webhook.js')),
      stage('Response', 'Finished response preview', base({
        kind: 'review', status: 'waiting', title: 'Claude Finished',
        prompt: 'Make invoice posting resilient to transient failures and add coverage for retries.',
        message: 'Claude finished: “Added retry with backoff to the billing webhook — 42 tests pass.”',
        detail: 'Added `withRetry()` around postInvoice — 3 attempts with exponential backoff, 200ms base, and 409 treated as success. Both paths are covered and all 42 tests pass.',
      })),
      popup('Expanded popup', 'Read All', '/reader/?flow=complete'),
    ],
  },
  permission: {
    stages: [
      stage('Resting', 'Small Clippy', idle()),
      stage('Prompt running', 'Preparing a command', working('Bash', 'Running: prepare stale fixture cleanup')),
      stage('Action popup', 'Approve tool use', base({ kind: 'approval', status: 'needs_permission', variant: 'tool', tool: 'Bash', title: 'Run: delete stale invoice fixtures', detail: '$ rm -rf test/fixtures/invoices/*.json' })),
    ],
  },
  plan: {
    stages: [
      stage('Resting', 'Small Clippy', idle()),
      stage('Prompt running', 'Drafting a plan', working('Read', 'Reading webhook and test structure')),
      stage('Review popup', 'Approve the plan', base({ kind: 'approval', status: 'needs_permission', variant: 'plan', tool: 'ExitPlanMode', title: '📋 Review the plan', detail: '## Add retry to the billing webhook\n\n1. Add exponential backoff.\n2. Treat 409 as success.\n3. Log retry attempts.\n4. Cover both paths in tests.' })),
    ],
  },
  question: {
    stages: [
      stage('Resting', 'Small Clippy', idle()),
      stage('Prompt running', 'Evaluating retry options', working('Read', 'Comparing retry strategies')),
      stage('Answer popup', 'Choose a retry strategy', base({ kind: 'answer', status: 'waiting', title: 'Which retry strategy?', questions: [{ question: 'Which retry strategy should the webhook use?', header: 'Strategy', multiSelect: false, options: [{ label: 'Exponential backoff', description: 'Three attempts, 200ms base.' }, { label: 'Fixed interval', description: 'Retry every second.' }, { label: 'No retry', description: 'Fail fast and alert.' }] }] })),
    ],
  },
  failure: {
    stages: [
      stage('Resting', 'Small Clippy', idle()),
      stage('Prompt running', 'Running the test suite', working('Bash', 'Running: npm test')),
      stage('Response', 'Tool failed', base({ kind: 'failure', status: 'working', title: 'Bash failed · npm test', detail: 'Expected retry count: 3. Received retry count: 1. The webhook stopped after the first 503 response.', activity: { tool: 'Bash', label: 'Running: npm test', state: 'done', ok: false, error: 'Expected retry count: 3. Received retry count: 1.' } })),
      popup('Expanded popup', 'Failure details', '/reader/?flow=failure'),
    ],
  },
};

function stage(phase, title, event) {
  return { phase, title, event };
}

function popup(phase, title, url) {
  return { phase, title, url };
}

function rendererUrl(name, color) {
  return `/renderer/?name=${encodeURIComponent(name)}&color=${encodeURIComponent(color)}&pet=Fox`;
}

// Clippy's built-in GIFs are pre-rendered for this palette. Using an arbitrary
// design color here produces a valid-looking URL for an image that cannot
// exist, which leaves a broken buddy in the preview.
const stageColors = ['#9aa3ad', '#59b9ae', '#4fa3d1', '#6cbf6c'];

function preloadStageImages() {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = resolve;
    image.onerror = resolve;
    image.src = '/renderer/assets/themes/fox/spritesheet.webp';
  });
}

/* ---------------- the message protocol, shared by every frame ---------------- */

const post = (win, type, payload) => win.postMessage({ __clippyDemo: true, type, payload }, '*');

/** Frames start empty and say 'ready' when clippy.js is listening. Until then
 *  everything — settings, events, and the timers of a running story — waits. */
function sendOrQueue(state, type, payload) {
  if (state.ready) post(state.iframe.contentWindow, type, payload);
  else state.queue.push([type, payload]);
}

/**
 * Replies are matched against the live `contentWindow` at delivery time rather
 * than a key captured up front: a frame that reloads (the tester's Reset) gets
 * a new window, and the frame's own 'ready' can land before the parent's load
 * event has run.
 */
function register(state) {
  frames.push(state);
  state.iframe.addEventListener('load', () => {
    // Chromium composites the renderer's transparent surface onto white; this
    // class gives the frame the same dark screen the page has behind it.
    state.iframe.contentDocument.documentElement.classList.add('states-graph');
    state.iframe.contentDocument.body.classList.add('states-graph');
  });
}

/* ---------------- the live tester ---------------- */

const live = {
  kind: 'live',
  iframe: document.getElementById('live-frame'),
  ready: false,
  queue: [],
  timers: [],
  open: new Set(), // request ids still held by the last story
  sessions: new Set(), // session ids the last story spoke for
  seq: 0,
  settings: null,
};

function liveSettings() {
  return {
    approvals: true,
    reviewOnStop: true,
    answerQuestions: true,
    autoPerch: true,
    character: pickCharacter.value || 'fox',
    size: pickSize.value || 'small',
    characters: rendererData.characters,
    sizes: rendererData.sizes,
  };
}

/** (Re)load the tester frame and hand it a fresh set of settings. */
function loadLiveFrame() {
  stopLive();
  live.ready = false;
  live.queue = [];
  live.settings = liveSettings();
  live.iframe.classList.remove('ready');
  live.iframe.style.height = `${COMPACT_H}px`;
  const swatch = rendererData.palette.find((c) => c.color) || {};
  live.iframe.src = rendererUrl('billing-api', swatch.color || '#9aa3ad');
  sendOrQueue(live, 'settings', live.settings);
  if (usagePayload) sendOrQueue(live, 'usage-data', usagePayload);
  nowPlaying.textContent = 'Nothing playing yet — pick a state.';
}

/**
 * Drop anything the previous story still has in flight. Held cards are closed
 * the way main closes a session's stale requests when it moves on, and the
 * session itself is removed, which is what takes a lingering nudge or failure
 * preview off the stage — otherwise the next state you click arrives behind a
 * queue of the last three.
 */
function stopLive() {
  live.timers.forEach(clearTimeout);
  live.timers = [];
  live.queue = live.queue.filter(([type]) => type !== '__timer__');
  for (const requestId of live.open) {
    sendOrQueue(live, 'event', base({ kind: 'request-closed', requestId, outcome: 'cancel' }));
  }
  live.open.clear();
  for (const sessionId of live.sessions) {
    sendOrQueue(live, 'event', base({ sessionId, kind: 'remove', status: 'idle' }));
  }
  live.sessions.clear();
  document.querySelectorAll('.playing').forEach((el) => el.classList.remove('playing'));
}

function schedule(fire, wait) {
  if (live.ready) live.timers.push(setTimeout(fire, wait));
  else live.queue.push(['__timer__', { wait, fire }]);
}

/**
 * Play a scenario's steps into the tester frame. Waits are capped, held cards
 * get an hour so they never expire mid-look, and `ref` still ties a later
 * request-closed step back to the card it closes.
 */
function playSteps(steps, tag, label, button) {
  stopLive();
  button?.classList.add('playing');
  nowPlaying.textContent = label;
  const refs = new Map();
  let at = 0;
  steps.forEach((step, i) => {
    at += Math.min(step.delay || 0, STEP_DELAY_CAP);
    const last = i === steps.length - 1;
    schedule(() => {
      if (step.action) runAction(step.action);
      if (step.event) {
        const event = { ...step.event };
        if (step.holdSecs) {
          const requestId = `${tag}-${++live.seq}`;
          event.requestId = requestId;
          event.expiresAt = Date.now() + HOLD_MS;
          live.open.add(requestId);
          if (step.ref) refs.set(step.ref, requestId);
        } else if (CARD_KINDS.has(event.kind) && !event.requestId) {
          // A card the scenario never meant to hold (a failure preview) still
          // becomes a request in the renderer, and one it names itself. Name it
          // here instead, so the next state you click can close it.
          event.requestId = `${tag}-${++live.seq}`;
          live.open.add(event.requestId);
        } else if (step.ref && refs.has(step.ref)) {
          event.requestId = refs.get(step.ref);
          live.open.delete(event.requestId);
        }
        if (event.sessionId) live.sessions.add(event.sessionId);
        sendOrQueue(live, 'event', event);
      }
      if (last) button?.classList.remove('playing');
    }, at);
  });
}

/** Steps the page performs rather than the renderer. */
function runAction(action) {
  switch (action.do) {
    case 'usage':
      sendOrQueue(live, 'poke', { button: 'left' });
      break;
    case 'usage-close':
    case 'poke-menu':
      sendOrQueue(live, 'poke-menu', { item: action.item || 'btn-usage-close' });
      break;
    case 'set':
      live.settings = { ...live.settings, [action.key]: action.value };
      if (action.key === 'character') pickCharacter.value = action.value;
      if (action.key === 'size') pickSize.value = action.value;
      sendOrQueue(live, 'settings', live.settings);
      break;
    // dock / walk-to-prompt move a real window; a frame has nothing to move.
  }
}

const motionOnly = (scenario) =>
  (scenario.steps || []).length > 0 &&
  (scenario.steps || []).every((s) => !s.event && s.action && WINDOW_MOTION.has(s.action.do));

function buildPickers(data) {
  for (const character of data.characters) {
    const option = document.createElement('option');
    option.value = character.id;
    option.textContent = character.label || character.id;
    pickCharacter.appendChild(option);
  }
  for (const size of data.sizes) {
    const option = document.createElement('option');
    option.value = size.id;
    option.textContent = `${size.id} (${size.buddy}px)`;
    pickSize.appendChild(option);
  }
  pickCharacter.value = data.characters.some((c) => c.id === 'fox') ? 'fox' : data.characters[0].id;
  pickSize.value = 'small';
  const apply = (key, value) => {
    live.settings = { ...live.settings, [key]: value };
    sendOrQueue(live, 'settings', live.settings);
  };
  pickCharacter.addEventListener('change', () => apply('character', pickCharacter.value));
  pickSize.addEventListener('change', () => apply('size', pickSize.value));
  document.getElementById('reset-frame').addEventListener('click', loadLiveFrame);
}

/** Every sandbox state as a button, under its group heading. */
function buildScenarioList(scenarios) {
  const groups = new Map();
  for (const scenario of scenarios) {
    const name = scenario.group || 'Other';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(scenario);
  }
  for (const [name, items] of groups) {
    const section = document.createElement('section');
    section.className = 'scenario-group';
    const heading = document.createElement('h3');
    heading.textContent = name;
    section.appendChild(heading);
    for (const scenario of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scenario';
      button.dataset.id = scenario.id;
      const title = document.createElement('b');
      title.textContent = scenario.label;
      const hint = document.createElement('small');
      hint.textContent = motionOnly(scenario)
        ? 'window-motion state — watch it in the app sandbox (npm run sandbox:app)'
        : scenario.hint || '';
      button.append(title, hint);
      if (motionOnly(scenario)) {
        button.disabled = true;
        button.classList.add('motion');
      } else {
        button.addEventListener('click', () =>
          playSteps(scenario.steps || [], scenario.id, scenario.label, button)
        );
      }
      section.appendChild(button);
    }
    scenarioList.appendChild(section);
  }
}

/* ---------------- the lifecycle graph ---------------- */

function graphSettings() {
  return {
    approvals: true, reviewOnStop: true, answerQuestions: true, autoPerch: true,
    character: 'fox', size: 'xs', characters: rendererData.characters, sizes: rendererData.sizes,
  };
}

function mountRenderer(container, item, index, flowId) {
  const iframe = document.createElement('iframe');
  iframe.title = item.title;
  iframe.className = 'renderer-frame';
  const state = {
    kind: 'graph',
    iframe,
    ready: false,
    minHeight: index === 1 ? 204 : 178,
    queue: [['settings', graphSettings()]],
  };
  const event = { ...item.event };
  if (HELD_KINDS.includes(event.kind)) {
    event.requestId = `${flowId}-${index}`;
    event.expiresAt = Date.now() + HOLD_MS;
  }
  state.queue.push(['event', event]);
  if (item.title === 'Prompt running') state.queue.push(['event', { kind: 'pose', pose: 'excited' }]);
  if (item.title === 'Finished response preview') state.queue.push(['event', { kind: 'pose', pose: 'think' }]);
  container.appendChild(iframe);
  register(state);
  iframe.src = rendererUrl(item.title, stageColors[index] || stageColors[0]);
}

function mountPopup(container, item) {
  const iframe = document.createElement('iframe');
  iframe.src = item.url;
  iframe.title = item.title;
  iframe.className = 'popup-frame';
  container.classList.add('popup-preview');
  iframe.addEventListener(
    'load',
    () => {
      iframe.contentDocument.body.classList.add('states-embed');
    },
    { once: true }
  );
  container.appendChild(iframe);
}

function graphSpec() {
  const nodes = [];
  const edges = [];
  const paths = new Map();
  const entries = Object.entries(flows);
  nodes.push(
    { id: 'rest', item: { ...entries[0][1].stages[0], title: 'Resting' }, column: 1, row: 1, index: 0 },
    { id: 'running', item: { ...entries[0][1].stages[1], title: 'Prompt running' }, column: 2, row: 1, index: 1 }
  );
  edges.push({ from: 'rest', to: 'running' });

  entries.forEach(([flowId, flow], rowIndex) => {
    const row = rowIndex + 1;
    const prefix = `${flowId}-`;
    const responseId = `${prefix}response`;
    const outcomeId = `${prefix}outcome`;
    if (flow.stages.length === 3) {
      nodes.push({ id: outcomeId, item: flow.stages[2], column: 3, row, index: 2, number: row });
      edges.push({ from: 'running', to: outcomeId, flow: flowId });
      paths.set(flowId, ['rest', 'running', outcomeId]);
    } else {
      nodes.push(
        { id: responseId, item: flow.stages[2], column: 3, row, index: 2, number: row },
        { id: outcomeId, item: flow.stages[3], column: 4, row, index: 3 }
      );
      edges.push(
        { from: 'running', to: responseId, flow: flowId },
        { from: responseId, to: outcomeId, flow: flowId }
      );
      paths.set(flowId, ['rest', 'running', responseId, outcomeId]);
    }
  });
  return { nodes, edges, paths };
}

/** The graph is also an index: a node hands its own event to the tester. */
function playNode(descriptor, node) {
  const event = descriptor.item.event;
  if (!event) return;
  playSteps(
    [{ event, holdSecs: HELD_KINDS.includes(event.kind) ? 3600 : 0 }],
    `graph-${descriptor.id}`,
    descriptor.item.title || descriptor.item.phase,
    node
  );
}

function mountNode(canvas, descriptor) {
  const node = document.getElementById('stage-template').content.firstElementChild.cloneNode(true);
  node.dataset.node = descriptor.id;
  node.style.gridColumn = String(descriptor.column);
  node.style.gridRow = String(descriptor.row);
  const badge = node.querySelector('.step');
  badge.textContent = descriptor.number || '';
  badge.classList.toggle('empty', !descriptor.number);
  const title = descriptor.item.title || descriptor.item.phase;
  node.querySelector('h3').textContent = title;
  const preview = node.querySelector('.preview');
  if (descriptor.item.url) {
    // The reader is a window of its own; the node keeps showing it inline and
    // the corner link opens the real page.
    node.setAttribute('aria-label', `${title}. Focus to show connections.`);
    const open = document.createElement('a');
    open.className = 'node-action';
    open.href = descriptor.item.url;
    open.target = '_blank';
    open.rel = 'noreferrer';
    open.textContent = '↗';
    open.title = 'Open the reader on its own';
    node.querySelector('header').appendChild(open);
    mountPopup(preview, descriptor.item);
  } else {
    node.classList.add('playable');
    node.setAttribute('aria-label', `${title}. Play it in the live tester; focus to show connections.`);
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'node-action';
    play.textContent = '▶';
    play.title = 'Play this state in the live tester';
    node.querySelector('header').appendChild(play);
    // The preview is an iframe and swallows its own clicks, so the header is
    // the target — the ▶ bubbles into the same handler.
    node.addEventListener('click', () => playNode(descriptor, node));
    node.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target !== node) return;
      e.preventDefault();
      playNode(descriptor, node);
    });
    mountRenderer(preview, descriptor.item, descriptor.index, descriptor.id);
  }
  node.addEventListener('mouseenter', () => showConnections(descriptor.id));
  node.addEventListener('mouseleave', clearConnections);
  node.addEventListener('focusin', () => showConnections(descriptor.id));
  node.addEventListener('focusout', clearConnections);
  canvas.appendChild(node);
}

function drawConnections(canvas, edges) {
  const old = canvas.querySelector('.connections');
  old?.remove();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('connections');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', String(canvas.scrollWidth));
  svg.setAttribute('height', String(canvas.scrollHeight));
  svg.setAttribute('viewBox', `0 0 ${canvas.scrollWidth} ${canvas.scrollHeight}`);
  for (const edge of edges) {
    const from = canvas.querySelector(`[data-node="${edge.from}"]`).getBoundingClientRect();
    const to = canvas.querySelector(`[data-node="${edge.to}"]`).getBoundingClientRect();
    const box = canvas.getBoundingClientRect();
    const x1 = from.right - box.left + canvas.scrollLeft;
    const y1 = from.top + from.height / 2 - box.top;
    const x2 = to.left - box.left + canvas.scrollLeft;
    const y2 = to.top + to.height / 2 - box.top;
    const bend = Math.max(32, (x2 - x1) * 0.48);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 8} ${y2}`);
    path.classList.add('connection');
    path.dataset.from = edge.from;
    path.dataset.to = edge.to;
    if (edge.flow) path.dataset.flow = edge.flow;
    svg.appendChild(path);
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', `M ${x2 - 15} ${y2 - 5} L ${x2 - 8} ${y2} L ${x2 - 15} ${y2 + 5}`);
    arrow.classList.add('connection', 'arrowhead');
    arrow.dataset.from = edge.from;
    arrow.dataset.to = edge.to;
    if (edge.flow) arrow.dataset.flow = edge.flow;
    svg.appendChild(arrow);
  }
  canvas.prepend(svg);
}

function showConnections(nodeId) {
  for (const edge of document.querySelectorAll('.connection')) {
    edge.classList.toggle('relevant', edge.dataset.from === nodeId || edge.dataset.to === nodeId);
  }
}

function clearConnections() {
  document.querySelectorAll('.connection.relevant').forEach((edge) => edge.classList.remove('relevant'));
}

function scheduleConnections() {
  cancelAnimationFrame(drawFrame);
  drawFrame = requestAnimationFrame(() => {
    const canvas = document.querySelector('.graph-canvas');
    if (canvas) drawConnections(canvas, currentEdges);
  });
}

function renderAllFlows() {
  const spec = graphSpec();
  graphPaths = spec.paths;
  currentEdges = spec.edges;
  const canvas = document.createElement('div');
  canvas.className = 'graph-canvas lifecycle';
  canvas.setAttribute('role', 'group');
  canvas.setAttribute('aria-label', 'Fox response lifecycle');
  spec.nodes.forEach((node) => mountNode(canvas, node));
  flowList.appendChild(canvas);
  scheduleConnections();
}

function playAll() {
  for (const timer of playTimers.values()) clearTimeout(timer);
  playTimers.clear();
  const stages = [...document.querySelectorAll('.stage')];
  const paths = [...graphPaths.values()];
  const showStep = (index) => {
    stages.forEach((node) => {
      const at = paths.some((path) => path[index] === node.dataset.node);
      node.classList.toggle('active', at);
    });
    document.querySelectorAll('.connection').forEach((edge) => {
      const active = paths.some((path) => path[index - 1] === edge.dataset.from && path[index] === edge.dataset.to);
      edge.classList.toggle('relevant', active);
    });
    if (index < 3) {
      const timer = setTimeout(() => showStep(index + 1), 1400);
      playTimers.set(index, timer);
    }
  };
  showStep(0);
}

function resetAllFlows() {
  for (const timer of playTimers.values()) clearTimeout(timer);
  playTimers.clear();
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].kind === 'graph') frames.splice(i, 1);
  }
  flowList.replaceChildren();
  renderAllFlows();
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.__clippyDemo !== true) return;
  const state = frames.find((frame) => frame.iframe.contentWindow === event.source);
  if (!state) return;
  if (message.type === 'ready') {
    state.ready = true;
    for (const [type, payload] of state.queue.splice(0)) {
      if (type === '__timer__') live.timers.push(setTimeout(payload.fire, payload.wait));
      else post(event.source, type, payload);
    }
    // The renderer starts with its production Clippy default, then receives
    // this page's setting over postMessage. Keep that first paint out of sight
    // so the running state never flashes the wrong buddy.
    setTimeout(() => state.iframe.classList.add('ready'), 80);
  } else if (message.type === 'mode') {
    const height = Number(message.payload?.height);
    if (!height) return;
    if (state.kind === 'live') {
      // The frame reports how tall its contents want to be — the same number
      // main resizes the real window to. Compact reports one too, so a Large
      // buddy is never clipped, and the floor keeps the stage from collapsing.
      state.iframe.style.height = `${Math.max(COMPACT_H, height)}px`;
      return;
    }
    state.iframe.style.height = `${Math.min(420, Math.max(state.minHeight, height))}px`;
    scheduleConnections();
  }
});

document.getElementById('play-all').addEventListener('click', () => {
  playAll();
});
document.getElementById('reset-all').addEventListener('click', resetAllFlows);

window.addEventListener('resize', () => {
  scheduleConnections();
});

fetch('/api/scenarios')
  .then((response) => response.json())
  .then(async (data) => {
    rendererData = data;
    usagePayload = data.usage && (data.usage.noplan || Object.values(data.usage)[0]);
    register(live);
    buildPickers(data);
    buildScenarioList(data.scenarios || []);
    loadLiveFrame();
    await preloadStageImages();
    renderAllFlows();
  });
