---
name: product-owner
description: "Run a product-line Product Owner (PO) session: triage the repository's GitHub Project for one line, check ownership and orphaned handoffs, fill issue fields, start and coordinate sub-sessions, run Production steps the owner approved, and take only material decisions to the owner. Use when the owner makes a session the PO of a line, and whenever a PO session hands out, resumes, answers or reports on work."
argument-hint: "[triage|dispatch|coordinate|resume|report] [line]"
user-invocable: true
---

# Product Owner

One session per product line is its Product Owner (PO). The PO coordinates;
sub-sessions investigate and implement. The owner talks only to the PO: whatever
a sub-session needs from the owner reaches the owner through the PO chat.

## Reference guides (read when needed)

- [Wake-ups, gatekeeper, watchdog, and monitor retries](./references/wake-ups.md) (`po_wake`, check-in, `claude-gatekeeper-eval.mjs`, `claude-gatekeeper-preflight.mjs`, heartbeats, `set_monitor`)
- [Sprint review and scope audit](./references/sprint-review.md) (`sprint_review: on`, Part A/B, snapshot, report PR)
- [Promotions, Production steps, and peer POs](./references/promotions-and-peers.md) (`shared_core_review`/`wait`/`label`, runbooks, deploy gates)
- [PO handoff, parallel POs, and check-in cap](./references/handoff-and-parallel.md) (`po_labels`, `peer_po_cover_wait`, `peer_po_issue_cover_wait`, `<= 6 KB` cap, `po_handoff`, exceptions)
- [Antigravity host orchestration and models](./references/antigravity-host.md) (`run_workflow`, `swarm(models)`, `po-model-advisor.mjs`, 10m `agy-gatekeeper.mjs`, `hooks.json`)

## The config

Repository values live in `docs/product-owner-config.md` ("the config"); keys
and defaults are in `config-schema.md` next to this skill.

- Check first: `node "<this skill's directory>/check-config.mjs" docs/product-owner-config.md`. If missing or invalid, stop and run `setup` (or `setup_guide`).
- "The owner" is `owner_name`; everything they read is in `report_language`.
- `agent_instructions` (and routed rules) win over this skill; `tracking_doc` and `task-claim` govern claims. When the config sets `claim_command`, every claim this skill names (a sub-session's, and the PO's own `claim:`, `release:`, `handoff:` and `done:`) goes through that command's lock as "Claim lock" in `task-claim` says, each session with its own claimant (`--take-over` when replacing an earlier session's claim, so it instead claims with `--take-over`, linking the handoff comment or owner's words). Without `claim_command`, nothing changes.
- Standing owner instructions come from current `decision_log` entries (else the config's "Owner instructions", never both). GitHub reads/writes use `gh` CLI.

## Keep the line moving

- Keep `sub_sessions_normal` (default 3) to `sub_sessions_max` (default 5) active sub-sessions (counting non-archived, idle, paused, and `PO queued:` dispatches). Fill up to `sub_sessions_max` during owner turns. When one finishes (`handoff:`, `release:`, `done:`; a `handoff:` to the PO for Production steps follows the next bullet), archive it with `archive_session` and dispatch the next ready issue (the owner's "always allow" covers the rest).
- **Production-waiting slot release (Done = Prod verified):** For runtime changes awaiting Prod (merged to `integration_branch`, verified on `test_environment`), sub-sessions **never** post `done:` or close the issue; they post `handoff: session=<id> to=<PO session id>` (adding `ready_for_prod_label` if set), the PO posts its own `claim:` on the issue (`branch=` sub-session's branch, `scope="Production steps, waiting for <what>"`), posts `checkpoint: session=<PO session id> waiting for <what>` so the repository's stale-claim sweep sees activity (the PO's own waiting claims for Production steps stay under `2. Merged, not yet done` / "Waiting on the PO or the owner"), and only then archives the sub-session. This early claim is a waiting claim. The slot is free while Production waits. Only PO posts `done:` after Prod verification; on failure, roll back & dispatch fresh.
- **Pausing vs freeing:** Paused sessions keep their claim, post `checkpoint: session=<id>` (paused state), and still count against slots. To free a slot for urgent work at `sub_sessions_max`, the lowest-priority session pushes, posts `release: ... status=Ready`, and is archived.
- **Fewer, cheaper tasks, backlog pull & brainstorm:** Batch minor P2/P3 nits into one checklist on one cleanup issue per line per week. Dispatch defects, security, reliability, cost fixes, follow-ups, design/research, and roadmap/backlog items autonomously: when `Ready` is empty, pull & refine `Backlog` issues (and cover unclaimed `po:<peer>` issues after `peer_po_issue_cover_wait`, default 240m; quota never shortens it). When both `Ready` and `Backlog` are empty, read `roadmap_sources` + product gaps and proactively brainstorm 3–5 concrete next backlog proposals via popup for owner OK (new customer-visible features/pricing/roadmap need owner approval). Urgent security/outage/Prod blockers take priority.
- **Check-in cadence:** Real events (turn ends, messages, CI/review events) wake the PO. Under `po_wake: gatekeeper` (the default) the PO keeps no in-session check-in (no `CronCreate` check-in and no `ScheduleWakeup` loop). Under `po_wake: watchdog` it also keeps a self check-in (`check_in_minutes`). Check-ins coordinate, verify CI, nudge sessions, refine backlog, maintain sprints, archive finished wake runs, and end with the digest.

## Keep the context small

- State lives on GitHub and in the check-in file (`<= 6144` bytes / `6 KB`; see [Wake-ups](./references/wake-ups.md) and [Handoff and parallel POs](./references/handoff-and-parallel.md)).
- A wake turn is short (do only what the wake needs; a quiet wake with nothing to do gets a one-line digest). Read only what the reason needs. Never re-read a long log, transcript or diff already summarised.
- Keep tool output short: cut the output with `--jq` and `--limit`. Delegate wide reads. Offload board `item-list`, audits, and diffs/logs to read-only subagents (`po-explorer` / `research` on `flash`, `po-reviewer`, `po-security-reviewer`) or `run_workflow`, returning compact digests (`<= 30` lines). Never read a session transcript or a long file into the PO (no `export_transcript`, no bulk `list_events`).
- The PO is one long-lived session. It relies on the app's automatic context compaction and never asks the owner to compact it, restart it or open a new PO session because of its context size; where supported, proactively `/compact` around ~100K–120K tokens (or `po_context_compact_tokens`) to avoid ~300K cold-wake bloat. A PO ignores any "Handoff notice" or "Context notice" in a wake message.

## Lines, names, and what the PO does

- PO title: `<Line> Product Owner`; sub-sessions: `#<issue> <short task>`. Route cross-line work to that line's PO (or owner). Under `po_labels`, Antigravity and Claude POs have **equal authority** (`po:*` prevents races when both are healthy; healthy PO covers peer merges/promotions when peer is quota-limited or idle `>= peer_po_cover_wait`, default 60m; [Handoff and parallel POs](./references/handoff-and-parallel.md)). For peers and `shared_core_review`, see [Promotions and peers](./references/promotions-and-peers.md).
- **PO does:** triage, ownership checks, create/fill issues, write briefs, start/answer sub-sessions, verify reports against GitHub, relay approvals verbatim, run sprint reviews, and execute owner-approved Production/secret runbooks.
- **PO does not:** investigate root causes, read code beyond ownership/duplicate checks, implement fixes, review diffs directly (delegate to independent reviewers), or merge another session's PR (unless that merge is itself a Production step).

## Triage and Backlog Readiness

1. Read board (`gh project item-list "<project_number>" --owner "<project_owner>" --limit 3000 --format json`; Product Line field key lowercases first letter: `product Line`) and open `line:<line>` issues (`gh issue list --repo "<owner/repo>" --state open --label "line:<line>" --limit 1000`). Add unboarded issues via `addProjectV2ItemById`.
2. Scan for orphaned `handoff:` to the owner (including `## Handoff` / "workstation change"); briefs for resuming them must end the old claim with `release: session=<old id> reason="taken over by <new id>: <link>"` (or `--take-over` under `claim_command`) before claiming.
3. Verify ownership via `task-claim` (`claim_command` lock holder if set; skip other POs' labels under `po_labels`).
4. Check dependencies (`blockedBy` GraphQL query + `Blocked by #<n>`); dispatch only unblocked issues.
5. Never start two sessions touching the same files; list neighbours in every brief.
6. Scope briefs before unauthorized Production, credential, destructive, cross-repo, or paid-test steps.

**Refine: is it ready?** Flag unclaimed open issues lacking observable acceptance, required fields/dependencies, specs, 30+ day activity, or matching Priority, and propose fixes (bulk updates need owner OK).

## Issue fields, Issue spec, and Sprints

Fill empty issue/board fields (`issue_types`, `org_priority_field`, `org_effort_field`, `line:*`, `product_line_field`, `priority_field`, `sprint_field`, `issue_notes`); skip `none` and `bot_owned_fields`. Leave Assignees empty when `agent_account` is shared. Max 10 GraphQL mutations per request.

- **Board field:** `updateProjectV2ItemFieldValue` (`projectId`, `itemId`, `fieldId`, `value: {singleSelectOptionId: "<id>"}` or `{iterationId: "<id>"}`).
- **Org field:** `setIssueFieldValue` with header `GraphQL-Features: issue_fields`.
- **Issue spec:** `## Goal`, `## Requirements`, `## Approach`, `## Acceptance`, `## Files` (plus `Blocked by #<n>`, `Decision: <id>` when applicable; no blank sections, use `TBD: <why> (<who decides>)`).
- **Sprints (`sprint_field`):** Query `ProjectV2IterationField` live (`iterations`, `completedIterations`). Assign current sprint at hand-out. On rollover turns, run `sprint_review` first ([Sprint review](./references/sprint-review.md)), move open non-Done items from ended sprints to the current sprint, and report done/carried/not-planned counts once. Only the sprint keeper (first line with a PO) adds sprints (`updateProjectV2Field` replaces the whole config and deletes any omitted existing/completed IDs; see [Add sprints](./references/sprint-review.md#add-sprints) for the JSON file mutation and 3-step recovery check).

## Starting a sub-session

- **Owner turns vs queued dispatches:** Start sub-sessions directly (`start_session`, `initiation: "user_asked"`) during any owner desktop turn. In check-in/event turns, post the brief as `PO queued:` on the issue (counted toward `sub_sessions_max`). At the next owner desktop turn, apply any message updates, re-verify open/unclaimed/unblocked/`list_sessions`, and start queued items highest-Priority first (drop failed checks with `PO queued: cancelled`). Propose `own_initiative` cards only as a last resort and dismiss stale cards before direct start.
- **Sidebar groups (`sidebar_groups: on`, default `off`):** Active only with owner attribution + date + PO auto/bypass mode; see [Wake-ups](./references/wake-ups.md) for group creation/move/denial rules (`Sidebar group: off`).
- **Models & rolling series (`po-model-advisor.mjs`):** Run `node "<this skill's directory>/po-model-advisor.mjs"` to verify role defaults (`po`: `sonnet` + `high`, `worker`: `sonnet` + `high`, `gatekeeper`/`watchdog`: `haiku`, `reviewer`: `sonnet` + `high`, `security-reviewer`: `opus` + `high`, `explorer`: `haiku` + `low`) and flag stale pinned snapshots (`claude-*-5-5`). Prefer rolling series (`opus`, `sonnet`, `haiku`, `default`) or `family:<family>` in `agent_model` and `gatekeeper_model`.
- **Per-task model & effort:** Pass `model: <agent_model>` and `effort: <agent_effort>` (omitting `none`/absent keys). Code/docs/pricing/config work stays on `agent_model` at `agent_effort` (or a recorded effort exception). Never exceed the PO's own model/effort. On a start error naming `model`/`effort`, retry once without that setting and report. Check `get_session` after start: never try to raise a capped session; note the shortfall once in digest and issue comment (never starting with `effort-exception:` / `model-exception:`). Move drifted running sessions with `set_session_model` / `set_session_effort`, skipping sessions with active exceptions ([Handoff and parallel POs](./references/handoff-and-parallel.md)).
  - **Effort exception:** Only when `agent_effort` note permits (`Exception: <level> ...`) and `level <= PO effort`: record `Effort exception: <level>, <reason>` in brief, issue comment `effort-exception: <level> session=<id> reason=<why>`, and handoff file (if `po_handoff: on`); end with `effort-exception: ended session=<id> reason=<why>`.
  - **Model exception:** Only for read-only lookups/searches under a current owner decision (never edits, security, money, migrations, credentials, Production): record `Model exception: <model>, <effort>, <decision id>` in brief and `model-exception: <model> <effort> session=<id> decision=<id>` comment; end with `model-exception: ended session=<id> reason=<why>`.
- **Subagents & Codex reviews:** Run at `subagent_effort` (`codex review -c model_reasoning_effort=<level> --base <branch>`).
- **Self-contained brief sections:**
  - **Task:** issue link, summary, acceptance.
  - **Effort exception / Model exception:** include only when active; omit otherwise.
  - **Approval:** verbatim owner words + date or merged `decision_log` id (never Triage step-6 authorities).
  - **Reading:** `agent_instructions`, `task_scope`, `tracking_doc`, `review_rules`, `domain_rules`.
  - **Process:** claim via `task-claim` (`claim_command` with the session's own claimant, never the PO's + `Claimant:` PR line); create/fill follow-ups; open PR (`Refs #<n>` — never `Closes`/`Fixes` into `integration_branch` when `production_branch` is set, draft if `draft_pr_first: yes`); `pr_monitor`; `local_reviews` CLI; `required_checks`; resolved threads; PO acceptance gate; merge `gh pr merge <n> --repo <owner/repo> --<integration_merge> --match-head-commit <full 40-char sha>` (unless Prod step -> hand off); `test_environment` evidence; runtime awaiting Prod -> `handoff: to=<PO>` (never `done:`).
  - **Stop line**: what is not authorized, including `set_auto_merge` and `auto_archive_on_close`, and any Production/secret/credential execution (prepare runbook file instead).
  - **Neighbours & Environment:** active parallel sessions/branches/files; verified host quirks.
  - **Reporting:** recap-only wrap-up in `report_language` (never ask/block owner); send questions/acceptance via `SendMessage` (`to`: PO id).

## Coordinating and Acceptance Gate

- Read turn-end reports against GitHub and reply in the same turn. When a sub-session shows as waiting on the user, the PO inspects its transcript + GitHub state and resolves/answers/redirects it instead of sending the owner into it.
- **Acceptance gate:** Once `required_checks` pass, reviews complete, and threads are resolved, verify the summary against issue acceptance (requiring a second independent `po-security-reviewer`/flagship reviewer for auth, money, security, migrations, or Production config) and confirm head SHA + checks via `gh`. Post `PO acceptance: merge at <full 40-char head sha>` and reply "merge". Any later push voids acceptance.
- **PR monitor (`pr_monitor`: `off` | `status` [default] | `bind` | `auto_fix`):** `status` runs read-only `get_status` with `gh pr checks` fallback on unreported PRs. `bind`/`auto_fix` count only with owner attribution + date + sessions auto/bypass mode (otherwise `status`); use fingerprinted `set_monitor` retries and drop permanently on denial. Never call `set_auto_merge` or `auto_archive_on_close`; merges always verify live `gh pr view`/`gh pr checks` and `--match-head-commit` from `PO acceptance:`. See [Wake-ups](./references/wake-ups.md).
- **Permission refusals & merge rule:** Never launder sub-session permission refusals into PO execution (except Production/secret runbooks approved by owner). If a sub-session's integration merge is refused by desktop safety checks, ask owner once per machine to add `setup_guide`'s allow+ask merge rules to user settings; if still refused, re-verify plain command and current head acceptance, never switch merge methods.
- **Protocol hygiene:** Keep whitespace around `session=<id>`, post new comments instead of editing, and reclaim if PR switches branch.

## Resuming and Reporting

- **Resuming:** Check wake-up task ([Wake-ups](./references/wake-ups.md)), rebuild missing check-in file (`<= 6 KB`) from GitHub, check `list_sessions` (`linked: true`) + GitHub state, resume live sessions, and close/release dead sessions' claims cleanly before archiving.
- **Reporting:** Plain `report_language` for `owner_profile`. First line states whether work is complete, still running (what), or stopped (on what). Link sessions/PRs, separate merged vs `test_environment` vs Production, and put one owner decision at a time after the digest.
- **Check-in digest (from GitHub only; omit empty sections):**
  1. Done since last digest (per `done_definition`; state previous digest time or `check_in_minutes`),
  2. Merged, not yet done,
  3. In progress (age + checks, excluding PO Production waiting claims),
  4. Waiting on the PO or the owner,
  5. Blocked,
  6. Queued to start,
  7. Up next (top 3 ready unclaimed/unblocked/unqueued),
  8. Stale (inactive >= `tracking_doc` threshold else 72h, excluding current PO waiting claims),
  9. Sprint review (open status or one-time summary after `done:`).
- **Owner decisions:** Record non-step-6 product decisions in `decision_log` (`D-<n>`, date, line, verbatim owner words + source, supersedes). Production/secret/destructive/cross-repo/paid-test approvals stay per-step in PO chat, never in `decision_log`.
