# CC-PO on Antigravity: host rules

Applies to `cc-po` skills (`product-owner`, `task-claim`, `setup`), POs, and sub-sessions. See [Antigravity guide](../skills/product-owner/references/antigravity-host.md).

## Tool map

| Skill says | On Antigravity |
| --- | --- |
| `start_session` | `invoke_subagent` (`TypeName: "self"`, `Role: "#<n> <title>"`, `Workspace/Model: "inherit"` unless `agent_model`/`Antigravity:`/`Model exception` pins `flash_lite`/`flash`/`pro`); pass PO `conversationId`, isolated worktree. `agentapi new-conversation` for top-level POs only. |
| `SendMessage` | `send_message` (`Recipient: <id>`) for subagents (revives stopped); top-level POs: `send_message` else `agentapi send-message`. |
| `list_sessions`, `get_session` | `manage_subagents` (`list`), `brain/<id>/.system_generated/logs/transcript.jsonl`, `claim:`/`*-po-checkin.md`; top-level: `agentapi get-conversation-metadata`. |
| `archive_session` | Subagents stay in pane (`manage_subagents` `kill` only if stuck); owner archives top-level chats. |
| `set_session_model`, `set_session_effort` | Keep model; skip effort silently. Keep `-c model_reasoning_effort=<subagent_effort>` on `codex review`. |
| `bind_pr`, `get_status`, `set_monitor` (`pr_monitor`), `create_group`, `move_sessions` (`sidebar_groups`) | Antigravity has no PR bar/groups: ignore; `gh pr checks` per resume. |
| Agent tool | `invoke_subagent` (`TypeName: "research"`, `inherit` or `flash` for broad reads); `run_workflow` for fan-out. |
| `AskUserQuestion` | `ask_question`. |
| `CronCreate`, `/loop` | `schedule` under `po_wake: watchdog` only; kill under `gatekeeper` (`manage_task`). |
| `create_scheduled_task`, `list_scheduled_tasks` | Under `po_wake: gatekeeper`, 1 sidecar (`<owner>-<repo>-po-gatekeeper`, `*/10`) runs `agy-gatekeeper.mjs` (0-token multi-signal, Profile Affinity Guard, atomic lock). Active iff `config.json` `enabled === true` + `sidecar.log` `Scheduler started`; never edit `config.json`, toggle in `[Dashboard](sidecar://dashboard)`. |
| CI `--watch` | Background `run_command` (`WaitMsBeforeAsync: 500`). |

## Models, context, hooks, and restarts

- **Models & Quota:** Inherit PO model unless pinning `flash_lite`/`flash`/`pro`; check `swarm(models)`/`po-model-advisor.mjs`. `Orchestrator (Neon)` (`gemini-pro-orchestrator-neon`), `Carbon`, `Argon` route steps; `research` for reviews. Flagship: `Claude Opus`, `Gemini 4 Neon`, `Carbon`, `Orchestrator (Neon)`/`(Carbon)`. Claude fallback (owner): PO=`Orchestrator (Neon)`; workers=`Gemini 4 Hydrogen (High)` (`gemini-4-hydrogen-high`) or `Gemini 4 Neon`. Never loop-retry.
- **Context & Hooks:** Offload broad reads to `research`/`flash` or `run_workflow`; proactively `/compact` ~100K–120K without asking owner. Root `hooks.json` enforces `<= 6 KB` check-in rotation + `Stop` turn status (`ok`/`error`/`quota`).
- **Commands & Restarts:** Run `agentapi`, `gh`, `git fetch`/`push`/`ls-remote` singly; prompt **Turbo**/allowlist if blocked. Reconcile + revive via `send_message`, respect `sub_sessions_normal`/`max`.
- **Asking JOY:** Always use `ask_question` popup (never plain text, so JOY gets a notification and nothing gets lost) with standalone Vietnamese options (effect, cost, risk; recommended first). Sub-sessions escalate to PO.
