import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLockChanges, lockChanges, lockPackages } from '../lib/lockfile.mjs';

const pnpm11 = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      '@types/node':
        specifier: 24.13.3
        version: 24.13.3

packages:

  '@types/node@24.13.3':
    resolution: {integrity: sha512-aaa}

  node@runtime:24.19.0:
    hasBin: true
    resolution:
      type: variations

  react-dom@19.1.0:
    resolution: {integrity: sha512-bbb}
    peerDependencies:
      react: ^19.1.0

snapshots:

  react-dom@19.1.0(react@19.1.0):
    dependencies:
      react: 19.1.0
`;

// pnpm 12 puts a document that pins pnpm itself in front of the usual one.
const pnpm12 = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.18.0
        version: 12.18.0

packages:

  '@pnpm/exe.darwin-arm64@12.18.0':
    resolution: {integrity: sha512-ccc}

  '@pnpm/exe.linux-x64@12.18.0':
    resolution: {integrity: sha512-ddd}

  pnpm@12.18.0:
    resolution: {integrity: sha512-eee}

---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      '@types/node':
        specifier: 26.6.5
        version: 26.6.5

packages:

  '@types/node@26.6.5':
    resolution: {integrity: sha512-fff}

  node@runtime:26.13.0:
    hasBin: true
    resolution:
      type: variations

  react-dom@19.1.0:
    resolution: {integrity: sha512-bbb}
`;

test('reads packages from every YAML document, without peer suffixes', () => {
  const pkgs = lockPackages(pnpm12);
  assert.deepEqual([...pkgs.get('pnpm')], ['12.18.0']);
  assert.deepEqual([...pkgs.get('node@runtime')], ['26.13.0']);
  assert.deepEqual([...pkgs.get('react-dom')], ['19.1.0']);
});

test('reports only resolved versions that changed, and collapses @pnpm/exe.*', () => {
  assert.deepEqual(formatLockChanges(lockChanges(pnpm11, pnpm12)), [
    '@types/node: 24.13.3 → 26.6.5',
    'node@runtime: 24.19.0 → 26.13.0',
    'pnpm: (none) → 12.18.0',
    '@pnpm/exe.*: 2 platform packages changed (pnpm pinning itself)',
  ]);
});

test('a reformatted lockfile with the same versions reports no changes', () => {
  assert.deepEqual(formatLockChanges(lockChanges(pnpm11, pnpm11.replace(/\n\n/g, '\n'))), ['no resolved versions changed']);
});
