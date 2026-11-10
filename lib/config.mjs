// repos.json and campaigns/<id>/campaign.json, validated before anything touches a repo.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadCampaign(root, id) {
  if (!id) throw new Error('name a campaign, e.g. node fixup.mjs prepare node26-pnpm12');
  const file = join(root, 'campaigns', id, 'campaign.json');
  if (!existsSync(file)) throw new Error(`no campaigns/${id}/campaign.json`);
  const campaign = JSON.parse(readFileSync(file, 'utf8'));
  const { org, repos } = JSON.parse(readFileSync(join(root, 'repos.json'), 'utf8'));
  if (campaign.id !== id) throw new Error(`campaigns/${id}/campaign.json says its id is "${campaign.id}"`);
  // The prefix marks branches the tool owns; publish only ever force-pushes those.
  if (!/^fixup\/[\w.-]+$/.test(campaign.branch ?? '')) throw new Error(`branch must look like fixup/<name>, got "${campaign.branch}"`);
  if (!campaign.title) throw new Error('campaign.json needs a title');
  const members = repos.filter((r) => r.groups?.includes(campaign.group));
  if (!members.length) throw new Error(`no repos in group "${campaign.group}" in repos.json`);
  return { org, campaign, repos: members };
}

/** The repos named by --only / --except. Unknown names are an error, not a silent no-op. */
export function pick(repos, { only, except } = {}) {
  const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const names = new Set(repos.map((r) => r.name));
  for (const n of [...list(only), ...list(except)]) if (!names.has(n)) throw new Error(`"${n}" is not in this campaign's group`);
  return repos.filter((r) => (!only || list(only).includes(r.name)) && !list(except).includes(r.name));
}
