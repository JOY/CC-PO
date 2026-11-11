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
| `start_session` (a sub-session with a fresh context) | Call `invoke_subagent` with `TypeName: "self"`, `Role: "#<n> <short title>"`, `Prompt: "<brief>"`, `Workspace: "inherit"`, and `Model: "inherit"` (unless `agent_model` names `flash_lite`, `flash` or `pro`, the only overrides `invoke_subagent` accepts). Include the PO's own `conversationId` in the brief so the sub-session can message the PO with `send_message`, and state in the brief's **Environment** section that the sub-session must create and work inside its own git worktree (following the repository's worktree rule, or `.agents/worktrees/<task>` if none) from `origin/<integration_branch>` before editing any file, and remove it after merging. `invoke_subagent` works in every turn (owner turns, subagent replies and gatekeeper wakes) and keeps worker sub-sessions inside the PO's Subagents pane instead of cluttering the left-hand sidebar. Reserve `agentapi new-conversation --title="<Line> Product Owner" -- "<brief>"` for starting a top-level PO conversation, never for worker sub-sessions. |
| `SendMessage`, `mcp__ccd_session_mgmt__send_message` (`to`: a session id) | Use the `send_message` tool (`Recipient`: `<conversationId>`) between a PO and its in-process sub-session subagents (sending a message to an idle or restart-stopped subagent also wakes and resumes it in place). Across separate top-level PO conversations, try `send_message` first and fall back to `agentapi send-message "<conversationId>" "<message>"` via `run_command` if refused. |
| `list_sessions` (`linked: true`), `mcp__ccd_session_mgmt__get_session` | For sub-sessions, call `manage_subagents` (`Action: "list"`) to read each direct subagent's `conversationId` and live state, and read `<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` when inspecting a subagent's recent turns. Record each sub-session's `conversationId` in its issue's `claim:` comment and in the PO's check-in or handoff file so it survives restarts. For top-level PO conversations, no global list exists; inspect a known id with `agentapi get-conversation-metadata <conversationId>` (carries no `lastActivityAt`). |
| `mcp__ccd_session_mgmt__archive_session` | Sub-session subagents live inside the PO's Subagents pane rather than the left sidebar, so finished subagents need no archive call (record completion in the check-in file; use `manage_subagents` with `Action: "kill"` only to terminate a stuck running subagent). Top-level conversations have no archive API; the owner archives retired PO conversations from the sidebar. |
| `set_session_model`, `set_session_effort`, `agent_model`, `agent_effort`, `subagent_effort` | Running conversations and subagents keep their initial model, and Antigravity has no session effort API. Skip session effort reconciliation and effort exceptions, and note that once in the PO's digest. Keep `-c model_reasoning_effort=<subagent_effort>` on `codex review` when `local_reviews` uses Codex CLI. |
| The Agent tool (in-process subagent) | `invoke_subagent`: `TypeName: "research"` for read-only work (such as the sprint review's audit or a fresh-context review), `TypeName: "self"` for work that writes, `Model: "inherit"`. |
| `AskUserQuestion` | `ask_question`. |
| `CronCreate`, `/loop`, a check-in inside the session | The `schedule` tool with a `CronExpression` (used only under `po_wake: watchdog`; under `po_wake: gatekeeper` keep no in-session check-in cron once the gatekeeper sidecar is enabled, and cancel any active one with `manage_task`, `Action: "kill"`). Stops when the server restarts, like `CronCreate`. |
| `create_scheduled_task`, `list_scheduled_tasks`, `update_scheduled_task` (`po_wake: gatekeeper` and `po_wake: watchdog`) | Under `po_wake: gatekeeper` (the default), keep **one** shared scheduled automation per repository at `~/.gemini/config/sidecars/<repo owner>-<repo>-po-gatekeeper/sidecar.json` (`"builtin": "schedule"`, `"restart_policy": "always"`, `"display_name": "PO gatekeeper (<owner/repo>)"`, and `"args": ["CRON_TZ=<IANA zone> <m>,<m+30> * * * *", "<absolute node path>", "<absolute plugin path>/skills/product-owner/agy-gatekeeper.mjs", "<po_check_in_dir>/<repo owner>-<repo>-agy-gatekeeper.json"]`, using absolute paths for `node`, `agy-gatekeeper.mjs` and the JSON config). The JSON config holds `{ "repo": "<owner/repo>", "owner": "<owner_name>", "language": "<report_language>", "activeMinutes": <gatekeeper_active_minutes>, "quietMinutes": <gatekeeper_quiet_minutes>, "pos": [{ "title": "<PO session>", "conversationId": "<uuid>", "label": "line:<slug>", "checkInFile": "<path>" }] }` (use `"labels": [...]` when a line owns multiple labels). `agy-gatekeeper.mjs` runs every 30 minutes without spawning sidebar conversations or spending model tokens: it inspects all registered POs of `<owner/repo>` and their in-flight subagents from local transcripts, runs the read-only restart check and `gh pr list`, wakes every PO that is not running when a restart came after its last activity, an open ready PR carrying its own line label is newer than its last activity, or its last activity is `gatekeeper_quiet_minutes` old while its line has work in flight (it names every reason that holds, lists the ready PRs and idle subagents, and sends no context notice: a PO's context needs no owner action), via `agentapi send-message`, and keeps no state file. The first PO of `<owner/repo>` creates the sidecar and JSON config; every other PO registers or updates its row in `pos` and tells the owner in its digest to switch off any older per-PO `-po-watchdog` sidecar. Under `po_wake: watchdog`, create a per-PO 15-minute sidecar (`<m>,<m+15>,<m+30>,<m+45> * * * *`) calling `agentapi send-message "<PO conversationId>" "<wake message>"`. Inspect `~/.gemini/config/sidecars/` in place of `list_scheduled_tasks`. Only the owner enables or disables automations in `[Open Automations Dashboard](sidecar://dashboard)`; never edit `user_config.json` yourself. Without an enabled gatekeeper automation, say in the digest that the PO has no durable wake automation. |
| Watching CI (Monitor, `gh pr checks --watch`) | `run_command` in the background (short `WaitMsBeforeAsync`, e.g. `500`, `IsDaemon: false`): Antigravity wakes the conversation when the command finishes. Never poll in a loop. |
| Renaming the session to `<Line> Product Owner` | A running conversation cannot rename itself (unless started via `agentapi new-conversation --title="<Line> Product Owner"`). State `<Line> Product Owner` in `claim:` comments, the check-in file and the first line of each report. |
| "The owner's next desktop turn" | The owner's next message in the PO's conversation. |

## Commands and permissions

- `agentapi` reaches the local Antigravity server, and `gh`, `git fetch`,
  `git push` and `git ls-remote` reach the network. Run each as a single
  command via `run_command`, never chained with other steps (`&&`, `;`, `||`).
- Keep `toolSummary` identical across calls of the same kind and prefer
  prefix-matchable command shapes (no command substitutions or wrapper
  binaries), so one "always allow" or Command Allowlist rule from the owner
  covers future calls.
- On the first turn a PO needs network or `agentapi` commands on a machine
  (or if terminal sandbox / internet policy blocks them), tell the owner once
  which command prefixes to allow in Settings -> Permission Grants / Command
  Allowlist: `agentapi`, `gh`, `git fetch`, `git push`, `git ls-remote`.
  Without them, every call waits for manual approval.

## Restarts

Antigravity stops active in-process subagents, in-session `schedule` timers
and background commands when its server restarts, while top-level PO
conversations, each subagent's `conversationId` and transcript on disk, and
git worktrees persist. After a restart notice:

1. Reconcile state from GitHub claims and the PO's check-in or handoff file
   (GitHub wins).
2. Send each unfinished sub-session subagent a short wake message with
   `send_message` (`Recipient`: its recorded `conversationId`) so it revives
   in place and resumes from its latest checkpoint rather than starting a
   duplicate subagent (use `agentapi send-message` only for legacy top-level
   sub-session conversations).
3. Restart any stopped background CI watch (`gh pr checks --watch`) or
   pending one-shot timer (and under `po_wake: watchdog`, recreate the
   in-session `schedule` timer).

## Shared boards and limits

- Follow the config's `sub_sessions_normal` and `sub_sessions_max` caps across
  active and unfinished sub-session subagents (or at most three at once when
  unset).
- Never claim or start a sub-session for an issue already claimed by a Claude
  Code session (or any other live session). Both hosts speak the same GitHub
  `task-claim` protocol and can share one board safely.
- Merges, Production steps and secrets follow the skills and the repository's
  agent instructions unchanged. Any action refused by permission checks stays
  a question for the owner in the PO chat.
