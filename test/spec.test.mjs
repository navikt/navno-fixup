import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integrityToHex, minimumReleaseAge, parsePackageManager } from '../lib/spec.mjs';

test('npm integrity converts to the hex hash that packageManager uses', () => {
  // pnpm 12.16.1: the registry's integrity, and the pin nav-dekoratoren-moduler carries for it.
  const { algo, hex } = integrityToHex('sha512-CR0d7nknV1Zhsl2rPCrjHK/BxU1rce1qZgDPDByxBDSkR+rhQBXxsj4ua+3u1535SpMuIWTSgyKA3OP7MvZW0Q==');
  assert.equal(algo, 'sha512');
  assert.equal(hex, '091d1dee7927575661b25dab3c2ae31cafc1c54d6b71ed6a6600cf0c1cb10434a447eae14015f1b23e2e6bedeed79df94a932e2164d2832280dce3fb32f656d1');
});

test('parses packageManager strings', () => {
  assert.deepEqual(parsePackageManager('pnpm@12.18.0+sha512.abc123'), { name: 'pnpm', version: '12.18.0', algo: 'sha512', hash: 'abc123' });
  assert.deepEqual(parsePackageManager('pnpm@11.1.2'), { name: 'pnpm', version: '11.1.2', algo: null, hash: null });
  assert.equal(parsePackageManager(undefined), null);
});

test('reads minimumReleaseAge from pnpm-workspace.yaml', () => {
  assert.equal(minimumReleaseAge("packages: []\nminimumReleaseAge: 5760\nminimumReleaseAgeExclude:\n  - '@navikt/*'\n"), 5760);
  assert.equal(minimumReleaseAge('packages: []\n'), 0);
});
