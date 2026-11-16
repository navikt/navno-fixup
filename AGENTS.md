# navno-fixup

Makes the same change in several navikt repos: a fresh clone of each, one `fixup/<id>` branch, and one draft PR. It is the write-side twin of `../gh-scanner`. This file is for the agent doing the work; `README.md` is for the person running it.

- `repos.json` lists the repos, their kind (`app`, `library` or `support`) and their groups.
- `campaigns/<id>/campaign.json` holds the group, branch, title and exact targets. `brief.md` describes the change in words.
- `fixup.mjs` (with `lib/`) does everything mechanical: prepare, verify, review, publish, status and clean. You make the change itself and keep the user in the loop.

## `repos.json`

- `org` is the GitHub org (`navikt`). The team that owns these repos is `team-nav-no`.
- `repos` lists every repo the tool may touch:
  - `name`: the repo in `navikt`.
  - `kind`: `app` (deployed), `library` (published package) or `support` (CI, actions and the like). Briefs give rules per kind.
  - `groups`: which campaigns it belongs to. A campaign's `group` picks its repos.
  - `verify` (optional): the check commands for `verify --local`, for repos whose PR checks don't use navno-ci's `node-build.yml`.
- `topics` maps each group to the GitHub topic its repos carry, e.g. `navno-node` → `node`, `dekoratoren` → `dekoratoren`. The team also tags repos `active`, `deployed` and `library`. Use topics to find repos with `gh`, and to spot a repo that has the topic but is missing from `repos.json`.

## Finding things across repos

Answer questions such as "which projects use Hono?" with `gh`, not from disk. Don't go up out of this folder to look through other checkouts; they may be stale, and many repos aren't there.

- Scope to the team. List its repos with their topics:
  `gh api orgs/navikt/teams/team-nav-no/repos --paginate --jq '.[] | select(.archived|not) | [.name, (.topics|join(","))] | @tsv'`
- Unless the user says otherwise, consider only repos with the `active` topic. Ignore the team's other repos, even when a search finds them. If it's unclear whether the user means a repo outside `active`, ask.
- Or by topic: `gh search repos --owner navikt --topic node --topic active` (add `--topic dekoratoren`, etc.).
- Search code: `gh search code '"hono"' --owner navikt --filename package.json`. Code search can't filter by team, so intersect the result with the team's repo list. It only covers default branches.
- Several repos are monorepos (nav-dekoratoren has `packages/*`, for example). A dependency may be in any workspace's `package.json`, not only the root one. Search all of them, as `--filename package.json` does; don't read just the root file.
- The same goes for changes: in a monorepo, check every workspace's `package.json` and `pnpm-workspace.yaml`, not only the root.

## Hard rules

- Edit only the fresh clones in `.work/<id>/<repo>`. Never touch the user's own checkouts such as `../nav-dekoratoren`.
- Never push, open or edit PRs, or call `gh api` yourself. `node fixup.mjs publish` is the only path to GitHub, and it runs only after the user has said yes to the review in chat.
- Never hand-edit `pnpm-lock.yaml`. `verify` regenerates it with the pinned pnpm.
- Never run a repo's package scripts yourself. Some publish packages (nav-dekoratoren-moduler has `publish:beta`).
- CI is the check. `verify` does not install, build, lint or test. `verify --local` runs the same fixed set CI runs, here; use it only when the user asks, or when review says no workflow runs on pull requests in that repo.
- Never weaken a check to get green: no skipped tests, lint disables, `@ts-ignore` or `--no-frozen-lockfile`.
- Write versions exactly as `campaign.json` gives them. Don't choose versions yourself.

## How the commands behave

- Progress goes to stderr: one line per repo as it finishes, and a `… still running` line whenever a command has said nothing for 20 seconds. That line names the repo, the step, how long it has taken and the newest line of output. A command that is silent for a minute is stuck; one that keeps saying `still running` is not.
- `prepare`, `review` and `status` take seconds. `verify` takes a second or two per changed repo. `verify --local` takes minutes per repo: run it in the background if you can, or one repo at a time with `--only`.
- `status --wait` blocks until no CI check is still running, 30 minutes at most.
- `--only a,b` and `--except a,b` limit a command to some repos. `--json` prints the result as JSON on stdout.
- Logs of `verify`'s steps are in `.work/<id>/logs/<repo>/`.

### In a sandbox

Pi's sandbox (the work machines run it) keeps every repository's `.git/config` and hooks read-only, leaves commits to the user and holds no GitHub login. The tool knows, and stops within a second instead of failing halfway:

| Command | In the sandbox |
|---|---|
| Edits in `.work/`, PR bodies, `review`, `status` | Work as usual. |
| `prepare`, `clean` | Are refused. Pi offers to run the command once outside the sandbox. When the user accepts, run the same command again. |
| `verify`, `publish` | Stop and print the command. Ask the user to run it. In Pi they type it with a leading `!`, and the output lands in the conversation. |

Give the user the exact line, wait, then carry on from its output. Don't look for another way to clone, commit or push, and don't ask the user to turn the sandbox off.

## Run or continue a campaign

1. **Prepare.** Run `node fixup.mjs prepare <id>`.
   - If a check says FAIL (exit code 1), stop and report it.
   - The pins table shows where each repo stands.
   - A repo whose campaign branch is already on GitHub is continued. `--fresh` restarts it from main; use that only when the user asks.
2. **Change.** Read `campaigns/<id>/brief.md`, then decide for each repo whether it is already done.
   - Leave converged repos untouched, and say in one line why each is done.
   - Make the change in `.work/<id>/<repo>`. Use the exact values from `campaign.json`, and make only the judgment edits the brief allows.
3. **Verify.** Run `node fixup.mjs verify <id>`. It regenerates each changed repo's lockfile with the pinned pnpm, checks that this pnpm is the one that ran, and commits.
   - On a failure, read the log it names.
   - Make at most two fixes that stay inside the brief, running `node fixup.mjs verify <id> --only <repo>` after each.
   - If it still fails, stop that repo and report it as needs-human, with the log.
4. **PR body.** For each changed repo, write `.work/<id>/<repo>.pr-body.md` as the brief says.
   - Use the headings of the repo's `.github/pull_request_template.md` when it has one.
   - The testing section says what ran: by default only the lockfile regeneration, and that CI runs install, build, lint and test.
   - No footer or marker: publish adds them.
5. **Review.** Run `node fixup.mjs review <id>` and read `.work/<id>/review.md`. Summarize each repo for the user:
   - what changed
   - the judgment calls
   - the lockfile summary
   - what CI won't cover

   Then ask whether to publish, naming the repos. The digest covers the PR bodies too, so run review again after any edit.
6. **Publish.** Only after an explicit yes for this review:
   - Publish one repo first as a canary: `node fixup.mjs publish <id> --approve <digest> --only <repo>`. Pick the smallest diff.
   - Wait for its checks: `node fixup.mjs status <id> --wait`. If they are red because of the change, stop and report before opening more PRs.
   - Then publish the rest with the same digest.
   - If publish says gh is not SSO-authorized, give the user the URL it printed and wait. Only they can authorize it.
7. **Status.** Run `node fixup.mjs status <id> --wait`. It lists every failing check with a link and writes `campaigns/<id>/report.md`.
   - For a failing check, read why: `gh run view <run-id> -R navikt/<repo> --log-failed` (the run id is in the link). Reading is fine; rerunning is the user's call.
   - Say for each red repo whether the change caused it. If it did, follow up as below. If it didn't (a flaky test, something already red on main), say so and leave it.
   - Drafts are marked ready by the user once CI is green.

## Follow-ups (review comments, red CI)

Run `node fixup.mjs prepare <id> --only <repo>`, which continues the published branch. Then edit, `verify`, update the PR body if needed, `review`, ask, and `publish`. Each round adds one commit to the PR. After two rounds that leave CI red, stop and report the repo as needs-human.

## New campaign

1. Copy `campaigns/node26-pnpm12/` to `campaigns/<new-id>/` and delete `report.md`.
2. Write `campaign.json`: group, branch `fixup/<new-id>`, title, exact targets, draft.
3. Write `brief.md`: when a repo counts as done, rules per repo kind, allowed judgment edits, what not to touch, and what PR bodies must say.
4. Run `prepare` and tell the user what you would change in each repo before editing anything.

## Working on the tool

Tests are offline: `node --test "test/*.test.mjs"`. The CLI has no dependencies. Keep it that way, in gh-scanner's style.
