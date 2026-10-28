#!/usr/bin/env node
// Checks a repository's Product Owner config (docs/product-owner-config.md)
// against config-schema.md, next to this file. No dependencies.
//
//   node check-config.mjs [path]     default path: docs/product-owner-config.md
//
// Exit 0 when the config is valid (warnings may still print), 1 when it has
// errors, 2 when the file cannot be read.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REQUIRED = ['owner_name', 'project_owner', 'project_number', 'project_id'];

export const KNOWN = new Set([
  ...REQUIRED,
  'owner_profile', 'report_language', 'agent_account',
  'project_url', 'product_line_field', 'priority_field', 'bot_owned_fields',
  'issue_types', 'org_priority_field', 'org_effort_field', 'issue_notes',
  'agent_instructions', 'task_scope', 'tracking_doc', 'review_rules', 'domain_rules',
  'roadmap_sources', 'setup_guide',
  'integration_branch', 'integration_merge', 'default_branch', 'draft_pr_first',
  'production_branch', 'production_merge', 'production_effect', 'promotion_notes',
  'test_environment', 'done_definition',
  'required_checks', 'claim_gate', 'external_review_app', 'local_reviews',
  'promotion_reviews', 'agent_effort',
  'sub_sessions_normal', 'sub_sessions_max', 'check_in_minutes', 'executors',
]);

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
  let fenced = false;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      current = null;
      linesTable = false;
      continue;
    }
    if (fenced) continue;
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

// checkConfig returns { errors, warnings } for the config text.
export function checkConfig(text) {
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
  if (values.project_owner && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(values.project_owner)) {
    errors.push('project_owner must be a GitHub login');
  }
  for (const key of ['product_line_field', 'priority_field']) {
    const v = values[key];
    if (v && !isNone(v) && !/^PVTS?SF_\w+/.test(v.replace(/`/g, ''))) errors.push(`${key} must start with a board field id (PVTSSF_...) or be none`);
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
  if (values.production_branch && !isNone(values.production_branch)
      && values.integration_branch && values.production_branch === values.integration_branch) {
    errors.push('production_branch equals integration_branch; use none when the integration branch ships');
  }

  if (lines.length === 0) errors.push('the Lines table has no rows (header: | Line | Label | Product Line option id | PO session |)');
  // Rows are named by number: a message never repeats a value, which could
  // be a secret pasted in the wrong place.
  const labels = new Map();
  lines.forEach(({ line, label, option }, i) => {
    const row = `Lines row ${i + 1}`;
    if (!line) errors.push(`${row} has no line name`);
    if (!/^line:[a-z0-9][a-z0-9-]*$/.test(label ?? '')) errors.push(`${row}: label must look like line:<slug>`);
    if (labels.has(label)) errors.push(`${row}: same label as row ${labels.get(label)}`);
    else labels.set(label, i + 1);
    if (option === undefined || option === '') errors.push(`${row}: option id is empty (write none)`);
    else if (!isNone(option) && (!values.product_line_field || isNone(values.product_line_field))) {
      errors.push(`${row}: has an option id but product_line_field is none`);
    }
  });

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
  const { errors, warnings } = checkConfig(text);
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
