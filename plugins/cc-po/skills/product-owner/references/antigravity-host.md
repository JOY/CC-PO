# Antigravity Host Orchestration, Models, and Sidecars

When running `cc-po` inside Antigravity (`plugins/cc-po/rules/AGENTS.md` active),
follow the Antigravity tool mappings and these host rules alongside the shared
GitHub protocol.

## Two-phase planning/execution & fan-out orchestration

- **Phase 1 (Read-only planning & independent reviews):** Use `invoke_subagent`
  with `TypeName: "research"` (`Model: "inherit"`, or `flash_lite`/`flash` for
  routine read-only scouts) for triage lookups, sprint audits, and independent
  fresh-context PR/security reviews so write and shell tools are omitted.
- **Phase 2 (Execution workers):** Map `start_session` to `invoke_subagent`
  with `TypeName: "self"`, `Role: "#<n> <short title>"`, `Prompt: "<brief>"`,
  `Workspace: "inherit"`, and `Model: "inherit"` (unless `agent_model`, an
  `Antigravity:` clause in its note, or a `Model exception` names `flash_lite`,
  `flash` or `pro`; see "Models and Orchestrator" below). Include the PO's own
  `conversationId` in the brief so the sub-session can reply with
  `send_message`, and require the subagent to create its own isolated git
  worktree from `origin/<integration_branch>` before any edit and remove it
  after merging. Reserve `agentapi new-conversation` for top-level PO chats
  only.
- **Fan-out / multi-repo sweeps (`run_workflow`):** For multi-module sprint
  audits, cross-repo status sweeps, or parallel review pipelines across many
  independent files/targets, prefer Antigravity's `run_workflow` (`parallel` /
  `pipeline` / `phase`) over manual serial loops.

## Models and Orchestrator

Which model a sub-session gets, Orchestrator included: "Models and Orchestrator" below.

- **Who picks the model.** The owner picks a conversation's model in the app's
  model picker, and a running conversation and its subagents keep it; no config
  value can change it. `invoke_subagent` can pin only `flash_lite`, `flash` or
  `pro`, so a sub-session runs on that model when `agent_model` (or an
  `Antigravity:` clause in `agent_model`'s parenthesized note) names one of
  them, and on the PO's own model (`Model: "inherit"`) otherwise. When
  `agent_model` carries an `Antigravity:` clause (such as
  `sonnet (Antigravity: inherit on Orchestrator (Carbon) or Gemini 4 Carbon)`),
  Antigravity reads that clause in place of a Claude model id. When the clause
  (or `agent_model` itself) asks for `flash_lite`, `flash` or `pro` at or below
  the PO's model and the PO pins it, or asks for `inherit` on a model the PO
  satisfies, no mismatch is reported. Only when neither `agent_model` nor an
  `Antigravity:` clause matches what Antigravity actually runs (or asks for an
  override above the PO's model) does the PO report the mismatch, higher or
  lower, once in its digest. It does not ask the owner to switch models in the
  middle of a task.
- **Discovering live models:** Run `swarm(action: "models")` when coordinating
  a swarm, or pass available model hints into
  `node "<this skill's directory>/po-model-advisor.mjs" --runtime antigravity --config docs/product-owner-config.md`
  to inspect config mappings and flag stale pinned minor snapshots without
  hardcoding future release numbers.
- **Orchestrator.** The picker's `Orchestrator (Carbon)` (model id
  `gemini-pro-orchestrator`) and `Orchestrator (Argon)` (model id
  `gemini-pro-orchestrator-argon`) are each one model choice: Gemini 4 Carbon
  (or Argon) leads in plan mode and may offload routine execution steps to
  Gemini 4 Hydrogen (prefer `TypeName: "research"`, `Model: "inherit"` for
  read-only tasks such as an independent security review or sprint audit so no
  write or shell tools are exposed, noting that Orchestrator may still route
  routine substeps to Hydrogen unless the conversation runs on direct
  `Gemini 4 Carbon` or `Claude Opus`). Where `Orchestrator (Neon)` (model id
  `gemini-pro-orchestrator-neon`) is available in the picker, it is the
  preferred Gemini orchestrator (routing routine execution while planning on
  Gemini 4 Neon). A PO the owner runs on Orchestrator
  needs nothing more for routine work: its sub-sessions inherit it, so each
  worker routes its own steps. The PO does not imitate the routing by pinning
  `flash` or `flash_lite` for tasks it judges simple: a task that changes
  anything stays on `agent_model`. An `agent_model` (or `Antigravity:` clause)
  naming either Orchestrator id is met when the owner runs the PO on that
  choice; otherwise it is the mismatch case above. How Orchestrator, Carbon,
  Argon and `pro` rank against each other for the rule that `agent_model` is
  not higher than the PO's model is the owner's decision, recorded in the
  config's note; without one, the PO treats an unlisted difference as a
  mismatch and reports it.
- **Model exceptions.** A read-only lookup the `product-owner` skill lets run
  cheaper names `flash_lite` or `flash`, the only cheaper models
  `invoke_subagent` can pin. A subagent cannot be moved to another model, so
  when such a task proves to need more, the PO ends it (`manage_subagents`,
  `Action: "kill"`), posts `model-exception: ended`, and starts a new
  sub-session on `agent_model` (or `inherit`) from the last checkpoint.
- **Flagship tier and named-model work.** Repositories shared across Claude
  Code and Antigravity should state PO and security-review capability by tier
  (a flagship model, or at least as capable as the PO's model) rather than
  hardcoding one vendor's model. Where the config or instructions ask for a
  flagship model (for example for POs and independent security reviews of
  protected paths), `Claude Opus` and `Gemini 4 Carbon` satisfy that tier with
  zero delegation to a smaller model, and `Orchestrator (Carbon)` (via a
  fresh-context `TypeName: "research"`, `Model: "inherit"` subagent) satisfies
  it too unless the repository's rules forbid routing substeps to Hydrogen on
  that gate; when satisfied, a PO on Carbon or Orchestrator (Carbon) runs its
  own independent review and does not wait on Claude Opus. `Gemini 4 Neon`
  (`gemini-4-neon-high` / `gemini-4-neon-xhigh`) and `Orchestrator (Neon)`
  (`gemini-pro-orchestrator-neon`, via a fresh-context `TypeName: "research"`,
  `Model: "inherit"` subagent unless Hydrogen delegation is forbidden) also
  satisfy the flagship tier. Whenever the
  reviewer's actual model (or review subagent, for example running a security
  review as `TypeName: "self"` under Orchestrator instead of
  `TypeName: "research"`, or running on Orchestrator when the repository
  forbids Hydrogen delegation on that review) does not satisfy the required
  tier, configured `Antigravity:` equivalent, or single-vendor pinned model,
  the PO does not count that work as done: it may run an independent review on
  the model it has, writes in the PR which model ran it, and holds the gate
  (the PR does not merge) until a qualifying model runs the review or the
  owner accepts the substitute for that PR.
- **Quota.** Each model has its own quota (Orchestrator's included), shown under
  `View Usage` in the picker. A start or turn on a model whose quota is used up
  fails. That failure is not the model error the skill's
  retry-once-without-`model` rule covers: the PO does not retry with `inherit`
  or another model, never retries in a loop and never moves the work to another
  model on its own. It says once in its digest which work is stopped and when
  the quota resets (if the app shows it); the owner picks another model or
  waits. When the owner or `docs/product-owner-config.md` explicitly authorizes
  a quota-fallback policy (for example, on Claude quota exhaustion: PO runs
  `Orchestrator (Neon)` (`gemini-pro-orchestrator-neon`), and subagents/swarm
  workers run `Gemini 4 Hydrogen (High)` (`gemini-4-hydrogen-high`) for
  routine/helper work or `Gemini 4 Neon` (`gemini-4-neon-medium` /
  `gemini-4-neon-high` / `gemini-4-neon-xhigh`) by task complexity), the PO
  switches cleanly via `swarm(action="model")` without asking again and records
  the switch in its check-in.
- **Effort skip.** Antigravity has no session effort API. Skip session effort
  reconciliation and effort exceptions silently (they need no owner action).
  Keep `-c model_reasoning_effort=<subagent_effort>` on `codex review` when
  `local_reviews` uses Codex CLI.

## Sidecar automations and multi-profile `agy-gatekeeper.mjs`

- Under `po_wake: gatekeeper` (the default), keep **one** shared scheduled
  automation per repository (and profile) at
  `~/.gemini/config/sidecars/<repo owner>-<repo>-po-gatekeeper/sidecar.json`
  (`"builtin": "schedule"`, `"restart_policy": "always"`,
  `"display_name": "PO gatekeeper (<owner/repo>)"`, and `"args":
  ["CRON_TZ=<IANA zone> */10 * * * *", "<absolute node path>",
  "<absolute plugin path>/skills/product-owner/agy-gatekeeper.mjs",
  "<po_check_in_dir>/<repo owner>-<repo>-agy-gatekeeper.json"]`).
- **10-minute multi-signal evaluation (`gatekeeper-core.mjs`):** Each run costs
  zero model tokens, spawns zero sidebar chats, and evaluates 6 triggers:
  `restart` (compared against `lastPlannerMs`—the last completed
  `PLANNER_RESPONSE`, ignoring `SYSTEM_MESSAGE` wake echoes),
  `pr-state-changed` (line PR fingerprint changes including `CLEAN`, `UNSTABLE`,
  `CHANGES_REQUESTED`, `DIRTY`, CI rollup, and new comments),
  `subagent-stalled-or-errored`, `issue-dispatchable-or-owner-reply`,
  `quota-recovery-probe` (exponential backoff `30m -> 60m -> 120m` /
  `1h -> 2h -> 4h` + optional macOS alert on `consecutiveUnansweredWakes >= 2`),
  and `safety-heartbeat` (`180` min active / `720` min idle by default).
- **Multi-profile safety (Profile Affinity Guard, atomic lockfile, 90s debounce):**
  On macOS multi-profile setups (`Antigravity Profiles/<profile>`), set
  `ANTIGRAVITY_APP_DATA_DIR` (or `brainDir` in the gatekeeper JSON) and
  optionally `ANTIGRAVITY_AGENTAPI_EXE` / `AGENTAPI_BIN` (otherwise
  `agy-gatekeeper.mjs` auto-discovers profile `Antigravity (<profile>).app`
  and `/Applications/Antigravity.app` binaries cleanly).
  - **Profile Affinity Guard** compares the sidecar's runtime profile
    (`ANTIGRAVITY_PROFILE`, `ANTIGRAVITY_APP_DATA_DIR`, and
    `ANTIGRAVITY_EXECUTABLE_DATA_DIR`) against `brainDir` and refuses
    cross-profile runs (for example an `acc2` sidecar pointing at `acc3`)
    cleanly (`skipped: profile-mismatch`), preventing duplicate wakes and
    `agentapi ETIMEDOUT` errors.
  - **Atomic lockfile** (`~/.claude/po-state/locks/`, `wx` + owner-token
    release + stale rename-before-unlink) serializes repo read-eval-write-send
    cycles, and a **90-second debounce** window (`RUNNING_MTIME_WINDOW_MS = 90_000`,
    overridable via `debounceSeconds`) avoids racing Antigravity's native
    reactive wakeup.
  - **State persistence:** Automatically reads/writes atomic `state.json` inside
    `ANTIGRAVITY_EXECUTABLE_DATA_DIR` when set (or `--state-file <path>` when
    passed explicitly); `--dry-run` inspects non-destructively without writing.
  - **v2.18.0 migration checklist:** Update legacy half-hour schedules
    (`9,39`, `7,37`) in existing `sidecar.json` files to `*/10`, verify every
    `*-agy-gatekeeper.json` sets `brainDir` for its own profile, and disable any
    duplicate gatekeeper sidecar enabled on another profile (for example `acc2`
    vs `acc3`).
- **Never hand-edit `~/.gemini/config/config.json` or `user_config.json`.**
  Only the owner enables or disables automations in
  `[Open Automations Dashboard](sidecar://dashboard)`. Treat the automation as
  active only when `<appDataDir>/sidecar_data/<sidecar id>/logs/sidecar.log`
  and `~/.gemini/config/config.json` (read-only) both confirm
  `sidecars["<sidecar id>"].enabled === true` AND the latest start block in
  `sidecar.log` (at or after the current Antigravity server start or OS boot
  time) shows `Scheduler started` without a later stop or failure; otherwise
  report in the digest that the PO has no durable wake automation and point
  the owner to the dashboard.

## Native hooks (`plugins/cc-po/hooks.json`)

Antigravity loads native plugin hooks from the plugin root `hooks.json`
(fail-open, 5-second timeout, zero model tokens) for **`PostToolUse`** and
**`Stop`** only (`PostInvocation` is intentionally omitted so the hook never
blocks every tool call in the agent loop):

- **`PostToolUse` (file write/edit tools) → `hooks/post-checkin-cap.mjs`:**
  Enforces the rolling `<= 6 KB` (`6144` bytes) cap on `*-po-checkin.md` files
  by atomically rotating older completed/archived history into a sibling
  `<base>-archive.md` file while preserving the metadata header, `On every wake`,
  and active `Live state`.
- **`Stop` → `hooks/agy-turn-status.mjs`:** Returns `{"decision":"allow"}` and
  atomically writes `~/.claude/po-state/turn-status/<conversationId>.json`
  (lowercase ID, auto-pruning entries older than 7 days) with
  `status: "ok" | "error" | "quota"` so `agy-gatekeeper.mjs` can tell a clean
  idle sleep apart from a quota-exhausted or failed turn without guessing.

## PO context hygiene (sawtooth control)

Because Gemini 4 uses implicit prompt caching (~2–5 min TTL), every cold wake
pays full input tokens for the PO's live context:

- **Delegate all broad reads:** Offload `gh project item-list`, sprint audits,
  and log/diff sweeps to `invoke_subagent(TypeName: "research", Model: "flash")`
  or `run_workflow`, returning only a compact JSON summary or digest (`<= 30`
  lines) to the PO chat.
- **Proactive `/compact` around ~100K–120K tokens:** Rather than letting PO
  context climb toward ~300K before automatic compaction kicks in, proactively
  run `/compact` once context approaches ~100K–120K (or
  `po_context_compact_tokens` in config). Keep state on GitHub and in the
  check-in file (`<= 6 KB`) so compaction is lossless, and never ask the owner
  to compact or replace the PO session.
- **Keep ephemeral jobs off the PO:** Run periodic non-conversational sweeps
  (multi-repo morning digests, weekly P2/P3 cleanup triage) via ephemeral
  `schedule` sidecars (`run_workflow` or `agentapi new-conversation --model=flash`)
  instead of waking the long-lived PO.

## Commands, permissions, and restarts

- Run `agentapi`, `gh`, `git fetch`, `git push`, and `git ls-remote` as single
  commands via `run_command` (never chained with `&&`, `;`, `||`) with
  consistent `toolSummary` and prefix-matchable command shapes.
- When commands already run cleanly (for example in **Turbo** terminal
  execution mode), do not ask the owner to configure a Command Allowlist when
  commands already execute cleanly. Only if a `run_command` call pauses for
  approval or is refused, tell the owner once to switch Terminal Execution
  Policy to **Turbo** or allow `agentapi`, `gh`, `git fetch`, `git push`,
  `git ls-remote`.
- After a server restart, reconcile from GitHub and the check-in file, revive
  unfinished sub-session subagents in place via `send_message` (`Recipient`:
  `<conversationId>`), and restart any stopped background CI watches or
  one-shot timers.
