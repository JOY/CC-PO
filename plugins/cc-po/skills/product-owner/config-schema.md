# Product Owner config schema

The `product-owner` and `task-claim` skills are the same text in every
repository. Everything a repository decides lives in one file in that
repository, `docs/product-owner-config.md`, "the config". This page defines
its keys and the default each skill uses when a key is absent. Where the
plugin ships a `setup` skill, it writes a first version; otherwise follow
`setup_guide`. `check-config.mjs` next to this page checks one:

```bash
node "<this skill's directory>/check-config.mjs" docs/product-owner-config.md
```

## Format

- A `#` title, then `##` sections. Section names are for people; a key may
  sit under any section, but the sample and the setup skill use the
  sections below.
- A value is a bullet whose first line is `- <key>: <value>`, with the key
  in lower snake case. Continuation lines are indented by two spaces. Each
  key appears once.
- `none` means "deliberately empty": the skill skips what the key drives.
  An absent key takes the default below.
- The lines are a Markdown table (see Lines).
- Other prose, lists and tables are allowed. Agents read them as context;
  the checker ignores them. Never write a secret, token or key into the
  config: it is committed and read by every session.
- Agents read the config at run time and it carries the owner's authority
  (owner, approvals, Production facts), so review a change to it as a
  change to agent instructions, not as documentation.

## Owner and reporting

| Key | Default | Meaning |
| --- | --- | --- |
| `owner_name` | required | The person whose approvals count: material decisions, Production, secret and credential steps, new commitments. The skills call them "the owner". |
| `owner_profile` | `the repository owner` | One line on who the owner is and how to write for them (for example a non-coder who decides product and risk, not code). |
| `report_language` | `English` | Language of everything the owner reads: reports, recaps, questions, sub-session reports. Code, commits, PRs, issues and messages between agents stay in English unless the repository's rules say otherwise. |
| `agent_account` | `none` | When every runtime posts as one GitHub account, name it here. Assignees then stay empty, because they would say nothing about who works. |

## Board

| Key | Default | Meaning |
| --- | --- | --- |
| `project_owner` | required | Login of the organization or user that owns the GitHub Project. |
| `project_number` | required | The Project number in its URL. |
| `project_id` | required | The Project node id (`PVT_...`). |
| `project_url` | derived | The Project's URL, for people. |
| `product_line_field` | `none` | Node id (`PVTSSF_...`) of the single-select board field that holds the line. With `none`, the `line:*` label alone tags the line. |
| `priority_field` | `none` | Node id of the board Priority field and its options, as `<field id>; Urgent <id>, High <id>, Normal <id>, Low <id>`. |
| `sprint_field` | `none` | The board iteration field that holds the sprint, as `<field id>; <field name>, <n> days` (for example `PVTIF_...; Sprint, 7 days`). Its iterations are read live from the field, never copied here as the source. With `none`, the PO keeps no sprints (see "Sprints" in the `product-owner` skill). |
| `bot_owned_fields` | `none` | Board fields a bot sets from claim comments, never by hand, and the bot that does it. With `none`, sessions set Status, Executor and Session ID by hand as the tracking document says. |

## Lines

A table with the header `| Line | Label | Product Line option id | PO session |`
and one row per line. The label starts with `line:`. The option id is the
line's option in `product_line_field`, or `none`. The PO session column is
that line's PO session title (`<Line> Product Owner`), or who decides while
the line has none.

## Issue fields

Organization-level issue fields. Leave them `none` when the owner of the
repository has not defined them.

| Key | Default | Meaning |
| --- | --- | --- |
| `issue_types` | `none` | Issue Type ids, as `Task <id>, Bug <id>, Feature <id>` (set with `updateIssueIssueType`). |
| `org_priority_field` | `none` | Org Priority field and options, as `<field id>; Urgent <id>, High <id>, Medium <id>, Low <id>` (set with `setIssueFieldValue`). |
| `org_effort_field` | `none` | Org Effort field and options, as `<field id>; High <id>, Medium <id>, Low <id>`. |
| `issue_notes` | `none` | Anything else every new issue must carry (for example a scope field a repository rule requires). |

## Rule documents

| Key | Default | Meaning |
| --- | --- | --- |
| `agent_instructions` | `AGENTS.md`, else `CLAUDE.md` | The repository's agent instructions. They win over the skills. |
| `task_scope` | `none` | The task-scope rule. |
| `tracking_doc` | `none` | The claim and tracking rules. With `none`, the `task-claim` skill is the protocol. Where both exist, the tracking document wins. |
| `review_rules` | `none` | The review, merge and delivery rules. |
| `domain_rules` | `none` | Where the domain rules are routed (deployment, pricing, auth and so on). |
| `roadmap_sources` | `none` | Where the line's roadmap lives. |
| `setup_guide` | the plugin README | Machine setup: tools, sign-ins and the merge permission rule. |
| `decision_log` | `none` | Where the owner's product decisions are recorded (a repository document or a GitHub issue), one entry each: id, date, line, the owner's exact words with where they said them, what it supersedes. When set, its current entries are the owner's standing instructions and the config's "Owner instructions" section stays empty. With `none`, briefs quote the owner's words directly. |

## Branches and environments

| Key | Default | Meaning |
| --- | --- | --- |
| `integration_branch` | the repository's default branch | Where task PRs merge. |
| `integration_merge` | `squash` | Merge method for task PRs. |
| `default_branch` | the repository's default branch | Where `pull_request_target` workflows and dispatches run from. |
| `draft_pr_first` | `no` | `yes` when PRs open as drafts and are marked ready when complete (for example when CI skips drafts). |
| `production_branch` | `none` | The branch Production ships from. `none` means the integration branch ships and there is no promotion; when its merges deploy, each merge of a runtime change is a Production step. |
| `production_merge` | `merge commit` | Merge method for promotions. |
| `production_effect` | `unknown` | What a merge into the branch that ships does (`production_branch`, or `integration_branch` when that is `none`): which deploys run, how fast traffic moves, whether a release step follows. `unknown` means: read the deploy workflows' triggers before the first merge, and until the answer is recorded treat a merge into the branch that ships as a Production step. |
| `promotion_notes` | `none` | Selective promotions, runbook models and known gate exceptions. |
| `test_environment` | `none` | Where the integration branch runs before Production, and how it deploys. |
| `done_definition` | see below | When an issue is Done. Default: a change with no runtime surface (docs, CI, tooling) is Done once merged with its evidence; a runtime change is Done when it runs where it ships and is verified there; a findings task is Done when its `done:` carries them. |

## Checks and review

| Key | Default | Meaning |
| --- | --- | --- |
| `required_checks` | `none` | Checks a PR into the integration branch needs, each with the app that must produce it (`app id`), because a PR's own workflow can post a check of the same name. |
| `claim_gate` | `none` | The required check that enforces claims, and the workflow that re-runs it (for example a `claim-gate` check from `claim-gate.yml`). |
| `external_review_app` | `none` | The review app whose approval a Production runbook PR needs on its final head, with its app id. |
| `local_reviews` | a fresh-context subagent review | Reviews run before opening a PR, as commands an agent runs, with the repository's exemptions. A review a person types as a slash command has a CLI form for agents. A Codex review runs at `subagent_effort`: its form carries the level, `codex review -c model_reasoning_effort=<level> --base <branch>`. |
| `promotion_reviews` | `local_reviews` against `production_branch` | Reviews run on a promotion branch before its PR. |
| `shared_core_review` | `none` | The line that owns the code every line builds on, then its paths or the section of the repository's rules that lists them (`line:platform: see "Shared-core review" below`). A PR of another line that changes them also gets that line's PO's review of those files only ("Peer POs and security review" in the `product-owner` skill). `none`: each PO reviews its own line's PRs in full. |
| `agent_model` | the runtime's default | Model for sub-sessions, as the model id the PO passes to `start_session` (and `set_session_model` for a running one), not higher than the PO's own model, so the PO session runs on that model or a more capable one. A current owner decision may let low-risk small tasks run on a cheaper model for one task (a `Model exception`, "Starting a sub-session" in the `product-owner` skill); the PO records it in the brief and on the issue, and reconciliation leaves that session alone. Absent or `none`: a sub-session inherits the PO's model. |
| `agent_effort` | the runtime's default | Effort for sub-sessions, one of `low`, `medium`, `high`, `xhigh`, `max`, passed to `start_session` (and `set_session_effort` for a running one); the app takes an effort at or below the PO's own, so the PO session runs at least that high. It covers the sub-session itself, not its subagents or its reviews (see `subagent_effort`). Absent or `none`: a sub-session inherits the PO's effort. Any other value than a level (after which a note may follow) is a config error. When the note allows a higher level for one kind of task, it names that level after `Exception:` (`Exception: xhigh only for hard security work`), and the checker rejects any other word there (only the literal `Exception:` followed by a word is read, case-insensitively, so even "No exception: ask the owner" is an error; reword such a note), because the PO passes it to `start_session`. A PO that starts a session at the exception records it in the brief (`Effort exception: <level>, <reason>`) and, where `po_handoff` is `on`, in its handoff file; effort reconciliation leaves that session at the exception level until a later record ends it (an `effort-exception: ended` comment on the issue, or an `ended` line on the handoff file), and the latest record wins over the brief's static line ("Starting a sub-session" in the `product-owner` skill). |
| `subagent_effort` | `agent_effort` | Effort for in-process subagents (the Agent tool: a sub-session's, and the PO's own, such as the sprint review's audit subagents) and for the reviews a sub-session runs; a Codex review takes it on its command line (`-c model_reasoning_effort=<level>`), because it otherwise reads the machine's `~/.codex/config.toml`. Absent or `none`: the same level as `agent_effort`. The same levels as `agent_effort` apply; any other value is a config error. |

## Sessions

| Key | Default | Meaning |
| --- | --- | --- |
| `sub_sessions_normal` | `3` | Sub-sessions a PO keeps running. A number, optionally followed by a note. |
| `sub_sessions_max` | `5` | Hard limit, counting idle and paused sub-sessions. |
| `check_in_minutes` | `30` | Interval of the PO's self check-in while work is in flight. Under `po_wake: watchdog` it is the interval of the in-session check-in cron; under `gatekeeper` the PO keeps no such cron and the key only sets the digest's "since" fallback. |
| `po_wake` | `gatekeeper` | How a PO is woken after a stop and when it has gone quiet (see "Wake-ups" in the `product-owner` skill). `gatekeeper`: one app scheduled task per repository (`gatekeeper-template.md`, no state file) wakes a PO that is not running after a restart, with a ready PR it has not seen, or after a quiet stretch, and the PO keeps no in-session check-in cron. `watchdog`: the earlier behaviour, one watchdog task per PO (`watchdog-template.md`) plus the PO's in-session check-in cron. `off`: nothing wakes a PO but real events, and the PO disables any gatekeeper or watchdog it finds. |
| `po_watchdog` | none | The earlier name of `po_wake`, accepted for one version: `off` means `po_wake: off`, `on` means the default (`gatekeeper`). `po_wake` wins when both are set; the checker warns. |
| `gatekeeper_model` | `claude-haiku-5-5` | Model the gatekeeper's runs ask for (a `model:` line in the task's `SKILL.md` frontmatter; the app may ignore it). Any model id; `none` leaves the line out. |
| `gatekeeper_active_minutes` | `60` | A sub-session that is not running and has had no activity for longer than this counts as idle in a wake message. Since 2.10.0 it no longer decides when a PO is woken (`gatekeeper_quiet_minutes` does). An integer from 5 to 1440. |
| `gatekeeper_quiet_minutes` | `180` | A PO that is not running is woken for the quiet reason once its last activity is this many minutes old, and only while its line has work in flight: an open pull request with the line's label (draft or ready), or a non-archived sub-session that the PO started. A line with nothing in flight is never woken for being quiet. The restart and unseen-ready-PR reasons are unchanged. An integer from 30 to 1440. |
| `gatekeeper_quiet_hours` | none | No longer used since 2.8.0 (the quiet wake follows `gatekeeper_quiet_minutes` since 2.10.0). Accepted for one version; the checker warns. Remove it. |
| `compact_notice_tokens` | `500000` | A sub-session whose context is above this many tokens gets its PO a compaction notice, in the wake the PO gets in that run. It does not apply to the PO's own session, which `po_handoff_tokens` covers. An integer from 50000 to 2000000. |
| `po_handoff_tokens` | `250000` | Context size at which a PO hands its line over to a fresh PO session. When the gatekeeper wakes a PO whose own context is above this many tokens (`get_usage`), or the PO reads its own size at a check-in and finds it above, the PO writes its handoff and asks the owner to open a fresh PO session ("PO handoff" in the `product-owner` skill). The handoff follows the size of the PO's context, not the clock: a daily rotation does not stop a context that grows within a day. An integer from 50000 to 2000000, or `none` for no size trigger. |
| `coordinator_line` | none | No longer used since 2.10.0: the gatekeeper counts only pull requests labelled with the PO's own line, so no PO is woken for every pull request. Accepted for one version; the checker warns. Remove it. |
| `po_check_in_dir` | `~/.claude/po-state` | The folder on the PO's machine for its check-in file and the owner's wake-up approval (`watchdog-approval.md`). It is outside the repository (an absolute or `~` path, not under the repository root), because the file is machine state that is never committed. |
| `po_handoff` | `off` | `on` when the handoff of a PO that is retired (its context passed `po_handoff_tokens`, a new machine, a changed owner) goes through a file, the one the PO already keeps, else `<po_check_in_dir>/<repo owner>-<repo>-<slug>-po-handoff.md` (named as the check-in file is; `<slug>` is the line's label after `line:`): the outgoing PO writes the sub-sessions in flight, effort exceptions, pending owner decisions, holds and next steps, and the incoming PO reads it first ("PO handoff" in the `product-owner` skill). `off`: no file is kept, and the incoming PO rebuilds from GitHub and `list_sessions`. The size trigger and the owner prompt do not depend on this key. |
| `executors` | `Codex, "Claude Code", Antigravity, Cursor` | Values of `executor=` in claim comments. |

## Sprint review

See "Sprint review" in the `product-owner` skill.

| Key | Default | Meaning |
| --- | --- | --- |
| `sprint_review` | `off` | `on` when each line's PO reviews its sprint and audits its line's scope at the end of every sprint. Needs `sprint_field`. |
| `line_scopes` | `none` | The paths each line's audit covers, as `<label>: <paths and notes>` per line, entries separated by `;`, so a note holds no `;` (for example `` `line:core`: `src/core`, `cmd/` ``). Each label is one from the Lines table, and every path is relative to the repository, with no `..` segment and no absolute, drive-letter, home or environment-variable path. A line with no entry gets no audit of its scope. |
| `sprint_review_report` | `` `docs/sprint-reviews/<YYYY-MM-DD>-<line>-<sprint>.md`; Markdown `` | Where the review report goes and its format, as `<path template>; <format>`. The template holds `<YYYY-MM-DD>` (the reviewed sprint's last day) and `<line>` (the label after `line:`), and may hold `<sprint>` (the sprint title in lower case, every run of characters other than `a-z` and `0-9` as one hyphen, no leading or trailing hyphen, so a title can never add a directory). The report is committed through a PR, so the path is relative to the repository, with no `..` segment and no spaces, and a format follows it. It cannot be `none` while `sprint_review` is on. |

## Owner instructions

Optional prose, used only when `decision_log` is `none`: the owner's
standing instructions for this repository, quoted word for word with their
date, for example how continuously POs work or who
runs Production steps. The skills apply them; they never widen what the
skills allow without the owner.
