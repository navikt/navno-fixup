import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DENIED, exec, pool } from '../lib/proc.mjs';

const node = process.execPath;

test('exec returns what the command printed and whether it worked', async () => {
  const ok = await exec(node, ['-e', 'console.log("out"); console.error("err")']);
  assert.deepEqual(ok, { ok: true, code: 0, out: 'out', err: 'err' });
  const bad = await exec(node, ['-e', 'process.exit(3)']);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
});

test('exec reports a command that cannot start, or that runs too long, as a failure', async () => {
  const missing = await exec('no-such-command-here', []);
  assert.equal(missing.ok, false);
  assert.match(missing.err, /ENOENT/);
  const slow = await exec(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 200 });
  assert.equal(slow.ok, false);
  assert.match(slow.err, /timed out/);
});

test('with a log, output goes to the file and the newest line is passed on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixup-proc-'));
  try {
    const log = join(dir, 'logs', 'step.log');
    const lines = [];
    const r = await exec(node, ['-e', 'console.log("one\\n\\x1b[32mtwo\\x1b[0m"); console.error("three")'], { log, onLine: (l) => lines.push(l) });
    assert.deepEqual({ ok: r.ok, out: r.out }, { ok: true, out: '' });
    assert.match(readFileSync(log, 'utf8'), /^\$ .*\n\none\n.*two.*\n/);
    assert.equal(lines.includes('two'), true); // colour codes stripped
    assert.equal(lines.at(-1), 'three');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pool keeps the order and never runs more than the limit at once', async () => {
  let running = 0;
  let most = 0;
  const results = await pool([30, 5, 20, 1, 10], 2, async (ms, i) => {
    most = Math.max(most, ++running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running--;
    return `${i}:${ms}`;
  });
  assert.deepEqual(results, ['0:30', '1:5', '2:20', '3:1', '4:10']);
  assert.equal(most, 2);
  assert.deepEqual(await pool([], 4, () => 1), []);
});

test('a sandbox refusal is told apart from a network failure', () => {
  assert.equal(DENIED.test("fatal: could not create leading directories of '/x/.git': Operation not permitted"), true);
  assert.equal(DENIED.test("EPERM: operation not permitted, unlink '/x/.git/config'"), true);
  assert.equal(DENIED.test('fatal: unable to access https://github.com/: Could not resolve host'), false);
});
