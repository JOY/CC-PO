# Product Owner workflow for Claude Code

CC-PO lets one person run a repository through Claude Code sessions without
reading code. Each product line gets one **Product Owner (PO)** session. The
PO keeps the line's backlog on a GitHub Project, starts a few sub-sessions
to do the work, answers their questions, accepts their pull requests, and
brings the owner only the decisions that need a person: product choices,
risk and Production.

The plugin has three skills:

| Skill | Command | What it does |
| --- | --- | --- |
| `product-owner` | `/cc-po:product-owner` | Runs a PO session: triage, issue fields, sub-session briefs, the acceptance gate before merge, Production steps the owner approved, reporting. |
| `task-claim` | `/cc-po:task-claim` | One writing session per GitHub issue: `claim:`, checkpoint, `handoff:`, `release:` and `done:` comments, with the earliest claim winning. |
| `setup` | `/cc-po:setup` | Asks a few questions, reads your GitHub Project and writes `docs/product-owner-config.md`. |

The skills are the same text in every repository. Everything your
repository decides (owner, report language, board and field ids, lines,
branches, required checks, review tools, session limits) lives in one
committed file, `docs/product-owner-config.md`.

## Requirements

- **Claude desktop app, Code tab, for the full workflow.** A PO starts
  sub-sessions and messages them (`start_session`, `SendMessage`,
  `list_sessions`), which only the desktop app provides. A terminal-only
  Claude Code session can use `task-claim` and the review flow, but cannot
  run a PO that starts or coordinates sub-sessions.
- **GitHub CLI** (`gh`) signed in with the `project` and `read:org` scopes
  (`gh auth login --scopes project,read:org`), and `workflow` if sessions
  dispatch workflows.
- **A GitHub Project** for the backlog, with Status and Priority fields and,
  ideally, a single-select Product Line field with one option per line.
  An iteration field is optional: with one, the POs keep sprints.
- **Node.js** (optional) to run the config checker.
- **GitHub connector** (optional). The plugin lists GitHub's remote MCP
  server (`https://api.githubcopilot.com/mcp/`) under the name `github`. On
  claude.ai and Cowork it appears on the plugin's Connectors tab, where each
  user connects their own account; Claude Code loads it with the plugin.
  The skills use `gh` and never depend on it. If you also have the official
  `github` plugin, both declare a server named `github`, so you may see it
  twice; keep either one.
- Optional reviewers. The skills run whatever your config lists in
  `local_reviews`; without any, sessions use a fresh-context subagent
  review. The [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc)
  and its CLI work well as one of them (agents run `codex review --base origin/<branch>`).

## Install

In Claude Code, inside your repository:

```
/plugin marketplace add JOY/CC-PO
/plugin install cc-po@cc-po
```

To enable it for everyone who works in the repository, install it at
project scope from a terminal and commit `.claude/settings.json`:

```bash
claude plugin marketplace add JOY/CC-PO --scope project
claude plugin install cc-po@cc-po --scope project
```

Each further machine runs the same two commands once; Claude Code does not
install a plugin from another repository by itself.

## Set up a repository

```
/cc-po:setup
```

Setup reads the repository and your GitHub Project, asks who the owner is,
which board and lines to use and whether a separate branch ships to
Production, writes `docs/product-owner-config.md` and checks it. Commit the
file. You can pass answers up front, for example
`/cc-po:setup owner_name=Sam project_owner=acme project_number=3`.

To check a config by hand:

```bash
node "<plugin directory>/skills/product-owner/check-config.mjs" docs/product-owner-config.md
```

The keys and their defaults are in
[`config-schema.md`](plugins/cc-po/skills/product-owner/config-schema.md);
[`sample-config.md`](plugins/cc-po/skills/setup/sample-config.md) is a
filled example.

## Start a Product Owner

Open a Claude desktop session in the repository and say:

> You are the Product Owner of line Storefront. Read the product-owner
> skill and the agent instructions, read the board, then hand out work to
> sub-sessions.

The PO renames itself `<Line> Product Owner`, reads the board for its line,
checks who holds what, fills missing issue fields, and starts up to three
sub-sessions (five at most, or what your config sets), each with a full
brief. Sub-sessions claim their issue, open a PR, pass the review gate and
send the PO a short acceptance summary; the PO answers "merge" or names what
is missing.

## Merge permission

In auto mode, a sub-session's safety check can refuse a merge that the PO,
not the user, asked for ("Merge Without Review"). The owner can approve, once
per machine, an allow rule in `~/.claude/settings.json` that lets a session
merge only the head the PO accepted, with the integration branch's merge
method. For squash merges:

```json
{
  "permissions": {
    "allow": [
      "Bash(gh pr merge * --squash --match-head-commit *)",
      "PowerShell(gh pr merge * --squash --match-head-commit *)"
    ],
    "ask": [
      "Bash(gh pr merge *--merge*)", "Bash(gh pr merge * -m*)",
      "Bash(gh pr merge *--rebase*)", "Bash(gh pr merge * -r*)",
      "Bash(gh pr merge *--squash=*)", "Bash(gh pr merge *--admin*)",
      "PowerShell(gh pr merge *--merge*)", "PowerShell(gh pr merge * -m*)",
      "PowerShell(gh pr merge *--rebase*)", "PowerShell(gh pr merge * -r*)",
      "PowerShell(gh pr merge *--squash=*)", "PowerShell(gh pr merge *--admin*)"
    ]
  }
}
```

`--match-head-commit` limits a merge to the head the PO accepted. The `ask`
entries win over `allow`, so a merge-commit merge (often the Production
path), a rebase, or `--admin` still asks the person. GitHub still enforces
your required checks and review rules; the rule only lets the command run.
Adjust it if your integration branch uses another merge method.

## How the pieces fit

- **Claims.** Every task that produces a result is a claimed GitHub issue.
  The issue and its comments are the record; the Project is the board view.
  A repository can enforce claims with a required check of its own
  (`claim_gate`), but the plugin does not need one.
- **Production.** Sub-sessions never run Production, secret or credential
  steps. They merge a reviewed runbook; the PO pins that commit, checks it in
  a fresh clone, shows the owner the concrete steps, and runs exactly those
  after the owner approves them in the PO chat. Session safety checks accept
  only the user's own words in a session, so an approval relayed by the PO
  would not unlock a sub-session.
- **Sprints (optional).** When the config names an iteration field
  (`sprint_field`), the PO sets each handed-out issue's sprint, moves the
  line's unfinished items into the new sprint at its first check-in of each
  sprint with a one-line done/carried count for the owner, and adds
  iterations before they run out (one PO, the sprint keeper, adds them).
- **Reports and decisions.** Every PO check-in ends with a digest built from
  GitHub only (done, in progress, blocked, up next, stale). Product
  decisions the owner makes can be kept in a decision log the config names,
  cited by id in briefs; Production approvals still happen in the PO chat.
- **Your rules win.** The repository's agent instructions (`AGENTS.md` or
  `CLAUDE.md`) and the documents your config names override the skills.

## Updating

Claude Code caches a plugin by version. To take a new release:

```bash
claude plugin marketplace update cc-po
claude plugin update cc-po@cc-po --scope project
```

New sessions load the new version. A major version means your config needs a
change; the release notes say which keys.

## License

[MIT](LICENSE)
