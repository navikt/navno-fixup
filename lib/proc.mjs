// Child processes with prompts and git hooks off, so a credential problem fails instead of hanging.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const QUIET = { GIT_TERMINAL_PROMPT: '0', HUSKY: '0' };

// Clone failures that follow the network rather than the repo, so they are worth a retry. From gh-scanner.
export const TRANSIENT = /failed to connect|could not resolve host|timed out|timeout|connection reset|unexpected disconnect|rpc failed|early eof|ssl_read|remote end hung up|index-pack|packfile|unable to read|fetch-pack|sideband|http\/2|gnutls|broken pipe|\b429\b|too many requests|rate limit|\b50[023]\b/i;

// A sandbox said no (macOS Seatbelt answers "Operation not permitted"). A retry cannot help: the command has to run outside it.
export const DENIED = /operation not permitted|permission denied|\bEPERM\b|\bEACCES\b/i;

/** Run a quick command and wait for it: { ok, code, out, err }. For local git plumbing; anything slow goes through exec. */
export function run(cmd, args, { cwd, env, timeout = 1_800_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...QUIET, ...env }, timeout, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, code: r.status, out: (r.stdout ?? '').trim(), err: `${r.stderr ?? ''}${r.error?.message ?? ''}`.trim() };
}

/**
 * Run a command without blocking, so progress can be shown while it works. Resolves to { ok, code, out, err }.
 * With `log`, stdout and stderr go to that file instead (verify's steps are long and loud), `out` is empty,
 * and `onLine` gets the newest line of output, for showing that the command is alive.
 */
export function exec(cmd, args, { cwd, env, log, timeout = 1_800_000, onLine } = {}) {
  return new Promise((resolve) => {
    let fd = null;
    if (log) {
      mkdirSync(dirname(log), { recursive: true });
      fd = openSync(log, 'w');
      writeSync(fd, `$ ${cmd} ${args.join(' ')}\n\n`);
    }
    let out = '';
    let err = '';
    let failure = '';
    let settled = false;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...QUIET, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      failure = `timed out after ${Math.round(timeout / 60_000)} min`;
      child.kill();
    }, timeout);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fd !== null) closeSync(fd);
      resolve({ ok: code === 0 && !failure, code, out: out.trim(), err: `${err}${failure}`.trim() });
    };
    const take = (stream, keep) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (fd === null) return keep(chunk);
        writeSync(fd, chunk);
        const line = lastLine(chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n'));
        if (line) onLine?.(line.trim());
      });
    };
    take(child.stdout, (chunk) => (out += chunk));
    take(child.stderr, (chunk) => (err += chunk));
    child.on('error', (e) => {
      failure = e.message; // the command could not start
      finish(null);
    });
    child.on('close', finish);
  });
}

/** git that throws, with git's own last words, when it fails. */
export function git(cwd, args, opts) {
  return gitResult(args, run('git', args, { cwd, ...opts }));
}

/** The same without blocking, for git commands that use the network. */
export async function gitAsync(cwd, args, opts) {
  return gitResult(args, await exec('git', args, { cwd, ...opts }));
}

function gitResult(args, r) {
  if (!r.ok) {
    const shown = args.filter((a) => !a.startsWith('credential.helper') && a !== '-c');
    throw new Error(`git ${shown.join(' ')}: ${lastLine(r.err)}`);
  }
  return r.out;
}

/** Map over items with at most `limit` running at once. Results come back in the items' order. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const lastLine = (s) => String(s ?? '').trim().split('\n').pop() ?? '';
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
