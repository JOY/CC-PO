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
| `local_reviews` | a fresh-context subagent review | Reviews run before opening a PR, as commands an agent runs, with the repository's exemptions. A review a person types as a slash command has a CLI form for agents. |
| `promotion_reviews` | `local_reviews` against `production_branch` | Reviews run on a promotion branch before its PR. |
| `agent_model` | the runtime's default | Model for sub-sessions, as the model id the PO passes to `start_session` (and `set_session_model` for a running one), not higher than the PO's own model, so the PO session runs on that model or a more capable one. Absent or `none`: a sub-session inherits the PO's model. |
| `agent_effort` | the runtime's default | Effort for sub-sessions, one of `low`, `medium`, `high`, `xhigh`, `max`, passed to `start_session` (and `set_session_effort` for a running one); the app takes an effort at or below the PO's own, so the PO session runs at least that high. It covers the sub-session itself, not its subagents or its reviews (see `subagent_effort`). Absent or `none`: a sub-session inherits the PO's effort. Any other value than a level (after which a note may follow) is a config error. |
| `subagent_effort` | `agent_effort` | Effort for in-process subagents (the Agent tool: a sub-session's, and the PO's own, such as the sprint review's audit subagents) and for the reviews a sub-session runs. Absent or `none`: the same level as `agent_effort`. The same levels as `agent_effort` apply; any other value is a config error. |

## Sessions

| Key | Default | Meaning |
| --- | --- | --- |
| `sub_sessions_normal` | `3` | Sub-sessions a PO keeps running. A number, optionally followed by a note. |
| `sub_sessions_max` | `5` | Hard limit, counting idle and paused sub-sessions. |
| `check_in_minutes` | `30` | Interval of the PO's self check-in while work is in flight. |
| `po_watchdog` | `on` | `off` when the POs keep no durable watchdog (an app scheduled task that wakes a PO after a process exit, a restart or a usage-limit stop; see "Durable watchdog" in the `product-owner` skill). |
| `po_check_in_dir` | `~/.claude/po-state` | The folder on the PO's machine for its check-in file and the owner's watchdog approval. It is outside the repository (an absolute or `~` path, not under the repository root), because the file is machine state that is never committed. |
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
