# minimumReleaseAge: 3 dager

Every repo in the group sets `minimumReleaseAge` in `pnpm-workspace.yaml` to 3 days. The value is in minutes, so 3 days is `4320`. Exact value is in `campaign.json` → `targets.minimumReleaseAge`.

## When a repo is done

A repo is converged, and gets no edits and no PR, when:

- `pnpm-workspace.yaml` has `minimumReleaseAge: 4320`.

## Repos without the setting

- **No `pnpm-workspace.yaml`**: create it with only `minimumReleaseAge: 4320`, if the repo's `packageManager` is pnpm. Say in the review that the file is new.
- **`pnpm-workspace.yaml` without `minimumReleaseAge`**: add `minimumReleaseAge: 4320` as a top-level key. Keep the rest of the file as it is.
- **The setting is somewhere other than `pnpm-workspace.yaml`** (for example `.npmrc` or `package.json`): leave it alone and flag it as needs-human, with the file and line.

## Exact values

- `minimumReleaseAge: 4320` in `pnpm-workspace.yaml`. Replace the old value if there is one.
- A larger value is stricter: it holds back newer releases for longer. If the old value is larger than 4320, the change loosens the setting. Still set 4320, as asked, and name the old value and the loosening in the PR body.

## Judgment edits you may make

None. Change only the `minimumReleaseAge` line (or add it). Don't change other settings, dependencies or the lockfile by hand.

## Don't

- Edit `.github/workflows/*`.
- Hand-edit `pnpm-lock.yaml`. `verify` regenerates it.
- Touch `packageManager`, Node pins or dependencies. This campaign changes only the release age.
- Weaken a check to get green.

## PR body

Write it in Norwegian, using the headings from the repo's `.github/pull_request_template.md` (these if it has none):

- **Oppsummering av hva som er gjort**: the setting changed (before → after, in minutes and days), or «ingen endring nødvendig» for a repo that is already converged.
- **Testing**:
  - «Lockfilen er generert på nytt med pnpm <versjon>. Ingenting er kjørt lokalt; CI kjører install, build, lint og test.»
  - If the old value was larger than 4320: name it, and say that the setting is now looser: releases from the last 3 days can be installed.
- **Dette trenger jeg å få et ekstra blikk på**: the lockfile summary from review (for example «ingen andre løste versjoner er endret»), and anything flagged above.
