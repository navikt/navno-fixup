import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../lib/decide.mjs';

const head = 'h'.repeat(40);
const remote = 'r'.repeat(40);

test('new branch: push with an empty lease and open a PR', () => {
  assert.deepEqual(decide({ remote: null, head, pr: null }), { action: 'push', lease: '', createPr: true, reason: 'new branch' });
});

test('already pushed with an open PR: nothing to do', () => {
  assert.equal(decide({ remote: head, head, pr: { number: 1, state: 'OPEN' } }).action, 'none');
});

test('pushed earlier but the PR is missing: only open the PR', () => {
  const d = decide({ remote: head, head, pr: null });
  assert.equal(d.action, 'pr-only');
  assert.equal(d.createPr, true);
});

test('follow-up commits fast-forward, leased on what GitHub has', () => {
  const d = decide({ remote, head, remoteIsAncestor: true, foreign: 0, pr: { number: 2, state: 'OPEN' } });
  assert.equal(d.action, 'push');
  assert.equal(d.lease, remote);
  assert.equal(d.createPr, false);
});

test('diverged with only our commits on GitHub: force with lease', () => {
  const d = decide({ remote, head, remoteIsAncestor: false, foreign: 0, pr: null });
  assert.equal(d.action, 'push');
  assert.equal(d.lease, remote);
});

test("someone else's commits on the branch block the repo", () => {
  assert.equal(decide({ remote, head, remoteIsAncestor: false, foreign: 1, pr: { number: 3, state: 'OPEN' } }).action, 'blocked');
});

test('a closed or merged PR is skipped unless --reopen', () => {
  assert.equal(decide({ remote, head, pr: { number: 4, state: 'CLOSED' } }).action, 'skip');
  assert.equal(decide({ remote: null, head, pr: { number: 4, state: 'MERGED' } }).action, 'skip');
  assert.equal(decide({ remote: null, head, pr: { number: 4, state: 'CLOSED' }, reopen: true }).action, 'push');
});
