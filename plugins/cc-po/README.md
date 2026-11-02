# CC Product Owner (cc-po)

A Product Owner workflow for Claude Code. One Product Owner session per
product line triages a GitHub Project, fills issue fields, keeps optional
sprints, starts sub-sessions with full briefs, accepts
their pull requests before merge, and brings the owner only product, risk
and Production decisions.

Skills:

- `product-owner`: runs a PO session.
- `task-claim`: one writing session per GitHub issue, through `claim:`,
  checkpoint, `handoff:`, `release:` and `done:` comments.
- `setup`: writes the repository's `docs/product-owner-config.md`.

The skills use the GitHub CLI (`gh`). The plugin also lists an optional
GitHub connector (GitHub's remote MCP server); each user connects it with
their own GitHub account, and nothing depends on it.

Install in Claude Code:

```
/plugin marketplace add JOY/CC-PO
/plugin install cc-po@cc-po
```

Install in Antigravity: copy `plugins/cc-po` to
`~/.gemini/config/plugins/cc-po` (or `.agents/plugins/cc-po`; use a real
directory rather than a Windows junction) and restart Antigravity.
`plugin.json` and `rules/AGENTS.md` adapt the skills' Claude desktop tool
names to Antigravity without changing the skills.

Full documentation: https://github.com/JOY/CC-PO
