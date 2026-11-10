// Reduces a pnpm-lock.yaml diff to the resolved versions that actually changed. A pnpm major bump
// rewrites hundreds of lines without changing a single resolved version, and reviewers need to see that.

/** name → Set(version), from the `packages:` section of every YAML document in the lockfile. */
export function lockPackages(text) {
  const out = new Map();
  let inPackages = false;
  for (const line of (text ?? '').split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = line.startsWith('packages:');
      continue;
    }
    if (!inPackages) continue;
    const m = /^ {2}(['"]?)(.+?)\1:\s*$/.exec(line);
    if (!m) continue;
    const key = m[2].replace(/\(.*$/, ''); // peer-dependency suffixes are not versions
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    let name = key.slice(0, at);
    let version = key.slice(at + 1);
    if (version.startsWith('runtime:')) {
      name += '@runtime'; // node@runtime:26.13.0 is the Node that devEngines downloads
      version = version.slice('runtime:'.length);
    }
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(version);
  }
  return out;
}

/** { changes: [{ name, from, to }], exe }. pnpm's per-platform @pnpm/exe.* packages are only counted. */
export function lockChanges(before, after) {
  const a = lockPackages(before);
  const b = lockPackages(after);
  const changes = [];
  let exe = 0;
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const from = [...(a.get(name) ?? [])].sort();
    const to = [...(b.get(name) ?? [])].sort();
    if (from.join() === to.join()) continue;
    if (name.startsWith('@pnpm/exe.')) exe++;
    else changes.push({ name, from, to });
  }
  changes.sort((x, y) => x.name.localeCompare(y.name));
  return { changes, exe };
}

export function formatLockChanges({ changes, exe }) {
  const lines = changes.map((c) => `${c.name}: ${c.from.join(', ') || '(none)'} → ${c.to.join(', ') || '(none)'}`);
  if (exe) lines.push(`@pnpm/exe.*: ${exe} platform packages changed (pnpm pinning itself)`);
  return lines.length ? lines : ['no resolved versions changed'];
}
