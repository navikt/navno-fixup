#!/usr/bin/env node
// navno-fixup: the same change in several navikt repos, from fresh clones, one branch and one draft PR each.
// This CLI owns everything that must be exact and repeatable. An agent (or a person) makes the change itself,
// following campaigns/<id>/brief.md. AGENTS.md has the workflow; README.md is for the person running it.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCampaign, pick } from './lib/config.mjs';
import { decide } from './lib/decide.mjs';
import { formatLockChanges, lockChanges } from './lib/lockfile.mjs';
import { catalogChanges, dependencyChanges, fromDir, fromRev, readPins } from './lib/pins.mjs';
import { delay, DENIED, exec, git, gitAsync, lastLine, pool, run, TRANSIENT } from './lib/proc.mjs';
import { progress } from './lib/progress.mjs';
import { checkPackageManager, checkTargets, minimumReleaseAge, parsePackageManager } from './lib/spec.mjs';
import { digest, localState, paths, PUBLISHABLE } from './lib/state.mjs';
import { prBuild, prWorkflows } from './lib/workflow.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
// Clones never hold credentials. publish hands gh's token to git for one command at a time.
const NO_CREDENTIALS = ['-c', 'credential.helper='];
const GH_CREDENTIALS = [...NO_CREDENTIALS, '-c', 'credential.helper=!gh auth git-credential'];
// Network work (clones, GitHub lookups) runs this many repos at a time. pnpm and pushes go one repo at a time.
const JOBS = 4;
// Pi's command sandbox sets this. It keeps .git/config and hooks read-only, leaves commits to the user
// and holds no GitHub login, so only review, status and the edits themselves can run inside it.
const SANDBOXED = process.env.PI_SANDBOXED === '1';
const CI_WAIT = 30 * 60_000;

const USAGE = `usage: node fixup.mjs <command> <campaign> [options]

commands:
  prepare   check the targets, then clone every repo in the campaign fresh into .work/<campaign>/
  verify    regenerate lockfiles with the pinned pnpm and commit; CI runs the checks on the PR
  review    write .work/<campaign>/review.md and print the digest that publish needs
  publish   push and open draft PRs; needs --approve <digest> from review
  status    PR state and CI checks, written to campaigns/<campaign>/report.md
  clean     delete .work/<campaign>

options:
  --only a,b      only these repos             --except a,b   all but these repos
  --fresh         prepare: start from the default branch even if the campaign branch exists
  --discard       prepare, clean: allow throwing away work that has not been published
  --local         verify: also install and run the repo's PR checks here (slow; CI runs the same ones)
  --approve <d>   publish: the digest printed by review
  --reopen        publish: publish even though the campaign's PR was closed or merged
  --wait          status: keep checking until no CI check is still running (30 min at most)
  --json          print JSON instead of tables

Progress goes to stderr: a line per repo as it finishes, and a sign of life in between.`;

const { values: opt, positionals: [cmd, id] } = parseOptions({
  allowPositionals: true,
  options: {
    only: { type: 'string' },
    except: { type: 'string' },
    fresh: { type: 'boolean' },
    discard: { type: 'boolean' },
    local: { type: 'boolean' },
    approve: { type: 'string' },
    reopen: { type: 'boolean' },
    wait: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

/** parseArgs, with a line instead of a stack trace for an option that does not exist. */
function parseOptions(config) {
  try {
    return parseArgs(config);
  } catch (err) {
    console.error(`error: ${err.message.split('. ')[0]}\n\n${USAGE}`);
    process.exit(1);
  }
}

const say = (text) => {
  if (!opt.json) console.log(text);
};
const out = progress();

/**
 * For a command that a sandbox stopped, or would stop: why, and how it gets run instead.
 * `offered`: the sandbox saw a write refused, and may offer to run the command outside (Pi does).
 */
function outside(why, offered = true) {
  return [
    `${cmd} cannot run in this sandbox: ${why}.`,
    ...(offered ? ['If the sandbox offers to run the command outside, accept, then run the same command again.'] : []),
    `${offered ? 'Otherwise ask' : 'Ask'} the user to run it (in Pi they type it with a leading "!", so the output lands in the conversation):`,
    `  node fixup.mjs ${process.argv.slice(2).join(' ')}`,
  ].join('\n');
}

// ── prepare ──────────────────────────────────────────────────────────────────

async function prepare({ org, campaign, repos }) {
  const chosen = pick(repos, opt);
  const tools = toolChecks();
  out.begin(`prepare ${campaign.id}: cloning ${chosen.length} repos into .work/${campaign.id}/, ${JOBS} at a time`, chosen.map((r) => r.name));
  let denied = false;
  const results = await pool(chosen, JOBS, async (repo) => {
    if (denied) return { repo: repo.name, error: 'not tried' };
    const t = out.task(repo.name);
    let r;
    try {
      r = await prepareRepo(org, campaign, repo, t);
    } catch (err) {
      r = { repo: repo.name, error: err.message, denied: DENIED.test(err.message) };
    }
    denied ||= !!r.denied;
    t.done(r.error ? `FAILED: ${r.error}` : `${r.from}${r.note ? `, ${r.note}` : ''}`);
    return r;
  });
  // One refusal means every clone is refused: stop, rather than fail the same way once per repo.
  if (denied) throw new Error(outside('it clones repositories, and git may not write .git/config or hooks here'));

  const t = out.task('targets');
  t.step('checking them against the npm registry, nodejs.org and GitHub');
  const ages = results
    .filter((r) => !r.error)
    .map((r) => ({ repo: r.repo, minutes: minimumReleaseAge(fromDir(paths(ROOT, campaign.id, r.repo).dir)('pnpm-workspace.yaml')) }));
  const checks = [...tools, ...(await checkTargets(campaign.targets ?? {}, ages, Date.now()))];
  const access = await ghAccess(org, results[0]?.repo);
  t.end();
  for (const c of checks) say(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  say(`${access.ok ? 'ok  ' : 'warn'} gh: ${access.detail}${access.ok ? '' : ' (only publish needs this)'}\n`);
  const rows = results.map((r) => ({
    repo: r.repo,
    pnpm: r.pins?.packageManager?.replace(/^pnpm@/, ''),
    engines: r.pins?.['engines.node'],
    devEngines: r.pins?.['devEngines.runtime'],
    '.nvmrc': r.pins?.['.nvmrc'],
    Dockerfile: r.pins?.['Dockerfile FROM'],
    from: r.from,
    note: r.error ? `ERROR: ${r.error}` : r.note,
  }));
  say(table(rows, ['repo', 'pnpm', 'engines', 'devEngines', '.nvmrc', 'Dockerfile', 'from', 'note']));
  const failed = checks.some((c) => !c.ok) || results.some((r) => r.error);
  if (!failed) say(`\nFresh clones are in .work/${campaign.id}/. Next: make the change per campaigns/${campaign.id}/brief.md, then verify.`);
  return { checks, access, repos: results, exitCode: failed ? 1 : 0 };
}

async function prepareRepo(org, campaign, repo, t) {
  const p = paths(ROOT, campaign.id, repo.name);
  const url = `https://github.com/${org}/${repo.name}.git`;
  if (!opt.discard) {
    const s = localState(ROOT, campaign, repo);
    if (s.dirty || (s.ahead > 0 && s.head !== s.remote)) {
      return { repo: repo.name, error: 'the clone has work that is not on GitHub: publish it, or re-run with --discard' };
    }
  }
  t.step('ls-remote');
  const ls = await exec('git', [...NO_CREDENTIALS, 'ls-remote', '--symref', url, 'HEAD', `refs/heads/${campaign.branch}`, 'refs/pull/*/head']);
  if (!ls.ok) return { repo: repo.name, error: `ls-remote: ${lastLine(ls.err)}` };
  const lines = ls.out.split('\n');
  const defaultBranch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(ls.out)?.[1];
  if (!defaultBranch) return { repo: repo.name, error: 'could not read the default branch' };
  const remoteSha = lines.find((l) => l.endsWith(`\trefs/heads/${campaign.branch}`))?.split('\t')[0] ?? null;
  const prs = remoteSha ? lines.filter((l) => l.startsWith(`${remoteSha}\trefs/pull/`)).map((l) => Number(/pull\/(\d+)/.exec(l)[1])) : [];

  assertRemovable(p.dir);
  rmSync(p.dir, { recursive: true, force: true });
  rmSync(p.verify, { force: true }); // a new clone has not been verified
  mkdirSync(p.work, { recursive: true });
  t.step('clone');
  for (let attempt = 0; ; attempt++) {
    // Partial clone: full history (so merge-base works), file contents fetched on demand.
    const args = [...NO_CREDENTIALS, 'clone', '--quiet', '--filter=blob:none', '--no-tags', '--single-branch', '--branch', defaultBranch, url, p.dir];
    const r = await exec('git', args);
    if (r.ok) break;
    const denied = DENIED.test(r.err);
    if (!denied) rmSync(p.dir, { recursive: true, force: true }); // a sandbox that refused the clone would refuse the cleanup too
    if (attempt === 2 || denied || !TRANSIENT.test(r.err)) return { repo: repo.name, error: `clone: ${lastLine(r.err)}`, denied };
    t.step(`clone, try ${attempt + 2} of 3`);
    await delay(3000 * 2 ** attempt);
  }
  const g = (args) => git(p.dir, args);
  g(['config', 'credential.helper', '']);
  const base = g(['rev-parse', 'HEAD']);
  if (remoteSha) {
    t.step(`fetch ${campaign.branch}`);
    await gitAsync(p.dir, [...NO_CREDENTIALS, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${campaign.branch}:refs/remotes/origin/${campaign.branch}`]);
  }
  // An existing campaign branch is continued, so review feedback becomes new commits on the same PR.
  const continuing = !!remoteSha && !opt.fresh;
  g(['switch', '--quiet', '--no-track', '-c', campaign.branch, ...(continuing ? [`refs/remotes/origin/${campaign.branch}`] : [])]);
  const behind = continuing ? Number(g(['rev-list', '--count', `HEAD..${base}`])) : 0;
  const meta = { repo: repo.name, url, defaultBranch, base, remoteSha, prs, preparedFrom: continuing ? 'campaign-branch' : 'default-branch', behind };
  writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`);

  let note = '';
  if (continuing) note = `continues ${campaign.branch}${prs.length ? ` (PR #${prs.join(', #')})` : ''}${behind ? `; ${behind} commits behind ${defaultBranch}` : ''}`;
  else if (remoteSha) note = `--fresh: replaces ${campaign.branch} on GitHub at publish`;
  return { repo: repo.name, from: `${defaultBranch}@${base.slice(0, 7)}`, pins: readPins(fromDir(p.dir)), note };
}

/**
 * Throws before anything is deleted where a sandbox keeps a clone's .git/config read-only. Deleting would
 * stop halfway there, and leave a clone without its files but with its .git.
 */
function assertRemovable(dir) {
  const config = join(dir, '.git', 'config');
  if (existsSync(config)) closeSync(openSync(config, 'a')); // opened for writing, nothing written
}

function toolChecks() {
  const first = (c, args) => {
    const r = run(c, args, { cwd: ROOT });
    return r.ok ? r.out.split('\n')[0] : null;
  };
  const checks = [['git', ['--version']], ['pnpm', ['--version']], ['gh', ['--version']]].map(([name, args]) => {
    const v = first(name, args);
    return { name, ok: !!v, detail: v ?? `${name} is not installed` };
  });
  const user = first('git', ['config', 'user.name']);
  const email = first('git', ['config', 'user.email']);
  checks.push({ name: 'git identity', ok: !!(user && email), detail: user && email ? `${user} <${email}>` : 'set git config --global user.name and user.email' });
  return checks;
}

async function ghAccess(org, repo) {
  if (!repo) return { ok: false, detail: 'no repo to check' };
  const r = await exec('gh', ['api', `repos/${org}/${repo}`, '--jq', '.permissions.push']);
  if (r.ok) return r.out === 'true' ? { ok: true, detail: `gh can push to ${org}/${repo}` } : { ok: false, detail: `gh has no push access to ${org}/${repo}` };
  if (/SAML|single sign-on|\/sso\b/i.test(r.err)) {
    const url = /https:\/\/github\.com\/orgs\/\S+\/sso\S*/.exec(r.err)?.[0];
    return { ok: false, sso: true, detail: `gh's token is not SSO-authorized for ${org}${url ? `. The user can authorize it here: ${url}` : ''}` };
  }
  return { ok: false, detail: `gh api: ${lastLine(r.err)}` };
}

function hasWorkflowScope() {
  const r = run('gh', ['auth', 'status']);
  return /Token scopes:.*'workflow'/.test(`${r.out}\n${r.err}`);
}

// ── verify ───────────────────────────────────────────────────────────────────

async function verify({ campaign, repos }) {
  if (SANDBOXED) throw new Error(outside('it commits, and the sandbox leaves commits to the user', false));
  const chosen = pick(repos, opt);
  const what = opt.local ? 'lockfile, install and the PR checks here, then commit' : 'lockfile and commit (CI runs the checks on the PR)';
  out.begin(`verify ${campaign.id}: ${what}`, chosen.map((r) => r.name));
  const results = [];
  for (const repo of chosen) {
    const t = out.task(repo.name);
    let r;
    try {
      r = await verifyRepo(campaign, repo, t);
    } catch (err) {
      r = { repo: repo.name, result: 'failed', note: err.message };
    }
    const steps = (r.steps ?? []).map((x) => x.name).join(' → ');
    t.done(r.result === 'passed' ? `${steps} → commit ${r.commit}` : `${r.result === 'failed' ? 'FAILED' : r.result}: ${r.note}`);
    results.push(r);
    if (r.result === 'failed' && DENIED.test(r.note ?? '')) throw new Error(outside(`it could not write in .work/${campaign.id}/${repo.name} (${r.note})`));
  }
  const rows = results.map((r) => ({
    repo: r.repo,
    result: r.result,
    steps: (r.steps ?? []).map((x) => (x.ok ? x.name : `${x.name} FAILED`)).join(' → '),
    versions: r.versions ? `pnpm ${r.versions.pnpm}${r.versions.node ? `, node ${r.versions.node}` : ''}` : '',
    note: r.note ?? '',
  }));
  say(table(rows, ['repo', 'result', 'steps', 'versions', 'note']));
  if (results.some((r) => r.result === 'passed')) {
    const checked = opt.local ? '' : ' Install, build, lint and test were not run here: CI runs them on each PR.';
    say(`\nCommitted.${checked} Next: write .work/${campaign.id}/<repo>.pr-body.md for each changed repo, then review.`);
  }
  return { repos: results, exitCode: results.some((r) => r.result === 'failed') ? 1 : 0 };
}

async function verifyRepo(campaign, repo, t) {
  const s = localState(ROOT, campaign, repo);
  const done = (result, extra = {}) => ({ repo: repo.name, result, ...extra });
  if (s.outcome === 'not-prepared') return done('skipped', { note: 'not prepared' });
  if (s.outcome === 'wrong-branch') return done('failed', { note: `the clone is not on ${campaign.branch}` });
  const { p } = s;
  const changed = changedSince(p.dir, s.upstream);
  if (!changed.length) return done('skipped', { note: 'no changes' });

  rmSync(p.logs, { recursive: true, force: true });
  const local = !!opt.local;
  const ci = prBuild(p.dir);
  const steps = [];
  const step = async (name, c, args, env) => {
    t.step(name);
    const started = Date.now();
    const log = join(p.logs, `${steps.length + 1}-${name.replace(/[^\w:.-]+/g, '-').slice(0, 40)}.log`);
    const r = await exec(c, args, { cwd: p.dir, log, env, onLine: t.note });
    steps.push({ name, ok: r.ok, seconds: Math.round((Date.now() - started) / 1000), log });
    return r.ok;
  };
  const written = local ? writeEnvFiles(p.dir, ci?.inputs) : [];
  let ok = true;
  let versions = null;
  let failure = null;
  try {
    if (changed.some((f) => /(^|\/)(package\.json|pnpm-workspace\.yaml|\.npmrc)$/.test(f))) {
      ok = await step('lockfile', 'pnpm', ['install', '--lockfile-only', '--ignore-scripts']);
    }
    if (ok && local) ok = await step('install', 'pnpm', ['install', '--frozen-lockfile']);
    if (ok) {
      // Without an install there is no Node to ask: check only that the pinned pnpm is the one that ran.
      t.step('versions');
      versions = await runtimeVersions(p.dir, { node: local });
      failure = versionProblem(safeJson(fromDir(p.dir)('package.json')), versions);
      steps.push({ name: 'versions', ok: !failure, seconds: 0 });
      ok = !failure;
    }
    for (const c of ok && local ? checkCommands(p.dir, repo, ci) : []) {
      ok = await step(c.name, 'bash', ['-eo', 'pipefail', '-c', c.run], { GIT_HASH: s.head });
      if (!ok) break;
    }
  } finally {
    restore(written);
  }

  const failed = steps.find((x) => !x.ok);
  const record = { ok, head: s.head, steps, versions, ci: ci?.file ?? null, local };
  if (!ok) {
    record.failure = failure ?? `${failed.name} failed; see ${failed.log}`;
    writeFileSync(p.verify, `${JSON.stringify(record, null, 2)}\n`);
    return done('failed', { steps, versions, note: record.failure });
  }
  t.step('commit');
  try {
    record.head = commitChanges(campaign, s);
  } catch (err) {
    return done('failed', { steps, versions, note: err.message });
  }
  writeFileSync(p.verify, `${JSON.stringify(record, null, 2)}\n`);
  let note = '';
  if (!local) note = prWorkflows(p.dir).length ? '' : 'no workflow runs on pull requests, so CI will not check this: run verify --local for this repo';
  else if (!ci && !repo.verify) note = 'no navno-ci PR workflow found: ran build, lint and test';
  else if (ci?.inputs.playwright) note = 'Playwright left to CI';
  return done('passed', { steps, versions, commit: record.head.slice(0, 7), note });
}

/** What verify --local runs: the checks of navno-ci's node-build.yml, in its order: build, lint, test, (Playwright: CI only), post-build-commands. */
function checkCommands(dir, repo, ci) {
  if (repo.verify) return repo.verify.map((c) => ({ name: c.replace(/^pnpm run /, ''), run: c }));
  const scripts = safeJson(fromDir(dir)('package.json'))?.scripts ?? {};
  const list = ['build', 'lint', 'test'].filter((name) => scripts[name]).map((name) => ({ name, run: `pnpm run ${name}` }));
  if (ci?.inputs['post-build-commands']) list.push({ name: 'post-build', run: ci.inputs['post-build-commands'] });
  return list;
}

/** The PR workflow's env-file, written where CI writes it. restore() puts back whatever was there. */
function writeEnvFiles(dir, inputs) {
  if (!inputs?.['env-file']) return [];
  const targets = [inputs['env-file-path'] || '.env', ...(inputs['env-file-copy-to'] ?? '').split(/\s+/).filter(Boolean)];
  return targets.map((rel) => {
    const file = join(dir, rel);
    const before = existsSync(file) ? readFileSync(file) : null;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, inputs['env-file']);
    return { file, before };
  });
}

function restore(written) {
  for (const { file, before } of written) {
    if (before === null) rmSync(file, { force: true });
    else writeFileSync(file, before);
  }
}

async function runtimeVersions(dir, { node = true } = {}) {
  const last = (r) => r.out.split('\n').pop()?.trim() ?? '';
  return {
    pnpm: last(await exec('pnpm', ['--version'], { cwd: dir })),
    node: node ? last(await exec('pnpm', ['exec', 'node', '--version'], { cwd: dir })).replace(/^v/, '') : null,
  };
}

/** The versions that actually ran must be the ones the repo pins, or verify proved nothing about them. */
function versionProblem(pkg, v) {
  const want = parsePackageManager(pkg?.packageManager);
  if (want?.name === 'pnpm' && v.pnpm !== want.version) return `pnpm ${v.pnpm} ran, but package.json pins ${want.version}`;
  const rt = pkg?.devEngines?.runtime;
  if (rt?.name === 'node' && rt.version && v.node) {
    const major = (x) => Number(/\d+/.exec(String(x))?.[0]);
    const fits = /^\d+\.\d+\.\d+$/.test(rt.version)
      ? v.node === rt.version
      : rt.version.startsWith('>=') ? major(v.node) >= major(rt.version) : major(v.node) === major(rt.version);
    if (!fits) return `Node ${v.node} ran, but devEngines.runtime asks for ${rt.version}`;
  }
  return null;
}

function changedSince(dir, upstream) {
  const tracked = git(dir, ['diff', '--name-only', upstream]); // commits since upstream plus the working tree
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean))];
}

/**
 * One commit per round: a new commit on a published branch, else the round's single commit
 * (amended when verify runs again). Hooks are off: they would run the repo's checks, which are CI's job
 * (or, with --local, the ones verify just ran).
 */
function commitChanges(campaign, s) {
  const { p } = s;
  const g = (args) => git(p.dir, args);
  g(['add', '-A']);
  const staged = g(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const forbidden = staged.filter((f) => /(^|\/)(\.env|node_modules)(\/|$)/.test(f));
  if (forbidden.length) {
    g(['reset', '--quiet']);
    throw new Error(`refusing to commit ${forbidden.join(', ')}`);
  }
  const message = commitMessage(campaign, s);
  const amend = s.ahead > 0 && s.head !== s.remote; // our own commit, not on GitHub yet
  // Nothing new: keep the commit, unless only its generated message is out of date.
  if (!staged.length && (!amend || g(['log', '-1', '--format=%B']) === message.trim())) return s.head;
  const file = join(p.work, `${s.repo}.commit-msg`);
  writeFileSync(file, message);
  g(['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-verify', ...(amend ? ['--amend'] : []), '-F', file]);
  return g(['rev-parse', 'HEAD']);
}

/** Title, one line per pin and dependency that changed since upstream, then the trailers. Expects the index to hold the change. */
function commitMessage(campaign, s) {
  const { p } = s;
  const all = git(p.dir, ['diff', '--cached', '--name-only', s.upstream]).split('\n').filter(Boolean);
  const before = readPins(fromRev(p.dir, s.upstream));
  const after = readPins(fromDir(p.dir));
  const pins = Object.keys(after).filter((k) => before[k] !== after[k]);
  const lines = pins.map((k) => `- ${k}: ${before[k] ?? '(none)'} → ${after[k] ?? '(none)'}`);
  const described = new Set(['pnpm-lock.yaml']);
  if (pins.includes('.nvmrc')) described.add('.nvmrc');
  if (pins.includes('Dockerfile FROM')) described.add('Dockerfile');
  if (pins.some((k) => ['packageManager', 'engines.node', 'devEngines.runtime'].includes(k))) described.add('package.json');
  for (const f of all.filter((x) => /(^|\/)package\.json$/.test(x))) {
    const changes = dependencyChanges(fromRev(p.dir, s.upstream)(f), fromDir(p.dir)(f));
    lines.push(...changes.map((c) => `- ${c}${f === 'package.json' ? '' : ` (${f})`}`));
    if (changes.length) described.add(f);
  }
  if (all.includes('pnpm-workspace.yaml')) {
    lines.push(...catalogChanges(fromRev(p.dir, s.upstream)('pnpm-workspace.yaml'), fromDir(p.dir)('pnpm-workspace.yaml')).map((c) => `- ${c}`));
  }
  if (all.includes('pnpm-lock.yaml')) lines.push('- pnpm-lock.yaml generert på nytt');
  const rest = all.filter((f) => !described.has(f));
  if (rest.length) lines.push(`- Også endret: ${rest.join(', ')}`);
  return `${[campaign.title, '', ...lines, '', `Fixup-Campaign: ${campaign.id}`, ...(campaign.commitTrailers ?? [])].join('\n')}\n`;
}

// ── review ───────────────────────────────────────────────────────────────────

async function review({ campaign, repos }) {
  // Always the whole campaign: the digest covers every publishable repo, and publish --only picks from it.
  const states = repos.map((repo) => localState(ROOT, campaign, repo));
  const hashChecks = new Map();
  const t = out.task('review');
  t.step(`reading ${states.length} clones and where their default branches are now`);
  const sections = await pool(states, JOBS, (s) => reviewRepo(campaign, s, hashChecks));
  t.end();
  const d = digest(campaign, states);
  const publishable = states.filter((s) => PUBLISHABLE.has(s.outcome)).map((s) => s.repo);
  const rows = sections.map((x) => x.row);
  const md = [
    `# Review: ${campaign.title}`,
    '',
    `Campaign \`${campaign.id}\`, branch \`${campaign.branch}\`. Digest \`${d}\` covers: ${publishable.join(', ') || 'nothing yet'}.`,
    '',
    'CI is the check: each PR runs the repo\'s own workflows. `verify` regenerated the lockfiles and committed; it ran install, build, lint and test here only where the verify column says so.',
    '',
    '| repo | outcome | files | lockfile | verify | notes |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.repo} | ${r.outcome} | ${r.files} | ${r.lockfile} | ${r.verify} | ${r.notes} |`),
    '',
    ...sections.map((x) => x.md),
  ].join('\n');
  mkdirSync(join(ROOT, '.work', campaign.id), { recursive: true });
  writeFileSync(join(ROOT, '.work', campaign.id, 'review.md'), md);
  say(table(rows, ['repo', 'outcome', 'files', 'lockfile', 'verify', 'notes']));
  say(`\nWrote .work/${campaign.id}/review.md`);
  if (publishable.length) {
    say(`Digest ${d} covers ${publishable.join(', ')}. Only after the user says yes:\n  node fixup.mjs publish ${campaign.id} --approve ${d} [--only <repo>]`);
  }
  return { digest: d, publishable, repos: rows };
}

async function reviewRepo(campaign, s, hashChecks) {
  const row = { repo: s.repo, outcome: s.outcome, files: '', lockfile: '', verify: '', notes: '' };
  if (s.outcome === 'not-prepared') return { row, md: `## ${s.repo}: not prepared\n` };
  const { p } = s;
  const g = (args) => git(p.dir, args);
  const notes = [];
  const body = [];
  const since = g(['merge-base', s.base, 'HEAD']); // what GitHub will diff the PR against
  const files = since === s.head ? [] : g(['diff', '--name-only', `${since}..HEAD`]).split('\n').filter(Boolean);
  row.files = files.length ? String(files.length) : '';
  if (s.dirty) notes.push('uncommitted edits: run verify');
  if (s.outcome === 'no-op' && s.remote) notes.push(`${campaign.branch} is on GitHub, but ${s.meta.defaultBranch} needs nothing: that PR is obsolete`);

  if (files.length) {
    const before = readPins(fromRev(p.dir, since));
    const after = readPins(fromRev(p.dir, 'HEAD'));
    const keys = Object.keys(after).filter((k) => before[k] || after[k]);
    body.push('| pin | before | after |', '|---|---|---|');
    for (const k of keys) body.push(`| ${k} | ${before[k] ?? ''} | ${after[k] === before[k] ? '(same)' : after[k] ?? '(removed)'} |`);
    body.push('');
    if (files.includes('pnpm-lock.yaml')) {
      const lc = lockChanges(fromRev(p.dir, since)('pnpm-lock.yaml'), fromRev(p.dir, 'HEAD')('pnpm-lock.yaml'));
      row.lockfile = lc.changes.length ? lc.changes.map((c) => c.name).join(', ') : 'no version changes';
      body.push('### Lockfile: resolved versions', '', ...formatLockChanges(lc).map((l) => `- ${l}`), '');
    }
    for (const f of files.filter((x) => x.endsWith('package.json'))) {
      const pm = safeJson(fromRev(p.dir, 'HEAD')(f))?.packageManager;
      if (!parsePackageManager(pm)?.hash) continue;
      // The promise is what is shared: repos are reviewed side by side, and each pin is asked about once.
      if (!hashChecks.has(pm)) hashChecks.set(pm, checkPackageManager(pm).catch((err) => ({ ok: false, detail: err.message })));
      const hash = await hashChecks.get(pm);
      if (!hash.ok) notes.push(`${f}: ${hash.detail}`);
    }
    const ci = prBuild(p.dir);
    if (files.includes('Dockerfile') && ci?.inputs['push-image'] === 'false') {
      notes.push('the Dockerfile changed, but the PR checks do not build the image: deploy the branch to dev before merging');
    }
    if (files.some((f) => f.startsWith('.github/workflows/'))) notes.push('changes .github/workflows: publish needs the gh workflow scope');
    // Records from before CI became the default check have no `local`: they ran the checks unless they say lockfileOnly.
    const local = !!s.verify && (s.verify.local ?? !s.verify.lockfileOnly);
    if (local && ci?.inputs.playwright) notes.push(`Playwright runs in CI only (${ci.inputs.playwright})`);
    if (!local && !prWorkflows(p.dir).length) notes.push(`no workflow runs on pull requests, so CI will not check this PR: run verify --local --only ${s.repo}`);
    if (s.verify) {
      row.verify = !s.verify.ok ? 'failed' : s.verify.head !== s.head ? 'stale' : local ? 'ok, checks ran here' : 'ok';
      body.push('### Verify', '', '| step | result | seconds |', '|---|---|---|');
      for (const x of s.verify.steps) body.push(`| ${x.name} | ${x.ok ? 'ok' : 'FAILED'} | ${x.seconds} |`);
      body.push('');
      const v = s.verify.versions;
      if (local && v) body.push(`Install and the PR checks ran here, on pnpm ${v.pnpm} and Node ${v.node}.`, '');
      else body.push(`Install, build, lint and test were not run here: CI runs them on the PR.${v ? ` pnpm ${v.pnpm} is the version that ran.` : ''}`, '');
    }
    if (s.remote && s.remote !== s.head) {
      body.push('### What this round adds to the published branch', '', '````diff', g(['diff', `${s.remote}..HEAD`, '--', '.', ':(exclude)pnpm-lock.yaml']), '````', '');
    }
    body.push('### Diff (without pnpm-lock.yaml)', '', '````diff', g(['diff', `${since}..HEAD`, '--', '.', ':(exclude)pnpm-lock.yaml']), '````', '');
    body.push('### PR body', '', s.body?.trim() || `_Missing: write .work/${campaign.id}/${s.repo}.pr-body.md_`, '');
  }
  const tip = (await exec('git', [...NO_CREDENTIALS, 'ls-remote', s.meta.url, `refs/heads/${s.meta.defaultBranch}`])).out.split('\t')[0];
  if (tip && tip !== s.base) notes.push(`${s.meta.defaultBranch} has moved since prepare (now ${tip.slice(0, 7)})`);
  row.notes = notes.join('; ');
  const where = `${s.meta.defaultBranch} ${s.base.slice(0, 7)} → HEAD ${s.head.slice(0, 7)}${s.remote ? `; ${campaign.branch} on GitHub is ${s.remote.slice(0, 7)}` : ''}${s.meta.prs?.length ? ` (PR #${s.meta.prs.join(', #')})` : ''}`;
  const head = [`## ${s.repo}: ${s.outcome}`, '', where, '', ...notes.map((n) => `- ${n}`), ...(notes.length ? [''] : [])];
  return { row, md: [...head, ...body].join('\n') };
}

// ── publish ──────────────────────────────────────────────────────────────────

async function publish({ org, campaign, repos }) {
  if (SANDBOXED) throw new Error(outside('it pushes and opens PRs, and the sandbox holds no GitHub login', false));
  if (!opt.approve) throw new Error('publish needs --approve <digest>, printed by review');
  const states = repos.map((repo) => localState(ROOT, campaign, repo));
  const current = digest(campaign, states);
  if (current !== opt.approve) {
    console.error(`The approved digest ${opt.approve} is not the current ${current}: something changed after review. Run review again.`);
    return { exitCode: 3 };
  }
  const chosen = new Set(pick(repos, opt).map((r) => r.name));
  const targets = states.filter((s) => chosen.has(s.repo) && PUBLISHABLE.has(s.outcome));
  if (!targets.length) {
    say('Nothing to publish.');
    return { repos: [] };
  }
  // Every access check runs before the first push, so a token problem can't leave the campaign half published.
  const access = out.task('access');
  access.step(`checking that gh can push to ${targets.length} repos`);
  const problems = await pool(targets, JOBS, async (s) => {
    const a = await ghAccess(org, s.repo);
    if (!a.ok) return a.detail;
    const files = git(s.p.dir, ['diff', '--name-only', `${s.base}...HEAD`]);
    if (/^\.github\/workflows\//m.test(files) && !hasWorkflowScope()) {
      return `${s.repo} changes .github/workflows. The user needs to run: gh auth refresh -h github.com -s workflow`;
    }
    return null;
  });
  access.end();
  const problem = problems.find(Boolean);
  if (problem) throw new Error(problem);

  out.begin(`publish ${campaign.id}: ${targets.length} repos, one at a time`, targets.map((s) => s.repo));
  const results = [];
  for (const s of targets) {
    const t = out.task(s.repo);
    const r = await publishRepo(org, campaign, s, t);
    t.done(`${r.result === 'failed' ? 'FAILED' : r.result}${r.reason ? `: ${r.reason}` : ''}${r.pr ? `  ${r.pr}` : ''}`);
    results.push(r);
  }
  say(table(results, ['repo', 'result', 'reason', 'pr']));
  writeReport(campaign, await statusRows(org, campaign, repos));
  say(`\nWrote campaigns/${campaign.id}/report.md. CI is checking the PRs now: node fixup.mjs status ${campaign.id} --wait`);
  return { repos: results, exitCode: results.some((r) => r.result === 'failed') ? 1 : 0 };
}

async function publishRepo(org, campaign, s, t) {
  const full = `${org}/${s.repo}`;
  const ref = `refs/heads/${campaign.branch}`;
  const g = (args) => git(s.p.dir, args);
  const remoteGit = (args) => gitAsync(s.p.dir, [...GH_CREDENTIALS, ...args]);
  try {
    // Read GitHub again now; the clone's view is from prepare.
    t.step('reading the branch and PR on GitHub');
    const remote = (await remoteGit(['ls-remote', 'origin', ref])).split('\t')[0] || null;
    let remoteIsAncestor = false;
    let foreign = 0;
    if (remote && remote !== s.head) {
      await remoteGit(['fetch', '--quiet', '--no-tags', 'origin', `+${ref}:refs/remotes/origin/${campaign.branch}`]);
      remoteIsAncestor = run('git', ['merge-base', '--is-ancestor', remote, 'HEAD'], { cwd: s.p.dir }).ok;
      if (!remoteIsAncestor) {
        const since = g(['merge-base', remote, 'HEAD']);
        foreign = g(['log', '--format=%B%x00', `${since}..${remote}`])
          .split('\0')
          .map((m) => m.trim())
          .filter((m) => m && !m.includes(`Fixup-Campaign: ${campaign.id}`)).length;
      }
    }
    const list = await exec('gh', ['pr', 'list', '-R', full, '--head', campaign.branch, '--state', 'all', '--json', 'number,state,url', '--limit', '20']);
    if (!list.ok) throw new Error(`gh pr list: ${lastLine(list.err)}`);
    const prs = safeJson(list.out) ?? [];
    const pr = prs.find((x) => x.state === 'OPEN') ?? prs.sort((a, b) => b.number - a.number)[0] ?? null;
    const plan = decide({ remote, head: s.head, remoteIsAncestor, foreign, pr, reopen: opt.reopen });
    if (plan.action === 'skip' || plan.action === 'blocked') return { repo: s.repo, result: plan.action, reason: plan.reason, pr: pr?.url ?? '' };
    if (plan.action === 'push') {
      t.step('push');
      await remoteGit(['push', '--quiet', '--no-verify', `--force-with-lease=${ref}:${plan.lease}`, 'origin', `HEAD:${ref}`]);
      g(['update-ref', `refs/remotes/origin/${campaign.branch}`, 'HEAD']);
    }
    let url = pr?.state === 'OPEN' ? pr.url : '';
    if (plan.createPr) {
      t.step('opening the PR');
      const file = join(s.p.work, `${s.repo}.pr-body.final.md`);
      writeFileSync(file, `${s.body.trimEnd()}\n\n${campaign.prFooter ? `${campaign.prFooter}\n` : ''}<!-- navno-fixup:${campaign.id} -->\n`);
      const created = await exec('gh', ['pr', 'create', '-R', full, '--base', s.meta.defaultBranch, '--head', campaign.branch,
        '--title', campaign.title, '--body-file', file, ...(campaign.draft === false ? [] : ['--draft'])]);
      if (!created.ok) throw new Error(`the branch is pushed, but gh pr create failed: ${lastLine(created.err)}`);
      url = created.out.split('\n').pop();
    }
    return { repo: s.repo, result: plan.action === 'none' ? 'up to date' : 'published', reason: plan.reason, pr: url };
  } catch (err) {
    return { repo: s.repo, result: 'failed', reason: err.message, pr: '' };
  }
}

// ── status, clean ────────────────────────────────────────────────────────────

async function status({ org, campaign, repos }) {
  const started = Date.now();
  let rows = await statusRows(org, campaign, repos);
  if (opt.wait) {
    // A PR opened a moment ago has no checks yet: give them a minute and a half to show up.
    const running = () => rows.filter((r) => r.pending > 0 || (r.checks === 'none yet' && Date.now() - started < 90_000));
    const t = out.task('CI');
    while (running().length && Date.now() - started < CI_WAIT) {
      const names = running().map((r) => r.repo);
      t.step(`checks still running in ${names.length} PR${names.length === 1 ? '' : 's'} (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`);
      await delay(30_000);
      rows = await statusRows(org, campaign, repos, t);
    }
    t.end();
  }
  writeReport(campaign, rows);
  say(table(rows, ['repo', 'local', 'pr', 'checks', 'url']));
  const failing = rows.flatMap((r) => r.failing.map((c) => `  ${r.repo}: ${c.name}  ${c.link}`));
  if (failing.length) say(`\nFailing checks:\n${failing.join('\n')}`);
  if (rows.some((r) => r.pending > 0)) say(`\nSome checks are still running${opt.wait ? ' after 30 minutes' : `: node fixup.mjs status ${campaign.id} --wait`}.`);
  say(`\nWrote campaigns/${campaign.id}/report.md`);
  return { repos: rows };
}

/** One row per repo: its PR and what CI says about it. `watcher` is the task already on screen when status --wait asks again. */
async function statusRows(org, campaign, repos, watcher) {
  const t = watcher ?? out.task('GitHub');
  if (!watcher) t.step(`reading PRs and checks for ${repos.length} repos`);
  const rows = await pool(repos, JOBS, async (repo) => {
    const full = `${org}/${repo.name}`;
    const row = { repo: repo.name, local: localState(ROOT, campaign, repo).outcome, pr: '', checks: '', url: '', pending: 0, failing: [] };
    const list = await exec('gh', ['pr', 'list', '-R', full, '--head', campaign.branch, '--state', 'all', '--json', 'number,state,isDraft,url', '--limit', '20']);
    if (list.ok) {
      const prs = safeJson(list.out) ?? [];
      const pr = prs.find((x) => x.state === 'OPEN') ?? prs.sort((a, b) => b.number - a.number)[0];
      if (!pr) return row;
      row.pr = `#${pr.number} ${pr.state.toLowerCase()}${pr.isDraft ? ', draft' : ''}`;
      row.url = pr.url;
      if (pr.state === 'OPEN') {
        // gh exits non-zero when a check fails or is still running; the JSON is on stdout all the same.
        const checks = safeJson((await exec('gh', ['pr', 'checks', String(pr.number), '-R', full, '--json', 'bucket,name,workflow,link'])).out) ?? [];
        const of = (b) => checks.filter((x) => x.bucket === b);
        row.checks = checks.length ? `${of('pass').length} pass, ${of('fail').length} fail, ${of('pending').length} pending` : 'none yet';
        row.pending = of('pending').length;
        row.failing = of('fail').map((c) => ({ name: c.workflow ? `${c.workflow} / ${c.name}` : c.name, link: c.link }));
      }
      return row;
    }
    // Without SSO, GitHub still shows branches and refs/pull/*/head to anyone.
    const ls = await exec('git', [...NO_CREDENTIALS, 'ls-remote', `https://github.com/${full}.git`, `refs/heads/${campaign.branch}`, 'refs/pull/*/head']);
    const lines = ls.out.split('\n');
    const sha = lines.find((l) => l.endsWith(`\trefs/heads/${campaign.branch}`))?.split('\t')[0];
    const prs = sha ? lines.filter((l) => l.startsWith(`${sha}\trefs/pull/`)).map((l) => /pull\/(\d+)/.exec(l)[1]) : [];
    row.pr = prs.length ? `#${prs.join(', #')} (state unknown: gh is not authorized)` : sha ? 'branch pushed, no PR' : '';
    return row;
  });
  if (!watcher) t.end();
  return rows;
}

function writeReport(campaign, rows) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const failing = rows.flatMap((r) => r.failing.map((c) => `- ${r.repo}: [${c.name}](${c.link})`));
  const md = [
    `# ${campaign.title}`,
    '',
    `Campaign \`${campaign.id}\`, branch \`${campaign.branch}\`. Updated ${stamp} UTC by \`node fixup.mjs status\`.`,
    '',
    '| Repo | Local | PR | Checks |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.repo} | ${r.local} | ${r.url ? `[${r.pr}](${r.url})` : r.pr || '—'} | ${r.checks || '—'} |`),
    '',
    ...(failing.length ? ['## Failing checks', '', ...failing, ''] : []),
  ];
  writeFileSync(join(ROOT, 'campaigns', campaign.id, 'report.md'), md.join('\n'));
}

async function clean({ campaign, repos }) {
  const unpublished = repos
    .map((repo) => localState(ROOT, campaign, repo))
    .filter((s) => ['needs-verify', 'needs-pr-body', 'ready'].includes(s.outcome) && s.head !== s.remote);
  if (unpublished.length && !opt.discard) {
    throw new Error(`unpublished work in ${unpublished.map((s) => s.repo).join(', ')}: publish it, or pass --discard`);
  }
  try {
    for (const repo of repos) assertRemovable(paths(ROOT, campaign.id, repo.name).dir);
  } catch (err) {
    throw new Error(DENIED.test(err.message) ? outside('it deletes clones, and their .git/config and hooks are read-only here') : err.message);
  }
  rmSync(join(ROOT, '.work', campaign.id), { recursive: true, force: true });
  say(`Removed .work/${campaign.id}`);
  return {};
}

// ── helpers ──────────────────────────────────────────────────────────────────

function table(rows, cols) {
  const cell = (v) => String(v ?? '');
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals) => vals.map((v, i) => cell(v).padEnd(width[i])).join('  ').trimEnd();
  return [line(cols), line(width.map((w) => '─'.repeat(w))), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const COMMANDS = { prepare, verify, review, publish, status, clean };
if (opt.help || !COMMANDS[cmd]) {
  console.log(USAGE);
  process.exit(opt.help ? 0 : 1);
}
try {
  const result = await COMMANDS[cmd](loadCampaign(ROOT, id));
  if (opt.json) console.log(JSON.stringify(result, null, 2));
  process.exitCode = result?.exitCode ?? 0;
} catch (err) {
  out.close();
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
}
