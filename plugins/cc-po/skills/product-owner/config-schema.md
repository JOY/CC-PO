# Product Owner config schema

The `product-owner` and `task-claim` skills are the same text in every
repository. Everything a repository decides lives in one file in that
repository, `docs/product-owner-config.md`, "the config". This page defines
its keys and the default each skill uses when a key is absent. The `setup`
skill writes a first version; `check-config.mjs` next to this page checks
one:

```bash
node <this skill's directory>/check-config.mjs docs/product-owner-config.md
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
| `agent_effort` | the runtime's default | Effort for sub-sessions, their subagents and their reviews. |

## Sessions

| Key | Default | Meaning |
| --- | --- | --- |
| `sub_sessions_normal` | `3` | Sub-sessions a PO keeps running. A number, optionally followed by a note. |
| `sub_sessions_max` | `5` | Hard limit, counting idle and paused sub-sessions. |
| `check_in_minutes` | `30` | Interval of the PO's self check-in while work is in flight. |
| `executors` | `Codex, "Claude Code", Antigravity, Cursor` | Values of `executor=` in claim comments. |

## Owner instructions

Optional prose: the owner's standing instructions for this repository, quoted
word for word with their date, for example how continuously POs work or who
runs Production steps. The skills apply them; they never widen what the
skills allow without the owner.
