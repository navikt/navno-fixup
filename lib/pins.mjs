// The Node and pnpm pins a navno repo carries, read from a directory or from a git revision.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.mjs';

export const fromDir = (dir) => (path) => {
  try {
    return readFileSync(join(dir, path), 'utf8');
  } catch {
    return null;
  }
};

export const fromRev = (dir, rev) => (path) => {
  const r = run('git', ['show', `${rev}:${path}`], { cwd: dir });
  return r.ok ? r.out : null;
};

/** "name: from → to" for each dependency whose version range changed between two package.json texts. */
export function dependencyChanges(beforeText, afterText) {
  const parse = (t) => {
    try {
      return JSON.parse(t ?? 'null') ?? {};
    } catch {
      return {};
    }
  };
  const a = parse(beforeText);
  const b = parse(afterText);
  const lines = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const x = a[field] ?? {};
    const y = b[field] ?? {};
    for (const name of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
      if (x[name] === y[name]) continue;
      const tag = field === 'dependencies' || field === 'devDependencies' ? '' : ` (${field})`;
      lines.push(`${name}${tag}: ${x[name] ?? '(none)'} → ${y[name] ?? '(removed)'}`);
    }
  }
  return lines;
}

/** The same for the `catalog:` section of two pnpm-workspace.yaml texts. */
export function catalogChanges(beforeText, afterText) {
  const read = (t) => {
    const out = {};
    let inCatalog = false;
    for (const line of (t ?? '').split('\n')) {
      if (/^\S/.test(line)) {
        inCatalog = /^catalog:\s*$/.test(line);
        continue;
      }
      const m = inCatalog && /^\s+(['"]?)([^'":\s]+)\1\s*:\s*(['"]?)([^'"#\s]+)\3/.exec(line);
      if (m) out[m[2]] = m[4];
    }
    return out;
  };
  const a = read(beforeText);
  const b = read(afterText);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((name) => a[name] !== b[name])
    .map((name) => `${name} (catalog): ${a[name] ?? '(none)'} → ${b[name] ?? '(removed)'}`);
}

export function readPins(read) {
  let pkg = null;
  try {
    pkg = JSON.parse(read('package.json') ?? 'null');
  } catch {}
  const images = (read('Dockerfile') ?? '')
    .split('\n')
    .map((l) => /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(l)?.[1])
    .filter(Boolean)
    .map((image) => image.replace(/^.*\//, '')); // node:26-slim, not the registry path
  return {
    packageManager: pkg?.packageManager?.replace(/\+sha\d+\.[0-9a-f]+$/, '') ?? null,
    'engines.node': pkg?.engines?.node ?? null,
    'devEngines.runtime': pkg?.devEngines?.runtime?.version ?? null,
    '.nvmrc': read('.nvmrc')?.trim() || null,
    'Dockerfile FROM': images.join(', ') || null,
  };
}
