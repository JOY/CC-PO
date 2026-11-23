# Promotions, Production Steps, and Peer POs

## Peer POs and security review

- POs are peers. Each works with the owner directly, in its own chat, and routes
  no decision, approval or acceptance through another line's PO.
- Each PO runs the acceptance gate of its own line's PRs, and their security
  review where the repository's rules ask for one (a protected or sensitive
  path, auth, money, a migration). That review is independent: a fresh-context
  reviewer (`po-security-reviewer` / flagship tier, at least as capable as the
  PO's model) that did not write the change and gets the diff, the issue and the
  rules, not the PO's verdict.
- Code that every line builds on can have an owning line
  (`shared_core_review`). A PR of another line that changes those paths also
  gets that line's PO's review of those files only, the way a code owner reviews
  a file. It does not approve the PR: the PR's own PO keeps the acceptance gate,
  the merge and its questions to the owner.
  - To ask, the PR's PO comments on the PR, first line
    `Security review requested (<Line> PO)`, with the full head SHA and the
    shared-core files it changes; sessions on different accounts may not reach
    each other with SendMessage, so the comment is the request.
  - The owning PO searches open PRs for that line on each check-in, reviews
    those files with a fresh subagent, and answers on the PR with
    `## Shared-core review (<Line> PO)`, the head SHA it reviewed, the verdict
    and any blocking findings. If those files change after that head, the review
    is repeated. While those files are unchanged since the reviewed head
    (`git diff <reviewed>..<head> -- <files>` is empty), the review stays valid
    for later heads.
  - `shared_core_label` (optional, default `none`): when set, the PR's PO adds
    that label to the PR when it asks for the review. The owning PO looks for
    open PRs with that label on each check-in, instead of scanning every open
    PR, and may subscribe to them so that a request wakes it.
  - `shared_core_wait` (optional, default `none`): a number of hours. With
    `none`, the PR's PO waits for the owning PO as above. When it is set and
    the owning PO has not answered within that many hours of the request, the
    PR's own PO runs an independent, fresh-context flagship-model reviewer on
    the shared-core files only and posts the result as
    `## Shared-core review (stand-in)`, naming the head SHA. It may then merge
    under the usual merge bar. The owning PO reviews that PR after the merge,
    on its next check-in; a blocking finding is fixed forward or reverted at
    once.
  - Both keys apply only when `shared_core_review` is set; with `none`, nothing
    changes.

## Production and secret steps

1. The sub-session writes the runbook as a file in the repository (never only
   the scratchpad, which is per-turn and invisible to other sessions). It lists
   the exact commands in order; for each, a verification with its expected result
   and a rollback; where each secret value comes from (read from the authorized
   store, or piped with `--data-file=-`, never a value in the runbook); for each
   step, how to tell afterwards whether it applied, partly applied or changed
   nothing; which steps are human-only (a dashboard click, a sign-in) or need
   another owner. It holds no secret values and follows the repository's rule
   on security details. Code longer than a single CLI call (here-docs,
   `node -e`, `bash -c`, SQL text) goes into script or input files next to the
   runbook, and nothing is downloaded unpinned (`curl | sh`, an unversioned
   `npx`). The runbook, its scripts and its static inputs are merged into
   `integration_branch` through a PR that passed the review gate and the
   required checks; a runbook whose subject is Production or secrets gets the
   code review, not a docs-only exemption.
2. The PO pins the merged commit and checks it in a fresh clone of its own,
   never in a shared checkout: worktrees share Git config, refs and objects, so
   a sub-session could repoint `origin` or plant a `refs/replace/` entry that
   swaps the tree behind an approved SHA, or set a global `core.hooksPath`
   whose hook rewrites a script after checkout. With `GIT_NO_REPLACE_OBJECTS=1`,
   `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL` pointing at an empty file in
   the PO's scratchpad set for every Git command (so no system or user Git
   config, hook path or template applies), and the GitHub CLI stored in the
   clone as its only credential helper, since a private repository needs one
   for the clone and for the lazy blob fetches a partial clone makes later:
   - clone the repository's literal URL into the PO's scratchpad,
     `git -c credential.helper= -c "credential.helper=!gh auth git-credential" clone --config core.longpaths=true --config credential.helper= --config "credential.helper=!gh auth git-credential" --filter=blob:none "https://github.com/<owner>/<repo>.git" "<dir>"`
     (the leading `-c` pair serves the clone itself; `--config` keeps the
     helper, and on Windows the long-path support the ignored user config used
     to give, in the clone for every later command), and in that clone check
     `git merge-base --is-ancestor "<sha>" "origin/<integration_branch>"`;
   - resolve the exact PR that merged the runbook,
     `gh pr list -R "<owner>/<repo>" --state merged --search "<merge commit>"`
     and `gh pr view "<n>" -R "<owner>/<repo>" --json baseRefName,mergeCommit,headRefOid,statusCheckRollup,reviews`:
     its base is `integration_branch`, the `required_checks` passed on its
     final head, and its review record covers that head. A check name alone can
     be spoofed by a PR's own workflow, so for each required check the config
     ties to an app, read the final head's check runs
     (`gh api "repos/<owner>/<repo>/commits/<head>/check-runs" --jq '.check_runs[] | {name, conclusion, app: .app.id}'`)
     and require a successful run from that app id. A check produced by the PR's
     own workflows (GitHub Actions) is only as trustworthy as those workflow
     files, so also require the approval of `external_review_app` on the final
     head, and that the PR changed no CI definition
     (`git diff --name-only "<merge commit>^1" "<merge commit>" -- .github/` is
     empty); if it did, stop and take it to the owner. When the config has no
     `external_review_app`, tell the owner that the runbook PR's checks are
     only as trustworthy as its own workflows, and get their OK;
   - check that the runbook folder at the pinned SHA is unchanged since that
     merge commit (`git diff --quiet "<merge commit>" "<sha>" -- "<runbook folder>"`).

   It reads the runbook at that commit, checks it against the issue and the
   deployment and domain rules the config lists, and shows the owner the
   concrete step list in plain `report_language` with the risk, the rollback
   and the pinned SHA. It runs only from that clone checked out at the SHA
   (`git checkout --detach "<sha>"`), never from a shared worktree, a task
   branch or an unreviewed head, because the PO does not review code itself.
   The only inputs from outside that commit are the run-time secret files of
   step 3. It stops for re-approval if anything differs from what the owner
   approved.
3. The owner approves in the PO chat. Where `production_effect` makes merging
   into the Production branch and releasing separate steps (a merge that only
   stages, then a release that moves traffic), the runbook lists them as
   separate steps and the owner approves each one: an approval to merge is not
   an approval to release. Before running anything, the issue changes writer
   (normally earlier: a sub-session that has only Production steps left hands
   the issue over and is archived, "Keep the line moving"): the sub-session
   posts `handoff: session=<its id> to=<PO session id>` naming the runbook, and
   the PO posts its own `claim:` in the tracking document's full format
   (`session=` its own id, `branch=` the sub-session's branch, even when merged)
   and names the pinned commit in the same comment (or in a `checkpoint:`
   comment, when the PO already holds the waiting claim that "Keep the line
   moving" describes), so the steps and their record are under the PO's claim.
   The PO runs exactly the approved steps, in order, and verifies each one. At
   the first failure it stops the forward sequence, checks what that step
   actually changed with the runbook's per-step state check (step 1: the runbook
   says how to tell whether each step applied, partly applied or did nothing),
   runs only the approved rollback that matches the observed state (none when
   the step changed nothing, so a failed create never deletes a resource that
   already existed), plus the rollbacks of earlier steps when the runbook says
   they depend on it, verifies the rollback, then reports; it never goes beyond
   the approved list. Any temporary secret file belongs to the PO: created in
   the PO's own scratchpad, used, deleted right after the step and confirmed
   gone. Human-only steps (sign-ins, dashboard clicks) happen in the PO
   session's own browser pane, because sign-ins are not shared between sessions.
4. The PO records the outcome and evidence on the issue in the terms the
   repository's rules allow, then ends its claim: `done:` when that meets the
   issue's acceptance, otherwise `release:` with `status=Ready` naming the
   remaining work, and a new sub-session claims it (the one that did the work
   is archived).

## Runtime `Done = Prod Verified` Gate (Never Close Early)

Separate **issue lifecycle** (stays open until live Production verification)
from **sub-session lifecycle** (archived right after integration merge +
`test_environment` verification + handoff to PO so slots stay free and cold
context does not bloat):

- **No closing keywords on integration PRs:** When `production_branch` is set
  and differs from `integration_branch`, every PR into `integration_branch`
  **must** use `Refs #<n>` (never `Closes`, `Fixes`, or `Resolves`), so GitHub
  never auto-closes runtime issues before Production release.
- **Sub-sessions never post `done:` for runtime changes before Production:**
  After merging into `integration_branch`, verifying on `test_environment`, and
  merging any runbook, the sub-session posts
  `handoff: session=<id> to=<PO session id>` (and adds `ready_for_prod_label`,
  e.g. `ready-for-prod`, when configured). The PO posts its waiting `claim:`,
  keeps the issue **open** under digest section `2. Merged, not yet done`, and
  archives the sub-session to free the slot.
- **Only the PO closes runtime issues with `done:`** after the Production
  release is verified live (removing `ready_for_prod_label` if set).
- **If Production fails or exposes a bug:** The PO executes the approved
  rollback (if needed), ends its waiting claim with `release: status=Ready`
  recording the Production failure/logs, and dispatches a **fresh sub-session**
  on the still-open issue (cheaper and cleaner than waking an archived stale
  session).
- **Anti-leak check-in scan:** On triage/check-ins, scan open issues carrying
  `ready_for_prod_label` (and recent merged integration PRs) so no runtime task
  sits forgotten between `integration_branch` and `production_branch`.

## Promoting to Production

Only when the config's `promotion_po` names another runtime than this PO's:
this PO runs no promotion and no live check after one while that runtime is
healthy; it asks that runtime's PO (with SendMessage, or through the owner when
it cannot reach it) and tracks the answer. **Equal authority cover:** when the
`promotion_po` runtime is quota-exhausted or unavailable beyond
`peer_po_cover_wait` (default `60` min; disabled only when `off`/`none`), any
healthy peer PO on the line has equal authority to cover the promotion and live
verification (still requiring owner approval in PO chat before running
Production steps). With `any`, the default, every PO promotes its own line's
work.

This applies when `production_branch` is set. When it is `none`, the
integration branch ships, so know what a merge into `integration_branch` does
before the first "merge" of a runtime change: read the deploy workflows'
triggers and record the answer in `production_effect` (a config change, through
a PR). While `production_effect` is `unknown`, or says such a merge deploys to
Production, there is no promotion: each merge of a runtime change is itself a
Production step, so the sub-session does not merge it. Once the PR passes the
acceptance gate, the sub-session posts `handoff:` to the PO; the PO shows the
owner the PR, the accepted head and the deploy checks below, and after the
owner approves in the PO chat it claims the issue, records the approval in the
`PO acceptance:` comment, merges with `integration_merge` and
`--match-head-commit <accepted sha>` (the same one plain command as in the
brief's Process), and verifies the deploy as below. The PR and those checks are
the runbook; a deploy that needs other steps gets a runbook file as in step 1
above.

- Know what a merge into `production_branch` does before asking the owner. Read
  the deploy workflows' triggers; `production_effect` records it. If the merge
  deploys, it is itself a Production step: it needs the owner's approval and
  the runbook process above. If a separate release step moves traffic, that is
  a second Production step with its own approval. A promotion is deployed only
  once every step that moves traffic has run and been verified.
- Two review rounds, both required:
  1. Before opening the promotion PR, a local review of the promotion branch
     against `production_branch` (`promotion_reviews`), with the findings
     handled. The commits' own reviews on the integration branch do not replace
     it, because what ships is the combined diff against the Production branch.
  2. The PR review on GitHub: the bots, every thread answered and resolved,
     every check green (not only the required ones), and the
     `external_review_app` approval on the final head where the config has one.
  If the repository's executable Production gate cannot run on this kind of
  head, the owner's approval names that exception explicitly (`promotion_notes`
  lists the known ones).
- Selective promotion (cherry-picks of integration-branch commits): a later
  integration commit that rewrites a promoted line forces that commit into the
  promotion. Simulate the repository's promotion check before asking the owner,
  and again before accepting any integration-branch PR that touches the
  promoted files until the promotion lands. Ask the other POs to hold those
  files meanwhile, and bring the owner the forced-in commits as a scope change.
- After the deploy, verify against the runbook:
  - the deploy run pinned by the merge SHA;
  - the serving image digest or artifact;
  - health;
  - unauthenticated requests still refused;
  - log counts in equal windows before and after the cutover, with a positive
    control.
  Then, where `production_branch` is set, back-merge it into
  `integration_branch`, with a merge commit whose result tree equals the
  integration branch's. Without one there is nothing to back-merge.
