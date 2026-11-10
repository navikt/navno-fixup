/**
 * What publish does for one repo, from the state it read just now. Pure, so the table is testable.
 *
 *   remote            sha of the campaign branch on GitHub, or null
 *   head              our HEAD
 *   remoteIsAncestor  the remote branch is an ancestor of HEAD (we only added commits)
 *   foreign           commits on the remote branch, since it diverged from HEAD, without our trailer
 *   pr                the open PR for the branch, else the newest closed or merged one, else null
 *
 * Returns { action: 'push' | 'pr-only' | 'none' | 'skip' | 'blocked', lease, createPr, reason }.
 * lease '' means "the branch must not exist yet".
 */
export function decide({ remote, head, remoteIsAncestor, foreign, pr, reopen = false }) {
  const open = pr?.state === 'OPEN';
  if (pr && !open && !reopen) {
    return { action: 'skip', reason: `PR #${pr.number} is ${pr.state.toLowerCase()}; pass --reopen to publish again` };
  }
  if (!remote) return { action: 'push', lease: '', createPr: !open, reason: 'new branch' };
  if (remote === head) {
    return open
      ? { action: 'none', createPr: false, reason: 'already up to date' }
      : { action: 'pr-only', createPr: true, reason: 'branch was pushed earlier, PR missing' };
  }
  if (remoteIsAncestor) return { action: 'push', lease: remote, createPr: !open, reason: 'new commits on top' };
  if (foreign > 0) {
    return { action: 'blocked', reason: `${foreign} commit(s) on the GitHub branch are not from this campaign; a human decides` };
  }
  return { action: 'push', lease: remote, createPr: !open, reason: 'rebased onto a newer base (force with lease)' };
}
