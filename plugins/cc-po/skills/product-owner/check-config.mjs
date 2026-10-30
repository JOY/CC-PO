#!/usr/bin/env node
// Checks a repository's Product Owner config (docs/product-owner-config.md)
// against config-schema.md, next to this file. No dependencies.
//
//   node check-config.mjs [path]     default path: docs/product-owner-config.md
//
// Exit 0 when the config is valid (warnings may still print), 1 when it has
// errors, 2 when the file cannot be read.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED = ['owner_name', 'project_owner', 'project_number', 'project_id'];

export const KNOWN = new Set([
  ...REQUIRED,
  'owner_profile', 'report_language', 'agent_account',
  'project_url', 'product_line_field', 'priority_field', 'sprint_field', 'bot_owned_fields',
  'issue_types', 'org_priority_field', 'org_effort_field', 'issue_notes',
  'agent_instructions', 'task_scope', 'tracking_doc', 'review_rules', 'domain_rules',
  'roadmap_sources', 'setup_guide', 'decision_log',
  'integration_branch', 'integration_merge', 'default_branch', 'draft_pr_first',
  'production_branch', 'production_merge', 'production_effect', 'promotion_notes',
  'test_environment', 'done_definition',
  'required_checks', 'claim_gate', 'external_review_app', 'local_reviews',
  'promotion_reviews', 'agent_model', 'agent_effort', 'subagent_effort',
  'sub_sessions_normal', 'sub_sessions_max', 'check_in_minutes', 'executors',
  'po_watchdog', 'po_check_in_dir',
  'sprint_review', 'line_scopes', 'sprint_review_report',
]);

const LABEL = /^line:[a-z0-9][a-z0-9-]*$/;

// parseScopes splits line_scopes into { label, paths } entries; label is
// null for an entry that does not start with a line label.
export function parseScopes(value) {
  return value.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const m = entry.match(/^`?(line:[a-z0-9][a-z0-9-]*)`?:?\s+(\S.*)$/);
    return m ? { label: m[1], paths: m[2] } : { label: null, paths: entry };
  });
}

// outsidePath is true for a path that can leave the repository: absolute,
// a drive letter or file: URL, or any segment (also after key=) that is ..
// or starts with home (~) or an environment variable ($HOME, %USERPROFILE%).
export function outsidePath(path) {
  return /^([A-Za-z]:|file:|[\\/])/i.test(path)
    || path.split(/[\\/=]/).some((segment) => segment === '..' || /^[~$%]/.test(segment));
}

// scopePaths splits an entry's paths and notes into words, without the
// backticks, quotes and brackets around them, so a path in a note is
// checked too.
export function scopePaths(paths) {
  return paths.split(/[\s,]+/)
    .map((word) => word.replace(/^[`'"(\[{<]+/, '').replace(/[`'")\]}>:;]+$/, ''))
    .filter(Boolean);
}

const LINES_HEADER = ['line', 'label', 'product line option id', 'po session'];

// Shapes of credentials that must never be committed in a config.
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  // The whole block, also when continuation lines have joined it into one
  // value, up to its END line or the end of the message.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
];

// redact hides anything credential-shaped. Messages quote no values (only
// key names, which the parser limits to lower snake case, and row
// numbers); this is a second guard.
export function redact(message) {
  return SECRET_PATTERNS.reduce((m, pattern) => m.replace(new RegExp(pattern.source, 'g'), '[redacted]'), message);
}

// stripCode drops the backticks around a value written as `code`.
function stripCode(value) {
  return value.replace(/^`([^`]*)`$/, '$1').trim();
}

function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripCode(c.trim()));
}

// parseConfig reads the bullets `- key: value` (with two-space continuation
// lines) and the Lines table. Fenced code blocks are skipped.
export function parseConfig(text) {
  const keys = new Map();
  const duplicates = [];
  const lines = [];
  let linesTable = false;
  let current = null;
  // The open fence (its character and length): only the same character, at
  // least as long and with nothing after it, closes it, so a ``` snippet
  // inside a ~~~ example stays inside.
  let fence = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const marker = raw.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      const [, run, rest] = marker;
      if (!fence) fence = { char: run[0], length: run.length };
      else if (run[0] === fence.char && run.length >= fence.length && rest.trim() === '') fence = null;
      current = null;
      linesTable = false;
      continue;
    }
    if (fence) continue;
    const bullet = raw.match(/^- `?([a-z][a-z0-9_]*)`?:\s*(.*)$/);
    if (bullet) {
      const [, key, value] = bullet;
      if (keys.has(key)) duplicates.push(key);
      current = { key, value: value.trim() };
      keys.set(key, current);
      linesTable = false;
      continue;
    }
    if (current && /^ {2,}\S/.test(raw)) {
      current.value = `${current.value} ${raw.trim()}`.trim();
      continue;
    }
    current = null;
    if (/^\s*\|/.test(raw)) {
      const row = cells(raw);
      if (row.map((c) => c.toLowerCase()).join('|') === LINES_HEADER.join('|')) {
        linesTable = true;
      } else if (linesTable && !row.every((c) => /^:?-{3,}:?$/.test(c))) {
        lines.push({ line: row[0], label: row[1], option: row[2], po: row[3] });
      }
      continue;
    }
    // A Markdown table ends at the first line that is not a row, blank or not.
    linesTable = false;
  }
  const values = Object.fromEntries([...keys].map(([k, v]) => [k, stripCode(v.value)]));
  return { values, duplicates, lines };
}

const isNone = (v) => /^none\b/i.test(v);

// insideRoot is true when path is root or a folder below it (case-insensitive
// on Windows, where the file system is).
export function insideRoot(root, path) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(fold(resolve(root)), fold(resolve(path)));
  // A name such as ..state is inside; only a .. segment leaves root.
  return rel === '' || (rel !== '..' && !/^\.\.[\\/]/.test(rel) && !isAbsolute(rel));
}

// findRoot returns the nearest folder at or above dir that holds a .git
// entry (a folder, or the file of a worktree), or undefined. It runs no
// program: a git found from the checkout's folder could be the checkout's.
export function findRoot(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return undefined;
  }
}

// checkConfig returns { errors, warnings } for the config text. root, when
// given, is the repository's root folder, for the checks that need it.
export function checkConfig(text, { root } = {}) {
  const errors = [];
  const warnings = [];
  const { values, duplicates, lines } = parseConfig(text);

  for (const key of duplicates) errors.push(`${key} appears more than once`);
  for (const key of REQUIRED) {
    if (!values[key]) errors.push(`${key} is required`);
    else if (isNone(values[key])) errors.push(`${key} is required and cannot be none`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!KNOWN.has(key)) warnings.push(`${key} is not a schema key; agents read it as prose`);
    if (value === '') errors.push(`${key} has no value (write none to leave it empty)`);
    if (/^<[^>]+>$|^(TODO|TBD)\b/.test(value) || (REQUIRED.includes(key) && /<[a-z][a-z0-9 _-]*>/i.test(value))) {
      errors.push(`${key} still holds a placeholder`);
    }
  }
  if (values.project_number && !/^[1-9]\d*$/.test(values.project_number)) {
    errors.push('project_number must be a positive integer');
  }
  if (values.project_id && !/^PVT_[\w-]+$/.test(values.project_id)) errors.push('project_id must be a Project node id (PVT_...)');
  // A GitHub login: letters, digits and single inner hyphens, at most 39.
  if (values.project_owner && !/^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(values.project_owner)) {
    errors.push('project_owner must be a GitHub login');
  }
  for (const key of ['product_line_field', 'priority_field']) {
    const v = values[key];
    if (v && !isNone(v) && !/^PVTSSF_[A-Za-z0-9_-]+(?=$|[\s;(])/.test(v.replace(/`/g, ''))) {
      errors.push(`${key} must start with a board field id (PVTSSF_...) or be none`);
    }
  }
  // The PO sets board Priority with an option id, so each level needs one.
  const priority = values.priority_field;
  if (priority && !isNone(priority)) {
    const options = priority.replace(/`/g, '').split(';').slice(1).join(';');
    for (const level of ['Urgent', 'High', 'Normal', 'Low']) {
      if (!new RegExp(`\\b${level}\\s+\\S+`).test(options)) errors.push(`priority_field needs an option id for ${level} (<field id>; Urgent <id>, High <id>, Normal <id>, Low <id>)`);
    }
  }
  // The PO rolls items over and adds iterations of this length, so it needs
  // the iteration field's id and the sprint length in days.
  const sprint = values.sprint_field;
  if (sprint && !isNone(sprint)) {
    const v = sprint.replace(/`/g, '');
    if (!/^PVTIF_[A-Za-z0-9_-]+(?=$|[\s;(])/.test(v)) errors.push('sprint_field must start with an iteration field id (PVTIF_...) or be none');
    if (!/^[^;]*;\s*[^\s,;][^,;]*,\s*[1-9]\d*\s+days?\b/.test(v)) errors.push('sprint_field needs the field name and the sprint length (<field id>; <field name>, <n> days)');
  }
  for (const key of ['sub_sessions_normal', 'sub_sessions_max', 'check_in_minutes']) {
    const v = values[key];
    if (v !== undefined && !/^[1-9]\d*\b/.test(v)) errors.push(`${key} must start with a positive integer`);
  }
  // A count may carry a note after the number ("5 (owner cap)").
  const count = (key, fallback) => (values[key] === undefined ? fallback : parseInt(values[key], 10));
  const shown = (key, n) => `${n}${values[key] === undefined ? ', the default' : ''}`;
  const normal = count('sub_sessions_normal', 3);
  const max = count('sub_sessions_max', 5);
  if (normal > max) {
    errors.push(`sub_sessions_normal (${shown('sub_sessions_normal', normal)}) must not exceed sub_sessions_max (${shown('sub_sessions_max', max)})`);
  }
  if (values.draft_pr_first !== undefined && !/^(yes|no)\b/i.test(values.draft_pr_first)) {
    errors.push('draft_pr_first must be yes or no');
  }
  if (values.po_watchdog !== undefined && !/^(on|off)(?![\w-])/i.test(values.po_watchdog)) {
    errors.push('po_watchdog must be on or off');
  }
  // The PO passes an effort to start_session, which takes one of a fixed set
  // of levels, so another value would fail every dispatch; a note may follow
  // the level ("xhigh (owner, 2026-10-31)").
  for (const key of ['agent_effort', 'subagent_effort']) {
    const v = values[key];
    if (v !== undefined && !isNone(v) && !/^(low|medium|high|xhigh|max)(?![\w-])/i.test(v)) {
      errors.push(`${key} must start with low, medium, high, xhigh or max (or be none): a PO cannot pass another value as an effort`);
    }
  }
  // The check-in file is machine state, never committed, so its folder must
  // be outside the repository: absolute, a drive letter or home (~), and not
  // under the repository root when the caller knows it.
  const checkInDir = values.po_check_in_dir;
  if (checkInDir !== undefined) {
    if (!/^([A-Za-z]:[\\/]|[\\/]|~([\\/]|$))/.test(checkInDir)) {
      errors.push('po_check_in_dir must be an absolute or home (~) path outside the repository');
    } else if (root && insideRoot(root, checkInDir.replace(/^~(?=[\\/]|$)/, homedir()))) {
      errors.push('po_check_in_dir is inside the repository; use a folder outside it');
    }
  }
  if (values.production_branch && !isNone(values.production_branch)
      && values.integration_branch && values.production_branch === values.integration_branch) {
    errors.push('production_branch equals integration_branch; use none when the integration branch ships');
  }

  if (lines.length === 0) errors.push('the Lines table has no rows (header: | Line | Label | Product Line option id | PO session |)');
  // Rows are named by number: a message never repeats a value, which could
  // be a secret pasted in the wrong place.
  const labels = new Map();
  lines.forEach(({ line, label, option, po }, i) => {
    const row = `Lines row ${i + 1}`;
    if (!line) errors.push(`${row} has no line name`);
    if (!po) errors.push(`${row} has no PO session (write the session title, or none and who decides)`);
    if (!LABEL.test(label ?? '')) errors.push(`${row}: label must look like line:<slug>`);
    if (labels.has(label)) errors.push(`${row}: same label as row ${labels.get(label)}`);
    else labels.set(label, i + 1);
    if (option === undefined || option === '') errors.push(`${row}: option id is empty (write none)`);
    else if (!isNone(option) && (!values.product_line_field || isNone(values.product_line_field))) {
      errors.push(`${row}: has an option id but product_line_field is none`);
    }
  });

  // The sprint review runs at a sprint's end, audits each line's scope and
  // writes one dated report per line and sprint.
  const review = values.sprint_review;
  const reviewOn = review !== undefined && /^on(?![\w-])/i.test(review);
  if (review !== undefined && !/^(on|off)(?![\w-])/i.test(review)) errors.push('sprint_review must be on or off');
  if (reviewOn && (!values.sprint_field || isNone(values.sprint_field))) errors.push('sprint_review is on but sprint_field is none');
  const scopes = values.line_scopes;
  const scoped = new Map();
  if (scopes && !isNone(scopes)) {
    parseScopes(scopes).forEach(({ label, paths }, i) => {
      const entry = `line_scopes entry ${i + 1}`;
      if (!label) errors.push(`${entry} must start with a line label (<label>: <paths>)`);
      else if (!labels.has(label)) errors.push(`${entry}: its label is not in the Lines table`);
      else if (scoped.has(label)) errors.push(`${entry}: same label as entry ${scoped.get(label)}`);
      else scoped.set(label, i + 1);
      // The audit reads these paths from a snapshot of the repository, so
      // each must stay inside it.
      if (scopePaths(paths).some(outsidePath)) {
        errors.push(`${entry}: paths must be relative to the repository, without .. (no absolute, drive-letter, home or environment-variable paths)`);
      }
    });
  }
  if (reviewOn) {
    lines.forEach(({ label, po }, i) => {
      if (LABEL.test(label ?? '') && po && !isNone(po) && !scoped.has(label)) {
        warnings.push(`Lines row ${i + 1} has a PO session but no line_scopes entry, so its sprint review audits no scope`);
      }
    });
  }
  const report = values.sprint_review_report;
  if (report !== undefined && isNone(report) && reviewOn) errors.push('sprint_review is on but sprint_review_report is none');
  if (report !== undefined && !isNone(report)) {
    const [rawPath, ...rest] = report.split(';');
    const path = rawPath.replace(/`/g, '').trim();
    if (!path.includes('<YYYY-MM-DD>') || !path.includes('<line>')) {
      errors.push('sprint_review_report needs a path template with <YYYY-MM-DD> and <line> (<path template>; <format>)');
    }
    // The report is committed through a PR, so it must land inside the
    // repository: a relative path with no .. segment and no spaces.
    if (/\s/.test(path) || outsidePath(path)) {
      errors.push('sprint_review_report path must be relative to the repository, without .. or spaces');
    }
    if (!rest.join(';').trim()) errors.push('sprint_review_report needs a format after the path (<path template>; <format>)');
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) errors.push(`the config holds something shaped like a credential (${pattern}); remove it`);
  }
  return { errors: errors.map(redact), warnings: warnings.map(redact) };
}

function main(argv) {
  const path = argv[0] ?? 'docs/product-owner-config.md';
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`cannot read ${path}: ${err.message}`);
    return 2;
  }
  const { errors, warnings } = checkConfig(text, { root: findRoot(dirname(resolve(path))) });

  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  if (errors.length) {
    console.error(`${path}: ${errors.length} error(s); see config-schema.md`);
    return 1;
  }
  const { values, lines } = parseConfig(text);
  console.log(`${path}: valid (${Object.keys(values).length} keys, ${lines.length} line(s))`);
  return 0;
}

// Run only as a script, not when imported. argv[1] may not be a real path
// (a REPL, `node -e`, some runners); then this file is not the script.
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
