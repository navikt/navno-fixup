// What a repo's CI runs on a pull request, and how its PR checks call navno-ci's node-build.yml,
// so review can say what CI covers and verify --local can repeat the checks.
// A line reader, not a YAML parser: it only needs one job's `with:` block, block scalars included
// (env-file is one), which gh-scanner's yamlish reader does not handle.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NODE_BUILD = /^\s*uses:\s*navikt\/navno-ci\/\.github\/workflows\/node-build\.yml@/;
const indentOf = (l) => l.length - l.trimStart().length;
const blank = (l) => !l.trim() || /^\s*#/.test(l);

export function onPullRequest(text) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (i < 0) return false;
  if (/\bpull_request\b/.test(lines[i])) return true; // on: pull_request, on: [push, pull_request]
  for (const l of lines.slice(i + 1)) {
    if (blank(l)) continue;
    if (indentOf(l) === 0) break;
    if (/^\s+(-\s+)?pull_request\b/.test(l)) return true; // not pull_request_target
  }
  return false;
}

/** The `with:` inputs of the job that calls node-build.yml; null when no job does. */
export function nodeBuildInputs(text) {
  const lines = text.split('\n');
  const u = lines.findIndex((l) => NODE_BUILD.test(l));
  if (u < 0) return null;
  const keyIndent = indentOf(lines[u]);
  let first = u;
  while (first > 0 && (blank(lines[first - 1]) || indentOf(lines[first - 1]) >= keyIndent)) first--;
  for (let i = first; i < lines.length; i++) {
    if (!blank(lines[i]) && indentOf(lines[i]) < keyIndent) break;
    if (indentOf(lines[i]) === keyIndent && /^\s*with:\s*(#.*)?$/.test(lines[i])) return readMap(lines, i + 1, keyIndent);
  }
  return {};
}

function readMap(lines, from, parentIndent) {
  const out = {};
  let indent = null;
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (blank(l)) continue;
    const ind = indentOf(l);
    if (ind <= parentIndent) break;
    indent ??= ind;
    if (ind !== indent) continue;
    const m = /^\s*([\w.-]+)\s*:\s*(.*)$/.exec(l);
    if (!m) continue;
    const [, key, rest] = m;
    const block = /^([|>])([+-]?)\d*\s*(#.*)?$/.exec(rest);
    if (!block) {
      out[key] = scalar(rest);
      continue;
    }
    const body = [];
    let bodyIndent = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const b = lines[j];
      if (b.trim() && indentOf(b) <= indent) break;
      if (b.trim()) bodyIndent ??= indentOf(b);
      body.push(b.trim() ? b.slice(bodyIndent) : '');
    }
    i = j - 1;
    while (body.length && body.at(-1) === '') body.pop();
    const text = block[1] === '|' ? body.join('\n') : body.join(' ');
    out[key] = block[2] === '-' ? text : `${text}\n`;
  }
  return out;
}

function scalar(s) {
  const q = /^(['"])(.*)\1\s*(#.*)?$/.exec(s.trim());
  return q ? q[2] : s.trim().replace(/\s+#.*$/, '');
}

/** The repo's workflows that run on pull requests: [{ file, text }]. None means CI checks nothing on a PR. */
export function prWorkflows(dir) {
  let files;
  try {
    files = readdirSync(join(dir, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return [];
  }
  return files
    .map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(dir, '.github/workflows', f), 'utf8') }))
    .filter((w) => onPullRequest(w.text));
}

/**
 * The repo's PR check that calls node-build.yml: { file, inputs }, or null.
 * When several workflows do, the one with push-image: false is the PR check.
 */
export function prBuild(dir) {
  const found = [];
  for (const { file, text } of prWorkflows(dir)) {
    const inputs = nodeBuildInputs(text);
    if (inputs) found.push({ file, inputs });
  }
  return found.find((w) => w.inputs['push-image'] === 'false') ?? found[0] ?? null;
}
