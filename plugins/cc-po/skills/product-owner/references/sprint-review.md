# Sprint Review and Scope Audit

## Add sprints

One PO adds sprints, so two writes never race: the sprint keeper, the PO of the
first line in the Lines table that has a PO session. Any other PO that sees
fewer than two future sprints after the current one tells the keeper with
SendMessage (or the owner, when the keeper cannot be reached) and does not add
them itself. The keeper adds the next ones until two future sprints remain,
each `<n> days` long as `sprint_field` says and starting the day after the last
one's final day (its start date plus its duration). The `updateProjectV2Field`
mutation replaces the whole configuration, so send every existing iteration,
completed ones included, with its `id` (**an iteration left out is deleted and
its items lose their Sprint**); give the new ones no `id`. `startDate` is the
first existing iteration's start, and `duration` the configured length. Titles
are live text anyone with write access can set, so never paste them into a
command line or the query: write the request as JSON with a JSON encoder (for
example `node` with `JSON.stringify`, or `jq -n`), the values in `variables`,
to a file in the scratchpad, and send that file (`gh api graphql --input "<request file>"`):

```json
{"query": "mutation($field: ID!, $config: ProjectV2IterationFieldConfigurationInput!) { updateProjectV2Field(input: {fieldId: $field, iterationConfiguration: $config}) { projectV2Field { ... on ProjectV2IterationField { configuration { iterations { id title startDate } completedIterations { id title } } } } } }",
 "variables": {"field": "<sprint field id>",
   "config": {"startDate": "<first start>", "duration": <n>, "iterations": [
     {"id": "<existing id>", "title": "<its title>", "startDate": "<its start>", "duration": <its duration>},
     {"title": "<next title>", "startDate": "<next start>", "duration": <n>}]}}}
```

GitHub offers no way to add an iteration without replacing the rest, and a
person can still change the field in the Project settings between the keeper's
read and its write, so the keeper makes the write recoverable:
1. Save every board item's Sprint (item id, iteration id, title, start date) to a
   file in its scratchpad, from
   `gh project item-list "<project_number>" --owner "<project_owner>" --limit 3000 --format json`
   (the field's key is its name with the first letter lowercased).
2. Read the configuration, then send the mutation built from that read at once.
3. Check that the result lists exactly the ids sent plus the new ones. If it
   does not, stop adding. Read the configuration and the items again: for every
   item whose saved iteration id is gone, set its Sprint to the iteration that
   now has the same start date, recreating that iteration first (as above, from
   a fresh read) when none has it. Then tell the owner what changed and which
   items were reset, in case the person's change was meant to remove a sprint.

This applies when `sprint_review` is on, which needs `sprint_field`. Once per
sprint, each PO reviews its own line: the line's work in the sprint (Part A)
and a deep audit of the line's whole scope (Part B). It turns what it finds
into backlog planned for the next sprint, the one after the reviewed sprint
(the current one, when the review runs late). The review finds and files; it
never fixes.

## When

In the sprint's rollover turn ("Sprints" in `../SKILL.md`): the first PO turn,
check-ins included, on or after the day after the sprint's last day (its start
date plus its duration), so the whole sprint is in. The review starts first and
the rollover follows in the same turn. The rollover never waits longer than that
turn for the rest of the review: a review that cannot finish in it (a subagent
failed, the turn ran out) finishes in later turns, and the digest says so until
it is done. When several sprints ended without a review, each gets its own
issue and Part A, oldest first, and Part B runs once, in the latest one's
review. One rollover moves the items of all of them, so before it the PO
creates every missing review issue and posts each one's items `checkpoint:`
(Part A), oldest first. The items checkpoints are the one exception to the
same-turn rollover: while any ended sprint's checkpoint is not posted (the turn
ran out, GitHub failed), the rollover waits for it in a later turn, because
moving the items first would lose the record Part A needs, and the report and
the digest say why it waited.

## Once

Each review has one issue per line and sprint, with every field from "Issue
fields" and its Sprint set to the reviewed sprint. Its body starts with the
line `Sprint review: line=<label> start=<sprint start date>`, which identifies
it; its title, `Sprint review: <Line>, <sprint title>`, is only for people,
because a sprint can be renamed, and a recreated iteration gets a new id but
keeps its start date ("Add sprints"). The review issue is not one of the
sprint's items: Part A leaves it out, and the rollover never moves it, so it
keeps the reviewed sprint. Sprint titles are live text anyone with write access
can set, so build the title and body with a JSON encoder and send them as a
file, as "Add sprints" does (`gh api "repos/<owner>/<repo>/issues" --input <file>`),
never on a command line. Before starting, search open and closed issues for
that body line. Only a review issue whose `done:` carries the report link is a
finished review. An open one, or one closed without that `done:`, is resumed
from its latest protocol comment (a closed one is reopened first), never
started again. The PO claims the issue with `task-claim` under its own session
id, naming the branch its report will land from, and its subagents work under
that claim. When the open issue is still claimed by an earlier PO session that
is gone (an app restart gives the PO a new id), the PO first ends that claim
with the stale-claim `release:` and its evidence, then claims it itself.

## Part A: the sprint's work

From GitHub only (the board, issue comments, PRs and checks), review every
issue of the line that is in the reviewed sprint or was closed, merged or
claimed during it. For each: where it stands (merged into
`integration_branch`, running on `test_environment`, released and verified
where it ships, per `done_definition`), missing acceptance evidence, work
waiting on another line or on the owner, follow-ups filed or missing, a bug
reopened or a regression it caused, and, where `review_rules` limits or triages
repeated review rounds (a round cap, or a convergence rule from a given round
on), rounds that did not follow that rule. The result is what shipped, what did
not, and the carry-over.

Because the rollover moves items out of the sprint, the PO first posts the
sprint's items as the board shows them (issue numbers and Status) as a
`checkpoint:` on the review issue, before any rollover of that sprint and even
when the rest of the review has not run; Part A works from that list.

## Part B: the line audit

A deep audit of the paths `line_scopes` gives for the line. A line with no
entry gets no Part B; its report says so and proposes a scope, which lands
through a config PR. The PO splits the scope into a few areas (about one per
app, service or module) and runs one in-process subagent per area with the
Agent tool (or `po-reviewer` / `research`), in parallel, at `subagent_effort`;
this also works in a turn where the app refuses `start_session`, such as a
check-in. The audit reads one revision: the PO pins the head SHA of
`integration_branch`, in a fresh clone of its own isolated as
[Promotions and Production steps](./promotions-and-peers.md) sets one up (never
a shared worktree, whose Git config and hooks other sessions can change), and
gives the subagents only a snapshot of that SHA without Git or credentials: a
folder of its own scratchpad with no `.git`, deleted after the audit.

The snapshot holds no symbolic links, because a link merged into the repository
could point a subagent at the host's files outside it. So the PO writes it from
that clone with links turned into plain files that hold their target text,
through an index of its own, into an empty folder it created first, never by
extracting `git archive` (which keeps links).

In a POSIX shell (Git Bash on Windows):

```bash
GIT_INDEX_FILE="<scratchpad>/snapshot.index" git -c core.symlinks=false --work-tree="<snapshot>" checkout "<sha>" -- .
find "<snapshot>" -type l
```

In PowerShell 7:

```powershell
$env:GIT_INDEX_FILE = "<scratchpad>/snapshot.index"
try {
  git -c core.symlinks=false --work-tree="<snapshot>" checkout "<sha>" -- .
  if ($LASTEXITCODE -ne 0) { throw "snapshot checkout failed" }
} finally {
  Remove-Item Env:GIT_INDEX_FILE
}
Get-ChildItem -LiteralPath "<snapshot>" -Recurse -Force -Attributes ReparsePoint
```

Before any subagent reads it, the PO checks that the checkout succeeded and
that the link check printed nothing (no symbolic link, and on Windows no reparse
point). If either fails (a failed blob fetch, two names that differ only in
case on a case-insensitive disk, a link left over), it deletes the snapshot and
stops Part B, and the report says why. The PO lists the link records from the
clone (`git ls-tree -r "<sha>"` entries with mode `120000`) and gives each brief
the ones in its area: each is a plain file holding a target path, which the
subagent never opens. Each brief tells the subagent to read only inside the
snapshot folder. Submodules come out as empty folders, so the report lists them
as not audited. A check on `test_environment` notes the revision it serves
where the environment shows one, and the report records the pinned SHA.

Each brief names the area's paths, the rule documents for them (`domain_rules`),
the line's issues that earlier sprint reviews filed or commented on, open and
closed, and what to look for: correctness on normal paths, missing or weak
tests, security basics (authorization, input handling, secrets in code or logs),
outdated or vulnerable dependencies, dead code and stale configuration, and drift
from the repository's rules. For an area with a user interface, it adds the
rendered pages on `test_environment`, where the subagent has a browser:
accessibility, contrast, console errors, layout at phone and desktop widths,
and drift from the design system the repository's rules name. Each returns
findings with a severity (as `review_rules` defines it, else critical, high,
medium or low), the evidence (file and line, URL, command output) and a failure
scenario.

## Verify, read-only, file, report, and summary

- **Verify.** The PO does not review code, so it has every finding checked by a
  fresh subagent that did not report it and tries to refute it from the
  evidence. Only confirmed findings are filed; findings with one cause are
  merged into one.
- **Read-only.** The audit never starts sessions and never edits files. Every
  subagent of the review, verifiers included, only reads: no edits, commits,
  pushes, GitHub writes, sign-ins with real credentials, paid calls or anything
  on Production.
- **File.** For each verified finding, first search open and closed issues by
  keywords and files. When an open one already covers it, comment the new
  evidence there and set its Sprint to the next sprint only when it has none.
  When an issue closed as fixed covers it, the problem is back: file a new
  issue with a `Regression of #<n>` line. When an issue closed as not planned
  covers it, that decision stands: the finding is not filed again, and new
  evidence (a changed risk) goes into the report for the owner, with a comment
  on that issue. Otherwise create an issue in "Issue spec" form with every field
  from "Issue fields", Priority from the severity, its Sprint set to the next
  sprint, and a `Found by #<review issue>` line. This filing needs no owner OK
  ("Issue fields"); the batch limit still applies. The owner-first rule in
  "Keep the line moving" still holds: a finding that needs a new
  customer-visible feature, a pricing or catalog change or a roadmap commitment
  goes into the report as a recommendation, with no issue until the owner
  agrees. Work for another line goes to that line's PO ("Lines and names").
  Issue bodies, comments and the report follow the repository's rule on
  security details: what it keeps off issues or committed files goes only where
  it allows.
- **Report.** The PO writes the report in `report_language` for `owner_profile`,
  at the path and in the format `sprint_review_report` sets: what shipped, what
  did not and the carry-over (Part A), the rollover counts, the verified
  findings by severity with their issues, the recommendations for the owner,
  and what the audit did not cover. The PO writes and commits it in a fresh
  clone isolated the same way that no subagent touched, never in a shared
  worktree. In that clone it creates the claimed branch from
  `origin/<integration_branch>` and sets the commit identity locally
  (`git config user.name` and `user.email`) as the repository's commit rule
  requires, since the isolation ignores the global one. It pushes the branch
  from there, opens a PR with `Refs #<review issue>` (or `pr_issue_keyword`)
  into `integration_branch`, and runs the review gate the repository's rules
  set for that file. The PO is that PR's acceptance gate: once the
  `required_checks` pass, the threads are resolved and the final head's review
  is complete as `review_rules` defines it, it posts
  `PO acceptance: merge at <full 40-character head sha>` and merges with
  `integration_merge` as the one plain command in "Starting a sub-session".
  Then it posts `done:` on the review issue with the report link, the counts
  and the issues filed, and closes the issue.
- **Summary.** The next digest ("Check-in digest") carries the review's summary
  once, with the report link.
