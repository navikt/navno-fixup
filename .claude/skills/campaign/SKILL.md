---
name: campaign
description: Run a navno-fixup campaign. It makes the same change in several navikt repos from fresh clones, reviews it, then opens draft PRs that CI checks. Use when the user asks to run, continue, check, publish or create a campaign, or to make one change across the navno repos.
argument-hint: "<id> | status <id> | publish <id> | new <id>"
---

# /campaign $ARGUMENTS

`AGENTS.md` at the repo root holds the hard rules and the workflow. Follow the part the arguments ask for:

- `<id>`: "Run or continue a campaign", from step 1. Skip the steps the clones in `.work/<id>/` have already passed.
- `status <id>`: step 7.
- `publish <id>`: steps 5 and 6. Review again first, and publish only after the user's yes to that review.
- `new <id>`: "New campaign".
