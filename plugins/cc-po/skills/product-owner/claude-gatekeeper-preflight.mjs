#!/usr/bin/env node
// Preflight verifier for Claude Code scheduled PO gatekeeper/watchdog tasks.
// Inspects scheduled task SKILL.md headers (default ~/.claude/scheduled-tasks),
// verifies rolling `model: haiku` frontmatter (flagging missing model: or
// brittle snapshots like claude-haiku-5-5), and cross-checks
// ~/.claude/po-state/watchdog-approval.md so intentional multi-account -2
// tasks are recognized as valid rather than reported as duplicates.
//
//   node claude-gatekeeper-preflight.mjs [--tasks-dir <dir>] [--approval-file <path>] [--json] [--advisory]
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyModelSpec } from './po-model-advisor.mjs';

export function expandHome(filePath, home = homedir()) {
  if (typeof filePath !== 'string') return '';
  if (filePath === '~') return home;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

export function parseTaskSkill(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/);
  if (!fmMatch) {
    return { frontmatter: {}, body: normalized, hasFrontmatter: false };
  }
  const frontmatter = {};
  for (const rawLine of fmMatch[1].split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).trim();
    }
    frontmatter[key] = val;
  }
  return { frontmatter, body: fmMatch[2] ?? '', hasFrontmatter: true };
}

export function extractRepoFromTaskBody(body) {
  const text = String(body ?? '');
  const patterns = [
    /\bof the ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) repository\b/i,
    /\bfor the ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) repository\b/i,
    /\bgh pr list\s+--repo(?:=|\s+)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/i,
    /\bPO (?:gatekeeper|watchdog) \(([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] && m[1] !== '<owner/repo>') return m[1];
  }
  return null;
}

export function parseWatchdogApprovals(approvalText) {
  const approvedTaskIds = new Set();
  const multiAccountTaskIds = new Set();
  const multiAccountRepos = new Set();

  if (typeof approvalText !== 'string' || !approvalText.trim()) {
    return { approvedTaskIds, multiAccountTaskIds, multiAccountRepos };
  }

  for (const rawLine of approvalText.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!/\bapproved\b/i.test(line) || /\b(?:declined|denied|revoked|rejected)\b/i.test(line)) continue;

    const repoMatch = line.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
    const isMultiAccountLine = /\b(?:second(?:\s+app)?\s+account|multi-account|another\s+account)\b/i.test(line);

    for (const m of line.matchAll(/\btask\s+id\s+`?([a-z0-9-]+)`?/gi)) {
      const id = m[1].toLowerCase();
      approvedTaskIds.add(id);
      if (isMultiAccountLine || /-\d+$/.test(id)) {
        multiAccountTaskIds.add(id);
      }
    }

    for (const m of line.matchAll(/`([a-z0-9-]+-po-(?:gatekeeper|watchdog)(?:-\d+)?)`/gi)) {
      const id = m[1].toLowerCase();
      approvedTaskIds.add(id);
      if (/-\d+$/.test(id)) multiAccountTaskIds.add(id);
    }

    if (isMultiAccountLine && repoMatch) {
      multiAccountRepos.add(repoMatch[1].toLowerCase());
    }
  }

  return { approvedTaskIds, multiAccountTaskIds, multiAccountRepos };
}

export function inspectScheduledGatekeepers({
  tasksDir = join(homedir(), '.claude', 'scheduled-tasks'),
  approvalFile = join(homedir(), '.claude', 'po-state', 'watchdog-approval.md'),
  includeAll = false,
} = {}) {
  const resolvedTasksDir = expandHome(tasksDir);
  const resolvedApprovalFile = expandHome(approvalFile);
  const approvalFileExists = existsSync(resolvedApprovalFile);
  const approvalText = approvalFileExists ? readFileSync(resolvedApprovalFile, 'utf8') : '';
  const approvals = parseWatchdogApprovals(approvalText);

  const tasks = [];
  const issues = [];

  if (!existsSync(resolvedTasksDir)) {
    return {
      tasksDir: resolvedTasksDir,
      approvalFile: resolvedApprovalFile,
      approvalFileExists,
      tasks,
      issues,
      ok: true,
    };
  }

  const entries = readdirSync(resolvedTasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const skillPath = join(resolvedTasksDir, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    const raw = readFileSync(skillPath, 'utf8');
    const parsed = parseTaskSkill(raw);
    const taskId = (parsed.frontmatter.name || entry.name).trim();
    const isPoWake = /-po-(gatekeeper|watchdog)(-\d+)?$/i.test(taskId)
      || /-po-(gatekeeper|watchdog)(-\d+)?$/i.test(entry.name)
      || /You are the (?:gatekeeper|watchdog) of /i.test(parsed.body);

    if (!includeAll && !isPoWake) continue;

    const kind = /watchdog/i.test(taskId) || /You are the watchdog/i.test(parsed.body)
      ? 'watchdog'
      : 'gatekeeper';
    const repo = extractRepoFromTaskBody(parsed.body);
    const baseTaskId = entry.name.toLowerCase().replace(/-\d+$/, '');
    const accountSuffixMatch = entry.name.match(/-(\d+)$/);
    const accountIndex = accountSuffixMatch ? Number.parseInt(accountSuffixMatch[1], 10) : 1;
    const rawModel = parsed.frontmatter.model ?? '';
    const modelSpec = classifyModelSpec(rawModel);

    let modelStatus = 'ok';
    if (!rawModel) {
      modelStatus = 'missing-model';
      issues.push({
        code: 'missing-model',
        severity: 'error',
        taskId: entry.name,
        skillPath,
        message: `Task '${entry.name}' is missing \`model:\` frontmatter; add \`model: haiku\`.`,
      });
    } else if (modelSpec.stale) {
      modelStatus = 'pinned-snapshot';
      issues.push({
        code: 'pinned-snapshot',
        severity: 'error',
        taskId: entry.name,
        skillPath,
        model: modelSpec.head,
        suggested: 'haiku',
        message: `Task '${entry.name}' uses brittle pinned model \`${modelSpec.head}\`; update frontmatter to rolling \`model: haiku\`.`,
      });
    } else if (
      !(
        (modelSpec.kind === 'rolling-series' && modelSpec.series === 'haiku')
        || (modelSpec.kind === 'family-alias' && modelSpec.family === 'haiku')
      )
    ) {
      modelStatus = 'non-haiku-model';
      issues.push({
        code: 'non-haiku-model',
        severity: 'warning',
        taskId: entry.name,
        skillPath,
        model: modelSpec.head,
        suggested: 'haiku',
        message: `Task '${entry.name}' uses \`model: ${modelSpec.head}\` instead of rolling \`haiku\`.`,
      });
    }

    const idLower = entry.name.toLowerCase();
    const repoLower = repo ? repo.toLowerCase() : '';
    const multiAccountApproved = accountIndex > 1 && (
      approvals.multiAccountTaskIds.has(idLower)
      || approvals.approvedTaskIds.has(idLower)
      || (repoLower && approvals.multiAccountRepos.has(repoLower))
    );

    tasks.push({
      taskId: entry.name,
      frontmatterName: parsed.frontmatter.name || null,
      kind,
      repo,
      baseTaskId,
      accountIndex,
      model: rawModel || null,
      modelKind: modelSpec.kind,
      modelStatus,
      multiAccountApproved,
      skillPath,
    });
  }

  // Group gatekeepers per repository (1 shared gatekeeper per repo), and
  // watchdogs per line baseTaskId (1 watchdog per line), so multi-line
  // watchdog setups are not flagged as duplicate while -2 multi-account
  // tasks still require approval in watchdog-approval.md.
  const groups = new Map();
  for (const task of tasks) {
    const groupKey = task.kind === 'gatekeeper'
      ? `gatekeeper:${(task.repo || task.baseTaskId).toLowerCase()}`
      : `watchdog:${task.baseTaskId.toLowerCase()}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(task);
  }

  for (const [, groupTasks] of groups) {
    if (groupTasks.length <= 1) continue;
    for (const task of groupTasks) {
      if (task.accountIndex > 1 && task.multiAccountApproved) {
        task.duplicateStatus = 'valid-multi-account';
        continue;
      }
      if (task.accountIndex === 1) {
        const allOthersApproved = groupTasks
          .filter((other) => other.taskId !== task.taskId)
          .every((other) => other.accountIndex > 1 && other.multiAccountApproved);
        if (allOthersApproved) {
          task.duplicateStatus = 'primary-with-approved-secondary';
          continue;
        }
      }
      task.duplicateStatus = 'unapproved-duplicate';
      issues.push({
        code: 'duplicate-task',
        severity: 'warning',
        taskId: task.taskId,
        repo: task.repo,
        skillPath: task.skillPath,
        message: `Task '${task.taskId}' shares ${task.repo || task.baseTaskId} (${task.kind}) with another scheduled task without a multi-account approval entry in watchdog-approval.md.`,
      });
    }
  }

  return {
    tasksDir: resolvedTasksDir,
    approvalFile: resolvedApprovalFile,
    approvalFileExists,
    tasks,
    issues,
    ok: issues.length === 0,
  };
}

export function formatPreflightText(report) {
  const lines = [`CC-PO Gatekeeper Preflight (${report.tasksDir})`];
  if (report.tasks.length === 0) {
    lines.push('No PO gatekeeper/watchdog scheduled tasks found.');
    return lines.join('\n');
  }
  for (const task of report.tasks) {
    const acctTag = task.duplicateStatus === 'valid-multi-account'
      ? ' [multi-account approved]'
      : (task.duplicateStatus === 'unapproved-duplicate' ? ' [DUPLICATE]' : '');
    lines.push(`- ${task.taskId} (${task.kind}${task.repo ? `, ${task.repo}` : ''}): model=${task.model || 'MISSING'} [${task.modelStatus}]${acctTag}`);
  }
  if (report.issues.length > 0) {
    lines.push('Issues:');
    for (const issue of report.issues) {
      lines.push(`  - [${issue.severity}] ${issue.message}`);
    }
  } else {
    lines.push('Status: ok (all scheduled PO tasks use rolling haiku and multi-account entries are validated).');
  }
  return lines.join('\n');
}

export function parseCliArgs(argv) {
  const opts = {
    tasksDir: join(homedir(), '.claude', 'scheduled-tasks'),
    approvalFile: join(homedir(), '.claude', 'po-state', 'watchdog-approval.md'),
    includeAll: false,
    json: false,
    advisory: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--all') opts.includeAll = true;
    else if (arg === '--advisory') opts.advisory = true;
    else if (arg === '--tasks-dir') {
      if (!argv[i + 1]) throw new Error('--tasks-dir requires a directory');
      opts.tasksDir = argv[++i];
    } else if (arg.startsWith('--tasks-dir=')) {
      opts.tasksDir = arg.slice(12);
    } else if (arg === '--approval-file') {
      if (!argv[i + 1]) throw new Error('--approval-file requires a path');
      opts.approvalFile = argv[++i];
    } else if (arg.startsWith('--approval-file=')) {
      opts.approvalFile = arg.slice(16);
    } else if (arg === '--po-state-dir') {
      if (!argv[i + 1]) throw new Error('--po-state-dir requires a directory');
      opts.approvalFile = join(argv[++i], 'watchdog-approval.md');
    } else if (arg.startsWith('--po-state-dir=')) {
      opts.approvalFile = join(arg.slice(15), 'watchdog-approval.md');
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
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
  const report = inspectScheduledGatekeepers(opts);
  process.stdout.write(`${opts.json ? JSON.stringify(report, null, 2) : formatPreflightText(report)}\n`);
  if (!opts.advisory && !report.ok) {
    process.exitCode = 1;
  }
}
