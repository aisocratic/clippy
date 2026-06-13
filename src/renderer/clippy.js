'use strict';

const REMIND_AFTER_MS = 90 * 1000; // re-bounce if a session is still ignored
const SNOOZE_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 1000;
const EXTEND_THROTTLE_MS = 5 * 1000; // while typing, ask main to extend the hold

const clippyEl = document.getElementById('clippy');
const bubbleEl = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const badgeEl = document.getElementById('badge');
const statusEl = document.getElementById('statusline');

const cardEl = document.getElementById('card');
const cardSession = document.getElementById('card-session');
const cardQueue = document.getElementById('card-queue');
const cardTitle = document.getElementById('card-title');
const cardDetail = document.getElementById('card-detail');
const cardOptions = document.getElementById('card-options');
const cardInput = document.getElementById('card-input');
const countdownFill = document.getElementById('card-countdown-fill');
const btnAllow = document.getElementById('btn-allow');
const btnDeny = document.getElementById('btn-deny');
const btnPass = document.getElementById('btn-pass');
const btnGood = document.getElementById('btn-good');
const btnFeedback = document.getElementById('btn-feedback');
const btnSubmit = document.getElementById('btn-submit');
const btnDismiss = document.getElementById('btn-dismiss');

const driveEl = document.getElementById('drive');
const driveTitle = document.getElementById('drive-title');
const driveTranscript = document.getElementById('drive-transcript');
const driveActivity = document.getElementById('drive-activity');
const driveInput = document.getElementById('drive-input');
const toggleApprovals = document.getElementById('toggle-approvals');
const toggleReview = document.getElementById('toggle-review');

const activityEl = document.getElementById('activity');
const qcardEl = document.getElementById('qcard');
const qcardSession = document.getElementById('qcard-session');
const qcardTitle = document.getElementById('qcard-title');
const qcardDetail = document.getElementById('qcard-detail');

// sessionId -> { message, urgency, name, lastNudge, snoozedUntil, acknowledged }
const pending = new Map();
// requestId -> { id, type: 'approval'|'review', name, title, detail, expiresAt, holdMs }
const requests = new Map();
let activeRequestId = null;
let counts = { total: 0, waiting: 0 };
let settings = { approvals: true, reviewOnStop: true };
let lastExtendAt = 0;

/* ---------- UI helpers ---------- */

function setExcited(on) {
  clippyEl.classList.toggle('excited', on);
}

function showBubble(text) {
  bubbleText.textContent = text;
  bubbleEl.classList.remove('hidden');
}

function hideBubble() {
  bubbleEl.classList.add('hidden');
  if (!activeRequestId) setExcited(false);
}

function render() {
  const active = [...pending.values()].filter((p) => !p.acknowledged);
  const open = active.length + requests.size;
  badgeEl.textContent = String(open);
  badgeEl.classList.toggle('hidden', open === 0);

  if (counts.total === 0) {
    statusEl.textContent = 'no sessions yet — start claude in a terminal';
  } else {
    statusEl.textContent =
      `${counts.total} session${counts.total === 1 ? '' : 's'}` +
      (counts.waiting ? ` · ${counts.waiting} waiting for you` : ' · all busy');
  }

  toggleApprovals.classList.toggle('on', settings.approvals);
  toggleReview.classList.toggle('on', settings.reviewOnStop);
  toggleApprovals.textContent = `${settings.approvals ? '✓' : '✗'} approvals`;
  toggleReview.textContent = `${settings.reviewOnStop ? '✓' : '✗'} review`;
}

function nudge(p) {
  p.lastNudge = Date.now();
  if (activeRequestId) return; // an interactive card owns the stage right now
  showBubble(p.message);
  setExcited(p.urgency === 'urgent');
  if (p.urgency !== 'urgent') {
    // brief hop even for gentle news
    setExcited(true);
    setTimeout(() => {
      if (!currentUrgent()) setExcited(false);
    }, 1600);
  }
}

function currentUrgent() {
  return [...pending.values()].some((p) => !p.acknowledged && p.urgency === 'urgent');
}

/* ---------- Ambient activity line ("what's Claude doing right now") ---------- */

function showActivity(name, activity) {
  if (!activity || !activity.label) {
    activityEl.classList.add('hidden');
    return;
  }
  const icon = !activity.ok ? '⚠' : activity.state === 'done' ? '✓' : '⚙';
  activityEl.textContent = `${icon} ${name} — ${activity.label}`;
  activityEl.classList.toggle('failed', !activity.ok);
  activityEl.classList.remove('hidden');
}

function clearActivity() {
  activityEl.classList.add('hidden');
  activityEl.classList.remove('failed');
}

/* ---------- Read-only question card (AskUserQuestion surfacing) ---------- */

function showQuestion(evt) {
  qcardSession.textContent = `📎 ${evt.name}`;
  qcardTitle.textContent = evt.title || 'Claude is asking you a question';
  qcardDetail.textContent = evt.detail || '';
  qcardDetail.classList.toggle('hidden', !evt.detail);
  qcardEl.classList.remove('hidden');
  setExcited(true);
}

function hideQuestion() {
  qcardEl.classList.add('hidden');
  if (!activeRequestId) setExcited(currentUrgent());
}

/* ---------- Drive mode panel (Clippy-driven Agent SDK session) ---------- */

function openDrive(evt) {
  driveTitle.textContent = `📎 Driving “${evt.name}”`;
  driveTranscript.innerHTML = '';
  driveActivity.classList.add('hidden');
  driveEl.classList.remove('hidden');
}

function closeDrive() {
  driveEl.classList.add('hidden');
  driveActivity.classList.add('hidden');
}

function setDriveStatus(evt) {
  if (evt.status === 'error') addDriveLine('system', `⚠ ${evt.message || 'error'}`);
  else if (evt.status === 'ended') addDriveLine('system', '— session ended —');
  else if (evt.status === 'turn-done') driveActivity.classList.add('hidden');
}

function addDriveLine(role, text) {
  if (!text) return;
  const line = document.createElement('div');
  line.className = `drive-line ${role}`;
  line.textContent = (role === 'user' ? 'you: ' : role === 'system' ? '' : 'claude: ') + text;
  driveTranscript.appendChild(line);
  driveTranscript.scrollTop = driveTranscript.scrollHeight;
}

/* ---------- Interactive cards (approvals & reviews) ---------- */

function showNextRequest() {
  const next = requests.values().next().value;
  if (!next) {
    activeRequestId = null;
    cardEl.classList.add('hidden');
    setExcited(currentUrgent());
    // surface whatever passive nudge was waiting behind the card
    const p = [...pending.values()].find((x) => !x.acknowledged);
    if (p) nudge(p);
    return;
  }

  activeRequestId = next.id;
  hideBubble();
  qcardEl.classList.add('hidden'); // a held card takes the stage

  const isApproval = next.type === 'approval';
  const isAnswer = next.type === 'answer';
  const isPlan = next.variant === 'plan';
  cardSession.textContent = `📎 ${next.name}`;
  cardQueue.classList.toggle('hidden', requests.size <= 1);
  cardQueue.textContent = `+${requests.size - 1} more`;
  cardTitle.textContent = next.title;

  // Answerable multiple-choice question (Drive mode only — option buttons).
  if (isAnswer) {
    cardDetail.classList.add('hidden');
    cardInput.classList.add('hidden');
    renderAnswerOptions(next);
    for (const b of [btnAllow, btnDeny, btnPass, btnGood, btnFeedback]) b.classList.add('hidden');
    btnSubmit.classList.remove('hidden');
    btnDismiss.classList.remove('hidden');
    cardEl.classList.remove('hidden');
    setExcited(true);
    return;
  }

  cardOptions.classList.add('hidden');
  cardOptions.innerHTML = '';
  cardInput.classList.remove('hidden');
  btnSubmit.classList.add('hidden');
  btnDismiss.classList.add('hidden');

  cardDetail.textContent = next.detail || '';
  cardDetail.classList.toggle('hidden', !next.detail);
  cardInput.value = '';
  cardInput.placeholder = isPlan
    ? 'optional: what to change before approving (Revise sends this back)…'
    : isApproval
    ? 'optional: tell Claude why, or what to do instead…'
    : 'type feedback to send Claude back to work…';
  // Plan approvals reuse the allow/deny path but read better as Approve/Revise.
  btnAllow.textContent = isPlan ? 'Approve plan' : 'Allow';
  btnDeny.textContent = isPlan ? 'Revise' : 'Deny';
  btnAllow.classList.toggle('hidden', !isApproval);
  btnDeny.classList.toggle('hidden', !isApproval);
  btnPass.classList.toggle('hidden', !isApproval || next.noPass); // Drive has no terminal
  btnGood.classList.toggle('hidden', isApproval);
  btnFeedback.classList.toggle('hidden', isApproval);
  btnFeedback.disabled = true;

  cardEl.classList.remove('hidden');
  setExcited(true);
}

// answers map for the active answer card: questionText -> label | [labels]
let answerState = {};

function renderAnswerOptions(req) {
  answerState = {};
  cardOptions.innerHTML = '';
  for (const q of req.questions || []) {
    answerState[q.question] = q.multiSelect ? [] : null;
    const group = document.createElement('div');
    group.className = 'opt-group';
    const label = document.createElement('div');
    label.className = 'opt-question';
    label.textContent = q.question;
    group.appendChild(label);
    for (const opt of q.options || []) {
      const btn = document.createElement('button');
      btn.className = 'opt';
      btn.textContent = opt.label;
      if (opt.description) btn.title = opt.description;
      btn.addEventListener('click', () => {
        if (q.multiSelect) {
          const sel = answerState[q.question];
          const i = sel.indexOf(opt.label);
          if (i >= 0) sel.splice(i, 1);
          else sel.push(opt.label);
          btn.classList.toggle('chosen', i < 0);
        } else {
          answerState[q.question] = opt.label;
          [...group.querySelectorAll('.opt')].forEach((b) => b.classList.remove('chosen'));
          btn.classList.add('chosen');
        }
        btnSubmit.disabled = !answersComplete();
      });
      group.appendChild(btn);
    }
    cardOptions.appendChild(group);
  }
  cardOptions.classList.remove('hidden');
  btnSubmit.disabled = !answersComplete();
}

function answersComplete() {
  return Object.values(answerState).every((v) => (Array.isArray(v) ? v.length > 0 : v != null));
}

function decide(action, message = '') {
  if (!activeRequestId) return;
  window.clippyAPI.decide(activeRequestId, action, message);
  requests.delete(activeRequestId);
  showNextRequest();
  render();
}

// Shrink the countdown bar; main resolves the request server-side on timeout,
// this is just so the user can see how long Clippy can wait.
setInterval(() => {
  if (!activeRequestId) return;
  const req = requests.get(activeRequestId);
  if (!req) return;
  const left = Math.max(0, req.expiresAt - Date.now());
  countdownFill.style.width = `${Math.min(100, (left / req.holdMs) * 100)}%`;
}, 200);

/* ---------- Event handling from main process ---------- */

window.clippyAPI.onSettings((s) => {
  settings = s;
  render();
});

function handleEvent(evt) {
  if (evt.counts) counts = evt.counts;

  switch (evt.kind) {
    case 'approval':
    case 'review': {
      requests.set(evt.requestId, {
        id: evt.requestId,
        type: evt.kind,
        variant: evt.variant || 'tool',
        noPass: !!evt.noPass,
        name: evt.name,
        title: evt.kind === 'approval' ? evt.title : evt.message,
        detail: evt.detail || '',
        expiresAt: evt.expiresAt,
        holdMs: Math.max(1, evt.expiresAt - Date.now()),
      });
      if (!activeRequestId) showNextRequest();
      else cardQueue.classList.remove('hidden');
      break;
    }
    case 'answer': {
      // Drive mode: an answerable multiple-choice question (option buttons).
      requests.set(evt.requestId, {
        id: evt.requestId,
        type: 'answer',
        name: evt.name,
        title: evt.title || 'Claude is asking you',
        questions: evt.questions || [],
        expiresAt: evt.expiresAt || Date.now() + 300000,
        holdMs: 300000,
      });
      if (!activeRequestId) showNextRequest();
      else cardQueue.classList.remove('hidden');
      break;
    }
    case 'drive-open':
      openDrive(evt);
      break;
    case 'drive-close':
      closeDrive();
      break;
    case 'drive-status':
      setDriveStatus(evt);
      break;
    case 'drive-transcript':
      addDriveLine(evt.role, evt.text);
      break;
    case 'drive-activity':
      driveActivity.textContent = `⚙ ${evt.label || ''}`;
      driveActivity.classList.toggle('hidden', !evt.label);
      break;
    case 'activity': {
      showActivity(evt.name, evt.activity);
      break;
    }
    case 'question': {
      // Surface-only: hooks can't answer AskUserQuestion (that's Drive mode).
      showQuestion(evt);
      break;
    }
    case 'request-closed': {
      // resolved elsewhere: timeout, terminal answer, or session moved on
      if (requests.delete(evt.requestId) && evt.requestId === activeRequestId) {
        showNextRequest();
      }
      break;
    }
    case 'extended': {
      const req = requests.get(evt.requestId);
      if (req) {
        req.expiresAt = evt.expiresAt;
        req.holdMs = Math.max(req.holdMs, evt.expiresAt - Date.now());
      }
      break;
    }
    case 'attention': {
      const p = {
        message: evt.message,
        urgency: evt.urgency,
        name: evt.name,
        lastNudge: 0,
        snoozedUntil: 0,
        acknowledged: false,
      };
      pending.set(evt.sessionId, p);
      nudge(p);
      break;
    }
    case 'clear': // user typed a prompt — that session no longer needs us
      pending.delete(evt.sessionId);
      hideQuestion();
      showActivity(evt.name, evt.activity); // "Working…"
      if (pending.size === 0 || ![...pending.values()].some((p) => !p.acknowledged)) {
        hideBubble();
      }
      break;
    case 'remove': {
      pending.delete(evt.sessionId);
      hideQuestion();
      clearActivity();
      if (pending.size === 0 || ![...pending.values()].some((p) => !p.acknowledged)) {
        hideBubble();
      }
      break;
    }
    case 'info':
      if (!activeRequestId) {
        showBubble(evt.message);
        setTimeout(() => {
          if (!activeRequestId && ![...pending.values()].some((p) => !p.acknowledged)) {
            hideBubble();
          }
        }, 4000);
      }
      break;
  }
  render();
}

window.clippyAPI.onEvent(handleEvent);

/* ---------- Reminder loop: Clippy doesn't give up ---------- */

setInterval(() => {
  const now = Date.now();
  for (const p of pending.values()) {
    if (p.acknowledged || now < p.snoozedUntil) continue;
    if (now - p.lastNudge >= REMIND_AFTER_MS) {
      p.message = p.message.startsWith('Still ')
        ? p.message
        : `Still here! ${p.message}`;
      nudge(p);
    }
  }
}, CHECK_INTERVAL_MS);

/* ---------- Buttons ---------- */

btnAllow.addEventListener('click', () => decide('allow', cardInput.value.trim()));
btnDeny.addEventListener('click', () => decide('deny', cardInput.value.trim()));
btnPass.addEventListener('click', () => decide('pass'));
btnGood.addEventListener('click', () => decide('ok'));
btnFeedback.addEventListener('click', () => {
  const msg = cardInput.value.trim();
  if (msg) decide('feedback', msg);
});
btnSubmit.addEventListener('click', () => {
  if (answersComplete()) decide('answer', JSON.stringify(answerState));
});
btnDismiss.addEventListener('click', () => decide('dismiss'));

document.getElementById('drive-send').addEventListener('click', sendDrivePrompt);
document.getElementById('drive-stop').addEventListener('click', () => window.clippyAPI.driveStop());
driveInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendDrivePrompt();
});

function sendDrivePrompt() {
  const text = driveInput.value.trim();
  if (!text) return;
  window.clippyAPI.drivePrompt(text);
  driveInput.value = '';
}

// Typing a reason takes time — keep asking main to hold the hook a bit longer.
cardInput.addEventListener('input', () => {
  btnFeedback.disabled = !cardInput.value.trim();
  const now = Date.now();
  if (activeRequestId && now - lastExtendAt > EXTEND_THROTTLE_MS) {
    lastExtendAt = now;
    window.clippyAPI.extend(activeRequestId);
  }
});

document.getElementById('btn-qok').addEventListener('click', hideQuestion);

toggleApprovals.addEventListener('click', () => {
  window.clippyAPI.setSetting('approvals', !settings.approvals);
});
toggleReview.addEventListener('click', () => {
  window.clippyAPI.setSetting('reviewOnStop', !settings.reviewOnStop);
});

document.getElementById('btn-ok').addEventListener('click', () => {
  for (const p of pending.values()) p.acknowledged = true;
  hideBubble();
  render();
});

document.getElementById('btn-snooze').addEventListener('click', () => {
  const until = Date.now() + SNOOZE_MS;
  for (const p of pending.values()) p.snoozedUntil = until;
  hideBubble();
  render();
});

document.getElementById('btn-hide').addEventListener('click', () => {
  window.clippyAPI.hide();
});

// Clicking Clippy re-opens the bubble with whatever is pending.
clippyEl.addEventListener('click', () => {
  if (activeRequestId) return; // the card is already the main attraction
  const next = [...pending.values()].find((p) => !p.acknowledged) || [...pending.values()][0];
  if (next) nudge(next);
});

/* ---------- Idle life: blinking & wandering pupils ---------- */

const eyes = [...document.querySelectorAll('.eye')];
const pupils = [...document.querySelectorAll('.pupil')];

setInterval(() => {
  eyes.forEach((e) => e.classList.add('blink'));
  setTimeout(() => eyes.forEach((e) => e.classList.remove('blink')), 140);
}, 3800 + Math.random() * 1500);

setInterval(() => {
  const dx = (Math.random() * 6 - 3).toFixed(1);
  const dy = (Math.random() * 4 - 2).toFixed(1);
  pupils.forEach((p) => (p.style.transform = `translate(${dx}px, ${dy}px)`));
}, 2600);

render();
