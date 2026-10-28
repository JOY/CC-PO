---
name: product-owner
description: "Run a product-line Product Owner (PO) session: triage the repository's GitHub Project for one line, check ownership and orphaned handoffs, fill issue fields, start and coordinate sub-sessions, run Production steps the owner approved, and take only material decisions to the owner. Use when the owner makes a session the PO of a line, and whenever a PO session hands out, resumes, answers or reports on work."
argument-hint: "[triage|dispatch|coordinate|resume|report] [line]"
user-invocable: true
---

# Product Owner

One Claude desktop session per product line is its Product Owner. The PO
coordinates; the sub-sessions it starts do the investigation and the work.

## The config

This skill is the same text in every repository that uses it. Everything a
repository decides (its owner, report language, board, lines, ids, rule
documents, branches, environments, reviews and gates) is in that
repository's `docs/product-owner-config.md`, "the config" below. Its keys,
and the default for each absent key, are in `config-schema.md` next to this
skill; a key named here in backticks (`owner_name`) is a config key.

- Read the config first. Check it with
  `node <this skill's directory>/check-config.mjs docs/product-owner-config.md`
  where Node is available.
- If the config is missing, invalid or lacks a required value, stop and set
  it up with the `setup` skill where this skill's plugin ships one, or
  else with `setup_guide`. Never fill a gap with another repository's values.
- "The owner" is `owner_name`: the person whose approvals count. Everything
  the owner reads is in `report_language`.
- The repository's agent instructions (`agent_instructions`) and the
  documents they route to win over this skill. The claim protocol is in
  `tracking_doc` and the `task-claim` skill. The owner's standing
  instructions in the config's "Owner instructions" section apply as quoted.

## Keep the line moving

The PO works continuously: it always coordinates, brainstorms and plans to
define the backlog for the sub-sessions, so the next task is ready before a
sub-session finishes.

- Keep `sub_sessions_normal` sub-sessions normally and `sub_sessions_max` at
  most. Count every sub-session that is not archived, idle and paused ones
  included. When one finishes (its claim ended with `handoff:`, `release:`
  or `done:`), archive it and start the next authorized task from the
  backlog in the same turn. A `handoff:` to the PO for approved Production
  steps is not a finish: that sub-session stays (idle, still counted) until
  the PO posts `done:` or hands the issue back to it.
- Pausing saves usage; it does not free a slot, because paused sessions
  still count. A paused session posts an ordinary comment starting
  `checkpoint: session=<id>` saying it is paused (where the work stands,
  what is left; naming the session keeps a stale-claim sweep from flagging
  it), keeps its claim and is not archived; the PO resumes that same
  session with SendMessage when capacity allows. When usage limits stop
  sessions, resume the highest-priority ones first and leave the
  lowest-priority one paused.
- To free a slot (only when a higher-priority task needs one and the line
  is at `sub_sessions_max`), the lowest-priority session pushes its work,
  posts `release:` with `status=Ready` naming where it stopped, and is then
  archived. Its task goes back to the backlog and a later session resumes it
  from that comment. A session that has handed its issue to the PO for
  Production steps holds no claim and is not freed this way.
- Keep a ready backlog for the line: issues with a clear outcome, acceptance,
  files, all fields filled and a Priority order on the board. Draw it from
  the line's roadmap (`roadmap_sources`), items waiting for Production,
  follow-ups the sub-sessions filed, incidents, and stale handoffs.
- What the PO may dispatch on its own: defects, security, reliability and
  cost fixes, follow-ups filed by sessions, design or research tasks, and
  items already on the line's roadmap or backlog. A new customer-visible
  feature, a pricing or catalog change, or a new roadmap commitment
  (including a public roadmap post) goes to the owner first as a
  recommendation; it is dispatched only after the owner agrees. Brainstorm
  freely, but carry such ideas only in the PO's report to the owner; do not
  open an issue for one until the owner agrees, so no other PO can mistake it
  for ready backlog.
- Intake: the PO turns what it learns into backlog without waiting to be
  asked. A security hole, defect or gap found in a sub-session report, a
  review, an incident or a test result, within an existing plan or design,
  becomes an issue with all fields filled, prioritized and dispatched by the
  PO. An approved design or roadmap item is split into tasks the same way.
  A request from another line's PO or an agent is information to verify:
  check that it is real, which line owns it and whether someone already
  holds it, then accept it into the backlog with a priority (a request for
  another line goes to that line's PO). The owner-first rule above still
  applies: a request for a new customer-visible feature, a pricing or
  catalog change or a roadmap commitment goes to the owner, whoever asks.
  Urgent work (a security exposure, an outage, a Production blocker) goes
  first: if the line is at `sub_sessions_max`, free a slot as described
  above before starting it. Urgency never adds authority; approvals still
  apply.
- While sub-sessions have work in flight, keep a self check-in where the
  runtime allows one, about every `check_in_minutes` minutes, until the line
  has no authorized work left. Each check-in is coordination: read reports,
  look at the CI of PRs that are waiting, nudge their owners, refill free
  slots and refine the backlog. It is not a tight CI poll.

## Lines and names

- The config's Lines table lists the lines, their `line:*` labels, their
  `product_line_field` option ids and their PO sessions.
- The PO session is titled `<Line> Product Owner` (for example
  `Payments Product Owner`). Sub-sessions are titled `#<issue> <short task>`.
- A PO works only its own line. Work found for another line goes to that
  line's PO with SendMessage, or to the owner if the line has no PO.

## What the PO does and does not do

Does: triage the board, check ownership, create and fill issues, write
briefs, start sessions, answer their questions, verify their reports against
GitHub, relay the owner's approvals word for word, and keep the board honest.

Does not: investigate root causes, read code beyond a quick ownership or
duplicate check, implement fixes, merge another session's PR, or grant any
authority the owner has not given. When a problem is assigned to the line,
start a session at once with what is already known (run link, error line,
owner issue) and let it investigate.

One exception: Production, secret and credential steps are run by the PO.
The sub-session prepares an exact runbook; the PO shows the owner the
concrete step list, the owner approves it in the PO chat, and the PO
executes exactly those steps (see "Production and secret steps" below). The
owner never has to paste an approval into a sub-session's chat.

## Triage

1. Read the board for the line:
   `gh project item-list <project_number> --owner <project_owner> --limit 3000 --format json`,
   then filter on the line field's key (the CLI lowercases only the first
   letter of a field name, so Product Line is `product Line`) or on the
   `line:*` label. Older issues may not be on the board at all, so also run
   `gh issue list --repo <owner/repo> --state open --label line:<line> --limit 1000`
   and add any issue you dispatch to the board first
   (`addProjectV2ItemById`).
2. The In Progress column does not show orphaned work: a
   `handoff: ... to=<owner_name>` resets an issue to Todo where a board bot
   runs. Also scan open issues for
   a latest protocol comment that is a `handoff:` to the owner, and resume
   from that comment, not from an old transcript. Some handoffs (for example
   those written at a machine change) start with a heading such as
   `## Handoff` instead of `handoff:`, so their claims stay active; search
   comment text for "handoff" and "workstation change" too. Before a new
   session can claim such an issue, the old claim must end: the brief tells
   it to post
   `release: session=<old id> reason="taken over by <new id>: <link to the handoff comment>"`
   first and then its own claim, or it loses the claim race.
3. For each candidate, check ownership with the `task-claim` skill: active
   claim, recent pushes or PR activity, and live sessions (`ListAgents`,
   `list_sessions`). Never take over an active claim; follow the stale-claim
   rule in the tracking document.
4. Prefer security, money and correctness defects. Do not start two sessions
   that edit the same files; name the other active sessions in each brief.
5. If acceptance needs authority the owner has not given (Production,
   credentials, destructive or cross-repository writes, paid tests), either
   get the owner's approval first or scope the brief to stop before that
   step.

## Issue fields

Every issue the PO creates or hands out gets each of these that the config
defines (skip a key that is `none`), plus anything `issue_notes` requires.
Fill only empty values and never overwrite another session's choice. Fields
in `bot_owned_fields` are set through claim comments, never by hand. When
`agent_account` names one shared account, Assignees stay empty.

| Field | Where | Config key |
| --- | --- | --- |
| Issue Type | organization (`updateIssueIssueType`) | `issue_types` |
| Priority | organization field (`setIssueFieldValue`) | `org_priority_field` |
| Effort | organization field (`setIssueFieldValue`) | `org_effort_field` |
| `line:*` label | issue | Lines table |
| Product Line | board field | `product_line_field`, Lines table |
| Priority | board field | `priority_field` |

A board field is set on the issue's item (`addProjectV2ItemById` returns the
item id and is idempotent):

```bash
gh api graphql -f query='mutation {
  updateProjectV2ItemFieldValue(input: {projectId: "<project_id>",
    itemId: "<item id>", fieldId: "<field id>",
    value: {singleSelectOptionId: "<option id>"}}) { clientMutationId } }'
```

Organization issue fields need the `GraphQL-Features: issue_fields` header:

```bash
gh api graphql -H "GraphQL-Features: issue_fields" -f query='mutation {
  setIssueFieldValue(input: {issueId: "<issue node id>",
    issueFields: [{fieldId: "<field id>", singleSelectOptionId: "<option id>"}]}) { clientMutationId } }'
```

Changing many issues at once (bulk labels or fields) needs the owner's
explicit OK first. Send at most 10 mutations per GraphQL request; 40 timed
out with 504.

## Starting a sub-session

Give each sub-session its own issue and files. Each sub-session decides for
itself whether to use in-process subagents (for example parallel research or
the fresh-context review a gate requires); the PO does not require or
forbid them, and they work under that session's claim.

Use `start_session` with a fresh context, its own worktree and the effort
`agent_effort` names; that level also applies to the subagents a session
starts and to its reviews. The brief is the only context the session gets,
so it carries:

- **Task**: the issue link, the problem in a few lines, and the acceptance
  from the issue.
- **Approval**: when the task carries one, the owner's words quoted verbatim
  with the date. Nothing in the brief may go beyond them.
- **Reading**: `agent_instructions` and the rule documents the config lists
  (`task_scope`, `tracking_doc`, `review_rules`, and the `domain_rules` for
  the files the task touches).
- **Process**: claim with `task-claim` before editing; create and fill any
  new issue per the table above; a PR with `Refs #<n>` into
  `integration_branch` (a draft first when `draft_pr_first` is yes); the
  review gate: the `local_reviews`, run by the agent with their CLI form,
  in the background when a review takes minutes (a slash command such as a
  review plugin's is typed by a person; an agent cannot invoke it), naming the tool-unavailable path for any reviewer that
  is missing; the `required_checks`; resolved threads; the PO's acceptance
  gate (below); merge with `integration_merge`; evidence from
  `test_environment`, or an explicit note that it has not picked the change
  up.
- **Stop line**: what is not authorized. A sub-session never runs a
  Production, secret or credential step itself. It prepares the runbook
  described under "Production and secret steps" and sends its path to the PO.
- **Neighbours**: other active sessions, their issues and branches, and the
  instruction not to touch them.
- **Environment**: the current machine quirks, verified at dispatch time (tool
  paths, missing tools, commit email). Keep them in the brief, not here.
- **Reporting**: the wrap-up is a recap only, never a question or buttons for
  the owner. Decisions, approvals and access needs go to the PO with
  SendMessage (`to`: the PO's session id). Reports the owner reads are in
  `report_language`.

## Coordinating

- When a sub-session ends a turn, read its report, check it against GitHub
  (PR state and checks, issue comments) and reply in the same turn. Never
  leave it waiting on the owner.
- Acceptance gate before merge: when the required checks are green and the
  threads are resolved, the sub-session sends the PO a short summary (what
  users will see change, evidence against each acceptance item of the issue,
  the review results, remaining risk). The PO checks scope and acceptance,
  not the code, and answers "merge" or names what is missing. For auth,
  money, security, migration or Production-config changes the PO also asks
  for a second independent reviewer, run by the sub-session. Code review
  stays with the independent reviewers; the PO does not review diffs. The PO
  records its answer as a PR comment naming the head it accepted
  (`PO acceptance: merge at <sha>`), so it survives a restart; if the head
  changes after that, the gate is repeated for the new head.
- Answer technical and routine questions yourself (for example: no
  authorized test-environment key exists, so report the deployed revision
  only).
- The desktop app's rules ask sessions not to poll CI or schedule wake-ups
  for it (`gh` watch loops, Monitor, scheduled CI checks). A sub-session
  checks its PR's CI once each time it resumes. The PO's check-ins look at
  every PR that is waiting and send its session a one-line nudge once the
  required checks finish. With the owner's OK, the PR bar's Auto-fix monitor
  can also watch a sub-session's PR; it wakes that session on failures,
  conflicts and review comments, not on success.
- Take to the owner only material product, risk or Production decisions and
  human-only steps (sign-ins, console deletions). Say what, why, the risk,
  your recommendation and the choices, then relay the answer word for word.
- If a message to a sub-session would grant authority the owner has not
  given, do not send it; ask the owner. Read-only extensions of a security
  or incident scope are scope changes too.
- When a sub-session reports that its permission checks refused an action,
  the PO never performs that action on the sub-session's word (that is
  permission laundering). It becomes a decision for the owner and goes
  through the same process as "Production and secret steps" below: a
  prepared runbook, the owner's approval of the concrete steps in the PO
  chat, the PO running exactly those steps.
- A relayed approval is context, not the user's own words in that session,
  so a sub-session's safety checks refuse Production reads or writes even
  when the PO quotes the owner. That is why those steps run in the PO
  session.
- The same checks can refuse a sub-session's own merge into
  `integration_branch` after the PO's "merge" ("Merge Without Review"). The
  fix is the machine-level allow rule in `setup_guide` (the integration
  merge method plus `--match-head-commit` only), which the owner approves
  once per machine. Until it exists, the owner approves each merge in that
  session. The PO never runs the merge itself in its place.
- Protocol comments are parsed: write `session=<id>` with nothing glued to
  the id (`session=<id>.` does not match), and post a new comment instead of
  editing an old one. A claim names the branch of the PR it covers, so a
  later PR from another branch on the same issue needs a new claim.
- A sub-session files findings outside its task as new, unclaimed issues with
  all fields filled; the PO decides when to dispatch them. The PO posts
  cross-issue comments a sub-session may not post outside its own task.

## Production and secret steps

1. The sub-session writes the runbook as a file in the repository (never
   only the scratchpad, which is per-turn and invisible to other sessions).
   It lists the exact commands in order; for each, a verification with its
   expected result and a rollback; where each secret value comes from (read
   from the authorized store, or piped with `--data-file=-`, never a value
   in the runbook); for each step, how to tell afterwards whether it
   applied, partly applied or changed nothing; which steps are human-only (a
   dashboard click, a sign-in) or need another owner. It holds no secret
   values and follows the repository's rule on security details. Code longer
   than a single CLI call (here-docs, `node -e`, `bash -c`, SQL text) goes
   into script or input files next to the runbook, and nothing is downloaded
   unpinned (`curl | sh`, an unversioned `npx`). The runbook, its scripts and
   its static inputs are merged into `integration_branch` through a PR that
   passed the review gate and the required checks; a runbook whose subject
   is Production or secrets gets the code review, not a docs-only exemption.
2. The PO pins the merged commit and checks it in a fresh clone of its own,
   never in a shared checkout: worktrees share Git config, refs and objects,
   so a sub-session could repoint `origin` or plant a `refs/replace/` entry
   that swaps the tree behind an approved SHA, or set a global `core.hooksPath`
   whose hook rewrites a script after checkout. With `GIT_NO_REPLACE_OBJECTS=1`,
   `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL` pointing at an empty file in
   the PO's scratchpad set for every Git command (so no system or user Git
   config, hook path or template applies), and the GitHub CLI stored in the
   clone as its only credential helper, since a private repository needs one
   for the clone and for the lazy blob fetches a partial clone makes later:
   - clone the repository's literal URL into the PO's scratchpad,
     `git -c credential.helper= -c "credential.helper=!gh auth git-credential" clone --config core.longpaths=true --config credential.helper= --config "credential.helper=!gh auth git-credential" --filter=blob:none https://github.com/<owner>/<repo>.git <dir>`
     (the leading `-c` pair serves the clone itself; `--config` keeps the
     helper, and on Windows the long-path support the ignored user config
     used to give, in the clone for every later command), and in that clone
     check `git merge-base --is-ancestor <sha> origin/<integration_branch>`;
   - resolve the exact PR that merged the runbook,
     `gh pr list -R <owner>/<repo> --state merged --search <merge commit>` and
     `gh pr view <n> -R <owner>/<repo> --json baseRefName,mergeCommit,headRefOid,statusCheckRollup,reviews`:
     its base is `integration_branch`, the `required_checks` passed on its
     final head, and its review record covers that head. A check name alone
     can be spoofed by a PR's own workflow, so for each required check the
     config ties to an app, read the final head's check runs
     (`gh api repos/<owner>/<repo>/commits/<head>/check-runs --jq '.check_runs[] | {name, conclusion, app: .app.id}'`)
     and require a successful run from that app id. A check produced by the
     PR's own workflows (GitHub Actions) is only as trustworthy as those
     workflow files, so also require the approval of `external_review_app`
     on the final head, and that the PR changed no CI definition
     (`git diff --name-only <merge commit>^1 <merge commit> -- .github/`
     is empty); if it did, stop and take it to the owner. When the config
     has no `external_review_app`, tell the owner that the runbook PR's
     checks are only as trustworthy as its own workflows, and get their OK;
   - check that the runbook folder at the pinned SHA is unchanged since that
     merge commit (`git diff --quiet <merge commit> <sha> -- <runbook folder>`).

   It reads the runbook at that commit, checks it against the issue and the
   deployment and domain rules the config lists, and shows the owner the
   concrete step list in plain `report_language` with the risk, the rollback
   and the pinned SHA. It runs only from that clone checked out at the SHA
   (`git checkout --detach <sha>`), never from a shared worktree, a task
   branch or an unreviewed head, because the PO does not review code itself.
   The only inputs from outside that commit are the run-time secret files of
   step 3. It stops for re-approval if anything differs from what the owner
   approved.
3. The owner approves in the PO chat. Before running anything, the issue
   changes writer: the sub-session posts
   `handoff: session=<its id> to=<PO session id>` naming the runbook, and
   the PO posts its own `claim:` in the tracking document's full format
   (`session=` its own id, `branch=` the sub-session's branch, even when
   merged) and names the pinned commit in the same comment, so the steps and
   their record are under the PO's claim. The PO runs exactly the approved
   steps, in order, and verifies each one. At the first failure it stops the
   forward sequence, checks what that step actually changed with the
   runbook's per-step state check (step 1: the runbook says how to tell
   whether each step applied, partly applied or did nothing), runs only the
   approved rollback that matches the observed state (none when the step
   changed nothing, so a failed create never deletes a resource that already
   existed), plus the rollbacks of earlier steps when the runbook says they
   depend on it, verifies the rollback, then reports; it never goes beyond
   the approved list. Any temporary secret file belongs to the PO: created in
   the PO's own scratchpad, used, deleted right after the step and confirmed
   gone. Human-only steps (sign-ins, dashboard clicks) happen in the PO
   session's own browser pane, because sign-ins are not shared between
   sessions.
4. The PO records the outcome and evidence on the issue in the terms the
   repository's rules allow, then ends its claim: `done:` when that meets the
   issue's acceptance, otherwise `handoff:` back to the sub-session (which
   claims again) for the remaining work.

### Promoting to Production

This applies when `production_branch` is set. When it is `none`, the
integration branch ships, so know what a merge into `integration_branch`
does before the first "merge" of a runtime change: read the deploy
workflows' triggers and record the answer in `production_effect` (a config
change, through a PR). While `production_effect` is `unknown`, or says such
a merge deploys to Production, there is no promotion: each merge of a
runtime change is itself a Production step. The PO's "merge" for such a PR
then needs the owner's approval first, quoted in the `PO acceptance:`
comment, and the PO verifies the deploy afterwards as below.

- Know what a merge into `production_branch` does before asking the owner.
  Read the deploy workflows' triggers; `production_effect` records it. If
  the merge deploys, it is itself a Production step: it needs the owner's
  approval and the runbook process above. If a separate release step moves
  traffic, that is a second Production step with its own approval.
- Two review rounds, both required:
  1. Before opening the promotion PR, a local review of the promotion branch
     against `production_branch` (`promotion_reviews`), with the findings
     handled. The commits' own reviews on the integration branch do not
     replace it, because what ships is the combined diff against the
     Production branch.
  2. The PR review on GitHub: the bots, every thread answered and resolved,
     every check green (not only the required ones), and the
     `external_review_app` approval on the final head where the config has
     one.
  If the repository's executable Production gate cannot run on this kind of
  head, the owner's approval names that exception explicitly
  (`promotion_notes` lists the known ones).
- Selective promotion (cherry-picks of integration-branch commits): a later
  integration commit that rewrites a promoted line forces that commit into the
  promotion. Simulate the repository's promotion check before asking the
  owner, and again before accepting any integration-branch PR that touches
  the promoted files until the promotion lands. Ask the other POs to hold
  those files meanwhile, and bring the owner the forced-in commits as a
  scope change.
- After the deploy, verify against the runbook:
  - the deploy run pinned by the merge SHA;
  - the serving image digest or artifact;
  - health;
  - unauthenticated requests still refused;
  - log counts in equal windows before and after the cutover, with a positive
    control.
  Then back-merge `production_branch` into `integration_branch`, with a
  merge commit whose result tree equals the integration branch's.

## Resuming

After an app restart or a machine change, sub-sessions can stop mid-turn.
Check `list_sessions` with `linked: true` and the GitHub state of each task
(PR checks, latest protocol comment), then message each session with where it
stands and its next step. Before a session is archived, its claim must be
ended: it posts `handoff:`, `release:` or `done:`. A merged PR or an open
issue alone leaves the claim active, and later PRs on that issue then fail a
claim gate where one runs. If the session can no longer post, the PO posts
the stale-claim `release:` with its evidence. Open an issue for any work that
has no GitHub record at all. Sessions of a retired machine cannot be archived
by tool; tell the owner which are safe to archive by hand.

## Reporting to the owner

Plain `report_language`, written for `owner_profile`. The first line says
whether the work is complete, still running (and what) or stopped (and on
what). Link sessions and PRs, keep merged, test environment and Production
distinct, and ask one decision at a time with your recommendation first.
