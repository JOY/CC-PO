# Changelog

Notes for each release of the `cc-po` plugin. The README's "Upgrading to x.y.z"
sections say what an existing install changes; this file lists what each
version contains. Versions before 2.12.2 are described in the README.

## 2.12.2

- Gatekeeper and watchdog templates: the read-only restart check has a Linux
  command beside the Windows and macOS ones, and a paragraph on choosing the
  command by the system the desktop app runs on (`uname -s`: `Darwin` is macOS,
  `Linux` is Linux, Windows uses the PowerShell command). A task made on one
  machine is created again on another from the template, never copied.
- macOS restart command: a missing Claude app process now prints an empty
  second line and the command ends with status 0, instead of ending with
  status 1, which a gatekeeper run reads as a failed check and so ignores the
  boot time.
- README: the `PowerShell(...)` merge-permission entries are marked Windows
  only; the restart-check note names all three systems.
- Windows restart command: unchanged. The Antigravity sidecar
  (`agy-gatekeeper.mjs`) still reads its restart times with Windows
  PowerShell only.
- Tests: 45 pass (new: the three commands, platform choice, status 0 form,
  bash syntax check where bash exists).
