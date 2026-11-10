import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogChanges, dependencyChanges, readPins } from '../lib/pins.mjs';

test('reads the Node and pnpm pins, image name without the registry path', () => {
  const files = {
    'package.json': JSON.stringify({
      packageManager: 'pnpm@12.18.0+sha512.abc',
      engines: { node: '26' },
      devEngines: { runtime: { name: 'node', version: '26.13.0' } },
    }),
    '.nvmrc': '26\n',
    Dockerfile: 'FROM europe-north1-docker.pkg.dev/cgr-nav/pull-through/nav.no/node:26-slim\nWORKDIR /app\n',
  };
  assert.deepEqual(readPins((path) => files[path] ?? null), {
    packageManager: 'pnpm@12.18.0',
    'engines.node': '26',
    'devEngines.runtime': '26.13.0',
    '.nvmrc': '26',
    'Dockerfile FROM': 'node:26-slim',
  });
});

test('lists dependency version changes, marking peer and optional ones', () => {
  const before = JSON.stringify({ devDependencies: { '@types/node': '25.9.1', vite: '8.2.0' }, peerDependencies: { react: '^18' } });
  const after = JSON.stringify({ devDependencies: { '@types/node': '26.6.5', vite: '8.2.0' }, peerDependencies: { react: '^18 || ^19' } });
  assert.deepEqual(dependencyChanges(before, after), ['@types/node: 25.9.1 → 26.6.5', 'react (peerDependencies): ^18 → ^18 || ^19']);
});

test('lists catalog changes in pnpm-workspace.yaml', () => {
  const before = "packages:\n  - 'packages/*'\n\ncatalog:\n  '@types/node': '24.13.3'\n  eslint: '9.39.5'\n\nengineStrict: true\n";
  const after = before.replace("'24.13.3'", "'26.6.5'");
  assert.deepEqual(catalogChanges(before, after), ['@types/node (catalog): 24.13.3 → 26.6.5']);
});
