// Registry checks that make a campaign's targets exact before anything is committed.

/** "pnpm@12.18.0+sha512.<hex>" → { name, version, algo, hash }. */
export function parsePackageManager(s) {
  const m = /^((?:@[^@/]+\/)?[^@]+)@([^+]+)(?:\+(sha\d+)\.([0-9a-f]+))?$/.exec(s ?? '');
  return m ? { name: m[1], version: m[2], algo: m[3] ?? null, hash: m[4] ?? null } : null;
}

/** npm's "sha512-<base64>" integrity → { algo, hex }, the form packageManager uses. */
export function integrityToHex(integrity) {
  const i = integrity.indexOf('-');
  return { algo: integrity.slice(0, i), hex: Buffer.from(integrity.slice(i + 1), 'base64').toString('hex') };
}

/** minimumReleaseAge in minutes from a pnpm-workspace.yaml, or 0. */
export function minimumReleaseAge(text) {
  const m = /^minimumReleaseAge:\s*(\d+)/m.exec(text ?? '');
  return m ? Number(m[1]) : 0;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** A packageManager string's hash must equal the registry's integrity for that version. */
export async function checkPackageManager(pm) {
  const p = parsePackageManager(pm);
  if (!p?.hash) return { ok: false, detail: `"${pm}" is not name@version+sha512.<hex>` };
  const doc = await getJson(`https://registry.npmjs.org/${p.name}/${p.version}`);
  const { algo, hex } = integrityToHex(doc.dist.integrity);
  return algo === p.algo && hex === p.hash
    ? { ok: true, detail: `${p.name}@${p.version} hash matches the registry` }
    : { ok: false, detail: `${p.name}@${p.version} hash does not match the registry's ${algo} integrity` };
}

/**
 * Checks for prepare. `ages` is [{ repo, minutes }] from the clones' pnpm-workspace.yaml: a pnpm too
 * young for the strictest minimumReleaseAge would be refused when the repos install it.
 */
export async function checkTargets(targets, ages, now) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  if (targets.packageManager) {
    try {
      const r = await checkPackageManager(targets.packageManager);
      add('packageManager', r.ok, r.detail);
      const p = parsePackageManager(targets.packageManager);
      const doc = await getJson(`https://registry.npmjs.org/${p.name}`); // the full document is the one with publish times
      const at = doc.time?.[p.version] ? new Date(doc.time[p.version]) : null;
      const strictest = ages.reduce((a, b) => (b.minutes > a.minutes ? b : a), { repo: null, minutes: 0 });
      if (!at) add('release age', false, `the registry has no publish time for ${p.name}@${p.version}`);
      else {
        const minutes = (now - at) / 60_000;
        const age = `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
        add('release age', minutes >= strictest.minutes,
          `${p.name}@${p.version} is ${age} old; the strictest minimumReleaseAge is ${strictest.minutes} min${strictest.repo ? ` (${strictest.repo})` : ''}`);
      }
    } catch (err) {
      add('packageManager', false, err.message);
    }
  }
  if (targets.node) {
    try {
      const index = await getJson('https://nodejs.org/dist/index.json');
      const rel = index.find((r) => r.version === `v${targets.node}`);
      add('node', !!rel, rel ? `v${targets.node} released ${rel.date}${rel.lts ? `, LTS ${rel.lts}` : ', not an LTS release'}` : `v${targets.node} is not on nodejs.org`);
    } catch (err) {
      add('node', false, err.message);
    }
  }
  return checks;
}
