---
name: setup
description: "Write this repository's Product Owner config (docs/product-owner-config.md) for the product-owner and task-claim skills: read the GitHub Project, ask the user a few questions, write the file and check it. Use once per repository before the first Product Owner session, or when the config is missing or invalid."
argument-hint: "[key=value ...]"
user-invocable: true
---

# Setup

Write `docs/product-owner-config.md`, the one file the `product-owner` and
`task-claim` skills read in this repository. The format, every key and its
default are in `../product-owner/config-schema.md` (relative to this skill's
directory); `sample-config.md` next to this file is a filled example. Read
both before writing.

Ask few questions: read what the repository and GitHub can tell you, and ask
only what they cannot. The person running setup decides the answers; you do
the reading and writing.

## Rules

- Values given as `key=value` pairs in the arguments are used as given and
  never asked again (for example
  `owner_name=Sam report_language=English project_owner=acme project_number=3 lines="Storefront,Payments"`).
  When a value read from GitHub disagrees with a given one, keep the given
  one and tell the user about the difference.
- Any GitHub read can fail (no remote, no access, a board that does not
  resolve). Then use the given values, ask the user for the missing
  required ones, and leave everything else to its default. Say in the final
  report which reads failed and what to fill in later; do not stop.
- When nobody can answer (a non-interactive run), use the given values and
  the defaults, skip every write to GitHub, and report what was skipped. If
  a required key (`owner_name`, `project_owner`, `project_number`,
  `project_id`) is still missing, or a config already exists, write nothing
  and report what is missing or the existing config's check result.
- Never overwrite an existing config without the user's OK. If
  `docs/product-owner-config.md` exists, check it first (step 6). When it is
  valid, ask whether to update it or stop; when it is invalid, show the
  errors and ask whether to fix it in place, keeping its values, or to
  write it again.
- Never write a secret, token or key into the config. It is committed and
  every session reads it.
- Write nothing to GitHub (labels, fields, projects) unless the user agrees
  to that specific change. Reading is fine.
- Do not commit. Show the result and suggest committing it.

## Steps

### 1. Read the repository

Run from the repository root (`git rev-parse --show-toplevel`):

```bash
gh repo view --json nameWithOwner,defaultBranchRef
gh auth status
```

Without a remote, the repository name for the title is the one the user
gave, else the folder name, and the default branch is
`git symbolic-ref --short refs/remotes/origin/HEAD` when that exists, else
the current branch (`git branch --show-current`); say which you used.

Note which of these exist, for the Rule documents keys: `AGENTS.md`,
`CLAUDE.md`, `CONTRIBUTING.md`, `ROADMAP.md`, and any document about agent
work tracking or reviews. Look at `.github/workflows/` for deploy triggers,
to describe `production_effect`; write `unknown` when you cannot tell. When
`gh` is not signed in, or lacks the `project` and `read:org` scopes
(`gh auth refresh --scopes project,read:org` adds them), say so and ask the
user for the values instead of reading them.

### 2. Ask

Ask in one round (AskUserQuestion where available, at most four questions),
skipping anything the arguments or step 1 settled:

1. **Owner**: who approves Production and product decisions (`owner_name`),
   and the language for everything they read (`report_language`, default
   English).
2. **Board**: which GitHub Project the lines live on. List the candidates
   with `gh project list --owner "<owner>" --format json`. If there is none,
   tell the user to create one (with Status, Priority and a single-select
   Product Line field) and run setup again, or continue with the ids they
   type.
3. **Lines**: the product lines, one Product Owner session each. Offer the
   options of the board's Product Line field when it has one. A shared line
   for CI, release and infrastructure (often "Platform") is optional; add
   it only when the user wants it.
4. **Production**: whether a separate branch ships to Production
   (`production_branch`), or the integration branch ships.

Everything else takes its schema default unless the user names it. Mention
the defaults you used in the summary so the user can change them.

### 3. Read the board

```bash
gh project view "<number>" --owner "<owner>" --format json --jq .id
gh project field-list "<number>" --owner "<owner>" --format json
```

From the field list take the Product Line field (`product_line_field`) and
its option ids (the Lines table), and the Priority field
(`priority_field`). A field the board does not have, or a board that cannot
be read, leaves the key out (its default is `none`), and each line then has
`none` as its option id. Where the owner is an organization, also read its Issue Types
and issue fields (skip them when the query fails or returns nothing):

```bash
gh api graphql -f query='{organization(login:"<owner>"){issueTypes(first:10){nodes{id name}}}}'
gh api graphql -H "GraphQL-Features: issue_fields" -f query='{organization(login:"<owner>"){issueFields(first:20){nodes{... on IssueFieldSingleSelect{id name options{id name}}}}}}'
```

### 4. Labels

Each line gets a label `line:<slug>` (lower case, hyphens). List the
repository's labels with `gh label list --limit 500`. If some are missing,
ask the user whether to create them, and only then run
`gh label create "line:<slug>" --description "<line>"`. When the list
cannot be read, skip this step and name the labels to create in the report.

### 5. Write the config

Write `docs/product-owner-config.md` in the format of the schema, in the
sections the sample uses, with:

- the title `# Product Owner config: <owner/repo>`, or the repository name
  alone when no remote gives the owner;
- every value read or answered that differs from its default, and `none`
  where the user chose to leave a key empty;
- always `report_language`, `integration_branch`, `production_branch` and
  `production_effect`, even at their defaults, so a reader sees them;
- a Rule documents key for each such file that exists, even when it
  matches the default, and no key for a file that does not; and
  `agent_instructions: none` when neither `AGENTS.md` nor `CLAUDE.md`
  exists;
- every other key left out, so the schema's default applies;
- the Lines table with one row per line: name, label, option id or `none`,
  and the PO session title `<Line> Product Owner`;
- a short prose note naming any read that failed and what to fill in later;
- an "Owner instructions" section only when the user gave standing
  instructions; quote them word for word with the date.

### 6. Check

```bash
node "<this skill's directory>/../product-owner/check-config.mjs" docs/product-owner-config.md
```

Fix every error and run it again until it prints `valid`. Without Node,
check the file against the schema yourself: the required keys
(`owner_name`, `project_owner`, `project_number`, `project_id`), a
`project_id` starting `PVT_`, and at least one Lines row whose label starts
with `line:`.

### 7. Report

Tell the user, in `report_language`:

- the file written and its check result;
- the defaults that apply and how to change them (edit the file, run the
  check again);
- what is left: commit the file; to start a Product Owner, open a Claude
  desktop session in this repository and say "You are the Product Owner of
  line <X>", which loads the `product-owner` skill;
- that sub-sessions need the Claude desktop app's Code tab, and that a
  terminal-only Claude Code session can use `task-claim` and the review
  flow but cannot start or message sub-sessions.
