---
name: task-claim
description: "Claim, checkpoint, and end GitHub issue work under the agent work tracking protocol, so two sessions never write the same issue at once. Use before starting any assigned task that produces a change, findings, or measurements, when opening or updating its PR, when a claim-gate check (such as a task-claim admission check) fails, and when handing off, releasing, or finishing the work."
argument-hint: "[check|claim|confirm|checkpoint|handoff|release|done|fix-gate] [issue]"
user-invocable: true
allowed-tools: Read, Grep, Glob
---

# Task Claim

One GitHub issue has one writing session at a time. The issue and its
protocol comments are the record. Where the repository runs a claim gate, a
PR into the integration branch passes it only when its branch holds the
winning claim of every issue it references.

The repository's values are in `docs/product-owner-config.md`, "the config"
(keys are defined in the `product-owner` skill's `config-schema.md`; a key
named here in backticks is a config key). Read its `tracking_doc` first when
it names one: the tracking document wins over this skill where they differ.
"The owner" is `owner_name`. Without a config, use the defaults in the
schema: the repository's default branch, no claim gate, no board bot.

## Exempt

- A question answered inside the conversation, with no task handed over.
- A review or verification of work another session claimed: comment on that
  issue or PR instead.
- A subagent working under its parent session's claim.

Issue creation and protocol comments are tracking writes. They are allowed in
read-only tasks and do not authorize editing the work under investigation.

## Session ID

Use the runtime's own identifier: a Claude Code session id, a Codex thread id,
an Antigravity conversation id. Otherwise build
`<executor>-<UTC yyyymmddThhmm>-<suffix>` with the suffix from
`openssl rand -hex 2`, and reuse it for every comment of the session.

## Steps

### 1. Check

Search for the same work before anything else, by keywords and by the files you
will touch:

```bash
gh issue list --repo "<owner/repo>" --state open --search "<keywords>" --json number,title,url
gh pr list --repo "<owner/repo>" --state open --search "<keywords>" --json number,title,headRefName,url
git worktree list
```

Read any matching issue, its comments, and its linked PRs. If another session
holds an active claim on it, or an active claim on another issue overlaps your
files, stop: note it on the issues and wait, or ask the owner which goes
first. If no issue exists, create one with the scope, acceptance criteria,
and the files or module it touches, plus anything `issue_notes` requires.

### 2. Claim

Post one new comment (never edit an old one). The first line is the protocol
line; double-quote any value with a space. `executor=` is one of `executors`:

```text
claim: executor=<executor> session=<id> scope="<files or module>" branch=<branch> target=<YYYY-MM-DD>
```

```bash
gh issue comment "<n>" --repo "<owner/repo>" --body 'claim: executor="Claude Code" session=<id> scope="<files>" branch=<branch> target=<YYYY-MM-DD>'
```

`branch=` and `session=` are required, or a gate or board bot ignores the
claim. While the claim is active, a later `claim:` from the same session
keeps its first comment id: use it to move `target=` or add a branch
(`branch=a,b`, no spaces). After that session posts `release:`, `handoff:`,
or `done:`, a new `claim:` starts over with its own, newer id, so it may lose
to a claim another session posted in between.

### 3. Confirm

Re-read the comments and repeat the overlap search. The active claim with the
lowest comment id wins (the number in its `#issuecomment-<id>` link). If
another session's active claim is lower, post
`release: session=<id> reason="lost the claim race"` and stop.

```bash
gh api "repos/<owner/repo>/issues/<n>/comments" --paginate --jq '.[] | "\(.id) \(.author_association) \(.created_at != .updated_at) \(.body | split("\n")[0])"'
```

An edited protocol comment, or one from an author who is not an owner, member,
collaborator, or contributor, does not count.

### 4. Open the PR early

Push the first commit and open the PR into `integration_branch` with the
reference on its own line. Use `Refs`, never Fixes, Closes, or Resolves;
merging into the integration branch must not close the issue, and a claim
gate rejects closing keywords.

```text
Refs #<n>
```

When `draft_pr_first` is yes, open it as a draft and run
`gh pr ready <number>` when the work is complete.

### 5. Checkpoint

Comment at each milestone (PR opened, merged, deployed, blocked): what is done,
the evidence, and the next step. Not every command.

### 6. End the claim

Post exactly one of:

- `handoff: session=<id> to=<executor or owner>` with done, evidence,
  remaining work, and next step. The receiver posts its own claim.
- `release: session=<id> reason=<why> status=<Ready|Blocked>` when stopping
  without finishing. A blocker names who can clear it.
- `done: session=<id>` with the acceptance evidence named in the issue, then
  close the issue. Follow `done_definition`: CI or a merge alone is not
  acceptance for a runtime change, a change with no runtime surface (docs,
  CI, tooling) is Done once merged with its evidence, and a findings or
  measurements task is Done when its `done:` carries them.

## Fix a failed claim-gate check

This applies when the config names a `claim_gate`. Read the check summary:
it names each problem.

| Problem | Fix |
| --- | --- |
| No issue referenced | Add `Refs #<n>` on its own line to the PR body. |
| Closing keyword | Replace Fixes/Closes/Resolves with `Refs`. |
| No active claim | Post a new `claim:` with this PR's branch. |
| Held by another session | Stop. Coordinate on the issue; never edit a claim or open a parallel issue to pass. |
| Closed issue or a PR referenced | Reference the open issue the work is tracked on. |
| Head in a fork | Push the branch to the repository itself. |

Then trigger a fresh evaluation: edit the PR body, push the next commit, or
dispatch the gate's workflow on `default_branch`. GitHub runs
`pull_request_target` workflows and accepts a dispatch only from the default
branch, so a change to the gate workflows takes effect only once it reaches
that branch:

```bash
gh workflow run "<claim_gate workflow>" --repo "<owner/repo>" --ref "<default_branch>" -f pr="<number>"
```

## Stale claims

Never take over only because a claim looks old. Check recent commits, PR
activity, and active worktrees first; if the claim's session may still be
active, ask the owner. When that session is gone, post
`release: session=<stale id> reason="taken over by <new id>: <evidence>"`, then
your own claim.
