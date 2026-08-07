'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { identityFor, petNameFor, PET_NAMES, PALETTE } = require('../src/identity');

test('sessions in the same project keep the label but get different looks', () => {
  const a = identityFor('sess-1', 'billing-api');
  const b = identityFor('sess-999', 'billing-api');
  assert.equal(a.name, 'billing-api');
  assert.equal(b.name, 'billing-api');
  assert.notEqual(a.color, b.color);
  assert.ok(PALETTE.some((p) => p.color === a.color && p.dark === a.dark));
});

test('different projects generally get different buddies', () => {
  const names = ['billing-api', 'clippy', 'web', 'infra', 'docs', 'mobile-updates'];
  const looks = names.map((n) => identityFor(n, n));
  // Not a guarantee for every possible input, but these must not all collide.
  assert.ok(new Set(looks.map((l) => l.color)).size >= names.length - 1);
});

test('falls back to the session id when there is no project name', () => {
  const id = identityFor('abc123', '');
  assert.equal(id.name, 'abc123');
  assert.ok(id.color);

  // …and never blows up on nothing at all.
  const empty = identityFor('', '');
  assert.equal(empty.name, 'clippy');
  assert.ok(empty.color);
});

test('pet names are stable per session and drawn from the list', () => {
  assert.equal(petNameFor('sess-1'), petNameFor('sess-1'));
  assert.ok(PET_NAMES.includes(petNameFor('sess-1')));
  assert.ok(PET_NAMES.includes(petNameFor('')), 'nothing at all still gets a name');
  // Not a guarantee for every pair, but a handful of sessions must not all
  // answer to the same name.
  const names = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(petNameFor));
  assert.ok(names.size >= 4);
});
