#!/usr/bin/env node
// Advises CC-PO Product Owners and orchestrators on rolling model series and
// effort per role, inspects docs/product-owner-config.md and runtime/swarm
// hints, and flags stale pinned minor versions without hardcoding future
// release numbers as mandatory. No external dependencies.
//
//   node po-model-advisor.mjs [--config path] [--role po|worker|gatekeeper|watchdog|reviewer|security-reviewer|explorer]
//                             [--model <spec>] [--runtime claude|antigravity|codex]
//                             [--swarm-models <json-or-csv>] [--tasks-dir <dir>] [--json] [--strict]
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from './check-config.mjs';

export const ROLE_DEFAULTS = Object.freeze({
  po: Object.freeze({
    series: 'sonnet',
    effort: 'high',
    antigravity: 'inherit (Orchestrator (Neon), Orchestrator (Carbon), Gemini 4 Neon, or Gemini 4 Carbon)',
    reason: 'PO triage and coordination need strong reasoning without flagship-only cost',
  }),
  worker: Object.freeze({
    series: 'sonnet',
    effort: 'high',
    antigravity: 'inherit (or agent_model Antigravity clause)',
    reason: 'Code, docs, pricing, and config changes keep quality and delivery first',
  }),
  gatekeeper: Object.freeze({
    series: 'haiku',
    effort: 'low',
    antigravity: 'agy-gatekeeper.mjs (zero model tokens)',
    reason: 'Gatekeeper wakes run read-only status checks on the cheapest rolling series',
  }),
  watchdog: Object.freeze({
    series: 'haiku',
    effort: 'low',
    antigravity: 'schedule sidecar (zero model tokens)',
    reason: 'Watchdog wakes only compare timestamps and send one wake message',
  }),
  reviewer: Object.freeze({
    series: 'sonnet',
    effort: 'high',
    antigravity: 'TypeName: "research", Model: "inherit"',
    reason: 'Independent spec-vs-diff review at high effort',
  }),
  'security-reviewer': Object.freeze({
    series: 'opus',
    effort: 'high',
    antigravity: 'Claude Opus, Gemini 4 Neon (High/XHigh), Gemini 4 Carbon, or Orchestrator (Neon/Carbon) research subagent',
    reason: 'Auth, billing, RLS, secrets, and Production gates require flagship tier',
  }),
  explorer: Object.freeze({
    series: 'haiku',
    effort: 'low',
    antigravity: 'flash_lite or flash',
    reason: 'Fast read-only issue, PR, and codebase scouting',
  }),
});

const ROLLING_SERIES_RE = /^(opus|sonnet|haiku|default|inherit)(\[[a-z0-9]+\])?$/i;
const FAMILY_ALIAS_RE = /^family:([a-z0-9][a-z0-9._[\]-]*)$/i;
const ANTIGRAVITY_MODELS = new Set([
  'flash_lite',
  'flash',
  'pro',
  'gemini-pro-orchestrator',
  'gemini-pro-orchestrator-argon',
  'gemini-pro-orchestrator-neon',
  'gemini-4-neon-medium',
  'gemini-4-neon-high',
  'gemini-4-neon-xhigh',
  'gemini-4-hydrogen-high',
]);

// Matches pinned vendor snapshots such as claude-haiku-5-5, claude-sonnet-4-5,
// claude-opus-4-6-20260501, claude-3-5-sonnet-20241022, or dated snapshots.
const CLAUDE_SERIES_SNAPSHOT_RE = /^claude-(opus|sonnet|haiku)-\d+(?:[.-]\d+)+(?:-\d{8})?(?:\[[a-z0-9]+\])?$/i;
const CLAUDE_LEGACY_SNAPSHOT_RE = /^claude-\d+(?:[.-]\d+)-(opus|sonnet|haiku)(?:-\d{8})?(?:\[[a-z0-9]+\])?$/i;
const DATED_SNAPSHOT_RE = /-\d{8}(?:\[[a-z0-9]+\])?$|\b\d{4}-\d{2}-\d{2}$/;

function stripQuotes(raw) {
  let s = String(raw ?? '').trim();
  for (let i = 0; i < 2; i += 1) {
    if (
      (s.startsWith('`') && s.endsWith('`'))
      || (s.startsWith('"') && s.endsWith('"'))
      || (s.startsWith("'") && s.endsWith("'"))
    ) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

export function extractAntigravityClause(rawValue) {
  const m = String(rawValue ?? '').match(/\(\s*Antigravity:\s*([^)]+(?:\([^)]*\)[^)]*)*)\)/i);
  return m ? m[1].trim() : null;
}

export function classifyModelSpec(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw || /^none\b/i.test(raw)) {
    return { raw, head: '', kind: 'none', stale: false, suggestedSeries: null, note: '' };
  }
  const clean = stripQuotes(raw);
  const match = clean.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const head = (match?.[1] ?? '').replace(/`+$/g, '');
  const note = (match?.[2] ?? '').trim();
  const antigravityClause = extractAntigravityClause(clean);

  const rolling = head.match(ROLLING_SERIES_RE);
  if (rolling) {
    return {
      raw,
      head,
      kind: 'rolling-series',
      series: rolling[1].toLowerCase(),
      stale: false,
      suggestedSeries: rolling[1].toLowerCase(),
      note,
      antigravityClause,
    };
  }

  const family = head.match(FAMILY_ALIAS_RE);
  if (family) {
    const fam = family[1].toLowerCase();
    const seriesHint = fam.match(/\b(opus|sonnet|haiku)\b/)?.[1] ?? fam;
    return {
      raw,
      head,
      kind: 'family-alias',
      family: fam,
      stale: false,
      suggestedSeries: seriesHint,
      note,
      antigravityClause,
    };
  }

  const claudeSnap = head.match(CLAUDE_SERIES_SNAPSHOT_RE) || head.match(CLAUDE_LEGACY_SNAPSHOT_RE);
  if (claudeSnap) {
    const series = claudeSnap[1].toLowerCase();
    return {
      raw,
      head,
      kind: 'pinned-snapshot',
      series,
      stale: true,
      suggestedSeries: series,
      note,
      antigravityClause,
      reason: `Pinned minor/snapshot model '${head}' drifts on model updates; prefer rolling series '${series}' or 'family:${series}'.`,
    };
  }

  if (DATED_SNAPSHOT_RE.test(head)) {
    const seriesHint = head.match(/(opus|sonnet|haiku)/i)?.[1]?.toLowerCase() ?? 'default';
    return {
      raw,
      head,
      kind: 'pinned-snapshot',
      series: seriesHint,
      stale: true,
      suggestedSeries: seriesHint,
      note,
      antigravityClause,
      reason: `Dated snapshot '${head}' freezes an aging point-in-time build; prefer rolling series '${seriesHint}' or 'family:${seriesHint}'.`,
    };
  }

  if (ANTIGRAVITY_MODELS.has(head.toLowerCase())) {
    return {
      raw,
      head,
      kind: 'antigravity-id',
      stale: false,
      suggestedSeries: head.toLowerCase(),
      note,
      antigravityClause,
    };
  }

  return {
    raw,
    head,
    kind: 'exact-id',
    stale: false,
    suggestedSeries: head.match(/(opus|sonnet|haiku)/i)?.[1]?.toLowerCase() ?? null,
    note,
    antigravityClause,
  };
}

export function parseSwarmModelsHint(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((x) => String(x).trim()).filter(Boolean);
  const text = String(input).trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === 'string' ? item : (item?.id || item?.name || item?.model || '')))
          .map((s) => String(s).trim())
          .filter(Boolean);
      }
      if (parsed && typeof parsed === 'object') {
        const list = parsed.models || parsed.available || [];
        if (Array.isArray(list)) {
          return list
            .map((item) => (typeof item === 'string' ? item : (item?.id || item?.name || item?.model || '')))
            .map((s) => String(s).trim())
            .filter(Boolean);
        }
      }
    } catch {
      // Fall through to comma-separated parsing.
    }
  }
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

export function inspectScheduledTasksDir(tasksDir) {
  const findings = [];
  if (!tasksDir || !existsSync(tasksDir)) return findings;
  let entries = [];
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return findings;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(tasksDir, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    let text;
    try {
      text = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      continue;
    }
    const isPoWake = /-po-(gatekeeper|watchdog)(-\d+)?$/i.test(entry.name)
      || /You are the (?:gatekeeper|watchdog) of the /i.test(text);
    if (!isPoWake) continue;

    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const modelLine = fm ? fm[1].match(/^model:\s*(.+)$/m) : null;
    if (!modelLine || !modelLine[1].trim()) {
      findings.push({
        taskId: entry.name,
        skillPath,
        status: 'missing-model',
        severity: 'warning',
        message: `Task '${entry.name}' has no model: frontmatter; add 'model: haiku' so runs use the cheapest rolling series.`,
      });
      continue;
    }
    const spec = classifyModelSpec(modelLine[1].trim());
    if (spec.stale) {
      findings.push({
        taskId: entry.name,
        skillPath,
        status: 'stale-pinned-model',
        severity: 'warning',
        model: spec.head,
        suggested: spec.suggestedSeries || 'haiku',
        message: `Task '${entry.name}' pins '${spec.head}'; replace with rolling '${spec.suggestedSeries || 'haiku'}'.`,
      });
    }
  }
  return findings;
}

export function adviseModels({
  configText = null,
  configPath = null,
  role = null,
  model = null,
  runtime = 'claude',
  swarmModels = null,
  tasksDir = null,
} = {}) {
  const warnings = [];
  const recommendations = {};
  const entries = role ? [[role, ROLE_DEFAULTS[role]]] : Object.entries(ROLE_DEFAULTS);

  for (const [roleName, spec] of entries) {
    if (!spec) {
      warnings.push(`Unknown role '${roleName}'; expected one of: ${Object.keys(ROLE_DEFAULTS).join(', ')}`);
      continue;
    }
    recommendations[roleName] = { ...spec };
  }

  let resolvedConfigText = configText;
  if (resolvedConfigText === null && configPath) {
    if (existsSync(configPath)) {
      resolvedConfigText = readFileSync(configPath, 'utf8');
    } else {
      warnings.push(`Config file not found: ${configPath}`);
    }
  }

  const configInspection = {};
  if (typeof resolvedConfigText === 'string') {
    const { values } = parseConfig(resolvedConfigText);
    for (const key of ['agent_model', 'gatekeeper_model']) {
      if (values[key] === undefined) continue;
      const info = classifyModelSpec(values[key]);
      configInspection[key] = info;
      if (info.stale) {
        warnings.push(`${key}: ${info.reason}`);
      }
      if (runtime === 'antigravity' && key === 'agent_model') {
        if (info.antigravityClause) {
          configInspection.antigravityMapping = info.antigravityClause;
        } else if (info.kind === 'rolling-series' || info.kind === 'pinned-snapshot' || info.kind === 'family-alias') {
          configInspection.antigravityMapping = 'inherit (or pin flash_lite/flash/pro when needed)';
        }
      }
    }
    if (values.agent_effort) configInspection.agent_effort = values.agent_effort;
    if (values.subagent_effort) configInspection.subagent_effort = values.subagent_effort;
  }

  let modelInspection = null;
  if (model !== null && model !== undefined && String(model).trim() !== '') {
    modelInspection = classifyModelSpec(model);
    if (modelInspection.stale) {
      warnings.push(`model argument: ${modelInspection.reason}`);
    }
  }

  const taskFindings = tasksDir ? inspectScheduledTasksDir(tasksDir) : [];
  for (const finding of taskFindings) {
    warnings.push(finding.message);
  }

  const availableSwarm = parseSwarmModelsHint(swarmModels);
  const swarmHints = {};
  if (availableSwarm.length > 0) {
    swarmHints.available = availableSwarm;
    const findMatch = (patterns) => {
      for (const pattern of patterns) {
        const hit = availableSwarm.find((m) => pattern.test(m));
        if (hit) return hit;
      }
      return null;
    };
    swarmHints.byRole = {
      po: findMatch([/orchestrator.*neon/i, /orchestrator/i, /neon-high/i, /carbon/i, /sonnet/i, /\bpro\b/i]) || 'inherit',
      explorer: findMatch([/flash_lite/i, /\bflash\b/i, /haiku/i]) || 'flash_lite',
      reviewer: findMatch([/research/i, /neon-high/i, /sonnet/i, /carbon/i, /\bpro\b/i]) || 'inherit',
      'security-reviewer': findMatch([/opus/i, /neon-high/i, /neon-xhigh/i, /carbon/i, /orchestrator(?!.*argon)/i]) || 'inherit',
    };
  }

  return {
    runtime,
    recommendations,
    configInspection,
    modelInspection,
    taskFindings,
    swarmHints,
    warnings,
  };
}

export function formatAdviceText(report) {
  const lines = [`CC-PO Model Advisor (runtime: ${report.runtime})`];
  lines.push('Recommended rolling series & effort by role:');
  for (const [roleName, spec] of Object.entries(report.recommendations)) {
    const target = report.runtime === 'antigravity' ? spec.antigravity : `${spec.series} (effort: ${spec.effort})`;
    lines.push(`  - ${roleName}: ${target} — ${spec.reason}`);
  }
  if (Object.keys(report.configInspection).length > 0) {
    lines.push('Config model inspection:');
    for (const [key, val] of Object.entries(report.configInspection)) {
      if (typeof val === 'string') lines.push(`  - ${key}: ${val}`);
      else lines.push(`  - ${key}: ${val.head || 'none'} (${val.kind}${val.stale ? ', STALE' : ''})`);
    }
  }
  if (report.modelInspection) {
    const m = report.modelInspection;
    lines.push(`Checked model '${m.head}': ${m.kind}${m.stale ? ` (stale; prefer ${m.suggestedSeries})` : ''}`);
  }
  if (report.swarmHints.available) {
    lines.push(`Swarm/runtime models detected: ${report.swarmHints.available.join(', ')}`);
  }
  if (report.warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of report.warnings) lines.push(`  - ${w}`);
  } else {
    lines.push('Status: clean (no stale pinned minor versions detected).');
  }
  return lines.join('\n');
}

function parseCliArgs(argv) {
  const opts = {
    configPath: existsSync('docs/product-owner-config.md') ? 'docs/product-owner-config.md' : null,
    role: null,
    model: null,
    runtime: 'claude',
    swarmModels: null,
    tasksDir: null,
    json: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--default-tasks-dir') opts.tasksDir = join(homedir(), '.claude', 'scheduled-tasks');
    else if (arg === '--config') {
      if (!argv[i + 1]) throw new Error('--config requires a path');
      opts.configPath = argv[++i];
    } else if (arg.startsWith('--config=')) opts.configPath = arg.slice(9);
    else if (arg === '--role') {
      if (!argv[i + 1]) throw new Error('--role requires a value');
      opts.role = argv[++i];
    } else if (arg.startsWith('--role=')) opts.role = arg.slice(7);
    else if (arg === '--model') {
      if (!argv[i + 1]) throw new Error('--model requires a value');
      opts.model = argv[++i];
    } else if (arg.startsWith('--model=')) opts.model = arg.slice(8);
    else if (arg === '--runtime') {
      if (!argv[i + 1]) throw new Error('--runtime requires a value');
      opts.runtime = argv[++i];
    } else if (arg.startsWith('--runtime=')) opts.runtime = arg.slice(10);
    else if (arg === '--swarm-models') {
      if (!argv[i + 1]) throw new Error('--swarm-models requires a value');
      opts.swarmModels = argv[++i];
    } else if (arg.startsWith('--swarm-models=')) opts.swarmModels = arg.slice(15);
    else if (arg === '--tasks-dir') {
      if (!argv[i + 1]) throw new Error('--tasks-dir requires a directory');
      opts.tasksDir = argv[++i];
    } else if (arg.startsWith('--tasks-dir=')) opts.tasksDir = arg.slice(12);
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`usage error: ${err.message}\n`);
    process.exit(2);
  }
  const report = adviseModels(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatAdviceText(report)}\n`);
  }
  if (opts.strict && report.warnings.length > 0) {
    process.exitCode = 1;
  }
}
