import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocked } from '../.claude/hooks/guard.mjs';

test('blocks writes to GitHub and package registries, however they are spelled', () => {
  for (const command of [
    'git push origin fixup/x',
    'git -C .work/a/b push',
    "git -c 'credential.helper=!gh auth git-credential' push --force",
    'cd .work/x && git push',
    'gh pr create --draft --title x',
    'gh pr merge 12',
    'gh api repos/navikt/x/pulls -f title=x',
    'gh workflow run deploy.yml',
    'pnpm run publish:beta',
    'npm publish',
    'curl -X POST https://api.github.com/repos/navikt/x/pulls',
  ]) {
    assert.ok(blocked(command), command);
  }
});

test('lets reads and the tool itself through', () => {
  for (const command of [
    'node fixup.mjs publish node26-pnpm12 --approve abc123def456',
    'git log --grep push',
    'git status',
    'gh pr list -R navikt/x',
    'gh pr checks 12',
    'pnpm install --frozen-lockfile',
    'node --test "test/*.test.mjs"',
  ]) {
    assert.equal(blocked(command), null, command);
  }
});
