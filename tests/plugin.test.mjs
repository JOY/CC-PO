// Run with: node --test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkConfig, findRoot, insideRoot, outsidePath, parseConfig, parseScopes, scopePaths } from '../plugins/cc-po/skills/product-owner/check-config.mjs';
import {
  evaluateGatekeeper,
  expandHome,
  extractActiveCheckInIds,
  inspectConversation,
  pickAppStartTime,
  resolvePoConversationId,
  runGatekeeper,
} from '../plugins/cc-po/skills/product-owner/agy-gatekeeper.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('the marketplace lists the plugin once, and the version lives in plugin.json', () => {
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
  const manifest = JSON.parse(read('plugins/cc-po/.claude-plugin/plugin.json'));
  const entries = marketplace.plugins.filter((p) => p.name === manifest.name);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, './plugins/cc-po');
  assert.equal('version' in entries[0], false);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('every skill has a SKILL.md whose name matches its folder', () => {
  for (const skill of ['product-owner', 'task-claim', 'setup']) {
    const text = read(`plugins/cc-po/skills/${skill}/SKILL.md`);
    assert.match(text, new RegExp(`^---\\nname: ${skill}\\n`));
  }
});

test('the sample config is valid', () => {
  assert.deepEqual(checkConfig(read('plugins/cc-po/skills/setup/sample-config.md')), { errors: [], warnings: [] });
});

const minimal = `# Product Owner config: example/repo

- owner_name: Sam
- project_owner: example
- project_number: 1
- project_id: PVT_example

| Line | Label | Product Line option id | PO session |
| --- | --- | --- | --- |
| Core | \`line:core\` | none | \`Core Product Owner\` |
`;

test('a minimal config is valid and absent keys keep their defaults', () => {
  assert.deepEqual(checkConfig(minimal), { errors: [], warnings: [] });
  const { values, lines } = parseConfig(minimal);
  assert.equal(values.report_language, undefined);
  assert.deepEqual(lines, [{ line: 'Core', label: 'line:core', option: 'none', po: 'Core Product Owner' }]);
});

test('config errors are reported', () => {
  const broken = minimal
    .replace('- owner_name: Sam\n', '')
    .replace('PVT_example', '<project id>')
    .replace('- project_number: 1', '- project_number: one\n- sub_sessions_normal: 6\n- sub_sessions_max: 5\n- draft_pr_first: maybe\n- check_in_minutes: 30\n- check_in_minutes: 20\n- mystery: x')
    .replace('`line:core` | none', '`core` | `abc123`')
    + `\n- agent_account: ghp_${'a'.repeat(36)}\n`;
  const { errors, warnings } = checkConfig(broken);
  const text = errors.join('\n');
  assert.match(text, /owner_name is required/);
  assert.match(text, /project_id still holds a placeholder/);
  assert.match(text, /project_number must be a positive integer/);
  assert.match(text, /sub_sessions_normal \(6\) must not exceed sub_sessions_max \(5\)/);
  assert.match(text, /draft_pr_first must be yes or no/);
  assert.match(text, /check_in_minutes appears more than once/);
  assert.match(text, /label must look like line:<slug>/);
  assert.match(text, /has an option id but product_line_field is none/);
  assert.match(text, /shaped like a credential/);
  assert.match(warnings.join('\n'), /mystery is not a schema key/);
});

test('no message repeats a credential pasted into the config', () => {
  const token = `ghp_${'b'.repeat(36)}`;
  const leaked = minimal.replace('`line:core`', `\`${token}\``).replace('- owner_name: Sam', `- owner_name: TODO ${token}`);
  const { errors, warnings } = checkConfig(leaked);
  const text = [...errors, ...warnings].join('\n');
  assert.match(text, /Lines row 1: label must look like line:<slug>/);
  assert.match(text, /shaped like a credential/);
  assert.doesNotMatch(text, /ghp_b/);
  // A secret no pattern knows (40 characters, like a cloud secret key) is
  // not repeated either, because messages quote no values.
  const unknown = 'Q7vX2pL9mK4tR8wZ1nB6cY3hJ5sD0fG2aE7uI9oP';
  const other = checkConfig(minimal.replace('`line:core`', unknown)).errors.join('\n');
  assert.match(other, /Lines row 1: label must look like line:<slug>/);
  assert.doesNotMatch(other, /Q7vX2/);
});

test('realistic values are not mistaken for errors, and more credential shapes are caught', () => {
  const fine = minimal
    .replace('- owner_name: Sam', '- owner_name: Sam Lee <1+sam@users.noreply.github.com>')
    .replace('- project_number: 1', '- project_number: 1\n- sub_sessions_max: 5 (owner cap)\n- promotion_notes: see the TODO list in the runbook');
  assert.deepEqual(checkConfig(fine).errors, []);
  const capped = minimal.replace('- project_number: 1', '- project_number: 1\n- sub_sessions_max: 2');
  assert.match(checkConfig(capped).errors.join('\n'), /sub_sessions_normal \(3, the default\) must not exceed sub_sessions_max \(2\)/);
  for (const secret of [`sk_live_${'d'.repeat(24)}`, `AIza${'e'.repeat(35)}`, `eyJ${'f'.repeat(10)}.eyJ${'g'.repeat(10)}.${'h'.repeat(10)}`]) {
    const text = checkConfig(`${minimal}\n- agent_account: ${secret}\n`).errors.join('\n');
    assert.match(text, /shaped like a credential/);
    assert.doesNotMatch(text, new RegExp(secret.slice(0, 12)));
  }
});

test('a private key pasted over continuation lines is redacted whole', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(2);
  const pem = `- owner_name: TODO\n  -----BEGIN PRIVATE KEY-----\n  ${body}\n  -----END PRIVATE KEY-----`;
  const { errors, warnings } = checkConfig(minimal.replace('- owner_name: Sam', pem));
  const text = [...errors, ...warnings].join('\n');
  assert.match(text, /owner_name still holds a placeholder/);
  assert.match(text, /shaped like a credential/);
  assert.doesNotMatch(text, /MIIEvQ|END PRIVATE KEY/);
});

test('a Project id may contain a hyphen', () => {
  assert.deepEqual(checkConfig(minimal.replace('PVT_example', 'PVT_kwDNJr_OAJoN-Q')).errors, []);
});

test('a table after a blank line is not part of the Lines table', () => {
  const text = `${minimal}\n| Key | Default |\n| --- | --- |\n| a | b |\n`;
  assert.deepEqual(checkConfig(text).errors, []);
  assert.equal(parseConfig(text).lines.length, 1);
});

test('a required key cannot be none', () => {
  const text = minimal.replace('- owner_name: Sam', '- owner_name: none').replace('- project_owner: example', '- project_owner: none');
  const errors = checkConfig(text).errors.join('\n');
  assert.match(errors, /owner_name is required and cannot be none/);
  assert.match(errors, /project_owner is required and cannot be none/);
});

test('a Lines row needs a PO session', () => {
  const text = minimal.replace('| `Core Product Owner` |', '| |');
  assert.match(checkConfig(text).errors.join('\n'), /Lines row 1 has no PO session/);
});

test('logins, field ids, priority options and nested fences are checked', () => {
  const err = (text) => checkConfig(text).errors.join('\n');
  assert.match(err(minimal.replace('project_owner: example', 'project_owner: acme-')), /project_owner must be a GitHub login/);
  assert.match(err(minimal.replace('project_owner: example', 'project_owner: a--b')), /project_owner must be a GitHub login/);
  assert.deepEqual(checkConfig(minimal.replace('project_owner: example', 'project_owner: my-org2')).errors, []);
  const field = (v) => minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n- product_line_field: ${v}`);
  assert.match(err(field('PVT_SFabc')), /product_line_field must start with a board field id/);
  assert.deepEqual(checkConfig(field('PVTSSF_ex-am_ple9 (options in Lines)')).errors, []);
  const prio = (v) => minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n- priority_field: ${v}`);
  assert.match(err(prio('PVTSSF_example')), /priority_field needs an option id for Urgent/);
  assert.match(err(prio('`PVTSSF_x`; Urgent `a1`, High `b2`, Normal `c3`')), /priority_field needs an option id for Low/);
  assert.deepEqual(checkConfig(prio('`PVTSSF_x`; Urgent `a1`, High `b2`, Normal `c3`, Low `d4`')).errors, []);
  const nested = `${minimal}\n~~~markdown\n\`\`\`text\nsnippet\n\`\`\`\n- owner_name: Example\n~~~\n`;
  assert.deepEqual(checkConfig(nested).errors, []);
});

test('a sprint field needs an iteration field id, a name and a length', () => {
  const err = (text) => checkConfig(text).errors.join('\n');
  const sprint = (v) => minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n- sprint_field: ${v}`);
  assert.deepEqual(checkConfig(sprint('`PVTIF_ex-am_ple9`; Sprint, 7 days (starts Monday; #1)')).errors, []);
  assert.deepEqual(checkConfig(sprint('none')).errors, []);
  assert.deepEqual(checkConfig(sprint('PVTIF_x; Iteration, 14 days')).warnings, []);
  assert.match(err(sprint('PVTSSF_x; Sprint, 7 days')), /sprint_field must start with an iteration field id/);
  assert.match(err(sprint('PVTIF_x')), /sprint_field needs the field name and the sprint length/);
  assert.match(err(sprint('PVTIF_x; Sprint')), /sprint_field needs the field name and the sprint length/);
  assert.match(err(sprint('PVTIF_x; Sprint, 0 days')), /sprint_field needs the field name and the sprint length/);
  assert.match(err(sprint('PVTIF_x; , 7 days')), /sprint_field needs the field name and the sprint length/);
});

test('a config with no lines is invalid', () => {
  const { errors } = checkConfig(minimal.slice(0, minimal.indexOf('| Line')));
  assert.match(errors.join('\n'), /Lines table has no rows/);
});

test('sprint review keys are checked', () => {
  const err = (text) => checkConfig(text).errors.join('\n');
  const sprint = '- sprint_field: PVTIF_x; Sprint, 7 days';
  const review = (extra) => minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n${extra}`);
  const on = review(`${sprint}\n- sprint_review: on (owner, #1)\n- line_scopes: \`line:core\`: \`src/core\`, \`cmd/\` (not docs)\n- sprint_review_report: \`docs/reviews/<YYYY-MM-DD>-<line>-<sprint>.html\`; HTML`);
  assert.deepEqual(checkConfig(on), { errors: [], warnings: [] });
  assert.deepEqual(parseScopes('`line:core`: `src/core`; line:web apps/web'), [
    { label: 'line:core', paths: '`src/core`' },
    { label: 'line:web', paths: 'apps/web' },
  ]);
  assert.deepEqual(checkConfig(review('- sprint_review: off')).errors, []);
  assert.match(err(review('- sprint_review: maybe')), /sprint_review must be on or off/);
  assert.match(err(review('- sprint_review: on-hold')), /sprint_review must be on or off/);
  assert.match(err(review('- sprint_review: on')), /sprint_review is on but sprint_field is none/);
  assert.match(err(review(`${sprint}\n- sprint_review: on\n- sprint_review_report: none`)), /sprint_review_report is none/);
  assert.match(err(review('- sprint_review_report: docs/review.md; Markdown')), /needs a path template with <YYYY-MM-DD> and <line>/);
  for (const outside of ['/tmp/<YYYY-MM-DD>-<line>.md', '../out/<YYYY-MM-DD>-<line>.md', 'C:/r/<YYYY-MM-DD>-<line>.md', 'notes <YYYY-MM-DD> <line>']) {
    assert.match(err(review(`- sprint_review_report: ${outside}; Markdown`)), /path must be relative to the repository/);
  }
  assert.match(err(review('- sprint_review_report: docs/<YYYY-MM-DD>-<line>.md')), /needs a format after the path/);
  assert.match(err(review('- sprint_review_report: docs/<YYYY-MM-DD>-<line>.md;  ')), /needs a format after the path/);
  assert.match(err(review('- line_scopes: src/core')), /line_scopes entry 1 must start with a line label/);
  assert.match(err(review('- line_scopes: line:web: apps/web')), /line_scopes entry 1: its label is not in the Lines table/);
  assert.match(err(review('- line_scopes: line:core src; line:core lib')), /line_scopes entry 2: same label as entry 1/);
  for (const outside of ['`~/.ssh`', '`../other-repo`', '/etc', '`C:\\Users\\me`', 'c:/r', '`src`, `$HOME/.aws`', '`%USERPROFILE%`',
    '`src/../../x`', 'src (and `..\\up`)', '`\\\\host\\share`', '<../x>', '{..}', 'path=../x', 'file:///etc/passwd',
    '`src/$HOME`', '`src/%USERPROFILE%`', 'dir=~/x',
    'path=/etc', 'dir=C:\\x', 'root=~/.ssh', 'dir=$HOME/.aws', 'see:/etc', 'note:C:\\Users', '`path=/etc`', 'path=`/etc`',
    'x="/etc"', 'root=(C:\\Users)', 'path:../x', 'key=C:rel', 'path=//host/share', 'path=\\\\host\\share', 'where=file:///etc/passwd',
    // A URL in the middle of a path hides nothing: it is a folder named https: followed by ..
    'a/https://../../../etc', 'docs/ssh://../../../../x', 'src/http://x/../../..', 'key=a/https://../..',
    'a:https://../../../etc', 'url=https://example.com/../../x', 'see:https://example.com/a/../b',
    'src/core ([x](https://example.com/../../etc))', 'src/core ([x](file:///etc/passwd))', 'src/core ([x](a/https://../../etc))']) {
    const text = review(`- line_scopes: \`line:core\`: ${outside}`);
    assert.match(err(text), /line_scopes entry 1: paths must be relative to the repository/, outside);
    assert.doesNotMatch(err(text), /\.ssh|other-repo|etc|Users|aws|USERPROFILE|share/, 'no message repeats a path');
  }
  for (const inside of ['`apps/*`, `.github/workflows/deploy-*.yml`', 'behavior and data of `apps/web` (D-003)', '`tools/a..b`, `docs/x...`', '`apps/web` (pages at https://example.com/docs)',
    '`apps/web/**`, `docs/guides/ui.md`', 'path=apps/web, dir=`docs/guides`', 'ratio=1:2 (see http://localhost:3000/a)',
    'see:https://example.com/a/b', 'url=`https://example.com/x`, (https://example.com/y)',
    // The target of a Markdown link is a URL, not a path.
    'src/core (see [architecture](https://example.com/guide))', '`apps/web` ([guide](https://example.com/a/b), [faq](http://localhost:3000/faq))']) {
    assert.deepEqual(err(review(`- line_scopes: \`line:core\`: ${inside}`)), '', inside);
  }
  // A URL is a note, not a path: only a note's words may hold one, never a path to write.
  assert.equal(outsidePath('url=https://example.com/x;path=/etc', { urls: true }), true);
  assert.equal(outsidePath('url=https://example.com/x', { urls: true }), false);
  assert.equal(outsidePath('https://example.com/x'), true);
  assert.equal(outsidePath('https://example.com/../../x'), true);
  assert.equal(outsidePath('a/https://../../../etc', { urls: true }), true);
  assert.equal(outsidePath('file:///etc/passwd', { urls: true }), true);
  assert.equal(outsidePath('docs/<YYYY-MM-DD>-<line>.md'), false);
  assert.deepEqual(scopePaths('`src/core`, `cmd/` (not docs); "x"'), ['src/core', 'cmd/', 'not', 'docs', 'x']);
  const unscoped = checkConfig(review(`${sprint}\n- sprint_review: on`));
  assert.deepEqual(unscoped.errors, []);
  assert.match(unscoped.warnings.join('\n'), /Lines row 1 has a PO session but no line_scopes entry/);
});

test('watchdog keys are checked', () => {
  const err = (extra, options) => checkConfig(minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n${extra}`), options).errors.join('\n');
  for (const ok of ['- po_watchdog: on', '- po_watchdog: off (owner, 2026-01-15)', '- po_check_in_dir: `~/.claude/po-state`',
    '- po_check_in_dir: ~', '- po_check_in_dir: /home/sam/po', '- po_check_in_dir: C:\\Users\\sam\\po', '- po_check_in_dir: D:/po']) {
    assert.equal(err(ok), '', ok);
  }
  assert.match(err('- po_watchdog: yes'), /po_watchdog must be on or off/);
  assert.match(err('- po_watchdog: on-call'), /po_watchdog must be on or off/);
  for (const inside of ['docs/po-state', '.claude/po-state', '~sam/po', 'C:relative', '$HOME/po', 'none']) {
    assert.match(err(`- po_check_in_dir: ${inside}`), /po_check_in_dir must be an absolute or home/, inside);
  }
  // With the repository root known, an absolute path inside it is refused.
  const root = join(tmpdir(), 'repo');
  for (const inside of [root, join(root, '.claude', 'po-state'), join(root, 'docs', '..', 'state'), join(root, '..state')]) {
    assert.match(err(`- po_check_in_dir: ${inside}`, { root }), /po_check_in_dir is inside the repository/, inside);
  }
  for (const outside of [join(tmpdir(), 'repo-state'), join(tmpdir(), 'po-state'), '~/.claude/po-state']) {
    assert.equal(err(`- po_check_in_dir: ${outside}`, { root }), '', outside);
  }
  assert.equal(insideRoot(root, join(root, '..', 'other')), false);
});

// A path is read by its own system's rules wherever the check runs, and
// never against the working directory: a Windows path checked on
// Linux used to resolve under the checkout and be refused as inside it.
test('po_check_in_dir containment follows the path\'s own system on every host', () => {
  const windowsRoot = 'C:\\Projects\\repo';
  const posixRoot = '/home/sam/repo';
  for (const [root, path, inside] of [
    [windowsRoot, 'C:\\Users\\sam\\po', false],
    [windowsRoot, 'D:\\po', false],
    [windowsRoot, 'C:\\Projects\\repo', true],
    [windowsRoot, 'C:\\Projects\\repo\\.claude\\po-state', true],
    [windowsRoot, 'c:/projects/REPO/state', true],
    [windowsRoot, 'C:\\Projects\\repo-state', false],
    [windowsRoot, 'C:\\Projects\\repo\\..\\other', false],
    [windowsRoot, 'C:\\Projects\\repo\\..state', true],
    [windowsRoot, '\\\\host\\share\\po', false],
    [windowsRoot, '/home/sam/po', false],
    // Without a drive, Windows puts a rooted path on the root's own drive.
    [windowsRoot, '\\Projects\\repo\\po-state', true],
    [windowsRoot, '/Projects/repo/po-state', true],
    [windowsRoot, '\\Projects\\REPO', true],
    [windowsRoot, '\\Projects\\repo-state', false],
    [windowsRoot, '\\Users\\sam\\po', false],
    [windowsRoot, 'Projects\\repo\\po-state', false],
    [windowsRoot, '//host/share/po', false],
    ['\\\\host\\share\\repo', '//host/share/repo/po-state', true],
    ['\\\\host\\share\\repo', '\\repo\\po-state', true],
    ['\\\\host\\share\\repo', '\\\\host\\share\\other', false],
    ['\\\\host\\share\\repo', 'C:\\repo', false],
    // A UNC root written with / is Windows too.
    ['//host/share/repo', '\\\\host\\share\\repo\\po-state', true],
    ['//host/share/repo', '//HOST/share/repo/po-state', true],
    ['//host/share/repo', '\\\\host\\share\\other', false],
    ['//host/share/repo', '\\repo\\po-state', true],
    [posixRoot, 'C:\\Users\\sam\\po', false],
    [posixRoot, '\\home\\sam\\repo\\po-state', false],
    [posixRoot, 'home/sam/repo/po-state', false],
    [posixRoot, 'C:\\Users\\sam\\repo', false],
    [posixRoot, '\\\\host\\share\\po', false],
    [posixRoot, '/home/sam/repo', true],
    [posixRoot, '/home/sam/repo/.claude/po-state', true],
    [posixRoot, '/home/sam/Repo/state', false],
    [posixRoot, '/home/sam/repo/../other', false],
    [posixRoot, '/home/sam/repo-state', false],
  ]) {
    assert.equal(insideRoot(root, path), inside, `${root} ${path}`);
  }
  // Through checkConfig too: a Windows or a POSIX folder outside the repository is fine, wherever the root is.
  const checked = (root, dir) => checkConfig(minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n- po_check_in_dir: ${dir}`), { root }).errors;
  for (const [root, dir] of [[posixRoot, 'C:\\Users\\sam\\po'], [windowsRoot, 'C:\\Users\\sam\\po'], [windowsRoot, '/home/sam/po']]) {
    assert.deepEqual(checked(root, dir), [], `${root} ${dir}`);
  }
  // A Windows path with no drive, or with / in a UNC name, still lands inside the repository.
  for (const [root, dir] of [[windowsRoot, '\\Projects\\repo\\po-state'], ['\\\\host\\share\\repo', '//host/share/repo/po-state'],
    ['//host/share/repo', '\\\\host\\share\\repo\\po-state']]) {
    assert.match(checked(root, dir).join('\n'), /po_check_in_dir is inside the repository/, `${root} ${dir}`);
  }
});

test('the check run from inside a checkout does not read a Windows path under it', () => {
  const top = mkdtempSync(join(tmpdir(), 'po-cwd-'));
  try {
    const checkout = join(top, 'repo');
    mkdirSync(join(checkout, 'docs'), { recursive: true });
    writeFileSync(join(checkout, '.git'), 'gitdir: elsewhere\n');
    const file = join(checkout, 'docs', 'product-owner-config.md');
    writeFileSync(file, minimal.replace('- project_id: PVT_example', '- project_id: PVT_example\n- po_check_in_dir: C:\\Users\\sam\\po'));
    const script = join(root, 'plugins/cc-po/skills/product-owner/check-config.mjs');
    for (const cwd of [checkout, join(checkout, 'docs'), top]) {
      const run = spawnSync(process.execPath, [script, file], { cwd, encoding: 'utf8' });
      assert.equal(run.status, 0, `${cwd}: ${run.stderr}`);
    }
    writeFileSync(file, minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n- po_check_in_dir: ${join(checkout, 'po-state')}`));
    const run = spawnSync(process.execPath, [script, file], { cwd: top, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /po_check_in_dir is inside the repository/);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test('sub-session model and effort keys are optional and checked', () => {
  const check = (extra) => checkConfig(minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n${extra}`));
  const clean = { errors: [], warnings: [] };
  // Absent keys are the defaults, so a config without them reports nothing.
  assert.deepEqual(checkConfig(minimal), clean);
  assert.deepEqual(check('- agent_model: claude-sonnet-5-5\n- agent_effort: xhigh\n- subagent_effort: high'), clean);
  const { values } = parseConfig(minimal.replace('- project_id: PVT_example', '- project_id: PVT_example\n- agent_model: claude-sonnet-5-5\n- subagent_effort: high'));
  assert.equal(values.agent_model, 'claude-sonnet-5-5');
  assert.equal(values.subagent_effort, 'high');
  // A note may follow an effort level, and none leaves the key unset.
  for (const ok of ['- agent_effort: low', '- agent_effort: xhigh (owner, 2026-10-31)', '- agent_effort: `max`', '- subagent_effort: none', '- agent_model: sonnet']) {
    assert.deepEqual(check(ok), clean, ok);
  }
  // Only an effort has a fixed set of values, and start_session fails on any
  // other, so prose or a near miss is an error; a model id is the runtime's to judge.
  for (const bad of ['as the review rules set it', 'very high', 'higher', 'extra-high', 'yes']) {
    for (const key of ['agent_effort', 'subagent_effort']) {
      const { errors, warnings } = check(`- ${key}: ${bad}`);
      assert.match(errors.join('\n'), new RegExp(`${key} must start with low, medium, high, xhigh or max`), `${key}: ${bad}`);
      assert.deepEqual(warnings, [], `${key}: ${bad}`);
    }
  }
  assert.match(check('- agent_model:').errors.join('\n'), /agent_model has no value/);
});

test('a prose effort makes the checker exit non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-effort-'));
  try {
    const file = join(dir, 'product-owner-config.md');
    const checker = join(root, 'plugins/cc-po/skills/product-owner/check-config.mjs');
    writeFileSync(file, minimal.replace('- project_id: PVT_example', '- project_id: PVT_example\n- agent_effort: as the review rules set it'));
    const run = spawnSync(process.execPath, [checker, file], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /agent_effort must start with low, medium, high, xhigh or max/);
    writeFileSync(file, minimal.replace('- project_id: PVT_example', '- project_id: PVT_example\n- agent_effort: xhigh (owner, 2026-10-31)'));
    assert.equal(spawnSync(process.execPath, [checker, file], { encoding: 'utf8' }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The watchdog only wakes its PO: its prompt reads one session, messages it
// and archives its own run.
test('the watchdog template is wake-only', () => {
  const text = read('plugins/cc-po/skills/product-owner/watchdog-template.md').replace(/\r\n/g, '\n');
  const prompt = text.split('\n---\n')[1];
  assert.ok(prompt, 'the prompt sits between two --- lines');
  assert.deepEqual([...new Set(prompt.match(/mcp__[a-z_]+__[a-z_]+/g))].sort(), [
    'mcp__ccd_session_mgmt__archive_session',
    'mcp__ccd_session_mgmt__get_session',
    'mcp__ccd_session_mgmt__send_message',
  ]);
  for (const placeholder of ['<po session id>', '<po title>', '<owner/repo>', '<owner>', '<language>', '<idle minutes>', '<check-in file>', '<restart check>']) {
    assert.ok(prompt.includes(placeholder), placeholder);
  }
});

// A restart kills the PO while its last activity still looks recent, so the
// watchdog wakes it on a boot or app start later than that activity, every
// 15 minutes, and its wake asks for the one-shots and sub-sessions a restart
// also stopped.
test('the watchdog wakes its PO right after a restart', () => {
  const text = read('plugins/cc-po/skills/product-owner/watchdog-template.md').replace(/\r\n/g, '\n');
  const prompt = text.split('\n---\n')[1];
  const flat = prompt.replace(/\n\s*/g, ' ');
  assert.match(flat, /The only local command you may run is the read-only restart check in step 2\./);
  assert.match(flat, /If either time is LATER than the session's `lastActivityAt`, a restart killed the PO's process: wake it now \(step 4\) with reason "restart"/);
  assert.match(flat, /\(reason: <reason>\)/);
  assert.match(flat, /machine boot <boot time>, app start <app start time>/);
  assert.match(flat, /and any one-shot you had pending/);
  assert.match(flat, /Wake every linked sub-session \(list_sessions linked\) that still has pending work/);
  // One read-only command per system the desktop app runs on.
  assert.match(text, /- Windows \(PowerShell\): `\(Get-CimInstance Win32_OperatingSystem\)\.LastBootUpTime/);
  assert.match(text, /- macOS \(zsh or bash\): `date -u -r "\$\(sysctl -n kern\.boottime/);
  assert.match(text, /`cronExpression`: `<m>,<m\+15>,<m\+30>,<m\+45> \* \* \* \*`/);
  assert.match(text, /`description`: `Every 15 min: wake the <po title> of <owner\/repo> after a machine or app restart, or if it is idle over <idle minutes> min`/);
  const skill = read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n').replace(/\n\s*/g, ' ');
  assert.match(skill, /Every 15 minutes it looks at the PO session/);
  assert.match(skill, /A prompt without the template's restart check \(one made from an older template\) is brought up to the current one/);
  assert.doesNotMatch(skill, /every 30 minutes/i);
});

// An upstream and its fork (or two repositories with one name) on one machine
// must not derive the same task id or check-in file, while an id made
// before the owner joined it is still found and kept.
test('the watchdog task id and check-in file name carry the repository owner', () => {
  const dir = join(root, 'plugins/cc-po/skills/product-owner');
  const template = readFileSync(join(dir, 'watchdog-template.md'), 'utf8').replace(/\r\n/g, '\n');
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const row = template.split('\n').find((line) => line.startsWith('| `<task id>`'));
  assert.ok(row, 'the Values table has a <task id> row');
  assert.match(row, /`<repo owner>-<repo>-<slug>-po-watchdog`/);
  assert.match(row, /no hyphen at either end of `<repo owner>`, `<repo>` or `<slug>`/);
  assert.match(row, /`<repo owner>` and `<repo>` are the two halves of `<owner\/repo>`/);
  assert.match(template, /`<repo owner>-<repo>-<slug>-po-checkin\.md`/);
  assert.match(skill, /`<repo owner>-<repo>-<slug>-po-checkin\.md`/);
  // No id or file name is built from the repository name alone.
  for (const [name, text] of [['watchdog-template.md', template], ['SKILL.md', skill]]) {
    assert.doesNotMatch(text.replace(/<repo owner>-<repo>-<slug>/g, ''), /<repo>-<slug>/, name);
  }
  // The lookup of existing watchdogs by suffix and prompt stays.
  assert.match(skill.replace(/\n\s*/g, ' '), /whose id ends in `-po-watchdog` and whose prompt \(read from its `path`\) names the line's PO title and this repository's `<owner\/repo>`/);
  assert.match(skill.replace(/\n\s*/g, ' '), /made before the repository owner was part of the template's id/);
});

// The checker finds the repository root without running git, whose lookup
// could pick a git program planted in the checkout.
test('the repository root is found by its .git entry', () => {
  const top = mkdtempSync(join(tmpdir(), 'po-root-'));
  try {
    mkdirSync(join(top, 'repo', 'docs'), { recursive: true });
    writeFileSync(join(top, 'repo', '.git'), 'gitdir: elsewhere\n');
    assert.equal(findRoot(join(top, 'repo', 'docs')), join(top, 'repo'));
    assert.equal(findRoot(join(top, 'repo')), join(top, 'repo'));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
  assert.doesNotMatch(read('plugins/cc-po/skills/product-owner/check-config.mjs'), /child_process/);
});

// A Codex review reads its effort from ~/.codex/config.toml unless the command
// line sets it, so the skill and the sample config both carry the per-run
// override, and a PO may re-enable its approved watchdog in any turn.
test('a Codex review is run at subagent_effort and an approved watchdog is re-enabled in any turn', () => {
  const skill = read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n').replace(/\n\s*/g, ' ');
  assert.match(skill, /codex review -c model_reasoning_effort=<level> --base <branch>/);
  assert.match(skill, /Re-enabling the PO's own existing watchdog is not a new approval: where the approval above is on record, the PO does it in any turn/);
  assert.match(skill, /Creating or retargeting a watchdog, enabling one the owner has not approved/);
  const { values } = parseConfig(read('plugins/cc-po/skills/setup/sample-config.md'));
  assert.match(values.local_reviews, /codex review -c model_reasoning_effort=<subagent_effort> --base origin\/main/);
});

// A deliberate per-task effort exception must not be reset to agent_effort by the
// reconciliation of a running sub-session, including after a PO handoff.
test('a recorded per-task effort exception survives effort reconciliation', () => {
  const skill = read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n').replace(/\n\s*/g, ' ');
  assert.match(skill, /the brief carries an `Effort exception:` line \(level, reason\)/);
  assert.match(skill, /reads the exception first and never moves a session to `agent_effort` while one stands/);
  assert.match(read('plugins/cc-po/skills/product-owner/config-schema.md'), /`Effort exception: <level>, <reason>`/);
});

// An exception has an explicit end that overrides the brief's static line, the
// PO handoff lifecycle is documented behind po_handoff, and the checker reads
// the level named after "Exception:".
test('an effort exception ends explicitly, the handoff lifecycle is documented and the exception level is checked', () => {
  const skill = read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n').replace(/\n\s*/g, ' ');
  assert.match(skill, /effort-exception: ended session=<id> reason=<why>/);
  assert.match(skill, /the latest authoritative record wins over the others/);
  assert.match(skill, /## PO handoff A PO hands its line to a fresh PO session when its own context passes `po_handoff_tokens`/);
  assert.match(read('plugins/cc-po/skills/product-owner/config-schema.md'), /\| `po_handoff` \| `off` \|/);
  const extra = (lines) => minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n${lines}`);
  assert.deepEqual(checkConfig(extra('- po_handoff: on\n- agent_effort: high. Exception: xhigh only for hard security work.')).errors, []);
  assert.match(checkConfig(extra('- agent_effort: high. Exception: very high')).errors.join('\n'), /the word after "Exception:" must be low, medium, high, xhigh or max/);
  assert.match(checkConfig(extra('- po_handoff: maybe')).errors.join('\n'), /po_handoff must be on or off/);
});

test('the Antigravity manifest matches the Claude Code manifest and uses only supported fields', () => {
  const claude = JSON.parse(read('plugins/cc-po/.claude-plugin/plugin.json'));
  const agy = JSON.parse(read('plugins/cc-po/plugin.json'));
  const allowed = new Set([
    'name',
    'displayName',
    'description',
    'version',
    'author',
    'homepage',
    'repository',
    'suggestedPrompts',
    'logo',
    'disabled',
  ]);
  for (const key of Object.keys(agy)) {
    assert.ok(allowed.has(key), `unsupported Antigravity plugin.json field: ${key}`);
  }
  for (const shared of ['name', 'displayName', 'version', 'author', 'homepage', 'repository']) {
    assert.deepEqual(agy[shared], claude[shared], `mismatch on ${shared}`);
  }
  assert.ok(Array.isArray(agy.suggestedPrompts) && agy.suggestedPrompts.length === 3);
  assert.ok(agy.suggestedPrompts.every((p) => typeof p === 'string' && p.trim().length > 0));
  // Omit mcp_config.json so Antigravity does not mount an unauthenticated Copilot MCP server,
  // while keeping .mcp.json intact for Claude Code.
  assert.equal(existsSync(join(root, 'plugins/cc-po/mcp_config.json')), false);
  assert.equal(existsSync(join(root, 'plugins/cc-po/.mcp.json')), true);
});

test('the Antigravity host rules map Claude desktop tools without altering the skills', () => {
  const rules = read('plugins/cc-po/rules/AGENTS.md').replace(/\r\n/g, '\n');
  for (const term of [
    'start_session',
    'invoke_subagent',
    'TypeName: "self"',
    'manage_subagents',
    'agentapi new-conversation',
    'SendMessage',
    'send_message',
    'list_sessions',
    'AskUserQuestion',
    'ask_question',
    'create_scheduled_task',
    'po_wake: gatekeeper',
    'agy-gatekeeper.mjs',
  ]) {
    assert.ok(rules.includes(term), `rules/AGENTS.md is missing ${term}`);
  }
  assert.doesNotMatch(rules, /BypassSandbox/);
});

// The gatekeeper is one cheap, wake-only task per repository: it reads the
// session list, one restart check and one gh query, writes no file,
// messages POs and archives its own run.
const gatekeeper = () => read('plugins/cc-po/skills/product-owner/gatekeeper-template.md').replace(/\r\n/g, '\n');
const gatekeeperPrompt = () => gatekeeper().split('\n---\n')[1];
const flatten = (text) => text.replace(/\n\s*/g, ' ');

test('the gatekeeper template is wake-only', () => {
  const prompt = gatekeeperPrompt();
  assert.ok(prompt, 'the prompt sits between two --- lines');
  assert.deepEqual([...new Set(prompt.match(/mcp__[a-z_]+__[a-z_]+/g))].sort(), [
    'mcp__ccd_session_mgmt__archive_session',
    'mcp__ccd_session_mgmt__get_session',
    'mcp__ccd_session_mgmt__get_usage',
    'mcp__ccd_session_mgmt__list_sessions',
    'mcp__ccd_session_mgmt__send_message',
  ]);
  const flat = flatten(prompt);
  assert.match(flat, /no repository, git, cloud or file action/);
  assert.match(flat, /You keep no state and write no file\./);
  assert.match(flat, /The only commands you may run are the read-only restart check in step 3 and the read-only gh query in step 4\./);
  assert.match(flat, /Never read the repository or any config\./);
  assert.match(flat, /no message to any session but the POs listed below/);
  // The one gh command is a read-only pull request list; no git, no write.
  assert.deepEqual([...prompt.matchAll(/\bgh ((?:pr|api|issue|repo|run|workflow|project|auth|release|label|search|gist|secret|variable|cache|ruleset) [a-z]+)/g)].map((m) => m[1]), ['pr list']);
  assert.match(flat, /gh pr list --repo <owner\/repo> --state open --limit 200 --json number,labels,isDraft,mergeStateStatus,updatedAt/);
  assert.doesNotMatch(prompt, /\bgit [a-z]|\bcurl\b|\bgh api\b|create_scheduled_task|update_scheduled_task/);
  for (const placeholder of ['<po rows>', '<owner/repo>', '<owner>', '<language>', '<active minutes>', '<quiet minutes>', '<compact tokens>', '<handoff tokens>', '<restart check>']) {
    assert.ok(prompt.includes(placeholder), placeholder);
  }
  // It archives its own run at the end, like the watchdog.
  assert.match(flat, /`mcp__ccd_session_mgmt__archive_session` with session_id "self" and reason "gatekeeper run finished"/);
  assert.match(gatekeeper(), /`notifyOnCompletion`: `false`/);
});

test('the gatekeeper wakes a PO that is not running when any of three reasons holds, and keeps no state', () => {
  const flat = flatten(gatekeeperPrompt());
  assert.match(flat, /Skip every PO whose session is running \(`isRunning` true\): a real event reaches it\./);
  assert.match(flat, /wake it when ANY of these holds, and name every one that holds in the message/);
  assert.match(flat, /\(a\) restart: the boot time or the app start time is LATER than the PO's `lastActivityAt`/);
  assert.match(flat, /\(b\) unseen ready PR: an open pull request that is not a draft \(`isDraft` false\) and carries one of the PO's own line labels .* has `mergeStateStatus` CLEAN or UNSTABLE and an `updatedAt` LATER than the PO's `lastActivityAt`.* There is no waiting time\./);
  assert.doesNotMatch(flat, /coordinator/);
  // Only the PO's own line counts, and the quiet reason needs work in flight.
  assert.match(flat, /a pull request of any other line never counts/);
  assert.match(flat, /\(c\) quiet: the PO's `lastActivityAt` is <quiet minutes> minutes or more before <now>, AND its line has work in flight: an open pull request \(a draft counts\) that carries one of the PO's line labels, or a non-archived session whose `startedBy` is the PO's session id \(a session that a retired PO started is not counted until it has an open PR with the line's label\)\. A line with no work in flight is not woken for being quiet/);
  const at = (s) => flat.indexOf(s);
  assert.ok(at('(a) restart') < at('(b) unseen ready PR') && at('(b) unseen ready PR') < at('(c) quiet'));
  assert.match(flat, /whose title is exactly the PO title/);
  // No state file, no per-PO memory, no quiet hours.
  const prompt = gatekeeperPrompt();
  assert.doesNotMatch(prompt, /last_wake|last_compact_notice|last_wake_prs|<quiet hours>|<state file>|state file in step/);
  assert.doesNotMatch(gatekeeper(), /\| PO title \| last_wake/);
  // The wake message names the reasons, lists ready PRs and idle sub-sessions, and asks for one short turn.
  assert.match(flat, /Gatekeeper wake at <now> \(reasons: <reasons>\)\. Ready PRs of your line: <ready PRs>\. Idle sub-sessions of your line: <idle sub-sessions>\. Do one short turn: merge or review the ready PRs, feed or archive the idle sub-sessions, resume work a crash cut off, answer messages\. Then end the turn\. Keep no CronCreate check-in and no ScheduleWakeup loop/);
  assert.match(flat, /resume every linked sub-session \(list_sessions linked\) that had pending work/);
  assert.match(flat, /Machine boot <boot time>, app start <app start time>/);
  // The first runs may show a permission prompt for the two commands.
  assert.match(flatten(gatekeeper()), /may show such a prompt in the first runs\. The owner approves each once \("always allow"\)\. After creating the task, the PO checks the first run with `list_task_runs` and `list_events`/);
  const skill = flatten(read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n'));
  assert.match(skill, /It keeps no state and writes no file/);
  assert.match(skill, /\(c\) the PO has been quiet: its `lastActivityAt` is `gatekeeper_quiet_minutes` \(180\) or more before now and its line has work in flight/);
  assert.match(skill, /`gatekeeper_quiet_hours` and `coordinator_line` are no longer used/);
  assert.doesNotMatch(skill, /rewrites its one state file|one state file in `po_check_in_dir`/);
  const rules = read('plugins/cc-po/rules/AGENTS.md');
  assert.doesNotMatch(rules, /wakes only the POs matching a gatekeeper reason|rewrites `stateFile`|"quietHours"/);
});

test('a compaction notice goes only in the wake of a PO woken in this run, above the token threshold', () => {
  const flat = flatten(gatekeeperPrompt());
  assert.match(flat, /Context check, for the POs you wake only/);
  assert.match(flat, /call `mcp__ccd_session_mgmt__get_usage` with its session id/);
  assert.match(flat, /When a started session's context is above <compact tokens> tokens/);
  // The PO's own session gets a handoff notice, not a compaction notice.
  assert.match(flat, /When the PO's own session is above <handoff tokens> tokens, that PO gets the handoff notice instead/);
  assert.match(flat, /Handoff notice: your own context is <tokens> tokens, above the <handoff tokens> limit\. Hand your line to a fresh PO session now, as the product-owner skill's 'PO handoff' says/);
  assert.match(flat, /tell <owner> in <language> on the first line to open a fresh PO session with the exact title <po title>/);
  assert.match(flat, /Keep no record of notices/);
  assert.match(flat, /A session cannot compact itself; '\/compact' sent as a message is read as text, not as a command; and clear_session refuses Remote Control sessions/);
  assert.match(flat, /tell <owner> in <language> to press 'Compact session' on each of them in the app/);
  const skill = flatten(read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n'));
  assert.match(skill, /A sub-session above `compact_notice_tokens` \(500000\) goes into a compaction notice in that PO's wake message/);
  assert.match(skill, /The PO's own session above `po_handoff_tokens` \(250000\) gets a handoff notice instead/);
});

test('the gatekeeper has one task id per repository, an off-the-half-hour cron and no state file', () => {
  const template = gatekeeper();
  const row = template.split('\n').find((line) => line.startsWith('| `<task id>`'));
  assert.ok(row, 'the Values table has a <task id> row');
  assert.match(row, /`<repo owner>-<repo>-po-gatekeeper`/);
  assert.match(row, /every run of characters other than `a-z` and `0-9` as one hyphen, no hyphen at either end of `<repo owner>` or `<repo>`/);
  assert.match(row, /an upstream and its fork \(or two repositories with one name\) on one machine each get their own task/);
  assert.doesNotMatch(template, /<repo owner>-<repo>-gatekeeper\.md/);
  assert.match(template, /`cronExpression`: `<m>,<m\+30> \* \* \* \*`/);
  assert.match(flatten(template), /`<m>` is a minute from 2 to 13/);
  assert.match(template, /`model: <model>`/);
  assert.match(flatten(template), /The app may ignore that line\. The PO checks the model of the first run with `get_session`/);
  const skill = flatten(read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n'));
  assert.match(skill, /task id `<repo owner>-<repo>-po-gatekeeper`/);
  assert.doesNotMatch(skill, /<repo owner>-<repo>-gatekeeper\.md/);
  assert.match(skill, /The first PO of the repository that finds no gatekeeper creates it, at an owner turn/);
  assert.match(skill, /Every other PO only checks that it exists/);
  assert.doesNotMatch(template.replace(/<repo owner>-<repo>-<slug>-po-checkin/g, ''), /<repo>-<slug>/);
});

test('under the gatekeeper a PO keeps no check-in cron, retires its watchdog and keeps its context small', () => {
  const skill = flatten(read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n'));
  assert.match(skill, /Under `po_wake: gatekeeper` \(the default\) the PO keeps no in-session check-in \(no `CronCreate` check-in and no `ScheduleWakeup` loop\)/);
  assert.match(skill, /disables it with `update_scheduled_task` \(`enabled: false`\), and deletes its own in-session check-in cron/);
  assert.match(skill, /Where the app refuses the disable, the PO says in its digest which task the owner must switch off by hand/);
  assert.match(skill, /Under `po_wake: watchdog` it also keeps a self check-in/);
  assert.match(skill, /## Keep the context small/);
  for (const rule of [/State lives on GitHub .* and in the check-in file/, /A wake turn is short/, /Read only what the reason needs/, /Never re-read a long log, transcript or diff already summarised/]) {
    assert.match(skill, rule);
  }
  assert.match(flatten(gatekeeper()), /The tool has no model parameter/);
});

test('the gatekeeper keys and po_wake are checked, and po_watchdog is an alias for one version', () => {
  const check = (extra) => checkConfig(minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n${extra}`));
  const err = (extra) => check(extra).errors.join('\n');
  const clean = { errors: [], warnings: [] };
  assert.deepEqual(check('- po_wake: gatekeeper\n- gatekeeper_model: claude-haiku-5-5\n- gatekeeper_active_minutes: 60\n- gatekeeper_quiet_minutes: 180\n- compact_notice_tokens: 500000\n- po_handoff_tokens: 250000'), clean);
  for (const ok of ['- po_wake: watchdog', '- po_wake: off (owner, 2026-11-04)', '- gatekeeper_active_minutes: 5', '- gatekeeper_active_minutes: 1440 (owner)',
    '- compact_notice_tokens: 50000', '- compact_notice_tokens: 2000000', '- gatekeeper_quiet_minutes: 30', '- gatekeeper_quiet_minutes: 1440 (owner)',
    '- po_handoff_tokens: 50000', '- po_handoff_tokens: 2000000', '- po_handoff_tokens: none', '- po_handoff_tokens: 250000 (owner, 2026-11-12)', '- coordinator_line: none']) {
    assert.deepEqual(check(ok), clean, ok);
  }
  assert.match(err('- po_wake: always'), /po_wake must be gatekeeper, watchdog or off/);
  assert.match(err('- po_wake: gatekeepers'), /po_wake must be gatekeeper, watchdog or off/);
  for (const [key, bad, range] of [
    ['gatekeeper_active_minutes', ['4', '1441', '0', 'sixty', '60.5', '60min', 'none', '-5'], '5 to 1440'],
    ['gatekeeper_quiet_minutes', ['29', '1441', '0', 'three hours', '180.5', '180min', 'none'], '30 to 1440'],
    ['gatekeeper_quiet_hours', ['0', '73', 'four', '4h', '1.5'], '1 to 72'],
    ['compact_notice_tokens', ['49999', '2000001', '500k', 'none', '500000.5'], '50000 to 2000000'],
  ]) {
    for (const value of bad) assert.match(err(`- ${key}: ${value}`), new RegExp(`${key} must start with an integer from ${range}`), `${key}: ${value}`);
  }
  // gatekeeper_quiet_hours is no longer used: still accepted for one version, with a warning.
  for (const v of ['4', '1', '72', '4 (owner)']) {
    const r = check(`- gatekeeper_quiet_hours: ${v}`);
    assert.deepEqual(r.errors, [], v);
    assert.match(r.warnings.join('\n'), /gatekeeper_quiet_hours is no longer used: the gatekeeper wakes a quiet PO after gatekeeper_quiet_minutes; remove it/, v);
  }
  // po_handoff_tokens is an integer in range or none.
  for (const bad of ['49999', '2000001', '250k', 'soon', '250000.5', '-1', '0']) {
    assert.match(err(`- po_handoff_tokens: ${bad}`), /po_handoff_tokens must start with an integer from 50000 to 2000000, or be none/, bad);
  }
  assert.match(err('- gatekeeper_quiet_hours: 0'), /gatekeeper_quiet_hours must start with an integer from 1 to 72/);
  // coordinator_line is no longer used: accepted for one version, with a warning, and never an error.
  for (const v of ['line:core', 'line:missing', 'core']) {
    const r = check(`- coordinator_line: ${v}`);
    assert.deepEqual(r.errors, [], v);
    assert.match(r.warnings.join('\n'), /coordinator_line is no longer used: the gatekeeper counts only pull requests labelled with its own line; remove it/, v);
  }
  assert.match(err('- gatekeeper_model:'), /gatekeeper_model has no value/);
  // The old key is read for one version: it validates as before and the checker warns.
  assert.deepEqual(check('- po_watchdog: on').errors, []);
  assert.match(check('- po_watchdog: on').warnings.join('\n'), /po_watchdog is the old name of po_wake: off means po_wake: off, on means the default \(gatekeeper\)/);
  assert.match(check('- po_watchdog: off').warnings.join('\n'), /old name of po_wake/);
  assert.match(err('- po_watchdog: maybe'), /po_watchdog must be on or off/);
  assert.match(check('- po_watchdog: off\n- po_wake: gatekeeper').warnings.join('\n'), /po_watchdog is ignored because po_wake is set/);
  // Every key is in the schema and the sample, so none reads as prose.
  const schema = read('plugins/cc-po/skills/product-owner/config-schema.md');
  const sample = parseConfig(read('plugins/cc-po/skills/setup/sample-config.md')).values;
  for (const [key, fallback] of [['po_wake', 'gatekeeper'], ['gatekeeper_model', 'claude-haiku-5-5'], ['gatekeeper_active_minutes', '60'], ['gatekeeper_quiet_minutes', '180'], ['compact_notice_tokens', '500000'], ['po_handoff_tokens', '250000']]) {
    assert.match(schema, new RegExp(`\\| \`${key}\` \\| \`${fallback}\` \\|`), key);
    assert.equal(sample[key], fallback, key);
  }
  assert.match(schema, /\| `po_watchdog` \| none \| The earlier name of `po_wake`/);
});

test('the version is 2.10.0 and the README describes the gatekeeper and Antigravity subagents', () => {
  assert.equal(JSON.parse(read('plugins/cc-po/.claude-plugin/plugin.json')).version, '2.10.0');
  const readme = flatten(read('README.md').replace(/\r\n/g, '\n'));
  assert.match(readme, /### Upgrading to 2\.6\.0/);
  assert.match(readme, /### Upgrading to 2\.7\.0/);
  assert.match(readme, /### Upgrading to 2\.8\.0/);
  assert.match(readme, /### Upgrading to 2\.9\.0/);
  assert.match(readme, /### Upgrading to 2\.10\.0/);
  assert.match(readme, /The Claude app gatekeeper keeps no state file/);
  assert.match(readme, /Wake-ups \(one gatekeeper per repository\)/);
  assert.match(readme, /`po_wake: watchdog` keeps the earlier behaviour/);
  assert.match(readme, /agy-gatekeeper\.mjs/);
});

// The session fields are normally present; get_session is only the fallback.
test('the gatekeeper reads the session fields from list_sessions and falls back to get_session', () => {
  const flat = flatten(gatekeeperPrompt());
  assert.match(flat, /Each row normally has `isRunning`, `lastActivityAt` and `startedBy`; only if a row lacks one, call `mcp__ccd_session_mgmt__get_session` for that session only/);
});

test('agy-gatekeeper inspects local transcripts, wakes a non-running PO for restart, unseen ready PR or quiet, and keeps no state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-gk-'));
  try {
    const brainDir = join(dir, 'brain');
    const stateFile = join(dir, 'dos-ludy-gatekeeper.md');
    const engageCheckIn = join(dir, 'dos-ludy-engage-checkin.md');
    const meetingsCheckIn = join(dir, 'dos-ludy-meetings-checkin.md');

    const engagePoId = 'a16e550a-bf11-40ca-af35-072cc33d83fd';
    const engageSubId = 'c2ef3e6f-2fa6-4ef4-873f-8ad7cb686e63';
    const engageSub2Id = '11111111-2222-3333-4444-555555555555';
    const researchSubId = 'fee67c34-e369-473d-9e44-a8b83b510850';
    const meetingsPoId = '735bec20-7c1f-44c7-9045-cb369c545487';

    const writeTranscript = (id, lines) => {
      const logDir = join(brainDir, id, '.system_generated', 'logs');
      mkdirSync(logDir, { recursive: true });
      const file = join(logDir, 'transcript.jsonl');
      writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
      // The file's mtime is the time of its last step, so the test does not depend on the real clock.
      const last = new Date(lines[lines.length - 1].created_at);
      utimesSync(file, last, last);
    };

    // Batched invoke_subagent calls in one PLANNER_RESPONSE (two self + one research),
    // plus a stale RUNNING step from before a server restart that must not block recovery.
    const engagePoSteps = [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-06T00:00:00Z',
        input_tokens: 12000,
        cache_read_tokens: 510000,
        tool_calls: [
          { name: 'invoke_subagent', args: { TypeName: '"self"', Role: '"#2333 CRM worker"' } },
          { name: 'invoke_subagent', args: { TypeName: '"research"', Role: '"Security reviewer"' } },
          { name: 'invoke_subagent', args: { TypeName: '"self"', Role: '"#2309 IG worker"' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-06T00:00:05Z',
        content: `Created the following subagent:\n{\n  "conversationId": "${engageSubId}"\n}`,
      },
      // Out-of-order completion: step_index 4 (second self worker) finishes before step_index 3 (research)
      {
        step_index: 4,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-06T00:00:06Z',
        content: `Created the following subagent:\n{\n  "conversationId": "${engageSub2Id}"\n}`,
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-06T00:00:07Z',
        content: `Created the following subagent:\n{\n  "conversationId": "${researchSubId}"\n}`,
      },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        created_at: '2026-11-06T00:01:05Z',
      },
    ];
    writeTranscript(engagePoId, engagePoSteps);

    writeTranscript(engageSubId, [
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'INVALID', created_at: '2026-11-06T00:30:00Z', input_tokens: 1000, cache_read_tokens: 20000 },
    ]);
    writeTranscript(engageSub2Id, [
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-06T00:32:00Z', input_tokens: 1000, cache_read_tokens: 10000 },
    ]);
    writeTranscript(researchSubId, [
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-06T00:35:00Z' },
    ]);
    writeTranscript(meetingsPoId, [
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-06T04:50:00Z', input_tokens: 5000, cache_read_tokens: 40000 },
    ]);

    const nowMs = Date.parse('2026-11-06T05:00:00Z');
    assert.equal(inspectConversation(brainDir, '../not-a-uuid', nowMs), null);
    const inspected = inspectConversation(brainDir, engagePoId, nowMs);
    assert.equal(inspected.contextTokens, 522000);
    assert.equal(inspected.stepRunning, true);
    assert.equal(inspected.isRunning, false);
    assert.deepEqual(inspected.spawnedSubagents, [
      { conversationId: engageSubId, role: '#2333 CRM worker' },
      { conversationId: engageSub2Id, role: '#2309 IG worker' },
    ]);
    assert.equal(
      pickAppStartTime({ guiStartIso: '2026-11-06T00:00:00Z', serverStartIso: '2026-11-06T03:00:00Z' }),
      '2026-11-06T03:00:00Z',
    );

    assert.equal(inspectConversation(brainDir, engageSubId, Date.parse('2026-11-06T00:31:00Z')).stepRunning, false);
    assert.equal(expandHome('~/po-state/gk.md', '/home/sam'), join('/home/sam', 'po-state/gk.md'));

    writeFileSync(engageCheckIn, `# Check-in\n- PO session: \`${engagePoId}\`\n- Coordinated with peer PO \`${meetingsPoId}\`\n## Completed\n- \`00000000-0000-0000-0000-000000000001\` MERGED\n## Active\n- \`${engageSubId}\` working\n`);
    writeFileSync(meetingsCheckIn, `# Check-in\nPO session: \`${meetingsPoId}\`\n`);
    assert.equal(resolvePoConversationId({ conversationId: '11111111-1111-1111-1111-111111111111' }, readFileSync(engageCheckIn, 'utf8')), engagePoId);
    assert.deepEqual([...extractActiveCheckInIds(readFileSync(engageCheckIn, 'utf8'), new Set([engagePoId, meetingsPoId]))], [engageSubId]);

    const configPath = join(dir, 'dos-ludy-agy-gatekeeper.json');
    // An old config still loads: stateFile and quietHours are ignored.
    writeFileSync(configPath, JSON.stringify({
      repo: 'DOS/Ludy',
      owner: 'JOY',
      language: 'Vietnamese',
      activeMinutes: 60,
      quietHours: 4,
      compactTokens: 500000,
      coordinatorLabel: 'line:platform',
      stateFile,
      brainDir,
      pos: [
        { title: 'Ludy Engage Product Owner', conversationId: engagePoId, label: 'line:social-management', checkInFile: engageCheckIn },
        { title: 'AI Meeting Notes Product Owner', conversationId: meetingsPoId, label: 'line:meetings', checkInFile: meetingsCheckIn },
      ],
    }, null, 2));
    // A config without stateFile loads too.
    const bareConfigPath = join(dir, 'bare.json');
    const bare = JSON.parse(readFileSync(configPath, 'utf8'));
    delete bare.stateFile;
    delete bare.quietHours;
    writeFileSync(bareConfigPath, JSON.stringify(bare));

    const pr = (updatedAt, status = 'CLEAN', label = 'line:social-management', number = 2660) => ({ number, labels: [{ name: label }], mergeStateStatus: status, updatedAt });
    const run = (cfg, at, restart, prs, sent) => runGatekeeper(cfg, {
      nowMs: Date.parse(at),
      getRestartTimes: () => restart,
      queryOpenPrs: () => { if (prs instanceof Error) throw prs; return prs; },
      sendMessage: (id, msg) => sent.push({ id, msg }),
    });

    // Pass 1 (05:00): all three reasons hold for the Engage PO, and each is named. The quiet reason
    // needs work in flight, which it has (a sub-session and an open PR). Its own context is above
    // the handoff threshold, so the handoff notice rides along. The Meetings PO was active 10 min
    // ago and is skipped.
    let sent = [];
    run(configPath, '2026-11-06T05:00:00Z', { bootTime: '2026-11-06T01:00:00Z', appStartTime: '2026-11-06T01:05:00Z' }, [pr('2026-11-06T02:00:00Z')], sent);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, engagePoId);
    assert.match(sent[0].msg, /\(reasons: restart, unseen ready PR, quiet for 298 minutes with work in flight\)/);
    assert.match(sent[0].msg, /Ready PRs of your line: #2660 \(CLEAN\)\./);
    assert.match(sent[0].msg, /Idle sub-sessions of your line: .*#2333 CRM worker/);
    assert.match(sent[0].msg, /Do one short turn: merge or review the ready PRs, feed or archive the idle sub-sessions, resume work a crash cut off, answer messages\. Then end the turn\./);
    assert.match(sent[0].msg, /Machine boot 2026-11-06T01:00:00Z, app start 2026-11-06T01:05:00Z/);
    assert.match(sent[0].msg, /Handoff notice at 2026-11-06T05:00:00Z: your own context is 522000 tokens, above the 250000 limit\. Hand your line to a fresh PO session now/);
    assert.match(sent[0].msg, /with the exact title Ludy Engage Product Owner, and the old session should be renamed 'Ludy Engage Product Owner \(retired 2026-11-06\)' before the new one opens/);
    // The PO itself is never in a compaction notice.
    assert.doesNotMatch(sent[0].msg, /Context notice at .*Ludy Engage Product Owner \(/);
    // No state file is written.
    assert.equal(existsSync(stateFile), false);

    // The PO acts at 05:01 (its transcript gets a newer step).
    writeTranscript(engagePoId, [...engagePoSteps, {
      step_index: 6, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-06T05:01:00Z', input_tokens: 12000, cache_read_tokens: 510000,
    }]);

    // Pass 2 (05:30): the PO has acted since the restart and the PR; nobody is quiet. No wake.
    sent = [];
    run(bareConfigPath, '2026-11-06T05:30:00Z', { bootTime: '2026-11-06T01:00:00Z', appStartTime: '2026-11-06T01:05:00Z' }, [pr('2026-11-06T02:00:00Z')], sent);
    assert.equal(sent.length, 0);

    // Pass 3 (05:35): the PR became ready again at 05:10, after the Engage PO's last activity: wake, with
    // no 30-minute wait and for that reason alone (no restart, not quiet).
    sent = [];
    run(configPath, '2026-11-06T05:35:00Z', { bootTime: '2026-11-06T01:00:00Z', appStartTime: '' }, [pr('2026-11-06T05:10:00Z'), pr('2026-11-06T05:20:00Z', 'BLOCKED', 'line:social-management', 2661), pr('2026-11-06T05:20:00Z', 'CLEAN', 'line:meetings', 2662)], sent);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].id, engagePoId);
    assert.match(sent[0].msg, /\(reasons: unseen ready PR\)\. Ready PRs of your line: #2660 \(CLEAN\)\./);
    assert.doesNotMatch(sent[0].msg, /#2661|#2662|Machine boot/);
    // The Meetings PO (last active 04:50) has its own ready PR #2662, newer than that: woken for it alone.
    assert.equal(sent[1].id, meetingsPoId);
    assert.match(sent[1].msg, /\(reasons: unseen ready PR\)\. Ready PRs of your line: #2662 \(CLEAN\)\. Idle sub-sessions of your line: none\./);

    // Pass 4 (06:02): the PR list fails; both POs have been idle for only 61 and 72 minutes, short of
    // the 180-minute quiet window, so nobody is woken for being quiet.
    sent = [];
    run(configPath, '2026-11-06T06:02:00Z', { bootTime: '2026-11-06T00:00:00Z', appStartTime: '' }, new Error('gh failed'), sent);
    assert.equal(sent.length, 0);

    // Pass 5 (08:10): the PR list fails. The Engage PO (idle since 05:01, 189 minutes) still has a
    // sub-session in flight, so it is woken for being quiet, with its ready PRs unknown. The Meetings PO
    // (idle 200 minutes) has no sub-session, and without the PR list nothing shows work in flight: skipped.
    sent = [];
    run(configPath, '2026-11-06T08:10:00Z', { bootTime: '2026-11-06T00:00:00Z', appStartTime: '' }, new Error('gh failed'), sent);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, engagePoId);
    assert.match(sent[0].msg, /\(reasons: quiet for 189 minutes with work in flight\)\. Ready PRs of your line: unknown, the gh query failed\./);

    // Pass 6 (08:10): the PR list works and is empty. The Meetings PO has nothing in flight and is not
    // woken, however long it has been quiet; the Engage PO still has its sub-session.
    sent = [];
    run(configPath, '2026-11-06T08:10:00Z', { bootTime: '2026-11-06T00:00:00Z', appStartTime: '' }, [], sent);
    assert.deepEqual(sent.map((m) => m.id), [engagePoId]);

    // Pass 7 (08:10): an open draft PR of the Meetings line is work in flight, so that PO is woken for
    // being quiet (200 minutes) but the draft is not a ready PR. A ready PR of another line, and one
    // labelled with the old coordinator label, never count for a PO that does not carry the label.
    sent = [];
    const draft = { ...pr('2026-11-06T04:00:00Z', 'CLEAN', 'line:meetings', 2670), isDraft: true };
    run(configPath, '2026-11-06T08:10:00Z', { bootTime: '2026-11-06T00:00:00Z', appStartTime: '' },
      [draft, pr('2026-11-06T08:00:00Z', 'CLEAN', 'line:other', 2671), pr('2026-11-06T08:00:00Z', 'CLEAN', 'line:platform', 2672)], sent);
    assert.deepEqual(sent.map((m) => m.id).sort(), [engagePoId, meetingsPoId].sort());
    const meetingsWake = sent.find((m) => m.id === meetingsPoId).msg;
    assert.match(meetingsWake, /\(reasons: quiet for 200 minutes with work in flight\)\. Ready PRs of your line: none\. Idle sub-sessions of your line: none\./);
    for (const m of sent) assert.doesNotMatch(m.msg, /#2671|#2672|#2670/);

    // A config that sets the new thresholds is honoured: a 120-minute quiet window wakes the Meetings PO
    // at 06:55 (125 minutes), and handoffTokens "none" turns the handoff notice off.
    const tunedPath = join(dir, 'tuned.json');
    writeFileSync(tunedPath, JSON.stringify({ ...bare, quietMinutes: 120, handoffTokens: 'none' }));
    sent = [];
    run(tunedPath, '2026-11-06T06:55:00Z', { bootTime: '2026-11-06T00:00:00Z', appStartTime: '' }, [draft], sent);
    assert.ok(sent.some((m) => m.id === meetingsPoId && /quiet for 125 minutes with work in flight/.test(m.msg)));
    for (const m of sent) assert.doesNotMatch(m.msg, /Handoff notice/);

    // A restart check that fails (empty times) is not a restart reason.
    sent = [];
    run(configPath, '2026-11-06T05:30:00Z', { bootTime: '', appStartTime: '' }, [], sent);
    assert.equal(sent.length, 0);

    const result = evaluateGatekeeper({
      config: bare,
      poInspections: new Map(),
      restartTimes: {},
      openPrs: [],
      nowMs,
    });
    assert.deepEqual(result.actions.map((a) => a.skipped), ['missing-session', 'missing-session']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POs are peers and shared_core_review is a known key that defaults to none', () => {
  const skill = flatten(read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n'));
  assert.match(skill, /### Peer POs and security review/);
  assert.match(skill, /POs are peers\. Each works with the owner directly/);
  assert.match(skill, /`Security review requested \(<Line> PO\)`/);
  assert.match(skill, /It does not approve the PR/);
  const schema = read('plugins/cc-po/skills/product-owner/config-schema.md');
  assert.match(schema, /\| `shared_core_review` \| `none` \|/);
  assert.match(read('plugins/cc-po/skills/setup/sample-config.md'), /^- shared_core_review: none$/m);
});

// 2.10.0: size-triggered PO handoff, a lean PO context, archiving, Production handoff and cheaper tasks.
test('the PO hands over by context size, keeps its context lean, archives finished sessions and frees Production-waiting slots', () => {
  const skill = flatten(read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n'));
  // Size, not the clock.
  assert.match(skill, /not at a fixed time\. A PO replaced each morning would still grow all day/);
  assert.doesNotMatch(skill, /a fresh PO each day/);
  assert.match(skill, /`po_handoff_tokens: none` turns the size trigger off/);
  assert.match(skill, /the PO may read its own size at a check-in/);
  assert.match(skill, /renames its own session to `<title> \(retired <UTC date>\)` with `set_session_title`/);
  // A lean PO context.
  assert.match(skill, /cut the output with `--jq`/);
  assert.match(skill, /Delegate wide reads\./);
  assert.match(skill, /Never read a session transcript or a long file into the PO/);
  // Archiving and Production-waiting sessions.
  assert.match(skill, /archive it with `archive_session`/);
  assert.match(skill, /the owner's "always allow" covers the rest/);
  assert.match(skill, /the PO posts its own `claim:` on the issue .* and only then\s+archives the sub-session\. This early claim is a waiting claim.*The slot is free while Production waits/);
  assert.doesNotMatch(skill, /that sub-session stays \(idle, still counted\)/);
  // Fewer, cheaper tasks.
  assert.match(skill, /one checklist on one cleanup issue per line per week/);
  // Review follow-ups: the upgrade path, the title precondition, the retired session and a durable model record.
  assert.match(skill, /Found and enabled, but its prompt has no `<quiet minutes>` setting or no handoff notice \(made by 2\.9\.0 or earlier\)/);
  assert.match(skill, /The rename is a hard precondition, not a courtesy/);
  assert.match(skill, /The retired PO session is <session id>\./);
  assert.match(skill, /a `handoff:` to the PO for Production steps follows the next bullet/);
  assert.match(skill, /`model-exception: <model> <effort> session=<id> decision=<id>`/);
  assert.match(skill, /at the start of each owner turn and at each check-in the PO reads its own size with `get_usage`/);
  assert.match(skill, /the PO's own waiting claims for Production steps/);
  assert.match(skill, /`Model exception: <model>, <effort>, <decision id>`/);
  assert.match(skill, /never above `agent_model` and `agent_effort`, and never for security, money, migration, credential or Production work/);
  const schema = read('plugins/cc-po/skills/product-owner/config-schema.md');
  assert.match(schema, /\| `po_handoff_tokens` \| `250000` \|/);
  assert.match(schema, /\| `gatekeeper_quiet_minutes` \| `180` \|/);
  assert.match(schema, /\| `coordinator_line` \| none \| No longer used since 2\.10\.0/);
  // The Antigravity rules carry the new config keys.
  const rules = read('plugins/cc-po/rules/AGENTS.md');
  assert.match(rules, /"quietMinutes": <gatekeeper_quiet_minutes>/);
  assert.match(rules, /"handoffTokens": <po_handoff_tokens or "none">/);
  assert.doesNotMatch(rules, /coordinatorLabel/);
});
