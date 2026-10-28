'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { ACTIONS } = require('../src/actions');
const { toHookResponse } = require('../src/decisions');

// The switches the tray's Quick settings offers. An action can only be gated on
// one of these — anything else would be a switch nobody can reach.
const SWITCHES = ['approvals', 'answerQuestions', 'reviewOnStop', 'autoPerch', 'quietWhenFocused'];

test('every action is complete enough to render', () => {
  assert.ok(ACTIONS.length >= 8, 'the catalogue should cover what Clippy actually does');

  const ids = new Set();
  for (const action of ACTIONS) {
    const where = action.id || '(no id)';
    assert.ok(action.id && !ids.has(action.id), `${where}: ids must exist and be unique`);
    ids.add(action.id);

    for (const field of ['icon', 'title', 'summary', 'when', 'shows']) {
      assert.ok(action[field], `${where}: missing ${field}`);
    }
    // The settings window shows only the summary: it has to stand on its own
    // and stay short enough to read at a glance.
    assert.ok(action.summary.length <= 190, `${where}: summary is ${action.summary.length} chars`);
    if (action.setting) {
      assert.ok(SWITCHES.includes(action.setting), `${where}: unknown switch ${action.setting}`);
    }
    // An action either answers for you (choices) or just shows you something.
    assert.ok(action.choices || action.passive, `${where}: needs choices, or to say it's passive`);
  }
});

test('the JSON shown for each choice is the JSON Claude Code would get', () => {
  const withChoices = ACTIONS.filter((a) => a.choices);
  assert.ok(withChoices.length >= 4);

  for (const action of withChoices) {
    for (const choice of action.choices) {
      assert.ok(choice.label && choice.effect, `${action.id}: a choice needs a label and an effect`);
      // The review card answers no hook (Stop is passive), so its choices
      // carry no json at all rather than claiming a response that never goes.
      if (action.id === 'review') {
        assert.equal(choice.json, undefined);
        continue;
      }
      const parsed = JSON.parse(choice.json); // never a hand-written string
      assert.equal(typeof parsed, 'object');
    }
  }

  // Spot-check the two that matter most: an allow really allows, and handing a
  // card back to the terminal really says "no opinion".
  const allow = ACTIONS.find((a) => a.id === 'approval').choices.find((c) => c.label === 'Allow');
  assert.deepEqual(JSON.parse(allow.json), toHookResponse('PermissionRequest', 'allow'));
  assert.equal(
    JSON.parse(allow.json).hookSpecificOutput.decision.behavior,
    'allow',
    'the page would be lying about what Allow does'
  );

  const pass = ACTIONS.find((a) => a.id === 'approval').choices.find((c) =>
    c.label.includes('terminal')
  );
  assert.equal(pass.json, '{}', 'handing back to the terminal is an empty decision');
});

test('an answered question carries the answer back as tool input', () => {
  const submit = ACTIONS.find((a) => a.id === 'question').choices.find((c) =>
    c.label.startsWith('Submit')
  );
  const out = JSON.parse(submit.json).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'allow');
  assert.ok(out.updatedInput.answers, 'the answers map is what makes the picker skip');
});
