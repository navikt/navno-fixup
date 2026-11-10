# navno-fixup

Makes the same change in several navikt repos. Each repo gets a fresh clone, one `fixup/<id>` branch and one draft PR. It is the write-side twin of [gh-scanner](../gh-scanner), which asks questions of many repos.

You tell an agent which campaign to run. The agent makes the change, following a short brief. `fixup.mjs` does everything that has to be exact: cloning, lockfiles, commits, the review, pushing and opening PRs. Nothing reaches GitHub until you have said yes to the review, and CI checks every PR.

This page is for you. The agent's instructions are in [AGENTS.md](AGENTS.md).

## What you need

- Node 24+, git, pnpm 10+ and gh 2.x.
- `gh auth login`, with the token SSO-authorized for navikt. `prepare` tells you if it isn't, and prints the link.
- A GitHub Packages read token in `~/.npmrc`, so pnpm can resolve `@navikt` packages.

## Run a campaign

1. Open this folder in your agent and ask for the campaign by its folder name in `campaigns/`.
   - Claude Code: `/campaign node26-pnpm12`
   - Pi, or any agent that reads AGENTS.md: "run the node26-pnpm12 campaign"
2. The agent clones the repos, makes the change in each, regenerates lockfiles and commits locally. Repos that are already done are left alone.
3. It shows you a review: what changed in each repo, the judgment calls it made, and what the lockfiles resolved to. The full text, with diffs, is in `.work/<id>/review.md`.
4. Say yes, or name the repos you want. The agent opens one draft PR first, waits for its CI, then opens the rest.
5. `campaigns/<id>/report.md` lists the PRs and their checks. Marking drafts ready and merging is yours.

To follow up on red CI or a review comment, tell the agent which repo. It adds a commit to the same PR, after another review and another yes.

Nothing is built or tested on your machine. CI runs install, build, lint and test on each PR. If a repo has no PR checks, the review says so, and you can ask the agent to run them locally for that repo (`verify --local`).

### In Pi, with the sandbox on

The sandbox does not let the agent clone, commit or push, so four commands are yours. The tool stops within a second and prints the exact line; the agent passes it on.

| Command | What you do |
|---|---|
| `prepare`, `clean` | Pi asks whether to run it once outside the sandbox. Accept. |
| `verify` | Type it with a leading `!`: `!node fixup.mjs verify <id>` |
| `publish` | The same, with the line the agent gives you: `!node fixup.mjs publish <id> --approve <digest> --only <repo>` |

A `!` command runs with your own permissions, and its output lands in the conversation, so the agent carries on from there. Everything else (the edits, the PR texts, `review`, `status`) runs inside the sandbox.

### In Claude Code

`.claude/settings.proposed.json` pre-approves the tool's read-only commands, asks before `publish` and `clean`, and blocks pushes and PR edits that don't go through `publish`. Copy it to `.claude/settings.json` if you want that.

## While it runs

Every command prints a line per repo as it finishes, and a spinner in between. Where there is no terminal (an agent, a log), a `… still running` line appears whenever a command has been quiet for 20 seconds, naming the repo, the step and the newest line of output.

```
prepare node26-pnpm12: cloning 15 repos into .work/node26-pnpm12/, 4 at a time
[ 1/15] nav-dekoratoren-status   main@3f0c1d2  (2s)
[ 2/15] nav-dekoratoren          main@9a41e07, continues fixup/node26-pnpm12 (PR #1049)  (3s)
```

Roughly: `prepare`, `review` and `status` take seconds, `verify` a second or two per changed repo, and `verify --local` minutes per repo.

## The commands

You can run every step yourself, and make the change by hand.

| Step | Command | What happens |
|---|---|---|
| Prepare | `node fixup.mjs prepare <id>` | Checks the targets against the npm registry and nodejs.org. Clones every repo in the campaign's group fresh into `.work/<id>/` and creates (or continues) the campaign branch. |
| Change | edit `.work/<id>/<repo>` | Follow `campaigns/<id>/brief.md`. Write the PR text to `.work/<id>/<repo>.pr-body.md`. |
| Verify | `node fixup.mjs verify <id>` | Regenerates the lockfile with the pinned pnpm, checks that this pnpm is the one that ran, and commits. With `--local` it also installs and runs the repo's PR checks here (env-file, build, lint, test and post-build commands), and checks the Node version. |
| Review | `node fixup.mjs review <id>` | Writes `.work/<id>/review.md` (diffs, lockfile changes as resolved versions, what CI won't cover) and prints a digest. |
| Publish | `node fixup.mjs publish <id> --approve <digest> [--only <repo>]` | Pushes and opens draft PRs. Refuses if anything changed since review. |
| Status | `node fixup.mjs status <id> [--wait]` | PR state and CI checks, with a link to each failing one, written to `campaigns/<id>/report.md`. `--wait` keeps checking until CI has finished. |
| Clean | `node fixup.mjs clean <id>` | Deletes `.work/<id>/`. |

`--only a,b` and `--except a,b` limit a command to some repos. `node fixup.mjs --help` lists every option.

Re-running is safe:

- `prepare` continues a campaign branch that is already on GitHub, so review feedback becomes a new commit on the same PR.
- `prepare` won't throw away work that hasn't been published.
- `publish` re-reads GitHub first. It never overwrites commits it didn't make.

## When something goes wrong

| What you see | What to do |
|---|---|
| `gh's token is not SSO-authorized for navikt` | Open the link it printed, authorize, and run the command again. |
| `changes .github/workflows` at publish | `gh auth refresh -h github.com -s workflow` |
| `The approved digest … is not the current …` | Something changed after the review. Run `review` again and approve the new digest. |
| `the clone has work that is not on GitHub` | Publish it, or run `prepare` with `--discard` to throw it away. |
| `cannot run in this sandbox` | See "In Pi, with the sandbox on" above. |
| `verify` fails | The log it names is in `.work/<id>/logs/<repo>/`. |
| A PR's checks are red | `status` lists the failing checks with links. Ask the agent to follow up on that repo. |

## Adding a repo or a campaign

- **Repos** live in `repos.json`, each with a kind (`app`, `library` or `support`) and groups. A repo whose PR checks don't use navno-ci's `node-build.yml` lists its check commands under `verify`, for `verify --local`.
- **A campaign** is a folder with two files:
  - `campaigns/<id>/campaign.json`: group, branch, title and exact targets.
  - `brief.md`: when a repo counts as done, what to change, what not to touch, and what the PR must say.

## Tests

`node --test "test/*.test.mjs"`. They run offline.
