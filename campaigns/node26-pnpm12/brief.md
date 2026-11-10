# Node 26 and pnpm 12

Every repo in the group should run on Node 26 and pnpm 12. Exact values are in `campaign.json` → `targets`.

## When a repo is done

A repo is converged, and gets no edits and no PR, when all of these hold:

- `packageManager` is any pnpm 12.x. Pins are aligned to the exact target only in repos that change anyway.
- `engines.node` admits 26. Apps pin exactly `"26"`.
- `devEngines.runtime.version` is 26.x.
- `.nvmrc`, if present, is 26.
- The Dockerfile's base image, if any, is `node:26-*`.

Libraries (`kind: library` in repos.json) are converged when `engines.node` admits 26. They keep their older supported majors.

## Exact values

- `packageManager`: `targets.packageManager`, in every package.json of the repo that has a `packageManager` field (examples included).
- Apps:
  - `engines.node` → `"26"`
  - `devEngines.runtime.version` → `targets.node`
  - `.nvmrc` → `26`
- Dockerfile: keep the registry path and the variant, change only the major. For example, `…/nav.no/node:24-slim` → `…/nav.no/node:26-slim`.

## Libraries (nav-dekoratoren-moduler)

- Never narrow `engines.node` or drop a Node major from the CI matrix. That is a breaking change for consumers.
- Don't bump `@types/node` majors. They track the lowest supported Node.

## Judgment edits you may make

List each one in the PR body with its file and the reason.

- Build targets that name the old runtime, for example esbuild `target: 'node24'` → `'node26'`, for code that runs on the server.
- A dependency whose `engines.node` rules out Node 26 and breaks install (repos with `engineStrict: true`): bump it to the lowest published version that admits 26. One example is `@navikt/nav-dekoratoren-moduler` 4.5.0 → 4.6.0. If no such version exists, stop: the repo is needs-human.
- pnpm 12 settings that keep today's behaviour. For example, pnpm 12 fails `pnpm -r run` on a workspace dependency cycle that pnpm 11 only warned about. If the cycle is harmless (only one side has the script), set `ignoreWorkspaceCycles: true` in pnpm-workspace.yaml. Flag it, and name breaking the cycle as a follow-up.
- Apps: `@types/node` → `targets.typesNode` where it is pinned (package.json or the pnpm catalog). Keep it only if the PR's checks pass. Otherwise revert it in a follow-up round and mention it in the PR.
- In repos that get a PR anyway: docs that tell contributors to run `corepack enable`, or that Node ships Corepack. Node 25+ no longer ships Corepack, and pnpm 12 switches itself to the `packageManager` version. Say to install pnpm instead.

## Don't

- Edit `.github/workflows/*`. CI already reads versions from package.json, and pushing workflow changes needs a token scope we don't use.
- Hand-edit `pnpm-lock.yaml`, or touch unrelated dependencies.
- Change comments that are still historically true, such as "immutable in Node 24".
- Weaken a check to get green.

## PR body

Write it in Norwegian, using the headings from the repo's `.github/pull_request_template.md` (these if it has none):

- **Oppsummering av hva som er gjort**: the pins changed (before → after) and any other edits.
- **Testing**:
  - What verify ran. By default that is only the lockfile, so say: «Lockfilen er generert på nytt med pnpm <versjon>. Ingenting er kjørt lokalt; CI kjører install, build, lint og test.»
  - If verify ran with `--local`: the steps that ran, with the pnpm and Node versions.
  - If the Dockerfile changed: «Docker-imaget bygges ikke i PR-sjekkene. Deploy branchen til dev før merge.»
  - If the repo runs Playwright: «Playwright kjøres i CI.»
- **Dette trenger jeg å få et ekstra blikk på**: each judgment edit, plus the lockfile summary from review (for example «ingen andre løste versjoner er endret»).
