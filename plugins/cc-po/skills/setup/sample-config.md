# Product Owner config: acme/shop

<!-- A sample. Every id below is made up: read your own with the setup
skill, or with the commands in its "Read the board" step. The keys and their
defaults are in ../product-owner/config-schema.md. -->

Values for the `product-owner` and `task-claim` skills in this repository.
Check this file with the `check-config.mjs` script of the `product-owner`
skill.

## Owner and reporting

- owner_name: Sam
- owner_profile: the product owner; decides product and risk, not code.
  Bring Sam material decisions in plain words, one at a time.
- report_language: English
- agent_account: none

## Board

- project_url: https://github.com/orgs/acme/projects/3
- project_owner: acme
- project_number: 3
- project_id: PVT_exampleProjectId
- product_line_field: PVTSSF_exampleLineField (options in Lines)
- priority_field: `PVTSSF_examplePriorityField`; Urgent `a1`, High `b2`,
  Normal `c3`, Low `d4`
- sprint_field: `PVTIF_exampleSprintField`; Sprint, 7 days
- bot_owned_fields: none

## Lines

| Line | Label | Product Line option id | PO session |
| --- | --- | --- | --- |
| Storefront | `line:storefront` | `e5` | `Storefront Product Owner` |
| Payments | `line:payments` | `f6` | `Payments Product Owner` |
| Platform (CI, release, infra) | `line:platform` | `g7` | none; Sam decides |

## Issue fields

- issue_types: none
- org_priority_field: none
- org_effort_field: none
- issue_notes: none

## Rule documents

- agent_instructions: `AGENTS.md`
- task_scope: none
- tracking_doc: none
- review_rules: `CONTRIBUTING.md`
- domain_rules: none
- roadmap_sources: `ROADMAP.md`
- setup_guide: the cc-po plugin README
- decision_log: `docs/product-decisions.md`

## Branches, environments and gates

- integration_branch: main
- integration_merge: squash
- default_branch: main
- draft_pr_first: no
- production_branch: none
- production_effect: a merge into `main` deploys the storefront to
  Production within about 10 minutes, so a merge of a runtime change is a
  Production step.
- test_environment: a preview deployment per PR.

## Checks and review

- required_checks: `ci` (GitHub Actions, app id 15368); all review threads
  resolved.
- claim_gate: none
- external_review_app: none
- local_reviews: `codex review --base origin/main` where the Codex CLI is
  installed, then a fresh-context subagent review.
- agent_effort: high

## Sessions

- sub_sessions_normal: 3
- sub_sessions_max: 5
- check_in_minutes: 30
- executors: Codex, "Claude Code", Cursor
- po_watchdog: on
- po_check_in_dir: `~/.claude/po-state`

## Sprint review

- sprint_review: on
- line_scopes: `line:storefront`: `apps/storefront`, `packages/ui`;
  `line:payments`: `services/payments`,
  `.github/workflows/deploy-payments.yml`
- sprint_review_report:
  `docs/sprint-reviews/<YYYY-MM-DD>-<line>-<sprint>.md`; Markdown

## Owner instructions

- Sam (2026-01-15): "Payments changes always get a second reviewer."
