# CC-PO on Antigravity: host rules

Applies only to `cc-po` skills (`product-owner`, `task-claim`, `setup`), POs, and sub-sessions. Repo rules, claims, gates, and [Antigravity guide](../skills/product-owner/references/antigravity-host.md) apply unchanged.

## Tool map

| Skill says | On Antigravity |
| --- | --- |
| `start_session` | `invoke_subagent` (`TypeName: "self"`, `Role: "#<n> <title>"`, `Prompt: "<brief>"`, `Workspace: "inherit"`, `Model: "inherit"` unless `agent_model`/`Antigravity:` note/`Model exception` pins `flash_lite`/`flash`/`pro`). Pass PO's `conversationId`; require an isolated worktree. `agentapi new-conversation` is for top-level PO chats only. |
| `SendMessage` | `send_message` (`Recipient: <id>`) with subagents (revives stopped ones). Top-level POs: `send_message`, else `agentapi send-message`. |
| `list_sessions`, `get_session` | `manage_subagents` (`Action: "list"`), `<appDataDir>/brain/<id>/.system_generated/logs/transcript.jsonl`, and `claim:`/`*-po-checkin.md` ids. Top-level: `agentapi get-conversation-metadata`. |
| `archive_session` | Subagents stay in Subagents pane (`manage_subagents` `kill` only if stuck); owner archives top-level chats. |
| `set_session_model`, `set_session_effort` | Conversations keep initial model; no effort API—skip effort reconciliation silently. Keep `-c model_reasoning_effort=<subagent_effort>` on `codex review`. |
| `bind_pr`, `get_status`, `set_monitor` (`pr_monitor`), `create_group`, `move_sessions` (`sidebar_groups`) | Antigravity has no PR bar or sidebar groups: ignore both; run `gh pr checks` once per resume. |
| Agent tool | `invoke_subagent` (`TypeName: "research"`, `Model: "inherit"`) for read-only reviews/audits; `run_workflow` for fan-out. |
| `AskUserQuestion` | `ask_question`. |
| `CronCreate`, `/loop` | `schedule` only under `po_wake: watchdog`; kill under `gatekeeper` (`manage_task`). |
| `create_scheduled_task`, `list_scheduled_tasks` | Under `po_wake: gatekeeper`, keep one sidecar (`<owner>-<repo>-po-gatekeeper`) running `agy-gatekeeper.mjs` (zero tokens, no state file). Active when `config.json` `sidecars["<id>"].enabled === true` AND `sidecar.log` shows `Scheduler started`. Never edit `config.json`; owner toggles in `[Open Automations Dashboard](sidecar://dashboard)`. |
| CI `--watch` | Background `run_command` (`WaitMsBeforeAsync: 500`, `IsDaemon: false`). |

## Models, commands, and restarts

- **Models & Orchestrator:** Inherit PO model unless pinning `flash_lite`/`flash`/`pro`; check `swarm(models)` / `po-model-advisor.mjs`. `Orchestrator (Carbon)` (`gemini-pro-orchestrator`) / `Argon` route steps; use `research` for read-only reviews. Flagship gates need `Claude Opus`, `Gemini 4 Carbon`, or `Orchestrator (Carbon)` (`research` if allowed); hold merge otherwise. Never swap/retry models on quota exhaustion.
- **Commands & Restarts:** Run `agentapi`, `gh`, `git fetch`/`push`/`ls-remote` as single commands. Prompt for **Turbo** or allowlist only if blocked. After restarts, reconcile GitHub + check-in, revive subagents via `send_message`, respect `sub_sessions_normal`/`sub_sessions_max`, and never touch another runtime's claim.
