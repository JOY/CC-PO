# PO watchdog template

The prompt of the durable watchdog each Product Owner creates for itself
("Durable watchdog" in `SKILL.md`). It is an app scheduled task: it lives
outside the PO's session, so it survives a process exit, an app restart and
a usage-limit stop, which kill in-session crons. Each run starts fresh, looks
at one PO session and wakes it right after a machine or app restart, or when
it has gone quiet. A run never reads or changes the repository, GitHub, the
cloud or any file; its one local command is a read-only restart check.

## Values

Fill every placeholder in this table before creating the task, as plain
text. Leave `<current UTC time>`, `<lastActivityAt>`, `<N>`, `<reason>`,
`<boot time>` and `<app start time>` in the prompt: each run fills those in
itself.

| Placeholder | Value |
| --- | --- |
| `<task id>` | `<repo owner>-<repo>-<slug>-po-watchdog`, lower case, every run of characters other than `a-z` and `0-9` as one hyphen, no hyphen at either end of `<repo owner>`, `<repo>` or `<slug>`. `<repo owner>` and `<repo>` are the two halves of `<owner/repo>`, so an upstream and its fork (or two repositories with one name) on one machine each get their own task; `<slug>` is the line's label after `line:`. |
| `<po session id>` | The PO's own app session id (`local_...`), from `get_session` with `self`. |
| `<po title>` | The PO session's title, `<Line> Product Owner`. |
| `<owner/repo>` | The repository, for people reading the task list. |
| `<owner>` | `owner_name`. |
| `<language>` | `report_language`. |
| `<idle minutes>` | `check_in_minutes` plus 10 (40 with the default). |
| `<check-in file>` | The absolute path of the PO's check-in file: the one it already keeps, else `po_check_in_dir` with `~` expanded, then `<repo owner>-<repo>-<slug>-po-checkin.md`, written as `<task id>` is. |
| `<restart check>` | The read-only command for the PO's own machine, from "Restart check" below, written exactly. |

### Restart check

A restart kills the PO's process at once, but its `lastActivityAt` stays
recent, so an idle rule alone leaves the line without a PO for up to the
idle time plus one interval. The restart check closes that gap: it prints
two UTC times, when the machine booted and when the Claude app started (the
second line is empty when the app's process is not found). App scheduled
tasks run where the desktop app runs, so there is one command per system:

- Windows (PowerShell): `(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); (Get-Process -Name claude -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).StartTime.ToUniversalTime().ToString('o')`
- macOS (zsh or bash): `date -u -r "$(sysctl -n kern.boottime | sed -E 's/^\{ sec = ([0-9]+).*/\1/')" +%Y-%m-%dT%H:%M:%SZ; p="$(pgrep -ox Claude)" && date -u -r "$(date -j -f '%a %b %e %T %Y' "$(ps -o lstart= -p "$p")" +%s)" +%Y-%m-%dT%H:%M:%SZ`

Both only read; neither changes anything. The PO runs the command once
before creating the task and checks that it prints a boot time, so a run
never meets a command its machine lacks.

### The task

Create the task with `create_scheduled_task`:

- `taskId`: `<task id>`;
- `title`: `<po title> watchdog (<owner/repo>)`, which the owner sees in
  the app's task list and which names the task's runs (add a few words in
  `<language>` when that is not English);
- `description`: `Every 15 min: wake the <po title> of <owner/repo> after a machine or app restart, or if it is idle over <idle minutes> min`;
- `cronExpression`: `<m>,<m+15>,<m+30>,<m+45> * * * *` (local time), where
  `<m>` is 1 plus (the line's row number in the Lines table - 1) modulo 13
  (row 1: `1,16,31,46`; row 2: `2,17,32,47`; row 3: `3,18,33,48`), so the
  watchdogs of the first thirteen lines fire at different minutes and none
  fires on the hour, a quarter or the half hour, when in-session check-ins
  often run (from row 14 the minutes repeat, and the app may delay a
  recurring run by a few minutes);
- `notifyOnCompletion`: `false`, so the PO is not woken by every run;
- `prompt`: the text between the two lines below, with the values filled
  in.

A run that stops before its last step (a usage limit, or an archive the app
does not approve) stays in the sidebar under the task's title. The PO archives them at
each check-in ("Durable watchdog", Run cleanup in `SKILL.md`), and the
check-in file below lists it as a step.

---

You are the watchdog of the <po title> session for the <owner/repo> repository. Your only job is to wake one Claude Code session after a machine or app restart, or if it has gone quiet. Do nothing else: no repository, git, GitHub, cloud or file action, and no message to any other session. The only local command you may run is the read-only restart check in step 2.

Target session: `<po session id>`, titled "<po title>".

Steps:
1. Call `mcp__ccd_session_mgmt__get_session` with that session id. If the session is archived or not found, write "target archived or missing" and go to step 6.
2. Restart check. Run this read-only command, which prints two UTC times and changes nothing: `<restart check>`. The first line is when the machine booted; the second is when the Claude app started (it may be empty). If either time is LATER than the session's `lastActivityAt`, a restart killed the PO's process: wake it now (step 4) with reason "restart", whatever its idle time. If the command fails, write its error in one line and go on with step 3.
3. Otherwise take the current UTC time and compute how many minutes ago `lastActivityAt` was. Ignore `isRunning`: it is false whenever the session is idle between turns, which is normal. A healthy PO runs a check-in on a schedule, so its `lastActivityAt` is rarely older than its check-in interval plus a few minutes. If `lastActivityAt` is less than <idle minutes> minutes ago, note "PO active (last activity N min ago), no restart since, no wake" and go to step 6. Otherwise wake it with reason "idle".
4. To wake it, call `mcp__ccd_session_mgmt__send_message` with that session id and this message, with the values filled in:
   "Watchdog wake at <current UTC time> (reason: <reason>): last activity <lastActivityAt>, <N> minutes ago; machine boot <boot time>, app start <app start time>. A restart, a crash or a usage limit stopped your process, or your check-in cron died. Tell <owner> in <language> on the first line that you are back, why, and how long you were away. Recreate your in-session check-in cron if CronList shows none, and any one-shot you had pending. Wake every linked sub-session (list_sessions linked) that still has pending work, because a restart stops them too. Then run the check-in in <check-in file> now."
   If that call is refused, call `SendMessage` with `to` set to that session id and the same message. If both fail, write the error in one line; the next run tries again.
5. Write one line: what you saw and whether you sent the wake.
6. Archive this run's own session, so watchdog runs do not pile up in the sidebar. Call `mcp__ccd_session_mgmt__archive_session` with session_id "self" and reason "watchdog run finished". This ends the run. If the app does not archive it, stop here: the PO archives finished runs at its check-ins.

If a tool call fails (for example a usage limit), write the error in one line and still try step 6. The next scheduled run will try again.

---

## Check-in file

The watchdog's wake message points the PO at its check-in file, so the file,
not the task prompt, carries what a check-in does. The PO creates it next to
the task and keeps it current; it is machine state, never committed. It
starts like this:

```markdown
# <po title> check-in (<owner/repo>)

Session: `<po session id>`. Line `line:<slug>`. Reports to <owner> in
<language>. Watchdog: scheduled task `<task id>` (cron `<m>,<m+15>,<m+30>,<m+45> * * * *`).

On every wake:
1. If CronList shows no recurring check-in, recreate it (every
   `check_in_minutes` minutes) with the prompt "<po title> check-in: follow
   <check-in file>", and any one-shot this file lists as pending.
2. After a restart, wake every linked sub-session that still has pending
   work (the skill's "Resuming").
3. Archive the finished runs of `<task id>` (the skill's "Run cleanup").
4. Run the check-in of the `product-owner` skill ("Keep the line moving"),
   then end with its digest.

Live state (update when it changes):
- (open items, holds, waits and queued dispatches that are not on GitHub yet)
```

Live state is a cache for the PO's next turn. GitHub stays the record: the
digest is built from GitHub, never from this file.
