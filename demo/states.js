'use strict';

const HOLD_MS = 60 * 60 * 1000;
const frames = new Map();
const flowList = document.getElementById('flows');
const playTimers = new Map();
let rendererData;
let currentView = 'each';
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

const flows = {
  complete: {
    label: 'Successful response',
    description: 'A normal prompt finishes with a compact response preview, then opens the complete prompt and response.',
    popupContract: 'Click Read: hide the mini review and open the complete prompt/response reader with the buddy and reply controls.',
    stages: [
      stage('Resting', 'Small Clippy', idle(), 'No prompt is active yet.', ['status: idle', 'card: hidden']),
      stage('Prompt running', 'Editing and testing', working('Edit', 'Editing webhook.js'), 'The prompt is in progress and tool activity replaces the idle label.', ['status: working', 'activity: Edit']),
      stage('Response', 'Finished response preview', base({
        kind: 'review', status: 'waiting', title: 'Claude Finished',
        prompt: 'Make invoice posting resilient to transient failures and add coverage for retries.',
        message: 'Claude finished: “Added retry with backoff to the billing webhook — 42 tests pass.”',
        detail: 'Added `withRetry()` around postInvoice — 3 attempts with exponential backoff, 200ms base, and 409 treated as success. Both paths are covered and all 42 tests pass.',
      }), 'A compact gray block shows part of the prompt and response.', ['card: review', 'actions: Reply · Looks good · Read']),
      popup('Expanded popup', 'Read All', '/reader/?flow=complete', 'The full prompt and response move into the reader; the mini popup closes.', ['mini: hidden', 'reader: open', 'buddy: moved']),
    ],
  },
  permission: {
    label: 'Tool permission',
    description: 'A running prompt pauses because the agent needs approval before it can use a tool.',
    popupContract: 'The urgent response expands into the permission card. It has no separate Read All window; the card already contains the actionable detail.',
    stages: [
      stage('Resting', 'Small Clippy', idle(), 'No prompt is active yet.', ['status: idle']),
      stage('Prompt running', 'Preparing a command', working('Bash', 'Running: prepare stale fixture cleanup'), 'The agent reaches a tool that needs permission.', ['status: working', 'activity: Bash']),
      stage('Action popup', 'Approve tool use', base({ kind: 'approval', status: 'needs_permission', variant: 'tool', tool: 'Bash', title: 'Run: delete stale invoice fixtures', detail: '$ rm -rf test/fixtures/invoices/*.json' }), 'The actionable popup contains the command and decision buttons.', ['card: approval', 'actions: Allow · Deny']),
    ],
  },
  plan: {
    label: 'Plan review',
    description: 'A planning prompt finishes with a plan that must be approved or sent back for revision.',
    popupContract: 'The response expands directly into the plan-review card. The plan text scrolls inside the card; there is no second reader window.',
    stages: [
      stage('Resting', 'Small Clippy', idle(), 'No prompt is active yet.', ['status: idle']),
      stage('Prompt running', 'Drafting a plan', working('Read', 'Reading webhook and test structure'), 'Clippy reports the work used to form the plan.', ['status: working', 'activity: Read']),
      stage('Review popup', 'Approve the plan', base({ kind: 'approval', status: 'needs_permission', variant: 'plan', tool: 'ExitPlanMode', title: '📋 Review the plan', detail: '## Add retry to the billing webhook\n\n1. Add exponential backoff.\n2. Treat 409 as success.\n3. Log retry attempts.\n4. Cover both paths in tests.' }), 'The full plan and Approve plan / Revise controls appear.', ['card: plan', 'actions: Approve · Revise']),
    ],
  },
  question: {
    label: 'Agent question',
    description: 'The agent cannot continue until the user chooses an answer or writes a custom one.',
    popupContract: 'The response expands into the answer card. Submitting a choice closes it and sends the structured answer back to the active prompt.',
    stages: [
      stage('Resting', 'Small Clippy', idle(), 'No prompt is active yet.', ['status: idle']),
      stage('Prompt running', 'Evaluating retry options', working('Read', 'Comparing retry strategies'), 'The agent works until it reaches a decision only the user can make.', ['status: working', 'activity: Read']),
      stage('Answer popup', 'Choose a retry strategy', base({ kind: 'answer', status: 'waiting', title: 'Which retry strategy?', questions: [{ question: 'Which retry strategy should the webhook use?', header: 'Strategy', multiSelect: false, options: [{ label: 'Exponential backoff', description: 'Three attempts, 200ms base.' }, { label: 'Fixed interval', description: 'Retry every second.' }, { label: 'No retry', description: 'Fail fast and alert.' }] }] }), 'The popup exposes the choices and returns the selected value to the prompt.', ['card: answer', 'actions: Submit · Terminal']),
    ],
  },
  failure: {
    label: 'Failed / blocked',
    description: 'A tool fails during a prompt; Clippy shows the failure state and can open the complete activity detail.',
    popupContract: 'Open the activity detail: keep the failed state visible in history and show the complete error output in a read-only reader.',
    stages: [
      stage('Resting', 'Small Clippy', idle(), 'No prompt is active yet.', ['status: idle']),
      stage('Prompt running', 'Running the test suite', working('Bash', 'Running: npm test'), 'The command is active and the prompt is still running.', ['status: working', 'activity: Bash']),
      stage('Response', 'Tool failed', base({ kind: 'failure', status: 'working', title: 'Bash failed · npm test', detail: 'Expected retry count: 3. Received retry count: 1. The webhook stopped after the first 503 response.', activity: { tool: 'Bash', label: 'Running: npm test', state: 'done', ok: false, error: 'Expected retry count: 3. Received retry count: 1.' } }), 'A compact problem preview names the failure and offers Read for the complete output.', ['card: failure', 'action: Read']),
      popup('Expanded popup', 'Failure details', '/reader/?flow=failure', 'A read-only activity reader shows the complete command failure.', ['reader: open', 'review actions: hidden']),
    ],
  },
};

function stage(phase, title, event, description, changes) {
  return { phase, title, event, description, changes };
}

function popup(phase, title, url, description, changes) {
  return { phase, title, url, description, changes };
}

function rendererUrl(name, color) {
  return `/renderer/?name=${encodeURIComponent(name)}&color=${encodeURIComponent(color)}&pet=Fox`;
}

// Clippy's built-in GIFs are pre-rendered for this palette. Using an arbitrary
// design color here produces a valid-looking URL for an image that cannot
// exist, which leaves a broken buddy in the preview.
const stageColors = ['#9aa3ad', '#59b9ae', '#4fa3d1', '#6cbf6c'];
const screenAgents = [
  { name: 'billing-api', color: '#4fa3d1', character: 'Fox', art: 'fox', sheet: true, log: 'Finished invoice retry changes' },
  { name: 'webhooks', color: '#59b9ae', character: 'Pixel cat', art: '/renderer/assets/themes/cat/idle.gif', log: 'Waiting for tool permission' },
  { name: 'plans', color: '#c264c9', character: 'Clod', art: '/renderer/assets/themes/clod/idle.gif', log: 'Plan ready for review' },
  { name: 'retries', color: '#d4b03c', character: 'Clippy', art: '/renderer/assets/themes/clip/d4b03c-idle.gif', log: 'Question waiting' },
  { name: 'tests', color: '#e0605f', character: 'Azure', art: 'azure', sheet: true, log: 'Test command failed' },
];

function preloadStageImages() {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = resolve;
    image.onerror = resolve;
    image.src = '/renderer/assets/themes/fox/spritesheet.webp';
  });
}

function settings() {
  return {
    approvals: true, reviewOnStop: true, answerQuestions: true, autoPerch: true,
    character: 'fox', size: 'xs', characters: rendererData.characters, sizes: rendererData.sizes,
  };
}

function mountRenderer(container, item, index, flowId) {
  const iframe = document.createElement('iframe');
  iframe.title = item.title;
  iframe.className = 'renderer-frame';
  const state = { iframe, minHeight: index === 1 ? 204 : 178, queue: [['settings', settings()]] };
  const event = { ...item.event };
  if (['review', 'approval', 'answer'].includes(event.kind)) {
    event.requestId = `${flowId}-${index}`;
    event.expiresAt = Date.now() + HOLD_MS;
  }
  state.queue.push(['event', event]);
  if (item.title === 'Prompt running') state.queue.push(['event', { kind: 'pose', pose: 'excited' }]);
  if (item.title === 'Finished response preview') state.queue.push(['event', { kind: 'pose', pose: 'think' }]);
  iframe.src = rendererUrl(item.title, stageColors[index] || stageColors[0]);
  iframe.addEventListener(
    'load',
    () => {
      frames.set(iframe.contentWindow, state);
      iframe.contentDocument.documentElement.classList.add('states-graph');
      iframe.contentDocument.body.classList.add('states-graph');
    },
    { once: true }
  );
  container.appendChild(iframe);
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

function mountNode(canvas, descriptor) {
  const node = document.getElementById('stage-template').content.firstElementChild.cloneNode(true);
  node.dataset.node = descriptor.id;
  node.style.gridColumn = String(descriptor.column);
  node.style.gridRow = String(descriptor.row);
  const badge = node.querySelector('.step');
  badge.textContent = descriptor.number || '';
  badge.classList.toggle('empty', !descriptor.number);
  node.querySelector('h3').textContent = descriptor.item.title || descriptor.item.phase;
  node.setAttribute('aria-label', `${descriptor.item.title || descriptor.item.phase}. Focus to show connections.`);
  const preview = node.querySelector('.preview');
  if (descriptor.item.url) mountPopup(preview, descriptor.item);
  else mountRenderer(preview, descriptor.item, descriptor.index, descriptor.id);
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

function screenBuddy(agent, shared = false) {
  const appearance = shared ? screenAgents[0] : agent;
  const buddy = document.createElement('div');
  buddy.className = `screen-buddy${shared ? ' shared' : ''}`;
  const art = document.createElement(appearance.sheet ? 'div' : 'img');
  art.className = `screen-buddy-art${appearance.sheet ? ` sheet ${appearance.art}` : ''}`;
  if (appearance.sheet) art.setAttribute('aria-hidden', 'true');
  else {
    art.src = appearance.art;
    art.alt = '';
  }
  const label = document.createElement('span');
  label.textContent = shared ? 'Fox · all sessions' : `${appearance.character} · ${agent.name}`;
  buddy.append(art, label);
  if (shared) {
    const dots = document.createElement('div');
    dots.className = 'agent-dots';
    dots.setAttribute('aria-label', `${screenAgents.length} sessions`);
    for (const item of screenAgents) {
      const dot = document.createElement('i');
      dot.style.setProperty('--agent', item.color);
      dots.appendChild(dot);
    }
    buddy.appendChild(dots);
  } else {
    const dot = document.createElement('i');
    dot.className = 'agent-dot';
    dot.style.setProperty('--agent', agent.color);
    buddy.appendChild(dot);
  }
  return buddy;
}

function sharedAgentLog() {
  const panel = document.createElement('section');
  panel.className = 'agent-log';
  panel.setAttribute('aria-label', 'Recent activity from each agent');
  const title = document.createElement('strong');
  title.textContent = 'Agent activity';
  panel.appendChild(title);
  for (const agent of screenAgents) {
    const row = document.createElement('div');
    row.className = 'agent-log-row';
    const dot = document.createElement('i');
    dot.style.setProperty('--agent', agent.color);
    const copy = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = agent.name;
    const status = document.createElement('small');
    status.textContent = agent.log;
    copy.append(name, status);
    row.append(dot, copy);
    panel.appendChild(row);
  }
  return panel;
}

function renderOnScreen() {
  const each = currentView === 'each';
  const host = document.getElementById('screen-buddies');
  host.classList.toggle('shared-mode', !each);
  host.replaceChildren(
    ...(each
      ? screenAgents.map((agent) => screenBuddy(agent))
      : [screenBuddy(null, true), sharedAgentLog()])
  );
  document.getElementById('screen-title').textContent = each ? 'One each' : 'One for all';
  document.getElementById('mode-note').textContent = each
    ? 'A buddy per session, side by side — every agent has its own face, colour and spot on screen. Best when you want to see at a glance how many are running.'
    : "A single buddy that speaks for whichever agent needs you, wearing that agent's name, colour and face while it does. Best when several agents are running and you would rather not have a desk full of paperclips.";
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
  renderOnScreen();
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
      node.classList.toggle('visited', paths.some((path) => path.slice(0, index).includes(node.dataset.node)));
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
  frames.clear();
  flowList.replaceChildren();
  renderAllFlows();
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.__clippyDemo !== true) return;
  const state = frames.get(event.source);
  if (!state) return;
  if (message.type === 'ready') {
    for (const [type, payload] of state.queue.splice(0)) {
      event.source.postMessage({ __clippyDemo: true, type, payload }, '*');
    }
    // The renderer starts with its production Clippy default, then receives
    // this preview's Fox setting over postMessage. Keep that first paint out
    // of sight so the running state never flashes the wrong buddy.
    setTimeout(() => state.iframe.classList.add('ready'), 80);
  } else if (message.type === 'mode') {
    const height = Number(message.payload?.height);
    if (height) {
      state.iframe.style.height = `${Math.min(420, Math.max(state.minHeight, height))}px`;
      scheduleConnections();
    }
  }
});

document.getElementById('play-all').addEventListener('click', () => {
  playAll();
});
document.getElementById('reset-all').addEventListener('click', resetAllFlows);
document.querySelectorAll('.view-option').forEach((button) => {
  button.addEventListener('click', () => {
    currentView = button.dataset.view;
    document.querySelectorAll('.view-option').forEach((option) => {
      const selected = option === button;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-pressed', String(selected));
    });
    renderOnScreen();
  });
});

window.addEventListener('resize', () => {
  scheduleConnections();
});

fetch('/api/scenarios')
  .then((response) => response.json())
  .then(async (data) => {
    rendererData = data;
    await preloadStageImages();
    renderAllFlows();
  });
