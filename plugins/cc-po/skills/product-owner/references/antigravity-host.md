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
  `Gemini 4 Carbon` or `Claude Opus`). A PO the owner runs on Orchestrator
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
  own independent review and does not wait on Claude Opus. Whenever the
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
  waits.
- **Effort skip.** Antigravity has no session effort API. Skip session effort
  reconciliation and effort exceptions silently (they need no owner action).
  Keep `-c model_reasoning_effort=<subagent_effort>` on `codex review` when
  `local_reviews` uses Codex CLI.

## Sidecar automations and multi-profile `agy-gatekeeper.mjs`

- Under `po_wake: gatekeeper` (the default), keep **one** shared scheduled
  automation per repository (or profile) at
  `~/.gemini/config/sidecars/<repo owner>-<repo>-po-gatekeeper/sidecar.json`
  (`"builtin": "schedule"`, `"restart_policy": "always"`,
  `"display_name": "PO gatekeeper (<owner/repo>)"`, and `"args":
  ["CRON_TZ=<IANA zone> <m>,<m+30> * * * *", "<absolute node path>",
  "<absolute plugin path>/skills/product-owner/agy-gatekeeper.mjs",
  "<po_check_in_dir>/<repo owner>-<repo>-agy-gatekeeper.json"]`).
- On macOS multi-profile setups (`Antigravity Profiles/<profile>`), set
  `ANTIGRAVITY_APP_DATA_DIR` (or `brainDir` in the gatekeeper JSON) and
  optionally `ANTIGRAVITY_AGENTAPI_EXE` / `AGENTAPI_BIN` (otherwise
  `agy-gatekeeper.mjs` auto-discovers profile `Antigravity (<profile>).app`
  and `/Applications/Antigravity.app` binaries cleanly). Use `--dry-run` for
  non-destructive inspection and `--state-file <path>` only if explicit
  structured run-status persistence is wanted (default keeps no state file).
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
