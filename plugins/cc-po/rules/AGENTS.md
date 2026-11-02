# CC-PO on Antigravity: host rules

These rules apply only while you run one of this plugin's skills
(`product-owner`, `task-claim`, `setup`), or work as a Product Owner (PO) or
as a sub-session a PO started. Ignore them for any other task.

The skills are written for the Claude desktop app and name its tools. On
Antigravity, use the tool in the right column instead. Everything else in the
skills (claims, briefs, the review gate, the acceptance gate, Production
steps, reports, the repository's config and agent instructions) applies
unchanged.

## Tool map

| The skill says | On Antigravity |
| --- | --- |
| `start_session` (a sub-session with a fresh context) | `agentapi new-conversation --title="#<n> <short title>" -- "<brief>"`, run via `run_command` with `BypassSandbox: true`. It starts a top-level conversation in the same project and workspace, listed in the sidebar, and prints its `conversationId`. Include the PO's own `conversationId` in the brief so the sub-session can reply. Because `agentapi new-conversation` opens in the project's main checkout rather than a dedicated worktree, state in the brief's **Environment** section that the sub-session must create and work inside its own git worktree (following the repository's worktree rule, or `.agents/worktrees/<task>` if none) from `origin/<integration_branch>` before editing any file, and remove it after merging. `--model` accepts only `flash_lite`, `flash` or `pro`; omit it unless `agent_model` names one of those, so the owner's default model is used. |
| `SendMessage`, `mcp__ccd_session_mgmt__send_message` (`to`: a session id) | Try the `send_message` tool (`Recipient`: `<conversationId>`). If it is refused across top-level conversations, run `agentapi send-message "<conversationId>" "<message>"` via `run_command` with `BypassSandbox: true`. |
| `list_sessions` (`linked: true`), `mcp__ccd_session_mgmt__get_session` | No global session list exists. Record each sub-session's `conversationId` in its issue's `claim:` comment and in the PO's check-in or handoff file, and inspect one with `agentapi get-conversation-metadata <conversationId>` (`BypassSandbox: true`; note it carries no `lastActivityAt`). For in-process subagents, use `manage_subagents` (`Action: "list"`). |
| `mcp__ccd_session_mgmt__archive_session` | Not available. The owner archives finished conversations from the sidebar. |
| `set_session_model`, `set_session_effort`, `agent_model`, `agent_effort`, `subagent_effort` | A running conversation keeps its model, and Antigravity has no session effort API. Skip session effort reconciliation and effort exceptions, and note that once in the PO's digest. Keep `-c model_reasoning_effort=<subagent_effort>` on `codex review` when `local_reviews` uses Codex CLI. |
| The Agent tool (in-process subagent) | `invoke_subagent`: `TypeName: "research"` for read-only work (such as the sprint review's audit or a fresh-context review), `TypeName: "self"` for work that writes (with `Workspace: "share"` when it needs its own worktree), `Model: "inherit"`. |
| `AskUserQuestion` | `ask_question`. |
| `CronCreate`, `/loop`, a check-in inside the session | The `schedule` tool with a `CronExpression`. It stops when the server restarts, like `CronCreate`. |
| `create_scheduled_task`, `list_scheduled_tasks`, `update_scheduled_task` (the durable watchdog) | A scheduled automation created by following Antigravity's built-in `automation` skill (`sidecar.json` with `"builtin": "schedule"` and `"args": ["CRON_TZ=<IANA zone> <m>,<m+15>,<m+30>,<m+45> * * * *", "agentapi", "send-message", "<PO conversationId>", "<wake message>"]`). Because `get-conversation-metadata` exposes no `lastActivityAt`, the automation sends the wake directly to the PO conversation without spawning extra sidebar conversations; an active PO treats it as a regular check-in. Only the owner enables it in `[Open Automations Dashboard](sidecar://dashboard)`; never enable it yourself. Without an enabled automation, say in the digest that the PO has no durable watchdog. |
| Watching CI (Monitor, `gh pr checks --watch`) | `run_command` in the background (short `WaitMsBeforeAsync`, `BypassSandbox: true`): Antigravity wakes the conversation when the command finishes. Never poll in a loop. |
| Renaming the session to `<Line> Product Owner` | A running conversation cannot rename itself (unless started via `agentapi new-conversation --title="<Line> Product Owner"`). State `<Line> Product Owner` in `claim:` comments, the check-in file and the first line of each report. |
| "The owner's next desktop turn" | The owner's next message in the PO's conversation. |

## Commands outside the sandbox

- `agentapi` reaches the local Antigravity server, and `gh`, `git fetch`,
  `git push` and `git ls-remote` reach the network. Both are blocked inside
  the default sandbox. Run each as a single command with
  `BypassSandbox: true`, never chained with other steps (`&&`, `;`, `||`).
- Keep `toolSummary` identical across calls of the same kind and prefer
  prefix-matchable command shapes (no command substitutions or wrapper
  binaries), so one "always allow" from the owner covers future calls.
- Run every other step (reading, editing, builds, tests) inside the sandbox
  (`BypassSandbox: false`).
- On the first turn a PO needs unsandboxed commands on a machine, tell the
  owner once which command prefixes to allow: `agentapi`, `gh`, `git fetch`,
  `git push`. Without them, every call waits for manual approval.

## Restarts

Antigravity stops in-process subagents and background tasks when its server
restarts, whereas top-level conversations started with
`agentapi new-conversation` persist across restarts. After a restart notice:

1. Reconcile state from GitHub claims and the PO's check-in or handoff file
   (GitHub wins).
2. Send each sub-session that still holds unfinished work a short wake
   message (`send_message` or `agentapi send-message`) to resume from its
   latest checkpoint.
3. Re-invoke or revive any stopped in-process subagent needed for the current
   turn.

## Shared boards and limits

- Start at most three sub-sessions at once, or the config's
  `sub_sessions_normal` / `sub_sessions_max` if lower.
- Never claim or start a sub-session for an issue already claimed by a Claude
  Code session (or any other live session). Both hosts speak the same GitHub
  `task-claim` protocol and can share one board safely.
- Merges, Production steps and secrets follow the skills and the repository's
  agent instructions unchanged. Any action refused by permission checks stays
  a question for the owner in the PO chat.
