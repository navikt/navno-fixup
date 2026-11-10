#!/usr/bin/env node
// PreToolUse hook for Bash: blocks commands that write to GitHub or a package registry.
// `node fixup.mjs publish` is the only sanctioned path to GitHub. It runs behind an 'ask' permission rule,
// after the user has approved the review. The deny rules in settings.json only match the start of a
// command (`git -C dir push` slips past `Bash(git push *)`), so this hook reads the whole command.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ARG = `(?:'[^']*'|"[^"]*"|\\S+)`;

export const RULES = [
  [new RegExp(`\\bgit(?:\\s+(?:-[Cc]\\s+${ARG}|--[\\w-]+(?:=${ARG})?))*\\s+['"]?push\\b`), 'git push'],
  [/\bgh\s+pr\s+(?:create|edit|ready|merge|close|reopen|comment|review)\b/, 'gh pr writes'],
  [/\bgh\s+api\b/, 'gh api'],
  [/\bgh\s+(?:workflow\s+run|run\s+(?:rerun|cancel)|release\s+(?:create|edit|delete|upload)|repo\s+(?:create|delete|edit|rename|archive|fork|sync)|issue\s+(?:create|comment|close|edit))\b/, 'gh writes'],
  [/\b(?:npm|pnpm|yarn)\b[^\n;&|]*\bpublish\b/, 'package publish'],
  [/\bcurl\b[^\n;&|]*\bapi\.github\.com\b/, 'GitHub API through curl'],
];

export const blocked = (command) => RULES.find(([re]) => re.test(command))?.[1] ?? null;

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  let command = '';
  try {
    command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '';
  } catch {}
  const what = blocked(command);
  if (what) {
    process.stderr.write(
      `Blocked by the navno-fixup guard (${what}). Pushes and PRs go only through "node fixup.mjs publish <id> --approve <digest>", ` +
        'after the user has said yes to the review. If this command really is needed, ask the user to run it.\n',
    );
    process.exit(2);
  }
}
