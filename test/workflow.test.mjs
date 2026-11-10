import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nodeBuildInputs, onPullRequest, prBuild, prWorkflows } from '../lib/workflow.mjs';

// tilbakemeldinger's pr-checks.yml, trimmed
const prChecks = `name: PR Checks
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  check:
    uses: navikt/navno-ci/.github/workflows/node-build.yml@v1
    with:
      push-image: false
      # Rebuilds with a pinned test env, so it can't be a part of pnpm test
      post-build-commands: pnpm run test:http
      env-file: |
        ENV=dev
        VITE_APP_ORIGIN=https://www.ansatt.dev.nav.no
        APP_PORT=9001
    secrets: inherit
`;

test('reads node-build inputs, block scalars included', () => {
  assert.deepEqual(nodeBuildInputs(prChecks), {
    'push-image': 'false',
    'post-build-commands': 'pnpm run test:http',
    'env-file': 'ENV=dev\nVITE_APP_ORIGIN=https://www.ansatt.dev.nav.no\nAPP_PORT=9001\n',
  });
});

test('finds with: when it comes before uses:', () => {
  const text = [
    'on: pull_request',
    'jobs:',
    '  build-and-test:',
    '    with:',
    '      playwright: pnpm run test:e2e',
    '      team: "personbruker" # owner',
    '    uses: navikt/navno-ci/.github/workflows/node-build.yml@v1',
    '    secrets: inherit',
    '',
  ].join('\n');
  assert.deepEqual(nodeBuildInputs(text), { playwright: 'pnpm run test:e2e', team: 'personbruker' });
});

test('ignores workflows that do not call node-build', () => {
  assert.equal(nodeBuildInputs('on: pull_request\njobs:\n  x:\n    runs-on: ubuntu-latest\n'), null);
});

test('detects pull_request triggers, but not pull_request_target or push-only workflows', () => {
  assert.equal(onPullRequest(prChecks), true);
  assert.equal(onPullRequest('on: [push, pull_request]\n'), true);
  assert.equal(onPullRequest('on:\n  pull_request_target:\n  push:\n'), false);
  assert.equal(onPullRequest('on:\n  push:\n    branches: [main]\njobs: {}\n'), false);
});

test('finds the workflows that run on pull requests, and the one that is the navno-ci PR check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixup-workflow-'));
  try {
    assert.deepEqual(prWorkflows(dir), []); // no .github/workflows at all: CI checks nothing
    assert.equal(prBuild(dir), null);
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/deploy.yml'), 'on:\n  push:\n    branches: [main]\njobs: {}\n');
    assert.deepEqual(prWorkflows(dir), []);
    writeFileSync(join(dir, '.github/workflows/codeql.yml'), 'on: [push, pull_request]\njobs: {}\n');
    writeFileSync(join(dir, '.github/workflows/pr-checks.yml'), prChecks);
    assert.deepEqual(prWorkflows(dir).map((w) => w.file), ['.github/workflows/codeql.yml', '.github/workflows/pr-checks.yml']);
    assert.equal(prBuild(dir).file, '.github/workflows/pr-checks.yml');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
