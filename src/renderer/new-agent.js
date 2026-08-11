'use strict';

/**
 * The "start an agent somewhere" form.
 *
 * A tray menu can hold a folder picker but not a text field, and an SSH target
 * needs two. Everything this window knows is pushed to it by main; everything
 * it does goes back the same way.
 */

const form = document.getElementById('form');
const agentRow = document.getElementById('agent-row');
const folder = document.getElementById('folder');
const host = document.getElementById('host');
const remotePath = document.getElementById('remote-path');
const errorEl = document.getElementById('error');
const startBtn = document.getElementById('start');

const placeNow = () => form.querySelector('input[name="place"]:checked').value;

function setError(message) {
  errorEl.textContent = message || '';
  errorEl.classList.toggle('hidden', !message);
}

/** Grey out the half of the form that isn't being used, without hiding it. */
function syncEnabled() {
  const ssh = placeNow() === 'ssh';
  folder.closest('.indent').classList.toggle('off', ssh);
  host.closest('.indent').classList.toggle('off', !ssh);
  (ssh ? host : folder).focus({ preventScroll: true });
}

window.newAgentAPI.onState((state) => {
  agentRow.replaceChildren();
  for (const agent of state.agents || []) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'agent';
    input.value = agent.id;
    input.checked = agent.id === state.defaultAgent;
    const text = document.createElement('span');
    text.textContent = agent.label;
    label.append(input, text);
    agentRow.appendChild(label);
  }

  // Open on the last place you started something, since starting another one
  // there is much the likelier reason to be here.
  const recent = (state.recentProjects || [])[0];
  if (recent && recent.host) {
    form.querySelector('input[value="ssh"]').checked = true;
    host.value = recent.host;
    remotePath.value = recent.remotePath || '';
  } else if (recent) {
    folder.value = recent.path || '';
  }
  syncEnabled();
});

for (const radio of form.querySelectorAll('input[name="place"]')) {
  radio.addEventListener('change', () => {
    setError('');
    syncEnabled();
  });
}

document.getElementById('browse').addEventListener('click', async () => {
  form.querySelector('input[value="local"]').checked = true;
  syncEnabled();
  const picked = await window.newAgentAPI.browse();
  if (picked) {
    folder.value = picked;
    setError('');
  }
});

document.getElementById('cancel').addEventListener('click', () => window.newAgentAPI.close());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const ssh = placeNow() === 'ssh';
  const agent = form.querySelector('input[name="agent"]:checked')?.value || 'claude';

  if (ssh && !host.value.trim()) return setError('Which host?');
  if (!ssh && !folder.value.trim()) return setError('Which folder?');

  setError('');
  startBtn.disabled = true;
  const result = await window.newAgentAPI.start(
    ssh
      ? { agent, host: host.value.trim(), remotePath: remotePath.value.trim() }
      : { agent, path: folder.value.trim() }
  );
  startBtn.disabled = false;
  // Main closes the window on success; a refusal comes back with a reason.
  if (result && result.error) setError(result.error);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.newAgentAPI.close();
});

window.newAgentAPI.ready();
