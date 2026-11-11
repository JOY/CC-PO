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
only a safety net. Each gatekeeper run is a fresh, short session on the
cheapest model. It wakes a PO that is not running when a restart cut it off,
when a PR of its own line is ready that the PO has not seen, or when the PO has
been quiet for the quiet window while its line has work in flight, so no PO sits
idle behind a ready PR or a crash, and an idle line is not woken for nothing.
It reads no session's context size and sends no notice that asks the owner to
compact a session or open a new PO session: a PO's context needs no owner
action.

A run never reads or changes the repository, never touches git or the cloud,
and writes no file: it keeps no state, and uses each PO session's
`lastActivityAt` as its memory. Its only commands are a read-only restart
check and one read-only `gh` query.

Why no state file: a scheduled task run that reads or writes a file outside
the project folder stops at a permission prompt that nobody answers, so a
gatekeeper with a state file never woke anyone. The two commands it still runs
(the restart check and `gh pr list`) may show such a prompt in the first runs.
The owner approves each once ("always allow"). After creating the task, the PO
checks the first run with `list_task_runs` and `list_events` to see that it got
past both commands, and tells the owner in its next report if it did not.

## Values

Fill every placeholder in this table before creating the task, as plain
text. Leave `<now>`, `<lastActivityAt>`, `<boot time>`, `<app start time>`,
`<reasons>`, `<ready PRs>`, `<idle sub-sessions>` and `<N>` in the prompt: each run fills
those in itself.

| Placeholder | Value |
| --- | --- |
| `<task id>` | `<repo owner>-<repo>-po-gatekeeper`, lower case, every run of characters other than `a-z` and `0-9` as one hyphen, no hyphen at either end of `<repo owner>` or `<repo>`. `<repo owner>` and `<repo>` are the two halves of `<owner/repo>`, so an upstream and its fork (or two repositories with one name) on one machine each get their own task. |
| `<owner/repo>` | The repository. |
| `<owner>` | `owner_name`. |
| `<language>` | `report_language`. |
| `<model>` | `gatekeeper_model` (default `claude-haiku-5-5`). |
| `<active minutes>` | `gatekeeper_active_minutes` (default 60): how long a sub-session is idle before the wake message lists it. |
| `<quiet minutes>` | `gatekeeper_quiet_minutes` (default 180): how long a PO with work in flight is quiet before it is woken for that. |
| `<po rows>` | One row per line of the Lines table that has a PO session: `<po title> \| line:<slug> \| <check-in file>`. The title is the table's PO session title; the check-in file is the one that PO already keeps, else `po_check_in_dir` with `~` expanded, then `<repo owner>-<repo>-<slug>-po-checkin.md`, written as `<task id>` is. A line whose PO session is `none` has no row. A PO that covers more than one line (the owner folded a small line into it) lists every label of those lines in the middle cell, separated by `, `: `line:<slug>, line:<other>`. The run counts only pull requests that carry one of the labels in the PO's own row. In the Lines table, the folded line's PO column reads `none (covered by <PO title>)`. |
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
- `description`: `Every 30 min: wake a <owner/repo> PO that is not running after a restart, with a ready PR of its line it has not seen, or after <quiet minutes> quiet minutes with work in flight`;
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

You are the gatekeeper of the Product Owner (PO) sessions of the <owner/repo> repository. Your only job is to wake a PO session that is not running and needs a wake. Do nothing else: no repository, git, cloud or file action, and no message to any session but the POs listed below. You keep no state and write no file. The only commands you may run are the read-only restart check in step 3 and the read-only gh query in step 4. Never read the repository or any config.

The POs of this repository (title, label, check-in file):
<po rows>

Report the owner as <owner>, language <language>. Settings: idle sub-session after <active minutes> min, quiet after <quiet minutes> min.

Steps:
1. Call `mcp__ccd_session_mgmt__list_sessions` once, with limit 200 and archived sessions left out. For each PO above, take the non-archived session whose title is exactly the PO title; a PO with none, or with two, is skipped (write that in one line). Each row normally has `isRunning`, `lastActivityAt` and `startedBy`; only if a row lacks one, call `mcp__ccd_session_mgmt__get_session` for that session only. Take the current UTC time as <now>.
2. Skip every PO whose session is running (`isRunning` true): a real event reaches it. The rest are the candidates. If there are none, go to step 7.
3. Restart check. Run this read-only command, which prints two UTC times and changes nothing: `<restart check>`. The first line is when the machine booted; the second is when the Claude app started (it may be empty). If the command fails, write its error in one line and treat reason (a) as false.
4. Run one read-only query for the open pull requests: `gh pr list --repo <owner/repo> --state open --limit 200 --json number,labels,isDraft,mergeStateStatus,updatedAt`. If it fails, write its error in one line, treat reason (b) as false, the ready PR list as unknown, and judge work in flight (step 5 (c)) from the sessions alone.
5. For each candidate PO, in the order listed, wake it when ANY of these holds, and name every one that holds in the message:
   (a) restart: the boot time or the app start time is LATER than the PO's `lastActivityAt`.
   (b) unseen ready PR: an open pull request that is not a draft (`isDraft` false) and carries one of the PO's own line labels (the labels in its row; a pull request of any other line never counts, whoever's it is) has `mergeStateStatus` CLEAN or UNSTABLE and an `updatedAt` LATER than the PO's `lastActivityAt`, so the PO has not acted since it became ready. There is no waiting time.
   (c) quiet: the PO's `lastActivityAt` is <quiet minutes> minutes or more before <now>, AND its line has work in flight: an open pull request (a draft counts) that carries one of the PO's line labels, or a non-archived session whose `startedBy` is the PO's session id (a session that a retired PO started is not counted until it has an open PR with the line's label). A line with no work in flight is not woken for being quiet. This wakes a PO at most once per quiet window while its line is busy and the PO is idle. A crash or restart is reason (a), not this one.
   If none holds, do not wake it.
6. Send. For each PO you wake, send ONE message with `mcp__ccd_session_mgmt__send_message` to its session id; if that is refused, call `SendMessage` with `to` set to that session id and the same text. If both fail, write the error in one line; the next run tries again.
   Wake text, with the values filled in:
   "Gatekeeper wake at <now> (reasons: <reasons>). Ready PRs of your line: <ready PRs>. Idle sub-sessions of your line: <idle sub-sessions>. Do one short turn: merge or review the ready PRs, feed or archive the idle sub-sessions, resume work a crash cut off, answer messages. Then end the turn. Keep no CronCreate check-in and no ScheduleWakeup loop: the gatekeeper and real events wake you. Your check-in file is <check-in file>; use the one you already keep if it differs. Read only what this needs."
   <reasons> names every reason that holds: "restart", "unseen ready PR", "quiet for <N> minutes with work in flight".
   <ready PRs> is the numbers of the line's open, non-draft PRs whose `mergeStateStatus` is CLEAN or UNSTABLE (the same label rule as (b)), each with its state, or "none"; say "unknown, the gh query failed" when step 4 failed.
   <idle sub-sessions> is the non-archived sessions whose `startedBy` is this PO's session id, that are not running and have had no activity for more than <active minutes> minutes, each with its title and how long it has been idle, or "none".
   When reason (a) holds add: "Machine boot <boot time>, app start <app start time>. A restart stopped your process and your sub-sessions. Tell <owner> in <language> on the first line that you are back and how long you were away, recreate any one-shot you had pending, and resume every linked sub-session (list_sessions linked) that had pending work."
7. Write one line: what you saw, and whom you woke and why.
8. Archive this run's own session, so gatekeeper runs do not pile up in the sidebar. Call `mcp__ccd_session_mgmt__archive_session` with session_id "self" and reason "gatekeeper run finished". This ends the run. If the app does not archive it, stop here: a PO archives finished runs at its check-ins.

If a tool call fails (for example a usage limit), write the error in one line and still try step 8. The next scheduled run will try again.

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

On every wake (the message names the reasons and lists the ready PRs and
the idle sub-sessions; do one short turn, then end it):
1. Run the full check-in of the `product-owner` skill ("Keep the line
   moving") only when the wake needs one; a wake for ready PRs or idle
   sub-sessions needs only that work, then a short digest. A wake for
   "quiet" with nothing ready and nothing idle gets a one-line digest.
2. After a restart (reason "restart"), resume every linked sub-session that
   still has pending work (the skill's "Resuming") and recreate any
   one-shot this file lists as pending.
3. Check that the gatekeeper exists (the skill's "Find it"), and archive
   its finished runs (the skill's "Run cleanup").
4. Never create a CronCreate check-in or a ScheduleWakeup loop.
5. Context needs no owner action: never ask <owner> to compact a session or
   open a new PO session because of context size ("Keep the context small").

Live state (update when it changes):
- (open items, holds, waits and queued dispatches that are not on GitHub yet)
```

Live state is a cache for the PO's next turn. GitHub stays the record: the
digest is built from GitHub, never from this file.
