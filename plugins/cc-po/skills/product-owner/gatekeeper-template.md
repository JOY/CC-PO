# PO gatekeeper template

The prompt of the one durable gatekeeper each repository keeps for all its
Product Owner (PO) sessions ("Wake-ups" in `SKILL.md`). It is an app
scheduled task, so it lives outside the PO sessions and survives a process
exit, an app restart and a usage-limit stop, which kill in-session crons. It
replaces the per-PO watchdog (`watchdog-template.md`) and the PO's in-session
check-in cron.

Why one cheap gatekeeper: a PO's context reaches hundreds of thousands of
tokens, and every wake makes it re-read that context, so an empty check-in
costs as much as a real one. Real events already wake a PO at once: a
sub-session's turn end, a message from another session, CI and review
notifications on PRs it watches, a finished background command. A timer is
only the safety net. Each gatekeeper run is a fresh, short session on the
cheapest model, and it wakes a PO only for a reason that needs a PO.

A run never reads or changes the repository, never touches git or the cloud,
and writes one file, its state file. Its only commands are a read-only restart
check and one read-only `gh` query.

## Values

Fill every placeholder in this table before creating the task, as plain
text. Leave `<now>`, `<lastActivityAt>`, `<boot time>`, `<app start time>`,
`<reason>`, `<detail>` and `<N>` in the prompt: each run fills those in
itself.

| Placeholder | Value |
| --- | --- |
| `<task id>` | `<repo owner>-<repo>-po-gatekeeper`, lower case, every run of characters other than `a-z` and `0-9` as one hyphen, no hyphen at either end of `<repo owner>` or `<repo>`. `<repo owner>` and `<repo>` are the two halves of `<owner/repo>`, so an upstream and its fork (or two repositories with one name) on one machine each get their own task. |
| `<owner/repo>` | The repository. |
| `<owner>` | `owner_name`. |
| `<language>` | `report_language`. |
| `<model>` | `gatekeeper_model` (default `claude-haiku-5-5`). |
| `<active minutes>` | `gatekeeper_active_minutes` (default 60). |
| `<quiet hours>` | `gatekeeper_quiet_hours` (default 4). |
| `<compact tokens>` | `compact_notice_tokens` (default 500000). |
| `<coordinator label>` | `coordinator_line`, or `none` (default). |
| `<state file>` | The absolute path of the state file: `po_check_in_dir` with `~` expanded, then `<repo owner>-<repo>-gatekeeper.md`, written as `<task id>` is. |
| `<po rows>` | One row per line of the Lines table that has a PO session: `<po title> \| line:<slug> \| <check-in file>`. The title is the table's PO session title; the check-in file is the one that PO already keeps, else `po_check_in_dir` with `~` expanded, then `<repo owner>-<repo>-<slug>-po-checkin.md`, written as `<task id>` is. A line whose PO session is `none` has no row. |
| `<restart check>` | The read-only command for the machine, from "Restart check" below, written exactly. |

The prompt carries these values, never the repository's files: a run never
reads the repository or the config. When the Lines table, a PO title or one
of the keys above changes, the PO that notices updates the task with
`update_scheduled_task`.

### Restart check

A restart kills a PO's process at once, but its `lastActivityAt` stays
recent, so an idle rule alone leaves the line without a PO for a while. The
restart check prints two UTC times, when the machine booted and when the
Claude app started (the second line is empty when the app's process is not
found). App scheduled tasks run where the desktop app runs, so there is one
command per system:

- Windows (PowerShell): `(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); (Get-Process -Name claude -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).StartTime.ToUniversalTime().ToString('o')`
- macOS (zsh or bash): `date -u -r "$(sysctl -n kern.boottime | sed -E 's/^\{ sec = ([0-9]+).*/\1/')" +%Y-%m-%dT%H:%M:%SZ; p="$(pgrep -ox Claude)" && date -u -r "$(date -j -f '%a %b %e %T %Y' "$(ps -o lstart= -p "$p")" +%s)" +%Y-%m-%dT%H:%M:%SZ`

Both only read; neither changes anything. The PO runs the command once
before creating the task and checks that it prints a boot time, so a run
never meets a command its machine lacks.

### The task

Create the task with `create_scheduled_task`:

- `taskId`: `<task id>`;
- `title`: `PO gatekeeper (<owner/repo>)`, which the owner sees in the app's
  task list and which names the task's runs (add a few words in `<language>`
  when that is not English);
- `description`: `Every 30 min: wake a <owner/repo> PO that needs one (restart, a PR ready to accept, finished sub-sessions, a long quiet), and tell it when a session's context is large`;
- `cronExpression`: `<m>,<m+30> * * * *` (local time), where `<m>` is a minute
  from 2 to 13 (7 unless another task on this machine already uses it), so
  the run never fires on the hour or half hour, when many in-session timers
  fire (the app may delay a recurring run by a few minutes);
- `notifyOnCompletion`: `false`, so no PO is woken by a run;
- `prompt`: the text between the two lines below, with the values filled
  in.

The tool has no model parameter, but the task is stored as a `SKILL.md` at
the `path` that `list_scheduled_tasks` shows. After creating the task, the PO
adds the line `model: <model>` to that file's frontmatter, once, so the app
can run each fresh session on the cheapest model. The app may ignore that
line. The PO checks the model of the first run with `get_session` (the run's
session, found with `list_task_runs`) and notes the result in its check-in
file and its next report: when the run did not use `<model>`, the owner may
set the model in the app's task settings.

A run that stops before its last step (a usage limit, or an archive the app
does not approve) stays in the sidebar under the task's title. A PO archives
them at each check-in ("Run cleanup" in `SKILL.md`).

---

You are the gatekeeper of the Product Owner (PO) sessions of the <owner/repo> repository. Your only job is to wake a PO session that needs a wake, and to tell a PO when a session's context has grown large. Do nothing else: no repository, git, cloud or other file action, and no message to any session but the POs listed below. The only files you touch are the state file in step 1 and step 7. The only commands you may run are the read-only restart check in step 3 and the read-only gh query in step 4. Never read the repository or any config.

The POs of this repository (title, label, check-in file):
<po rows>

State file: `<state file>`. Report the owner as <owner>, language <language>. Settings: active <active minutes> min, quiet <quiet hours> h, compact notice above <compact tokens> tokens, coordinator label <coordinator label>.

Steps:
1. Read the state file. It holds one row per PO title with `last_wake` and `last_compact_notice` (UTC times or `none`) and `last_wake_prs` (the pull request numbers that the PO's last pull request wake named, comma separated, or `none`). A missing or unreadable file means every value is `none`.
2. Call `mcp__ccd_session_mgmt__list_sessions` once, with limit 200 and archived sessions left out. For each PO above, take the non-archived session whose title is exactly the PO title; a PO with none, or with two, is skipped (write that in one line). Each row normally has `isRunning`, `lastActivityAt` and `startedBy`; only if a row lacks one, call `mcp__ccd_session_mgmt__get_session` for that session only. Take the current UTC time as <now>.
3. Restart check. Run this read-only command, which prints two UTC times and changes nothing: `<restart check>`. The first line is when the machine booted; the second is when the Claude app started (it may be empty). If the command fails, write its error in one line and treat the restart reason as false.
4. Run one read-only query for the open pull requests that are not drafts: `gh pr list --repo <owner/repo> --state open --search "draft:false" --limit 200 --json number,labels,mergeStateStatus,updatedAt`. If it fails, write its error in one line and treat the pull request reason as false.
5. For each PO, in the order listed:
   - Skip it, with no wake, when its session is running (`isRunning` true) or its `lastActivityAt` is less than <active minutes> minutes before <now>: it is working or just worked, and a real event reaches it.
   - Otherwise wake it for the FIRST reason below that holds, and for no other:
     (a) restart: the boot time or the app start time is LATER than the PO's `lastActivityAt`.
     (b) pull request: an open pull request with the PO's line label (the label in its row) has `mergeStateStatus` CLEAN or UNSTABLE and an `updatedAt` more than 30 minutes before <now>. For the PO whose label is the coordinator label, any open pull request counts, whatever its labels. A pull request counts only if it is new since the PO's last wake: its number is not in the PO's `last_wake_prs`, or its `updatedAt` is later than the PO's `last_wake`. So a pull request that waits on the owner wakes the PO once, not every hour. Name the pull request numbers.
     (c) sub-sessions: a non-archived session whose `startedBy` is this PO's session id is not running and has had no activity for more than <active minutes> minutes, and the PO's `last_wake` is none or more than 3 hours before <now>. Name those sessions.
     (d) safety net: the PO's `lastActivityAt` and its `last_wake` are both more than <quiet hours> hours before <now> (or `last_wake` is none).
   - If no reason holds, do not wake it.
6. Context check. For each non-archived PO session and each non-archived session it started (`startedBy` is the PO's session id) that is not running, call `mcp__ccd_session_mgmt__get_usage` with its session id. A session whose usage is unavailable is skipped. When a session's context is above <compact tokens> tokens, add it to its line's PO (the PO itself, or the session's `startedBy`). Send a PO a notice only if that PO is not running and its `last_compact_notice` is none or more than 6 hours before <now>; one notice lists all its sessions.
7. Send. For each PO that gets a wake or a notice, send ONE message with `mcp__ccd_session_mgmt__send_message` to its session id; if that is refused, call `SendMessage` with `to` set to that session id and the same text. If both fail, write the error in one line; the next run tries again. Then rewrite the state file whole, with `last_wake` set to <now> for each PO you woke and `last_compact_notice` set to <now> for each PO you sent a notice to, and `last_wake_prs` set, for each PO, to its old numbers that are still open pull requests in this run's query plus the numbers you named in a pull request wake to it (`none` if there are none), and the other values unchanged.
   Wake text, with the values filled in:
   "Gatekeeper wake at <now> (reason: <reason>): <detail>. Act on this reason only. Run a full check-in (your check-in file is <check-in file>; use the one you already keep if it differs) only if the reason needs one. Keep no CronCreate check-in and no ScheduleWakeup loop: the gatekeeper and real events wake you. Keep this turn short and read only what the reason needs."
   For reason (a) add: "Machine boot <boot time>, app start <app start time>. A restart stopped your process and your sub-sessions. Tell <owner> in <language> on the first line that you are back and how long you were away, recreate any one-shot you had pending, and resume every linked sub-session (list_sessions linked) that had pending work."
   For reason (b), <detail> is the pull request numbers and their state, "ready for your acceptance"; for (c) the sessions and how long each has been idle; for (d) "no activity for <quiet hours> hours".
   Notice text (alone, or after the wake text in the same message):
   "Context notice at <now>: these sessions of your line hold more than <compact tokens> tokens of context: <title, session id, tokens for each>. A session cannot compact itself; '/compact' sent as a message is read as text, not as a command; and clear_session refuses Remote Control sessions. In your next report, tell <owner> in <language> to press 'Compact session' on each of them in the app. Do not wait for it, and do not read more because of it."
8. Write one line: what you saw, whom you woke and why, and who got a notice.
9. Archive this run's own session, so gatekeeper runs do not pile up in the sidebar. Call `mcp__ccd_session_mgmt__archive_session` with session_id "self" and reason "gatekeeper run finished". This ends the run. If the app does not archive it, stop here: a PO archives finished runs at its check-ins.

If a tool call fails (for example a usage limit), write the error in one line and still try step 9. The next scheduled run will try again.

---

## Check-in file

A wake message points the PO at its check-in file, so the file, not the task
prompt, carries what a check-in does. The PO creates it next to the task and
keeps it current; it is machine state, never committed. It starts like this:

```markdown
# <po title> check-in (<owner/repo>)

Session: `<po session id>`. Line `line:<slug>`. Reports to <owner> in
<language>. Wake-ups: gatekeeper task `<task id>` (cron `<m>,<m+30> * * * *`),
owned by the repository's first PO; the PO keeps no in-session check-in cron.

On every wake (the message names the reason; act on that reason only):
1. Run the full check-in of the `product-owner` skill ("Keep the line
   moving") only when the reason needs one; a wake for pull request or
   sub-sessions needs only that work, then a short digest.
2. After a restart (reason "restart"), resume every linked sub-session that
   still has pending work (the skill's "Resuming") and recreate any
   one-shot this file lists as pending.
3. Check that the gatekeeper exists (the skill's "Find it"), and archive
   its finished runs (the skill's "Run cleanup").
4. Never create a CronCreate check-in or a ScheduleWakeup loop.

Live state (update when it changes):
- (open items, holds, waits and queued dispatches that are not on GitHub yet)
```

Live state is a cache for the PO's next turn. GitHub stays the record: the
digest is built from GitHub, never from this file.

## State file

The gatekeeper's one file, `<state file>`, is machine state like the
check-in files: never committed, no secrets. Each run rewrites it whole:

```markdown
# Gatekeeper state (<owner/repo>)

| PO title | last_wake | last_compact_notice | last_wake_prs |
| --- | --- | --- | --- |
| Core Product Owner | 2026-11-04T10:00:00Z | none | 41, 43 |
```
