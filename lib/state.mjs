// What a prepared clone holds, read locally. Every command re-derives this; there is no state file to go stale.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, run } from './proc.mjs';

export function paths(root, id, repo) {
  const work = join(root, '.work', id);
  return {
    work,
    dir: join(work, repo),
    meta: join(work, `${repo}.meta.json`),
    verify: join(work, `${repo}.verify.json`),
    body: join(work, `${repo}.pr-body.md`),
    logs: join(work, 'logs', repo),
  };
}

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const rev = (dir, ref) => {
  const r = run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir });
  return r.ok ? r.out : null;
};

/**
 * outcome is one of: not-prepared, wrong-branch, no-op, needs-verify, needs-pr-body, ready, published.
 * upstream is where this round's work starts: the campaign branch on GitHub when prepare continued it, else the base.
 */
export function localState(root, campaign, repo) {
  const p = paths(root, campaign.id, repo.name);
  const meta = readJson(p.meta);
  if (!meta || !existsSync(join(p.dir, '.git'))) return { repo: repo.name, kind: repo.kind, outcome: 'not-prepared', p };
  const base = rev(p.dir, `refs/remotes/origin/${meta.defaultBranch}`);
  const remote = rev(p.dir, `refs/remotes/origin/${campaign.branch}`);
  const head = git(p.dir, ['rev-parse', 'HEAD']);
  const branch = run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: p.dir }).out;
  const dirty = git(p.dir, ['status', '--porcelain']) !== '';
  const upstream = meta.preparedFrom === 'campaign-branch' && remote ? remote : base;
  const ahead = Number(git(p.dir, ['rev-list', '--count', `${upstream}..HEAD`]));
  const verify = readJson(p.verify);
  const body = existsSync(p.body) ? readFileSync(p.body, 'utf8') : null;
  let outcome;
  if (branch !== campaign.branch) outcome = 'wrong-branch';
  else if (!dirty && head === base) outcome = 'no-op';
  else if (!dirty && head === remote) outcome = 'published';
  else if (dirty || !verify?.ok || verify.head !== head) outcome = 'needs-verify';
  else if (!body?.trim()) outcome = 'needs-pr-body';
  else outcome = 'ready';
  return { repo: repo.name, kind: repo.kind, outcome, p, meta, base, remote, head, upstream, ahead, dirty, verify, body };
}

export const PUBLISHABLE = new Set(['ready', 'published']);

/** Binds publish to what review showed: each publishable repo's base, head and PR body. */
export function digest(campaign, states) {
  const lines = states
    .filter((s) => PUBLISHABLE.has(s.outcome))
    .map((s) => `${s.repo} ${s.base} ${s.head} ${sha(s.body ?? '')}`)
    .sort();
  return sha(`${campaign.id}\n${campaign.branch}\n${lines.join('\n')}`).slice(0, 12);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
