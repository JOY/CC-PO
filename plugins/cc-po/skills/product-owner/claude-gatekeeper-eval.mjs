#!/usr/bin/env node
// 0-token multi-signal gatekeeper evaluator for Claude Desktop's Thin Haiku Relay.
// Shares the evaluation engine in gatekeeper-core.mjs with Antigravity.
// Zero external dependencies, pure ESM Node.
//
// Usage:
//   node claude-gatekeeper-eval.mjs --repo <owner/repo> --pos-json '<json>' \
//     [--sessions-stdin | --sessions-file <path> | --sessions-json '<json>'] \
//     [--state-file <path> [--commit-state]] \
//     [--heartbeat-active 180] [--heartbeat-idle 720] [--owner <name>] [--language <lang>] [--json]
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HEARTBEAT_ACTIVE_MINUTES,
  DEFAULT_HEARTBEAT_IDLE_MINUTES,
  DEFAULT_SUB_SESSIONS_NORMAL,
  DEFAULT_SUBAGENT_STALL_MINUTES,
  evaluateSignals,
  expandHome,
  parseTimeMs,
  readJsonState,
  writeJsonStateAtomic,
} from './gatekeeper-core.mjs';

const REPO_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const QUOTA_RE = /quota|rate[_\s-]?limit|429|exhausted|capacity|overloaded/i;

function cleanTitle(title) {
  return String(title ?? '').replace(/[|\r\n]+/g, ' ').trim();
}

export function getClaudeRestartTimes(platform = process.platform, execSync = spawnSync) {
  const bootIso = new Date(Date.now() - uptime() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  if (platform === 'win32') {
    const res = execSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$b = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); $p = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.StartTime } | Sort-Object StartTime | Select-Object -First 1; Write-Output \"BOOT=$b\"; Write-Output (\"APP=\" + $(if ($p -and $p.StartTime) { $p.StartTime.ToUniversalTime().ToString('o') } else { '' }))",
      ],
      { encoding: 'utf8', shell: false, timeout: 15_000 },
    );
    if (res.status === 0 && res.stdout) {
      let bootTime = bootIso;
      let appStartTime = '';
      for (const raw of res.stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('BOOT=') && line.length > 5) bootTime = line.slice(5);
        else if (line.startsWith('APP=')) appStartTime = line.slice(4);
      }
      return { bootTime, appStartTime };
    }
    return { bootTime: bootIso, appStartTime: '' };
  }

  if (platform === 'darwin') {
    let appStartTime = '';
    const pg = execSync('pgrep', ['-ox', 'Claude'], { encoding: 'utf8', shell: false, timeout: 5_000 });
    if (pg.status === 0 && pg.stdout) {
      const pid = pg.stdout.trim().split(/\s+/)[0];
      if (pid && /^\d+$/.test(pid)) {
        const ps = execSync('ps', ['-o', 'lstart=', '-p', pid], {
          encoding: 'utf8',
          shell: false,
          timeout: 5_000,
          env: { ...process.env, LC_ALL: 'C' },
        });
        if (ps.status === 0 && ps.stdout?.trim()) {
          const d = new Date(ps.stdout.trim());
          if (!Number.isNaN(d.getTime())) {
            appStartTime = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
          }
        }
      }
    }
    return { bootTime: bootIso, appStartTime };
  }

  if (platform === 'linux') {
    let appStartTime = '';
    const pg = execSync('pgrep', ['-ox', 'claude'], { encoding: 'utf8', shell: false, timeout: 5_000 });
    if (pg.status === 0 && pg.stdout) {
      const pid = pg.stdout.trim().split(/\s+/)[0];
      if (pid && /^\d+$/.test(pid)) {
        const ps = execSync('ps', ['-o', 'etimes=', '-p', pid], { encoding: 'utf8', shell: false, timeout: 5_000 });
        if (ps.status === 0 && ps.stdout?.trim()) {
          const secs = Number(ps.stdout.trim());
          if (Number.isFinite(secs) && secs >= 0) {
            appStartTime = new Date(Date.now() - secs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
          }
        }
      }
    }
    return { bootTime: bootIso, appStartTime };
  }

  return { bootTime: bootIso, appStartTime: '' };
}

export function queryClaudeOpenPrs(repo, execSync = spawnSync) {
  if (!REPO_RE.test(repo)) throw new Error('invalid repo name');
  const fullFields = 'number,labels,mergeStateStatus,reviewDecision,headRefOid,updatedAt,statusCheckRollup,comments';
  const baseFields = 'number,labels,mergeStateStatus,updatedAt';
  let res = execSync(
    'gh',
    ['pr', 'list', `--repo=${repo}`, '--state', 'open', '--search', 'draft:false', '--limit', '200', '--json', fullFields],
    { encoding: 'utf8', shell: false, timeout: 30_000 },
  );
  if (res.status !== 0 && /unknown json field/i.test(res.stderr || '')) {
    res = execSync(
      'gh',
      ['pr', 'list', `--repo=${repo}`, '--state', 'open', '--search', 'draft:false', '--limit', '200', '--json', baseFields],
      { encoding: 'utf8', shell: false, timeout: 30_000 },
    );
  }
  if (res.status !== 0) {
    throw new Error((res.stderr || res.error?.message || 'gh pr list failed').trim().split(/\r?\n/)[0]);
  }
  return JSON.parse(res.stdout || '[]');
}

export function queryClaudeOpenIssues(repo, execSync = spawnSync) {
  if (!REPO_RE.test(repo)) throw new Error('invalid repo name');
  const res = execSync(
    'gh',
    ['issue', 'list', `--repo=${repo}`, '--state', 'open', '--limit', '100', '--json', 'number,state,labels,updatedAt,comments'],
    { encoding: 'utf8', shell: false, timeout: 30_000 },
  );
  if (res.status !== 0) {
    throw new Error((res.stderr || res.error?.message || 'gh issue list failed').trim().split(/\r?\n/)[0]);
  }
  return JSON.parse(res.stdout || '[]');
}

function normalizeSessionRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.sessionId || raw.session_id || raw.conversationId || '').trim();
  const title = cleanTitle(raw.title || raw.name || '');
  const lastActivityMs = parseTimeMs(raw.lastActivityAt ?? raw.lastActivityMs ?? raw.updatedAt) ?? 0;
  const lastPlannerMs = parseTimeMs(raw.lastPlannerAt ?? raw.lastPlannerMs) ?? lastActivityMs;
  const statusStr = String(raw.status ?? '').toLowerCase();
  const errStr = String(raw.error ?? raw.lastError ?? '');
  const lastTurnStatus = raw.lastTurnStatus
    || (QUOTA_RE.test(errStr) || statusStr === 'quota' ? 'quota' : (errStr || statusStr === 'error' || statusStr === 'failed' ? 'error' : null));
  return {
    id,
    conversationId: id,
    title,
    role: raw.role || title || (id ? id.slice(0, 8) : 'sub-session'),
    isRunning: Boolean(raw.isRunning ?? raw.running),
    lastActivityMs,
    lastPlannerMs,
    startedBy: raw.startedBy || raw.parentSessionId || null,
    archived: Boolean(raw.archived || statusStr === 'archived'),
    hasError: Boolean(raw.hasError || statusStr === 'error' || statusStr === 'failed' || errStr),
    waitingForUser: Boolean(raw.waitingForUser || /waiting|approval|permission|prompt/.test(statusStr)),
    sentMessageToPoAfterLastTurn: typeof raw.sentMessageToPoAfterLastTurn === 'boolean'
      ? raw.sentMessageToPoAfterLastTurn
      : undefined,
    consecutiveUnansweredWakes: Number(raw.consecutiveUnansweredWakes ?? 0) || 0,
    lastWakeAtMs: parseTimeMs(raw.lastWakeAt ?? raw.lastWakeAtMs),
    lastTurnStatus,
  };
}

function buildClaudeWakeMessage({ po, config, evalResult, restartTimes, nowIso }) {
  const owner = config.owner || 'owner';
  const language = config.language || 'English';
  const { reasons, readyPrs, changedPrs, stalledSubs, triggeredIssues, idleSubs, restartAfterActivity } = evalResult;

  const readyText = readyPrs === null
    ? 'unknown, the gh query failed'
    : (readyPrs.length > 0 ? readyPrs.map((pr) => `#${pr.number} (${pr.mergeStateStatus})`).join(', ') : 'none');
  const idleText = idleSubs.length > 0
    ? idleSubs
      .map((sub) => `${sub.role || sub.id.slice(0, 8)} (${sub.id}, idle ${Math.floor((Date.parse(nowIso) - sub.lastActivityMs) / 60_000)} min)`)
      .join('; ')
    : 'none';

  let message = `Gatekeeper wake at ${nowIso} (reasons: ${reasons.join(', ')}). Ready PRs of your line: ${readyText}. Idle sub-sessions of your line: ${idleText}. Do one short turn: merge or review the ready PRs, feed or archive the idle sub-sessions, resume work a crash cut off, answer messages. Then end the turn. Keep no CronCreate check-in and no ScheduleWakeup loop: the gatekeeper and real events wake you. Your check-in file is ${po.checkInFile || 'none'}; use the one you already keep if it differs. Read only what this needs.`;

  if (changedPrs.length > 0) {
    const detail = changedPrs.map((pr) => {
      const flags = [pr.mergeStateStatus];
      if (pr.reviewDecision) flags.push(pr.reviewDecision);
      if (pr.ciFail > 0) flags.push(`CI fail:${pr.ciFail}`);
      if (pr.hasNewComment) flags.push('new-comment');
      return `#${pr.number} (${flags.join(', ')})`;
    }).join(', ');
    message += ` Changed PRs: ${detail}.`;
  }
  if (stalledSubs.length > 0) {
    const detail = stalledSubs
      .map((s) => `${s.role} (${s.conversationId}, ${s.kind}, idle ${s.idleMinutes}m)`)
      .join('; ');
    message += ` Sub-sessions needing attention: ${detail}.`;
  }
  if (triggeredIssues.length > 0) {
    const detail = triggeredIssues.map((i) => `#${i.number} (${i.trigger})`).join(', ');
    message += ` Issues needing attention: ${detail}.`;
  }
  if (evalResult.signals?.quotaRecoveryProbe) {
    message += ' Quota recovery probe: check availability and resume paused sub-sessions if recovered.';
  }
  if (restartAfterActivity) {
    message += ` Machine boot ${restartTimes?.bootTime || 'unknown'}, app start ${restartTimes?.appStartTime || 'unknown'}. A restart stopped active processes and sub-sessions. Tell ${owner} in ${language} on the first line that you are back and how long you were away, recreate any one-shot you had pending, and resume every linked sub-session (list_sessions linked) that had pending work.`;
  }

  return message;
}

export function evaluateClaudeGatekeeper({
  repo,
  pos = [],
  sessions = null,
  restartTimes = { bootTime: '', appStartTime: '' },
  openPrs = null,
  openIssues = null,
  prevState = null,
  config = {},
  nowMs = Date.now(),
} = {}) {
  const nowIso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prevPoStates = prevState?.poStates && typeof prevState.poStates === 'object' ? prevState.poStates : {};
  const sessionList = Array.isArray(sessions)
    ? sessions.map(normalizeSessionRecord).filter(Boolean)
    : (Array.isArray(sessions?.sessions) ? sessions.sessions.map(normalizeSessionRecord).filter(Boolean) : null);

  const poSessionIds = new Set();
  for (const po of pos) {
    const sid = po?.sessionId || po?.conversationId || po?.id;
    if (typeof sid === 'string' && sid.trim()) poSessionIds.add(sid.trim());
  }

  const evalConfig = {
    owner: config.owner || 'owner',
    language: config.language || 'English',
    multiSignal: true,
    // Claude list_sessions lacks transcript-level send_message info, so do not fire
    // silent subagent stall unless error/waiting or explicit sentMessageToPoAfterLastTurn=false.
    allowSilentSubagentStall: config.allowSilentSubagentStall === true,
    heartbeatActiveMinutes: config.heartbeatActiveMinutes ?? DEFAULT_HEARTBEAT_ACTIVE_MINUTES,
    heartbeatIdleMinutes: config.heartbeatIdleMinutes ?? DEFAULT_HEARTBEAT_IDLE_MINUTES,
    subagentStallMinutes: config.subagentStallMinutes ?? DEFAULT_SUBAGENT_STALL_MINUTES,
    subSessionsNormal: config.subSessionsNormal ?? DEFAULT_SUB_SESSIONS_NORMAL,
    peerPoLogins: config.peerPoLogins ?? [],
  };

  const wakeList = [];
  const skipped = [];
  const nextPoStates = { ...prevPoStates };
  const activeSessions = sessionList !== null ? sessionList.filter((s) => !s.archived) : null;

  for (const po of pos) {
    const title = cleanTitle(po?.title);
    if (!title) continue;
    const explicitId = String(po?.sessionId || po?.conversationId || po?.id || '').trim();

    let matchedSession = null;
    let linkedSubs = [];

    if (activeSessions !== null) {
      if (explicitId) {
        matchedSession = activeSessions.find((s) => s.id === explicitId) || null;
        if (!matchedSession) {
          skipped.push({ title, sessionId: explicitId, reason: 'missing-session' });
          continue;
        }
      } else {
        const matches = activeSessions.filter((s) => s.title === title);
        if (matches.length === 0) {
          skipped.push({ title, sessionId: null, reason: 'missing-session' });
          continue;
        }
        if (matches.length > 1) {
          skipped.push({
            title,
            sessionId: null,
            reason: 'ambiguous-session',
            matchedSessionIds: matches.map((m) => m.id).filter(Boolean),
          });
          continue;
        }
        matchedSession = matches[0];
      }
      if (matchedSession.id) poSessionIds.add(matchedSession.id);
      linkedSubs = activeSessions.filter(
        (s) => s.startedBy && s.startedBy === matchedSession.id && s.id !== matchedSession.id && !poSessionIds.has(s.id),
      );
    } else {
      const stateKey = explicitId || title;
      const prevForPo = prevPoStates[stateKey] || prevPoStates[title] || null;
      const fallbackLastMs = parseTimeMs(po.lastActivityAt ?? po.lastActivityMs)
        ?? (typeof prevForPo?.lastSeenAtMs === 'number' ? prevForPo.lastSeenAtMs : 0);
      matchedSession = normalizeSessionRecord({
        id: explicitId,
        title,
        isRunning: Boolean(po.isRunning),
        lastActivityMs: fallbackLastMs,
        lastPlannerMs: parseTimeMs(po.lastPlannerAt ?? po.lastPlannerMs) ?? fallbackLastMs,
        consecutiveUnansweredWakes: po.consecutiveUnansweredWakes ?? 0,
        lastTurnStatus: po.lastTurnStatus ?? null,
      });
    }

    const stateKey = matchedSession.id || title;
    const prevPoState = prevPoStates[stateKey] || prevPoStates[title] || null;

    const evalResult = evaluateSignals({
      po,
      session: matchedSession,
      subSessions: linkedSubs,
      restartTimes,
      openPrs,
      openIssues,
      prevPoState,
      config: evalConfig,
      nowMs,
      multiSignal: true,
    });

    if (!evalResult.shouldWake) {
      skipped.push({
        title,
        sessionId: matchedSession.id || null,
        reason: evalResult.skipped || 'no-reason',
        ...(evalResult.backoffRemainingMs ? { backoffRemainingMs: evalResult.backoffRemainingMs } : {}),
      });
      if (evalResult.skipped === 'no-reason') {
        nextPoStates[stateKey] = {
          ...evalResult.nextPoState,
          lastSeenAtMs: matchedSession.lastPlannerMs || nowMs,
        };
      }
      continue;
    }

    const message = buildClaudeWakeMessage({
      po,
      config: evalConfig,
      evalResult,
      restartTimes,
      nowIso,
    });

    wakeList.push({
      title,
      sessionId: matchedSession.id || null,
      reasons: evalResult.reasons,
      signals: evalResult.signals,
      readyPrs: evalResult.readyPrs === null
        ? null
        : evalResult.readyPrs.map((pr) => `#${pr.number} (${pr.mergeStateStatus})`),
      changedPrs: evalResult.changedPrs,
      stalledSubSessions: evalResult.stalledSubs,
      issues: evalResult.triggeredIssues,
      message,
    });

    nextPoStates[stateKey] = {
      ...evalResult.nextPoState,
      lastSeenAtMs: matchedSession.lastPlannerMs || nowMs,
      lastSentAtMs: nowMs,
      lastSentAt: nowIso,
    };
  }

  return {
    ok: true,
    repo,
    checkedAt: nowIso,
    restartTimes,
    wakeList,
    skipped,
    nextPoStates,
  };
}

export function runClaudeGatekeeperEval(opts, deps = {}) {
  if (!opts?.repo || !REPO_RE.test(opts.repo)) {
    throw new Error('--repo requires a valid owner/repo');
  }
  const nowMs = deps.nowMs ?? Date.now();
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const dryRun = Boolean(opts.dryRun);

  let stdinPayload = null;
  if (opts.sessionsStdin) {
    const rawStdin = typeof deps.stdinText === 'string'
      ? deps.stdinText
      : readFileSync(0, 'utf8');
    if (rawStdin && rawStdin.trim()) {
      stdinPayload = JSON.parse(rawStdin);
    }
  }

  let pos = opts.pos;
  if (!Array.isArray(pos)) {
    const rawPos = opts.posFile ? readFileSync(expandHome(opts.posFile, home), 'utf8') : opts.posJson;
    if (rawPos) {
      pos = JSON.parse(rawPos);
    } else if (stdinPayload && Array.isArray(stdinPayload.pos)) {
      pos = stdinPayload.pos;
    } else {
      throw new Error('--pos-json (or --pos-file) is required');
    }
    if (!Array.isArray(pos)) throw new Error('--pos-json must be a JSON array');
  }

  let sessions = opts.sessions ?? null;
  if (sessions === null && opts.sessionsStdin && stdinPayload !== null) {
    sessions = Array.isArray(stdinPayload) ? stdinPayload : (stdinPayload.sessions ?? null);
  }
  if (sessions === null && (opts.sessionsFile || opts.sessionsJson)) {
    const rawSessions = opts.sessionsFile
      ? readFileSync(expandHome(opts.sessionsFile, home), 'utf8')
      : opts.sessionsJson;
    if (rawSessions) sessions = JSON.parse(rawSessions);
  }

  const resolvedStateFile = opts.stateFile ? expandHome(opts.stateFile, home) : null;
  const prevState = resolvedStateFile ? readJsonState(resolvedStateFile) : null;

  let restartTimes = { bootTime: '', appStartTime: '' };
  try {
    restartTimes = (deps.getRestartTimes ?? (() => getClaudeRestartTimes(platform)))();
  } catch (err) {
    process.stderr.write(`claude-gatekeeper-eval restart check error: ${err.message}\n`);
  }

  let openPrs = null;
  try {
    openPrs = (deps.queryOpenPrs ?? queryClaudeOpenPrs)(opts.repo);
  } catch (err) {
    process.stderr.write(`claude-gatekeeper-eval gh pr list error: ${err.message}\n`);
  }

  let openIssues = null;
  const shouldQueryIssues = Boolean(deps.queryOpenIssues) || !deps.queryOpenPrs;
  if (shouldQueryIssues) {
    try {
      openIssues = (deps.queryOpenIssues ?? queryClaudeOpenIssues)(opts.repo);
    } catch (err) {
      process.stderr.write(`claude-gatekeeper-eval gh issue list error: ${err.message}\n`);
    }
  }

  const result = evaluateClaudeGatekeeper({
    repo: opts.repo,
    pos,
    sessions,
    restartTimes,
    openPrs,
    openIssues,
    prevState,
    config: {
      owner: opts.owner || 'owner',
      language: opts.language || 'English',
      heartbeatActiveMinutes: opts.heartbeatActiveMinutes ?? DEFAULT_HEARTBEAT_ACTIVE_MINUTES,
      heartbeatIdleMinutes: opts.heartbeatIdleMinutes ?? DEFAULT_HEARTBEAT_IDLE_MINUTES,
      subagentStallMinutes: opts.subagentStallMinutes ?? DEFAULT_SUBAGENT_STALL_MINUTES,
      subSessionsNormal: opts.subSessionsNormal ?? DEFAULT_SUB_SESSIONS_NORMAL,
    },
    nowMs,
  });

  // Read-only by default (matches Claude Desktop's "no state file" invariant and avoids
  // swallowing PR/issue events before Haiku calls send_message). Only persist when --commit-state is set.
  if (resolvedStateFile && opts.commitState === true && !dryRun) {
    writeJsonStateAtomic(resolvedStateFile, {
      repo: opts.repo,
      checkedAt: result.checkedAt,
      restartTimes: result.restartTimes,
      poStates: result.nextPoStates,
    });
  }

  return {
    ok: result.ok,
    repo: result.repo,
    checkedAt: result.checkedAt,
    restartTimes: result.restartTimes,
    wakeList: result.wakeList,
    skipped: result.skipped,
  };
}

function parseIntArg(flag, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return n;
}

export function parseClaudeEvalArgs(argv) {
  const opts = {
    repo: null,
    posJson: null,
    posFile: null,
    sessionsJson: null,
    sessionsFile: null,
    sessionsStdin: false,
    stateFile: null,
    commitState: false,
    heartbeatActiveMinutes: DEFAULT_HEARTBEAT_ACTIVE_MINUTES,
    heartbeatIdleMinutes: DEFAULT_HEARTBEAT_IDLE_MINUTES,
    subagentStallMinutes: DEFAULT_SUBAGENT_STALL_MINUTES,
    subSessionsNormal: DEFAULT_SUB_SESSIONS_NORMAL,
    owner: 'owner',
    language: 'English',
    dryRun: false,
    json: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeVal = (name) => {
      if (i + 1 >= argv.length) throw new Error(`${name} requires a value`);
      i += 1;
      return argv[i];
    };

    if (arg === '--json') opts.json = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--sessions-stdin') opts.sessionsStdin = true;
    else if (arg === '--commit-state') opts.commitState = true;
    else if (arg === '--repo') opts.repo = takeVal('--repo');
    else if (arg.startsWith('--repo=')) opts.repo = arg.slice(7);
    else if (arg === '--pos-json') opts.posJson = takeVal('--pos-json');
    else if (arg.startsWith('--pos-json=')) opts.posJson = arg.slice(11);
    else if (arg === '--pos-file') opts.posFile = takeVal('--pos-file');
    else if (arg.startsWith('--pos-file=')) opts.posFile = arg.slice(11);
    else if (arg === '--sessions-json') opts.sessionsJson = takeVal('--sessions-json');
    else if (arg.startsWith('--sessions-json=')) opts.sessionsJson = arg.slice(16);
    else if (arg === '--sessions-file') opts.sessionsFile = takeVal('--sessions-file');
    else if (arg.startsWith('--sessions-file=')) opts.sessionsFile = arg.slice(16);
    else if (arg === '--state-file') opts.stateFile = takeVal('--state-file');
    else if (arg.startsWith('--state-file=')) opts.stateFile = arg.slice(13);
    else if (arg === '--heartbeat-active') opts.heartbeatActiveMinutes = parseIntArg('--heartbeat-active', takeVal('--heartbeat-active'));
    else if (arg.startsWith('--heartbeat-active=')) opts.heartbeatActiveMinutes = parseIntArg('--heartbeat-active', arg.slice(19));
    else if (arg === '--heartbeat-idle') opts.heartbeatIdleMinutes = parseIntArg('--heartbeat-idle', takeVal('--heartbeat-idle'));
    else if (arg.startsWith('--heartbeat-idle=')) opts.heartbeatIdleMinutes = parseIntArg('--heartbeat-idle', arg.slice(17));
    else if (arg === '--subagent-stall') opts.subagentStallMinutes = parseIntArg('--subagent-stall', takeVal('--subagent-stall'));
    else if (arg.startsWith('--subagent-stall=')) opts.subagentStallMinutes = parseIntArg('--subagent-stall', arg.slice(17));
    else if (arg === '--sub-sessions-normal') opts.subSessionsNormal = parseIntArg('--sub-sessions-normal', takeVal('--sub-sessions-normal'));
    else if (arg.startsWith('--sub-sessions-normal=')) opts.subSessionsNormal = parseIntArg('--sub-sessions-normal', arg.slice(22));
    else if (arg === '--owner') opts.owner = takeVal('--owner');
    else if (arg.startsWith('--owner=')) opts.owner = arg.slice(8);
    else if (arg === '--language') opts.language = takeVal('--language');
    else if (arg.startsWith('--language=')) opts.language = arg.slice(11);
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
    opts = parseClaudeEvalArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`usage error: ${err.message}\n`);
    process.exit(2);
  }
  if (!opts.repo || (!opts.posJson && !opts.posFile && !opts.sessionsStdin)) {
    process.stderr.write(
      'usage: node claude-gatekeeper-eval.mjs --repo <owner/repo> --pos-json \'<json>\' [--sessions-stdin | --sessions-file <path> | --sessions-json \'<json>\'] [--state-file <path> [--commit-state]] [--heartbeat-active 180] [--heartbeat-idle 720] [--json]\n',
    );
    process.exit(2);
  }
  try {
    const out = runClaudeGatekeeperEval(opts);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`claude-gatekeeper-eval error: ${err.message}\n`);
    process.exit(1);
  }
}
