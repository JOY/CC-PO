# PO watchdog template

The prompt of the durable watchdog each Product Owner creates for itself
("Durable watchdog" in `SKILL.md`). It is an app scheduled task: it lives
outside the PO's session, so it survives a process exit, an app restart and
a usage-limit stop, which kill in-session crons. Each run starts fresh, looks
at one PO session and wakes it only when it has gone quiet. A run never reads
or changes the repository, GitHub, the cloud or any file.

## Values

Fill every placeholder in this table before creating the task, as plain
text. Leave `<current UTC time>`, `<lastActivityAt>` and `<N>` in the
prompt: each run fills those in itself.

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

Create the task with `create_scheduled_task`:

- `taskId`: `<task id>`;
- `title`: `<po title> watchdog (<owner/repo>)`, which the owner sees in
  the app's task list and which names the task's runs (add a few words in
  `<language>` when that is not English);
- `description`: `Every 30 min: wake the <po title> of <owner/repo> if it is idle over <idle minutes> min or its process stopped`;
- `cronExpression`: `<m>,<m+30> * * * *` (local time), where `<m>` is
  3 * (the line's row number in the Lines table - 1), modulo 27, plus 2
  (row 1: `2,32`; row 2: `5,35`; row 3: `8,38`), so the watchdogs of the
  first nine lines fire at different minutes and none fires on the hour or
  the half hour, when in-session check-ins often run (from row 10 the
  minutes repeat, and the app may delay a recurring run by a few minutes);
- `notifyOnCompletion`: `false`, so the PO is not woken by every run;
- `prompt`: the text between the two lines below, with the values filled
  in.

A run that stops before its last step (a usage limit, or an archive the app
does not approve) stays in the sidebar under the task's title. The PO archives them at
each check-in ("Durable watchdog", Run cleanup in `SKILL.md`), and the
check-in file below lists it as a step.

---

You are the watchdog of the <po title> session for the <owner/repo> repository. Your only job is to wake one Claude Code session if it has gone quiet. Do nothing else: no repository, git, GitHub, cloud or file action, and no message to any other session.

Target session: `<po session id>`, titled "<po title>".

Steps:
1. Call `mcp__ccd_session_mgmt__get_session` with that session id. If the session is archived or not found, write "target archived or missing" and go to step 5.
2. Take the current UTC time and compute how many minutes ago `lastActivityAt` was. Ignore `isRunning`: it is false whenever the session is idle between turns, which is normal. A healthy PO runs a check-in on a schedule, so its `lastActivityAt` is rarely older than its check-in interval plus a few minutes. If `lastActivityAt` is less than <idle minutes> minutes ago, note "PO active (last activity N min ago), no wake" and go to step 5.
3. Otherwise wake it. Call `mcp__ccd_session_mgmt__send_message` with that session id and this message, with the values filled in:
   "Watchdog wake at <current UTC time>: last activity <lastActivityAt>, <N> minutes ago. Your process stopped, a usage limit stopped you or your check-in cron died. Tell <owner> in <language> on the first line that you are back and how long you were away. Recreate your in-session check-in cron if CronList shows none. Then run the check-in in <check-in file> now."
   If that call is refused, call `SendMessage` with `to` set to that session id and the same message. If both fail, write the error in one line; the next run tries again.
4. Write one line: what you saw and whether you sent the wake.
5. Archive this run's own session, so watchdog runs do not pile up in the sidebar. Call `mcp__ccd_session_mgmt__archive_session` with session_id "self" and reason "watchdog run finished". This ends the run. If the app does not archive it, stop here: the PO archives finished runs at its check-ins.

If a tool call fails (for example a usage limit), write the error in one line and still try step 5. The next scheduled run will try again.

---

## Check-in file

The watchdog's wake message points the PO at its check-in file, so the file,
not the task prompt, carries what a check-in does. The PO creates it next to
the task and keeps it current; it is machine state, never committed. It
starts like this:

```markdown
# <po title> check-in (<owner/repo>)

Session: `<po session id>`. Line `line:<slug>`. Reports to <owner> in
<language>. Watchdog: scheduled task `<task id>` (cron `<m>,<m+30> * * * *`).

On every wake:
1. If CronList shows no recurring check-in, recreate it (every
   `check_in_minutes` minutes) with the prompt "<po title> check-in: follow
   <check-in file>".
2. Archive the finished runs of `<task id>` (the skill's "Run cleanup").
3. Run the check-in of the `product-owner` skill ("Keep the line moving"),
   then end with its digest.

Live state (update when it changes):
- (open items, holds, waits and queued dispatches that are not on GitHub yet)
```

Live state is a cache for the PO's next turn. GitHub stays the record: the
digest is built from GitHub, never from this file.
