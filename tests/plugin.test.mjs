// Run with: node --test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkConfig, findRoot, insideRoot, outsidePath, parseConfig, parseScopes, scopePaths } from '../plugins/cc-po/skills/product-owner/check-config.mjs';

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
  assert.match(skill, /## PO handoff Where `po_handoff` is `on`/);
  assert.match(read('plugins/cc-po/skills/product-owner/config-schema.md'), /\| `po_handoff` \| `off` \|/);
  const extra = (lines) => minimal.replace('- project_id: PVT_example', `- project_id: PVT_example\n${lines}`);
  assert.deepEqual(checkConfig(extra('- po_handoff: on\n- agent_effort: high. Exception: xhigh only for hard security work.')).errors, []);
  assert.match(checkConfig(extra('- agent_effort: high. Exception: very high')).errors.join('\n'), /the word after "Exception:" must be low, medium, high, xhigh or max/);
  assert.match(checkConfig(extra('- po_handoff: maybe')).errors.join('\n'), /po_handoff must be on or off/);
});

// The gatekeeper is one cheap, wake-only task per repository: it reads the
// session list, one restart check and one gh query, rewrites its state file,
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
  assert.match(flat, /no repository, git, cloud or other file action/);
  assert.match(flat, /The only files you touch are the state file in step 1 and step 7\./);
  assert.match(flat, /The only commands you may run are the read-only restart check in step 3 and the read-only gh query in step 4\./);
  assert.match(flat, /Never read the repository or any config\./);
  assert.match(flat, /no message to any session but the POs listed below/);
  // The one gh command is a read-only pull request list; no git, no write.
  assert.deepEqual([...prompt.matchAll(/\bgh ((?:pr|api|issue|repo|run|workflow|project|auth|release|label|search|gist|secret|variable|cache|ruleset) [a-z]+)/g)].map((m) => m[1]), ['pr list']);
  assert.match(flat, /gh pr list --repo <owner\/repo> --state open --search "draft:false" --limit 200 --json number,labels,mergeStateStatus,updatedAt/);
  assert.doesNotMatch(prompt, /\bgit [a-z]|\bcurl\b|\bgh api\b|create_scheduled_task|update_scheduled_task/);
  for (const placeholder of ['<po rows>', '<state file>', '<owner/repo>', '<owner>', '<language>', '<active minutes>', '<quiet hours>', '<compact tokens>', '<coordinator label>', '<restart check>']) {
    assert.ok(prompt.includes(placeholder), placeholder);
  }
  // It archives its own run at the end, like the watchdog.
  assert.match(flat, /`mcp__ccd_session_mgmt__archive_session` with session_id "self" and reason "gatekeeper run finished"/);
  assert.match(gatekeeper(), /`notifyOnCompletion`: `false`/);
});

test('the gatekeeper wakes a PO for four reasons, in order, and skips an active one', () => {
  const flat = flatten(gatekeeperPrompt());
  assert.match(flat, /Skip it, with no wake, when its session is running \(`isRunning` true\) or its `lastActivityAt` is less than <active minutes> minutes before <now>/);
  assert.match(flat, /wake it for the FIRST reason below that holds, and for no other/);
  assert.match(flat, /\(a\) restart: the boot time or the app start time is LATER than the PO's `lastActivityAt`/);
  assert.match(flat, /\(b\) pull request: an open pull request with the PO's line label .* has `mergeStateStatus` CLEAN or UNSTABLE and an `updatedAt` more than 30 minutes before <now>\. For the PO whose label is the coordinator label, any open pull request counts/);
  assert.match(flat, /\(c\) sub-sessions: a non-archived session whose `startedBy` is this PO's session id is not running and has had no activity for more than <active minutes> minutes, and the PO's `last_wake` is none or more than 3 hours before <now>/);
  assert.match(flat, /\(d\) safety net: the PO's `lastActivityAt` and its `last_wake` are both more than <quiet hours> hours before <now>/);
  const at = (s) => flat.indexOf(s);
  assert.ok(at('(a) restart') < at('(b) pull request') && at('(b) pull request') < at('(c) sub-sessions') && at('(c) sub-sessions') < at('(d) safety net'));
  assert.match(flat, /whose title is exactly the PO title/);
  // The wake message names the reason and narrows the PO's work.
  assert.match(flat, /Gatekeeper wake at <now> \(reason: <reason>\): <detail>\. Act on this reason only\. Run a full check-in .* only if the reason needs one\. Keep no CronCreate check-in and no ScheduleWakeup loop/);
  assert.match(flat, /resume every linked sub-session \(list_sessions linked\) that had pending work/);
  assert.match(flat, /Machine boot <boot time>, app start <app start time>/);
});

test('a compaction notice goes above the token threshold, at most once per 6 hours per PO', () => {
  const flat = flatten(gatekeeperPrompt());
  assert.match(flat, /call `mcp__ccd_session_mgmt__get_usage` with its session id/);
  assert.match(flat, /When a session's context is above <compact tokens> tokens/);
  assert.match(flat, /Send a PO a notice only if that PO is not running and its `last_compact_notice` is none or more than 6 hours before <now>; one notice lists all its sessions/);
  assert.match(flat, /A session cannot compact itself; '\/compact' sent as a message is read as text, not as a command; and clear_session refuses Remote Control sessions/);
  assert.match(flat, /tell <owner> in <language> to press 'Compact session' on each of them in the app/);
  const skill = flatten(read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n'));
  assert.match(skill, /above `compact_notice_tokens`, it sends that line's PO one notice, at most once per 6 hours per PO/);
});

test('the gatekeeper has one task id per repository, one state file and an off-the-half-hour cron', () => {
  const template = gatekeeper();
  const row = template.split('\n').find((line) => line.startsWith('| `<task id>`'));
  assert.ok(row, 'the Values table has a <task id> row');
  assert.match(row, /`<repo owner>-<repo>-po-gatekeeper`/);
  assert.match(row, /every run of characters other than `a-z` and `0-9` as one hyphen, no hyphen at either end of `<repo owner>` or `<repo>`/);
  assert.match(row, /an upstream and its fork \(or two repositories with one name\) on one machine each get their own task/);
  assert.match(template, /`<repo owner>-<repo>-gatekeeper\.md`/);
  assert.match(template, /`cronExpression`: `<m>,<m\+30> \* \* \* \*`/);
  assert.match(flatten(template), /`<m>` is a minute from 2 to 13/);
  assert.match(template, /`model: <model>`/);
  assert.match(flatten(template), /The app may ignore that line\. The PO checks the model of the first run with `get_session`/);
  const skill = flatten(read('plugins/cc-po/skills/product-owner/SKILL.md').replace(/\r\n/g, '\n'));
  assert.match(skill, /task id `<repo owner>-<repo>-po-gatekeeper`/);
  assert.match(skill, /`<repo owner>-<repo>-gatekeeper\.md`/);
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
  assert.deepEqual(check('- po_wake: gatekeeper\n- gatekeeper_model: claude-haiku-5-5\n- gatekeeper_active_minutes: 60\n- gatekeeper_quiet_hours: 4\n- compact_notice_tokens: 500000\n- coordinator_line: none'), clean);
  for (const ok of ['- po_wake: watchdog', '- po_wake: off (owner, 2026-11-04)', '- gatekeeper_active_minutes: 5', '- gatekeeper_active_minutes: 1440 (owner)',
    '- gatekeeper_quiet_hours: 1', '- gatekeeper_quiet_hours: 72', '- compact_notice_tokens: 50000', '- compact_notice_tokens: 2000000', '- coordinator_line: `line:core`', '- coordinator_line: line:core']) {
    assert.deepEqual(check(ok), clean, ok);
  }
  assert.match(err('- po_wake: always'), /po_wake must be gatekeeper, watchdog or off/);
  assert.match(err('- po_wake: gatekeepers'), /po_wake must be gatekeeper, watchdog or off/);
  for (const [key, bad, range] of [
    ['gatekeeper_active_minutes', ['4', '1441', '0', 'sixty', '60.5', '60min', 'none', '-5'], '5 to 1440'],
    ['gatekeeper_quiet_hours', ['0', '73', 'four', '4h', '1.5'], '1 to 72'],
    ['compact_notice_tokens', ['49999', '2000001', '500k', 'none', '500000.5'], '50000 to 2000000'],
  ]) {
    for (const value of bad) assert.match(err(`- ${key}: ${value}`), new RegExp(`${key} must start with an integer from ${range}`), `${key}: ${value}`);
  }
  assert.match(err('- coordinator_line: line:missing'), /coordinator_line must be none or a label in the Lines table/);
  assert.match(err('- coordinator_line: core'), /coordinator_line must be none or a label in the Lines table/);
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
  for (const [key, fallback] of [['po_wake', 'gatekeeper'], ['gatekeeper_model', 'claude-haiku-5-5'], ['gatekeeper_active_minutes', '60'], ['gatekeeper_quiet_hours', '4'], ['compact_notice_tokens', '500000'], ['coordinator_line', 'none']]) {
    assert.match(schema, new RegExp(`\\| \`${key}\` \\| \`${fallback}\` \\|`), key);
    assert.equal(sample[key], fallback, key);
  }
  assert.match(schema, /\| `po_watchdog` \| none \| The earlier name of `po_wake`/);
});

test('the version is 2.6.0 and the README describes the gatekeeper', () => {
  assert.equal(JSON.parse(read('plugins/cc-po/.claude-plugin/plugin.json')).version, '2.6.0');
  const readme = flatten(read('README.md').replace(/\r\n/g, '\n'));
  assert.match(readme, /### Upgrading to 2\.6\.0/);
  assert.match(readme, /Wake-ups \(one gatekeeper per repository\)/);
  assert.match(readme, /`po_wake: watchdog` keeps the earlier behaviour/);
});
