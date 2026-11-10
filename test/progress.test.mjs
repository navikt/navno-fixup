import assert from 'node:assert/strict';
import { test } from 'node:test';
import { progress } from '../lib/progress.mjs';

function setup(tty) {
  const written = [];
  let clock = 0;
  const stream = { isTTY: tty, columns: 60, write: (text) => written.push(text) };
  const p = progress({ stream, tty, quietFor: 20_000, now: () => clock });
  return { p, written, advance: (ms) => (clock += ms) };
}

test('each finished repo gets a counted line with how long it took', () => {
  const { p, written, advance } = setup(false);
  p.begin('prepare x: 2 repos', ['a', 'longer-name']);
  const a = p.task('a');
  const b = p.task('longer-name');
  advance(4200);
  a.done('main@abc1234');
  b.done('FAILED: clone: nope');
  assert.deepEqual(written, ['prepare x: 2 repos\n', '[1/2] a            main@abc1234  (4s)\n', '[2/2] longer-name  FAILED: clone: nope  (4s)\n']);
});

test('without a terminal, silence gets a "still running" line, and not before it has been quiet a while', () => {
  const { p, written, advance } = setup(false);
  const t = p.task('nav-dekoratoren');
  t.step('test');
  t.note('✓ 12 tests passed');
  advance(19_000);
  p.tick();
  assert.deepEqual(written, []);
  advance(1000);
  p.tick();
  assert.deepEqual(written, ['        … still running: nav-dekoratoren: test 20s (✓ 12 tests passed)\n']);
  p.tick(); // it just spoke
  assert.equal(written.length, 1);
  advance(65_000);
  p.tick();
  assert.match(written[1], /nav-dekoratoren: test 1m25s/);
  t.end();
});

test('on a terminal, the spinner line is redrawn in place and cleared before a real line', () => {
  const { p, written } = setup(true);
  const t = p.task('a');
  t.step('clone');
  p.tick();
  assert.match(written[0], /^\r\x1b\[2K. a: clone 0s$/);
  t.done('ok');
  assert.deepEqual(written.slice(1), ['\r\x1b[2K', 'a  ok\n']);
});

test('a step change drops the previous step\'s output, and several tasks are listed without it', () => {
  const { p, written, advance } = setup(false);
  const a = p.task('a');
  a.step('lockfile');
  a.note('Progress: resolved 812');
  a.step('install');
  const b = p.task('b');
  b.note('noise');
  advance(20_000);
  p.tick();
  assert.deepEqual(written, ['        … still running: a: install 20s, b 20s\n']);
  p.close();
});
