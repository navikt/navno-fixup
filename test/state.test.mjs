import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from '../lib/state.mjs';

const campaign = { id: 'c', branch: 'fixup/c' };
const state = (repo, outcome, body = 'body') => ({ repo, outcome, base: 'b'.repeat(40), head: `${repo}-head`, body });

test('the digest covers publishable repos only, in any order', () => {
  const a = digest(campaign, [state('x', 'ready'), state('y', 'no-op'), state('z', 'published')]);
  assert.equal(a, digest(campaign, [state('z', 'published'), state('x', 'ready')]));
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('the digest changes when a commit or a PR body changes', () => {
  const a = digest(campaign, [state('x', 'ready')]);
  assert.notEqual(a, digest(campaign, [state('x', 'ready', 'edited body')]));
  assert.notEqual(a, digest(campaign, [{ ...state('x', 'ready'), head: 'other' }]));
});
