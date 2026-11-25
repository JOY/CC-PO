#!/usr/bin/env node
// Runs one Antigravity Product Owner gatekeeper pass for a repository,
// using the shared 0-token multi-signal engine in gatekeeper-core.mjs without
// spawning sidebar conversations or spending model tokens. Supports macOS
// multi-profile setups, Profile Affinity Guard, atomic lockfiles, persistent
// state via ANTIGRAVITY_EXECUTABLE_DATA_DIR or --state-file, --dry-run, and --json.
// No external dependencies.
//
//   node agy-gatekeeper.mjs <gatekeeper-config.json> [--dry-run] [--state-file <path>] [--json]
//
// Config JSON schema (<po_check_in_dir>/<repo owner>-<repo>-agy-gatekeeper.json):
//   {
//     "repo": "<owner/repo>",
//     "owner": "<owner_name>",
//     "language": "<report_language>",
//     "heartbeatActiveMinutes": 180,   (optional; default 180 in multi-signal mode)
//     "heartbeatIdleMinutes": 720,     (optional; default 720 in multi-signal mode)
//     "subagentStallMinutes": 30,      (optional; default 30)
//     "debounceSeconds": 90,           (optional; default 90)
//     "activeMinutes": 60,             (legacy window when multiSignal is not enabled)
//     "pos": [
//       { "title": "<PO session>", "conversationId": "<uuid>", "label": "line:<slug>", "checkInFile": "<path>" }
//     ]
//   }
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquirePoLock,
  checkProfileAffinity,
  computeBackoffMs,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_STALE_RUNNING_MS,
  evaluateSignals,
  expandHome,
  inferProfileName,
  isMultiSignalMode,
  parseTimeMs,
  readJsonState,
  releasePoLock,
  writeJsonStateAtomic,
} from './gatekeeper-core.mjs';

export { expandHome, inferProfileName };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARE_UUID_GLOBAL_RE = /(?<![A-Za-z0-9_-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_-])/gi;
const REPO_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACTIVE_STEP_STATUSES = new Set(['RUNNING', 'PENDING', 'IN_PROGRESS']);
const ERROR_STEP_STATUSES = new Set(['ERROR', 'FAILED', 'INVALID', 'CANCELLED', 'CANCELED']);
const WAITING_STEP_STATUSES = new Set(['WAITING', 'WAITING_FOR_USER', 'BLOCKED', 'PENDING_APPROVAL']);
const WAITING_STEP_TYPES = new Set(['ASK_USER', 'USER_APPROVAL', 'PERMISSION_REQUEST']);
const WAKE_STEP_TYPES = new Set(['SYSTEM_MESSAGE', 'USER_INPUT']);
const QUOTA_ERROR_RE = /quota|rate[_\s-]?limit|429|exhausted|capacity|overloaded/i;
const BACKOFF_ALERT_COOLDOWN_MS = 4 * 60 * 60_000;
export const RUNNING_MTIME_WINDOW_MS = DEFAULT_DEBOUNCE_MS;
const STALE_RUNNING_MS = DEFAULT_STALE_RUNNING_MS;

function unquoteArg(value) {
  if (typeof value !== 'string') return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function cleanCellTitle(title) {
  return String(title ?? '').replace(/[|\r\n]+/g, ' ').trim();
}

function inferProfilesBase(...hints) {
  for (const hint of hints) {
    if (typeof hint !== 'string' || !hint) continue;
    const match = hint.match(/^(.*?[\\/]Antigravity Profiles)[\\/][^\\/]+/i);
    if (match && match[1]) return match[1];
  }
  return null;
}

export function resolveBrainDir({
  config = {},
  deps = {},
  env = process.env,
  home = homedir(),
  exists = existsSync,
  readdir = readdirSync,
} = {}) {
  if (config?.brainDir) return expandHome(config.brainDir, home);
  if (deps?.brainDir) return expandHome(deps.brainDir, home);

  const rawAppData = config?.appDataDir || deps?.appDataDir || env.ANTIGRAVITY_APP_DATA_DIR || '';
  if (typeof rawAppData === 'string' && rawAppData.trim()) {
    const appDataDir = expandHome(rawAppData.trim(), home);
    const directBrain = join(appDataDir, 'brain');
    if (exists(directBrain)) return directBrain;
    // Handle profile root such as ".../Antigravity Profiles/acc2" where brain
    // sits inside gemini/<app_data_dir>/brain.
    const geminiDir = join(appDataDir, 'gemini');
    if (exists(geminiDir)) {
      try {
        const subdirs = readdir(geminiDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort();
        for (const sub of subdirs) {
          const candidate = join(geminiDir, sub, 'brain');
          if (exists(candidate)) return candidate;
        }
      } catch {
        // Fall through to default brain path under appDataDir.
      }
    }
    return directBrain;
  }

  return join(home, '.gemini', 'antigravity', 'brain');
}

export function resolvePoConversationId(po, checkInText) {
  if (typeof checkInText === 'string' && checkInText.length > 0) {
    const head = checkInText.slice(0, 1200);
    const match = head.match(/^(?:[-*>\s]*\**)?(?:PO\s+)?Session:\s*`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?/im);
    if (match && UUID_RE.test(match[1])) return match[1].toLowerCase();
  }
  if (typeof po?.conversationId === 'string' && UUID_RE.test(po.conversationId.trim())) {
    return po.conversationId.trim().toLowerCase();
  }
  return null;
}

export function extractActiveCheckInIds(checkInText, excludedIds = new Set()) {
  const excluded = excludedIds instanceof Set
    ? new Set([...excludedIds].map((x) => String(x).toLowerCase()))
    : new Set(excludedIds ? [String(excludedIds).toLowerCase()] : []);
  const ids = new Set();
  if (typeof checkInText !== 'string' || checkInText.length === 0) return ids;
  let inInactiveSection = false;
  for (const rawLine of checkInText.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (/^##+\s+/.test(line)) {
      inInactiveSection = /^##+\s+(?:completed|history|archive|done|retired)\b/i.test(line);
      continue;
    }
    if (inInactiveSection) continue;
    if (/^(?:[-*>\s]*\**)?(?:(?:PO\s+)?Session:|Coordinator\b|Watchdog:|Wake(?:-ups)?:)/i.test(line)) continue;
    if (/\b(?:MERGED|ARCHIVED|CLOSED)\b/.test(line)) continue;
    for (const match of line.matchAll(BARE_UUID_GLOBAL_RE)) {
      const id = match[0].toLowerCase();
      if (!excluded.has(id)) ids.add(id);
    }
  }
  return ids;
}

export function readTurnStatus(conversationId, { turnStatusDir = '', env = process.env, home = homedir() } = {}) {
  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) return null;
  const dir = turnStatusDir
    || (typeof env?.CC_PO_TURN_STATUS_DIR === 'string' && env.CC_PO_TURN_STATUS_DIR.trim())
    || join(home, '.claude', 'po-state', 'turn-status');
  const filePath = join(expandHome(dir, home), `${conversationId.toLowerCase()}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const status = String(parsed.status ?? '').toLowerCase();
    if (!['ok', 'error', 'quota'].includes(status)) return null;
    return {
      conversationId: conversationId.toLowerCase(),
      status,
      updatedAt: parsed.updatedAt || '',
      updatedAtMs: parseTimeMs(parsed.updatedAt),
      event: parsed.event || '',
    };
  } catch {
    return null;
  }
}

function classifyErrorText(text) {
  return QUOTA_ERROR_RE.test(String(text || '')) ? 'quota' : 'error';
}

export function isGatekeeperWakeText(content, stepType = 'USER_INPUT') {
  if (typeof content !== 'string') return false;
  if (String(stepType || '').toUpperCase() === 'SYSTEM_MESSAGE') {
    return /(?:^|\bcontent=|\n)\s*Gatekeeper wake at\s+/i.test(content);
  }
  return /^\s*Gatekeeper wake at\s+/i.test(content);
}

export function inspectConversation(brainDir, conversationId, nowMs = Date.now(), options = {}) {
  if (!brainDir || typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) return null;
  const id = conversationId.toLowerCase();
  const transcriptPath = join(expandHome(brainDir), id, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcriptPath)) return null;

  let stat;
  let content;
  try {
    stat = statSync(transcriptPath);
    content = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  let lastStep = null;
  let lastPlannerMs = null;
  let consecutiveUnansweredWakes = 0;
  let lastWakeAtMs = null;
  let lastErrorType = null;
  let sentMessageInCurrentTurn = false;
  let askedUserPending = false;

  const spawnedSubagents = [];
  const pendingByStepIndex = new Map();
  const pendingSubagentQueue = [];

  for (const line of lines) {
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    lastStep = step;
    const stepType = String(step.type ?? '').toUpperCase();
    const stepStatus = String(step.status ?? '').toUpperCase();
    const createdMs = parseTimeMs(step.created_at);

    if (stepType === 'PLANNER_RESPONSE') {
      const isErrStatus = ERROR_STEP_STATUSES.has(stepStatus);
      if (!isErrStatus) {
        if (createdMs !== null) lastPlannerMs = createdMs;
        consecutiveUnansweredWakes = 0;
        lastWakeAtMs = null;
        lastErrorType = null;
        askedUserPending = false;
      } else {
        lastErrorType = classifyErrorText(step.content || step.error || stepStatus);
      }

      if (Array.isArray(step.tool_calls)) {
        pendingByStepIndex.clear();
        pendingSubagentQueue.length = 0;
        const baseIndex = Number.isInteger(step.step_index) ? step.step_index : null;
        for (let i = 0; i < step.tool_calls.length; i += 1) {
          const call = step.tool_calls[i];
          const toolName = String(call?.name ?? '');
          if (toolName === 'invoke_subagent') {
            const spec = {
              typeName: unquoteArg(call.args?.TypeName),
              role: unquoteArg(call.args?.Role) || 'subagent',
            };
            if (baseIndex !== null) {
              pendingByStepIndex.set(baseIndex + 1 + i, spec);
            }
            pendingSubagentQueue.push(spec);
          } else if (toolName === 'send_message' || toolName === 'SendMessage') {
            sentMessageInCurrentTurn = true;
          } else if (toolName === 'ask_question' || toolName === 'AskUserQuestion') {
            askedUserPending = true;
          }
        }
      }
    } else if (stepType === 'ERROR_MESSAGE') {
      lastErrorType = classifyErrorText(step.content || step.error || '');
    } else {
      if (WAKE_STEP_TYPES.has(stepType)) {
        sentMessageInCurrentTurn = false;
        if (stepType === 'USER_INPUT') askedUserPending = false;
        if (isGatekeeperWakeText(step.content, stepType)) {
          consecutiveUnansweredWakes += 1;
          if (createdMs !== null) lastWakeAtMs = createdMs;
        }
      }

      if ((pendingByStepIndex.size > 0 || pendingSubagentQueue.length > 0) && typeof step.content === 'string') {
        const hasIndexed = Number.isInteger(step.step_index) && pendingByStepIndex.has(step.step_index);
        if (step.content.includes('Created the following subagent:')) {
          let spec = null;
          if (hasIndexed) {
            spec = pendingByStepIndex.get(step.step_index);
            pendingByStepIndex.delete(step.step_index);
            const qIdx = pendingSubagentQueue.indexOf(spec);
            if (qIdx !== -1) pendingSubagentQueue.splice(qIdx, 1);
          } else {
            spec = pendingSubagentQueue.shift() ?? null;
          }
          const m = step.content.match(/"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
          if (m && spec?.typeName === 'self') {
            spawnedSubagents.push({ conversationId: m[1].toLowerCase(), role: spec.role });
          }
        } else if (hasIndexed) {
          const spec = pendingByStepIndex.get(step.step_index);
          pendingByStepIndex.delete(step.step_index);
          const qIdx = pendingSubagentQueue.indexOf(spec);
          if (qIdx !== -1) pendingSubagentQueue.splice(qIdx, 1);
        } else if (stepStatus === 'ERROR' && /subagent/i.test(step.content)) {
          pendingSubagentQueue.shift();
        }
      }
    }
  }

  const lastStepMs = parseTimeMs(lastStep?.created_at) ?? stat.mtimeMs;
  const effectivePlannerMs = lastPlannerMs ?? lastStepMs;
  const latestTouchMs = Math.max(lastStepMs, stat.mtimeMs);
  const lastStepStatus = String(lastStep?.status ?? '').toUpperCase();
  const lastStepType = String(lastStep?.type ?? '').toUpperCase();
  const debounceMs = Number.isFinite(Number(options.debounceMs))
    ? Number(options.debounceMs)
    : RUNNING_MTIME_WINDOW_MS;

  const stepRunning = ACTIVE_STEP_STATUSES.has(lastStepStatus);
  const mtimeRunning = nowMs - stat.mtimeMs >= 0 && nowMs - stat.mtimeMs < debounceMs;
  const freshStepRunning = stepRunning && (nowMs - latestTouchMs < STALE_RUNNING_MS);

  // Fail-open turn-status metadata written by Antigravity PostInvocation/Stop hook.
  let lastTurnStatus = lastErrorType;
  const turnStatus = options.readTurnStatus === false
    ? null
    : readTurnStatus(id, {
      turnStatusDir: options.turnStatusDir,
      env: options.env,
      home: options.home,
    });
  if (turnStatus) {
    const statusFresh = turnStatus.updatedAtMs === null || (turnStatus.updatedAtMs + 60_000) >= effectivePlannerMs;
    if (statusFresh) {
      lastTurnStatus = turnStatus.status;
      if (turnStatus.status === 'quota' || turnStatus.status === 'error') {
        lastErrorType = turnStatus.status;
      }
    }
  }

  const hasError = lastStepType === 'ERROR_MESSAGE'
    || ERROR_STEP_STATUSES.has(lastStepStatus)
    || lastErrorType === 'error'
    || lastErrorType === 'quota';
  const waitingForUser = WAITING_STEP_STATUSES.has(lastStepStatus)
    || WAITING_STEP_TYPES.has(lastStepType)
    || askedUserPending;
  const sentMessageToPoAfterLastTurn = sentMessageInCurrentTurn;

  return {
    conversationId: id,
    lastActivityMs: effectivePlannerMs,
    lastStepMs,
    lastPlannerMs: effectivePlannerMs,
    mtimeMs: stat.mtimeMs,
    lastActivityAt: new Date(effectivePlannerMs).toISOString(),
    stepRunning,
    mtimeRunning,
    isRunning: freshStepRunning || mtimeRunning,
    consecutiveUnansweredWakes,
    lastWakeAtMs,
    lastErrorType,
    lastTurnStatus,
    hasError,
    waitingForUser,
    sentMessageToPoAfterLastTurn,
    spawnedSubagents,
  };
}

function buildWakeMessage({ po, config, evalResult, restartTimes, nowIso, useMultiSignal }) {
  const owner = config.owner || 'owner';
  const language = config.language || 'English';
  const { reasons, readyPrs, changedPrs, stalledSubs, triggeredIssues, idleSubs, restartAfterActivity } = evalResult;

  const readyText = readyPrs === null
    ? 'unknown, the gh query failed'
    : (readyPrs.length > 0 ? readyPrs.map((pr) => `#${pr.number} (${pr.mergeStateStatus})`).join(', ') : 'none');
  const idleText = idleSubs.length > 0
    ? idleSubs
      .map((sub) => `${sub.role || sub.conversationId.slice(0, 8)} (${sub.conversationId}, idle ${Math.floor((Date.parse(nowIso) - sub.lastActivityMs) / 60_000)} min)`)
      .join('; ')
    : 'none';

  let message = `Gatekeeper wake at ${nowIso} (reasons: ${reasons.join(', ')}). Ready PRs of your line: ${readyText}. Idle sub-sessions of your line: ${idleText}. Do one short turn: merge or review the ready PRs, feed or archive the idle sub-sessions, resume work a crash cut off, answer messages. Then end the turn. Keep no check-in schedule loop: the gatekeeper and real events wake you. Your check-in file is ${po.checkInFile || 'none'}; use the one you already keep if it differs. Read only what this needs.`;

  if (useMultiSignal) {
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
      message += ` Subagents needing attention: ${detail}.`;
    }
    if (triggeredIssues.length > 0) {
      const detail = triggeredIssues.map((i) => `#${i.number} (${i.trigger})`).join(', ');
      message += ` Issues needing attention: ${detail}.`;
    }
    if (evalResult.signals?.quotaRecoveryProbe) {
      message += ' Quota recovery probe: verify model quota availability and resume paused subagents if recovered.';
    }
  }

  if (restartAfterActivity) {
    message += ` Machine boot ${restartTimes?.bootTime || 'unknown'}, app start ${restartTimes?.appStartTime || 'unknown'}. A restart stopped active processes and subagents. Tell ${owner} in ${language} on the first line that you are back and how long you were away, recreate any one-shot you had pending, and resume every subagent that had pending work.`;
  }

  return message;
}

// Evaluates all configured POs using gatekeeper-core.mjs.
// Honors legacy activeMinutes mode when no v2.18 multi-signal config/state/issues are provided.
export function evaluateGatekeeper({
  config,
  poInspections,
  restartTimes,
  openPrs,
  openIssues = null,
  prevState = null,
  nowMs = Date.now(),
  legacyMode = false,
}) {
  const nowIso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prevPoStates = prevState?.poStates && typeof prevState.poStates === 'object' ? prevState.poStates : {};
  const useMultiSignal = isMultiSignalMode(config, { legacyMode });

  const actions = [];
  const nextPoStates = {};

  for (const po of config.pos ?? []) {
    const title = cleanCellTitle(po.title);
    if (!title) continue;
    const inspection = poInspections.get(title);
    if (!inspection) {
      actions.push({ title, skipped: 'missing-session' });
      continue;
    }

    const stateKey = inspection.po.conversationId || title;
    const prevPoState = prevPoStates[stateKey] || prevPoStates[title] || null;
    const evalResult = evaluateSignals({
      po,
      session: inspection.po,
      subSessions: inspection.subSessions ?? [],
      restartTimes,
      openPrs,
      openIssues,
      prevPoState,
      config,
      nowMs,
      multiSignal: useMultiSignal,
    });

    nextPoStates[stateKey] = evalResult.nextPoState;

    if (!evalResult.shouldWake) {
      actions.push({
        title,
        conversationId: inspection.po.conversationId,
        skipped: evalResult.skipped,
        consecutiveUnansweredWakes: evalResult.consecutiveUnansweredWakes,
        shouldAlertBackoff: evalResult.shouldAlertBackoff,
        backoffRemainingMs: evalResult.backoffRemainingMs,
      });
      continue;
    }

    const message = buildWakeMessage({
      po,
      config,
      evalResult,
      restartTimes,
      nowIso,
      useMultiSignal,
    });

    actions.push({
      title,
      conversationId: inspection.po.conversationId,
      reasons: evalResult.reasons,
      signals: evalResult.signals,
      consecutiveUnansweredWakes: evalResult.consecutiveUnansweredWakes,
      shouldAlertBackoff: evalResult.shouldAlertBackoff,
      message,
    });
  }

  return { actions, nextPoStates, multiSignal: useMultiSignal };
}

function commandForBinary(binPath) {
  if (/language_server(?:\.exe)?$/i.test(binPath)) {
    return { file: binPath, prefixArgs: ['agentapi'] };
  }
  return { file: binPath, prefixArgs: [] };
}

export function resolveAgentApiCommand(env = process.env, platform = process.platform, home = homedir(), options = {}) {
  const exists = options.existsSync ?? existsSync;
  const readdir = options.readdirSync ?? readdirSync;

  for (const envKey of ['ANTIGRAVITY_AGENTAPI_EXE', 'AGENTAPI_BIN']) {
    const raw = env?.[envKey];
    if (typeof raw === 'string' && raw.trim()) {
      const candidate = expandHome(raw.trim(), home);
      if (exists(candidate)) return commandForBinary(candidate);
    }
  }

  if (platform === 'win32') {
    const localAppData = env?.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const directExe = join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
    if (exists(directExe)) return { file: directExe, prefixArgs: ['agentapi'] };
    const batPath = join(home, '.gemini', 'antigravity', 'bin', 'agentapi.bat');
    if (exists(batPath)) {
      try {
        const bat = readFileSync(batPath, 'utf8');
        const m = bat.match(/"([^"]*language_server\.exe)"\s+agentapi/i);
        if (m && exists(m[1])) return { file: m[1], prefixArgs: ['agentapi'] };
      } catch {
        // Fall through to PATH lookup.
      }
    }
    return { file: 'agentapi', prefixArgs: [] };
  }

  if (platform === 'darwin') {
    const profile = options.profile
      || env?.ANTIGRAVITY_PROFILE
      || inferProfileName(env?.ANTIGRAVITY_APP_DATA_DIR, env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR, options.execDataDir, options.appDataDir, options.brainDir, options.scriptPath);
    const profilesBase = options.profilesBase
      || inferProfilesBase(env?.ANTIGRAVITY_APP_DATA_DIR, env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR, options.execDataDir, options.appDataDir, options.brainDir, options.scriptPath)
      || join(home, 'Library', 'Application Support', 'Antigravity Profiles');

    if (profile) {
      const profileBin = join(profilesBase, profile, `Antigravity (${profile}).app`, 'Contents', 'Resources', 'bin', 'language_server');
      if (exists(profileBin)) return commandForBinary(profileBin);
    }

    const binPath = join(home, '.gemini', 'antigravity', 'bin', 'agentapi');
    if (exists(binPath)) return { file: binPath, prefixArgs: [] };

    const standardCandidates = [
      options.systemApplicationsDir
        ? join(options.systemApplicationsDir, 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server')
        : '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
      join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server'),
    ];
    for (const candidate of standardCandidates) {
      if (exists(candidate)) return commandForBinary(candidate);
    }

    if (exists(profilesBase)) {
      try {
        const entries = readdir(profilesBase, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name)
          .sort();
        for (const p of entries) {
          const candidate = join(profilesBase, p, `Antigravity (${p}).app`, 'Contents', 'Resources', 'bin', 'language_server');
          if (exists(candidate)) return commandForBinary(candidate);
        }
      } catch {
        // Fall through to PATH lookup.
      }
    }
    return { file: 'agentapi', prefixArgs: [] };
  }

  const binPath = join(home, '.gemini', 'antigravity', 'bin', 'agentapi');
  if (exists(binPath)) return { file: binPath, prefixArgs: [] };
  return { file: 'agentapi', prefixArgs: [] };
}

export function pickAppStartTime({ guiStartIso = '', serverStartIso = '' } = {}) {
  const guiMs = parseTimeMs(guiStartIso);
  const srvMs = parseTimeMs(serverStartIso);
  if (guiMs !== null && srvMs !== null) {
    return srvMs >= guiMs ? serverStartIso : guiStartIso;
  }
  if (srvMs !== null) return serverStartIso;
  if (guiMs !== null) return guiStartIso;
  return '';
}

function parseTaggedRestartOutput(stdout, fallbackBootIso) {
  let bootTime = fallbackBootIso;
  let guiStartIso = '';
  let serverStartIso = '';
  for (const raw of (stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('BOOT=') && line.length > 5) bootTime = line.slice(5);
    else if (line.startsWith('GUI=')) guiStartIso = line.slice(4);
    else if (line.startsWith('SRV=')) serverStartIso = line.slice(4);
  }
  return { bootTime, appStartTime: pickAppStartTime({ guiStartIso, serverStartIso }) };
}

function findMacProcessStartIso(pattern, { exact = false, execSync = spawnSync } = {}) {
  const args = exact ? ['-a', '-o', '-x', pattern] : ['-a', '-o', '-f', pattern];
  const pg = execSync('pgrep', args, { encoding: 'utf8', shell: false, timeout: 5_000 });
  if (pg.status !== 0 || !pg.stdout) return '';
  const pid = pg.stdout.trim().split(/\s+/)[0];
  if (!pid || !/^\d+$/.test(pid)) return '';
  const ps = execSync('ps', ['-o', 'lstart=', '-p', pid], {
    encoding: 'utf8',
    shell: false,
    timeout: 5_000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (ps.status !== 0 || !ps.stdout) return '';
  const raw = ps.stdout.trim();
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function defaultRestartTimes(profile = null, execSync = spawnSync) {
  const bootIso = new Date(Date.now() - uptime() * 1000).toISOString();
  if (process.platform === 'win32') {
    const ps = execSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$b = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); $g = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.StartTime } | Sort-Object StartTime | Select-Object -First 1; $s = Get-Process -Name language_server -ErrorAction SilentlyContinue | Where-Object { $_.StartTime } | Sort-Object StartTime | Select-Object -First 1; Write-Output \"BOOT=$b\"; Write-Output (\"GUI=\" + $(if ($g -and $g.StartTime) { $g.StartTime.ToUniversalTime().ToString('o') } else { '' })); Write-Output (\"SRV=\" + $(if ($s -and $s.StartTime) { $s.StartTime.ToUniversalTime().ToString('o') } else { '' }))",
      ],
      { encoding: 'utf8', shell: false, timeout: 15_000 },
    );
    if (ps.status === 0 && ps.stdout) {
      return parseTaggedRestartOutput(ps.stdout, bootIso);
    }
    return { bootTime: bootIso, appStartTime: '' };
  }
  if (process.platform === 'darwin') {
    const safeProfile = profile && /^[A-Za-z0-9_.-]+$/.test(profile) ? profile : '';
    let guiStartIso = '';
    let serverStartIso = '';
    if (safeProfile) {
      const escapedProfile = safeProfile.replace(/\./g, '\\.');
      guiStartIso = findMacProcessStartIso(
        `Antigravity \\(${escapedProfile}\\)\\.app/Contents/MacOS/Antigravity`,
        { execSync },
      );
      serverStartIso = findMacProcessStartIso(
        `Antigravity \\(${escapedProfile}\\)\\.app/Contents/Resources/bin/language_server.*--standalone`,
        { execSync },
      );
    } else {
      guiStartIso = findMacProcessStartIso('Antigravity', { exact: true, execSync });
      serverStartIso = findMacProcessStartIso(
        '(?:^|/)Antigravity\\.app/Contents/Resources/bin/language_server.*--standalone',
        { execSync },
      ) || findMacProcessStartIso('language_server.*--standalone', { execSync });
    }
    return { bootTime: bootIso, appStartTime: pickAppStartTime({ guiStartIso, serverStartIso }) };
  }
  if (process.platform === 'linux') {
    const sh = execSync(
      '/bin/sh',
      [
        '-c',
        's="$(pgrep -a -f \'[a]ntigravity.*language_server|[l]anguage_server\' | head -n 1)"; if [ -n "$s" ]; then e="$(ps -o etimes= -p "$s" | tr -d \' \')"; [ -n "$e" ] && date -u -d "@$(( $(date +%s) - e ))" +"SRV=%Y-%m-%dT%H:%M:%SZ"; fi',
      ],
      { encoding: 'utf8', shell: false, timeout: 10_000 },
    );
    if (sh.status === 0 && sh.stdout) {
      return parseTaggedRestartOutput(sh.stdout, bootIso);
    }
  }
  return { bootTime: bootIso, appStartTime: '' };
}

export function defaultQueryOpenPrs(repo, execSync = spawnSync) {
  if (!REPO_RE.test(repo)) throw new Error('invalid repo name');
  const fullFields = 'number,labels,mergeStateStatus,reviewDecision,headRefOid,updatedAt,statusCheckRollup,comments';
  const midFields = 'number,labels,mergeStateStatus,reviewDecision,headRefOid,updatedAt';
  const baseFields = 'number,labels,mergeStateStatus,updatedAt';
  const runPrList = (limit, fields) => execSync(
    'gh',
    ['pr', 'list', `--repo=${repo}`, '--state', 'open', '--search', 'draft:false', '--limit', String(limit), '--json', fields],
    { encoding: 'utf8', shell: false, timeout: 25_000 },
  );

  let res = runPrList(50, fullFields);
  if (res.status !== 0) {
    // Fallback on ANY failure (HTTP 502/504 GraphQL timeout on large repos, unknown field, etc.)
    // to midFields (keeps mergeStateStatus/reviewDecision/headRefOid without heavy nested GraphQL).
    res = runPrList(100, midFields);
    if (res.status !== 0 && /unknown json field/i.test(res.stderr || '')) {
      res = runPrList(100, baseFields);
    }
  }
  if (res.status !== 0) {
    throw new Error((res.stderr || res.error?.message || 'gh pr list failed').trim().split(/\r?\n/)[0]);
  }
  return JSON.parse(res.stdout || '[]');
}

export function defaultQueryOpenIssues(repo, execSync = spawnSync) {
  if (!REPO_RE.test(repo)) throw new Error('invalid repo name');
  const runIssueList = (limit, fields) => execSync(
    'gh',
    ['issue', 'list', `--repo=${repo}`, '--state', 'open', '--limit', String(limit), '--json', fields],
    { encoding: 'utf8', shell: false, timeout: 25_000 },
  );
  let res = runIssueList(50, 'number,state,labels,updatedAt,comments');
  if (res.status !== 0) {
    res = runIssueList(100, 'number,state,labels,updatedAt');
  }
  if (res.status !== 0) {
    throw new Error((res.stderr || res.error?.message || 'gh issue list failed').trim().split(/\r?\n/)[0]);
  }
  return JSON.parse(res.stdout || '[]');
}

const DEFAULT_SEND_TIMEOUT_MS = 60_000;
const SEND_BACKOFF_BASE_MINUTES = 10;
const SEND_BACKOFF_MAX_MINUTES = 60;

function defaultSendMessage(conversationId, message, resolvedCmd = resolveAgentApiCommand(), timeoutMs = DEFAULT_SEND_TIMEOUT_MS) {
  if (!UUID_RE.test(conversationId)) throw new Error('invalid conversationId');
  const cmd = resolvedCmd;
  const effectiveTimeout = Number.isInteger(timeoutMs) && timeoutMs >= 5_000 ? timeoutMs : DEFAULT_SEND_TIMEOUT_MS;
  const res = spawnSync(
    cmd.file,
    [...cmd.prefixArgs, 'send-message', conversationId, message],
    { encoding: 'utf8', shell: false, timeout: effectiveTimeout },
  );
  if (res.status !== 0) {
    throw new Error((res.stderr || res.error?.message || `agentapi exited ${res.status}`).trim().split(/\r?\n/)[0]);
  }
}

export function sendMacNotification(title, message, execSync = spawnSync) {
  try {
    const safeTitle = String(title || 'CC-PO Gatekeeper').replace(/["\\\r\n]+/g, ' ').trim();
    const safeMsg = String(message || '').replace(/["\\\r\n]+/g, ' ').trim();
    const script = `display notification "${safeMsg}" with title "${safeTitle}"`;
    const res = execSync('osascript', ['-e', script], { encoding: 'utf8', shell: false, timeout: 5_000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

function selectPoInspection(brainDir, po, checkInText, nowMs, inspectOpts) {
  const candidates = [];
  const headerId = resolvePoConversationId({ conversationId: '' }, checkInText);
  const configId = typeof po?.conversationId === 'string' && UUID_RE.test(po.conversationId.trim())
    ? po.conversationId.trim().toLowerCase()
    : null;
  if (configId) candidates.push(configId);
  if (headerId && !candidates.includes(headerId)) candidates.push(headerId);

  let best = null;
  for (const id of candidates) {
    const info = inspectConversation(brainDir, id, nowMs, inspectOpts);
    if (!info) continue;
    if (!best || info.lastActivityMs > best.lastActivityMs) {
      best = info;
    }
  }
  return best;
}

export function runGatekeeper(configPath, deps = {}) {
  const nowMs = deps.nowMs ?? Date.now();
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const dryRun = Boolean(deps.dryRun);
  const resolvedConfigPath = expandHome(configPath, home);
  const config = JSON.parse(readFileSync(resolvedConfigPath, 'utf8'));
  if (!config?.repo || !REPO_RE.test(config.repo)) {
    throw new Error('gatekeeper config requires a valid owner/repo');
  }

  const brainDir = resolveBrainDir({ config, deps, env, home });
  const scriptPath = deps.scriptPath ?? fileURLToPath(import.meta.url);
  const rawEnvProfile = typeof env.ANTIGRAVITY_PROFILE === 'string' ? env.ANTIGRAVITY_PROFILE.trim() : '';
  const rawExecDataDir = typeof env.ANTIGRAVITY_EXECUTABLE_DATA_DIR === 'string'
    ? env.ANTIGRAVITY_EXECUTABLE_DATA_DIR.trim()
    : '';
  const profile = rawEnvProfile || inferProfileName(env.ANTIGRAVITY_APP_DATA_DIR, rawExecDataDir, config.appDataDir, brainDir, scriptPath);
  const agentApi = deps.agentApi ?? resolveAgentApiCommand(env, platform, home, {
    appDataDir: config.appDataDir,
    execDataDir: rawExecDataDir,
    brainDir,
    scriptPath,
    profile,
  });

  // Profile Affinity Guard: refuse cross-profile runs (e.g. acc2 sidecar targeting acc3 brainDir).
  const affinity = checkProfileAffinity({
    envProfile: rawEnvProfile,
    appDataDir: env.ANTIGRAVITY_APP_DATA_DIR || '',
    execDataDir: rawExecDataDir,
    brainDir,
    scriptPath,
  });
  if (!affinity.ok) {
    const summary = `gatekeeper (${config.repo}): skipped: profile-mismatch (${affinity.reason})`;
    const status = {
      repo: config.repo,
      checkedAt: new Date(nowMs).toISOString(),
      dryRun,
      profile: profile || null,
      brainDir,
      agentApi: { file: agentApi.file, prefixArgs: agentApi.prefixArgs },
      skipped: 'profile-mismatch',
      profileAffinity: affinity,
      restartTimes: { bootTime: '', appStartTime: '' },
      actions: [],
      summary,
    };
    return { summary, actions: [], status };
  }

  const lockDir = deps.lockDir !== undefined
    ? deps.lockDir
    : (config.lockDir !== undefined ? config.lockDir : (deps.sendMessage ? '' : join(home, '.claude', 'po-state', 'locks')));
  const lockTtlMs = Number.isFinite(Number(config.lockTtlMs)) && Number(config.lockTtlMs) > 0
    ? Number(config.lockTtlMs)
    : DEFAULT_LOCK_TTL_MS;

  // Repo-level lock serializes the full readState -> eval -> send -> writeState cycle
  // so overlapping cron runs never clobber state.json or double-wake POs.
  const repoLock = (!dryRun && lockDir)
    ? acquirePoLock(lockDir, `repo-${config.repo}`, lockTtlMs, nowMs)
    : { acquired: true, lockPath: null, token: null, disabled: true };
  if (!repoLock.acquired) {
    const summary = `gatekeeper (${config.repo}): skipped: locked`;
    const status = {
      repo: config.repo,
      checkedAt: new Date(nowMs).toISOString(),
      dryRun,
      profile: profile || null,
      brainDir,
      agentApi: { file: agentApi.file, prefixArgs: agentApi.prefixArgs },
      skipped: 'locked',
      profileAffinity: affinity,
      restartTimes: { bootTime: '', appStartTime: '' },
      actions: [],
      summary,
    };
    return { summary, actions: [], status };
  }

  try {
    // Optional persistent state: explicit --state-file / deps.stateFile, or ANTIGRAVITY_EXECUTABLE_DATA_DIR/state.json.
    const execDataDir = rawExecDataDir ? expandHome(rawExecDataDir, home) : '';
    const effectiveStateFile = deps.stateFile
      ? expandHome(deps.stateFile, home)
      : (execDataDir ? join(execDataDir, 'state.json') : null);
    const prevState = effectiveStateFile ? readJsonState(effectiveStateFile) : null;
    const prevPoStates = prevState?.poStates && typeof prevState.poStates === 'object' ? prevState.poStates : {};

    const debounceMs = Number.isFinite(Number(config.debounceSeconds)) && Number(config.debounceSeconds) > 0
      ? Number(config.debounceSeconds) * 1000
      : RUNNING_MTIME_WINDOW_MS;
    const inspectOpts = {
      debounceMs,
      turnStatusDir: deps.turnStatusDir,
      env,
      home,
      readTurnStatus: deps.readTurnStatus,
    };

    const excludedPoIds = new Set();
    const rawEntries = [];
    for (const po of config.pos ?? []) {
      const title = cleanCellTitle(po?.title);
      if (!title) continue;
      if (typeof po.conversationId === 'string' && UUID_RE.test(po.conversationId.trim())) {
        excludedPoIds.add(po.conversationId.trim().toLowerCase());
      }
      const checkInPath = po.checkInFile ? expandHome(po.checkInFile, home) : '';
      const checkInText = checkInPath && existsSync(checkInPath) ? readFileSync(checkInPath, 'utf8') : '';
      const poInfo = selectPoInspection(brainDir, po, checkInText, nowMs, inspectOpts);
      if (poInfo) excludedPoIds.add(poInfo.conversationId);
      rawEntries.push({ po, title, checkInText, poInfo });
    }

    const poInspections = new Map();
    for (const { po, title, checkInText, poInfo } of rawEntries) {
      if (!poInfo) continue;
      const activeIds = extractActiveCheckInIds(checkInText, excludedPoIds);
      for (const extraId of po.activeSubagents ?? []) {
        if (typeof extraId === 'string' && UUID_RE.test(extraId)) {
          const lower = extraId.toLowerCase();
          if (!excludedPoIds.has(lower)) activeIds.add(lower);
        }
      }

      const subMap = new Map();
      for (const spawned of poInfo.spawnedSubagents) {
        if (excludedPoIds.has(spawned.conversationId)) continue;
        const subInfo = inspectConversation(brainDir, spawned.conversationId, nowMs, inspectOpts);
        if (!subInfo) continue;
        const inCheckIn = activeIds.has(spawned.conversationId)
          || [...activeIds].some((id) => id.startsWith(spawned.conversationId.slice(0, 8)));
        const newerThanPo = subInfo.lastActivityMs > poInfo.lastActivityMs;
        if (inCheckIn || newerThanPo) {
          subMap.set(spawned.conversationId, { ...subInfo, role: spawned.role });
        }
      }
      for (const activeId of activeIds) {
        if (subMap.has(activeId)) continue;
        const subInfo = inspectConversation(brainDir, activeId, nowMs, inspectOpts);
        if (subInfo) subMap.set(activeId, { ...subInfo, role: `session ${activeId.slice(0, 8)}` });
      }

      poInspections.set(title, { po: poInfo, subSessions: [...subMap.values()] });
    }

    let restartTimes = { bootTime: '', appStartTime: '' };
    try {
      restartTimes = (deps.getRestartTimes ?? (() => defaultRestartTimes(profile)))();
    } catch (err) {
      process.stderr.write(`gatekeeper restart check error: ${err.message}\n`);
    }

    let openPrs = null;
    try {
      openPrs = (deps.queryOpenPrs ?? defaultQueryOpenPrs)(config.repo);
    } catch (err) {
      process.stderr.write(`gatekeeper gh pr list error: ${err.message}\n`);
    }

    let openIssues = null;
    const shouldQueryIssues = Boolean(deps.queryOpenIssues) || (!deps.queryOpenPrs && isMultiSignalMode(config, { legacyMode: deps.legacyMode }));
    if (shouldQueryIssues) {
      try {
        openIssues = (deps.queryOpenIssues ?? defaultQueryOpenIssues)(config.repo);
      } catch (err) {
        process.stderr.write(`gatekeeper gh issue list error: ${err.message}\n`);
      }
    }

    const { actions, nextPoStates } = evaluateGatekeeper({
      config,
      poInspections,
      restartTimes,
      openPrs,
      openIssues,
      prevState,
      nowMs,
      legacyMode: Boolean(deps.legacyMode),
    });

    const sendTimeoutMs = Number.isInteger(config.sendTimeoutMs) && config.sendTimeoutMs >= 5_000
      ? config.sendTimeoutMs
      : DEFAULT_SEND_TIMEOUT_MS;
    const send = deps.sendMessage ?? ((id, msg) => defaultSendMessage(id, msg, agentApi, sendTimeoutMs));
    const notify = deps.notify ?? ((t, m) => (platform === 'darwin' && !deps.sendMessage ? sendMacNotification(t, m) : false));

    const summaryParts = [];
    const sendFailedTitles = new Set();
    const lockedTitles = new Set();
    const sendBackoffTitles = new Set();
    const committedPoStates = { ...prevPoStates };

    for (const action of actions) {
      const stateKey = action.conversationId || action.title;
      const prevForPo = prevPoStates[stateKey] || prevPoStates[action.title] || {};
      const candidateForPo = nextPoStates[stateKey] || prevForPo;

      // Optional macOS alert when PO has >= 2 consecutive unanswered wakes (e.g., quota exhausted).
      if (action.shouldAlertBackoff && !dryRun && config.notifyOnBackoff !== false) {
        const lastAlertMs = typeof prevForPo.lastBackoffAlertAtMs === 'number' ? prevForPo.lastBackoffAlertAtMs : 0;
        if (lastAlertMs === 0 || (nowMs - lastAlertMs) >= BACKOFF_ALERT_COOLDOWN_MS) {
          const sentAlert = notify(
            `CC-PO Gatekeeper (${config.repo})`,
            `${action.title} has ${action.consecutiveUnansweredWakes} unanswered wakes (possible quota/error).`,
          );
          if (sentAlert) {
            candidateForPo.lastBackoffAlertAtMs = nowMs;
            prevForPo.lastBackoffAlertAtMs = nowMs;
          }
        }
      }

      if (!action.message) {
        summaryParts.push(`${action.title}: ${action.skipped}`);
        if (action.skipped === 'no-reason') {
          committedPoStates[stateKey] = candidateForPo;
        } else {
          committedPoStates[stateKey] = prevForPo;
        }
        continue;
      }

      const tags = action.reasons.join(' + ');
      if (dryRun) {
        summaryParts.push(`${action.title}: would-wake (${tags})`);
        continue;
      }

      // Exponential backoff after repeated send-message timeouts (10m -> 20m -> 40m -> 60m cap),
      // bypassed immediately on fresh restart so recovery is never delayed.
      const prevSendFails = Number.isInteger(prevForPo.consecutiveSendFailures) ? prevForPo.consecutiveSendFailures : 0;
      const lastSendFailMs = typeof prevForPo.lastSendFailedAtMs === 'number' ? prevForPo.lastSendFailedAtMs : 0;
      const isRestartWake = Array.isArray(action.reasons) && action.reasons.includes('restart');
      if (prevSendFails > 0 && lastSendFailMs > 0 && !isRestartWake) {
        const waitMs = computeBackoffMs(prevSendFails, SEND_BACKOFF_BASE_MINUTES, SEND_BACKOFF_MAX_MINUTES);
        if ((nowMs - lastSendFailMs) < waitMs) {
          sendBackoffTitles.add(action.title);
          action.skipped = 'send-backoff';
          committedPoStates[stateKey] = prevForPo;
          summaryParts.push(`${action.title}: send-backoff`);
          continue;
        }
      }

      const lockKey = `${config.repo}-${action.conversationId || action.title}`;
      const lock = acquirePoLock(lockDir, lockKey, lockTtlMs, nowMs);
      if (!lock.acquired) {
        lockedTitles.add(action.title);
        action.skipped = 'locked';
        committedPoStates[stateKey] = prevForPo;
        summaryParts.push(`${action.title}: locked`);
        continue;
      }

      try {
        send(action.conversationId, action.message);
        const priorUnansweredSends = Math.max(0, Number(candidateForPo.unansweredSendsSincePlanner ?? 0) || 0);
        committedPoStates[stateKey] = {
          ...candidateForPo,
          lastSentAtMs: nowMs,
          lastSentAt: new Date(nowMs).toISOString(),
          unansweredSendsSincePlanner: priorUnansweredSends + 1,
          consecutiveSendFailures: 0,
          lastSendFailedAtMs: null,
        };
        summaryParts.push(`${action.title}: woke (${tags})`);
      } catch (err) {
        process.stderr.write(`gatekeeper send error (${action.title}): ${err.message}\n`);
        sendFailedTitles.add(action.title);
        committedPoStates[stateKey] = {
          ...prevForPo,
          consecutiveSendFailures: prevSendFails + 1,
          lastSendFailedAtMs: nowMs,
        };
        summaryParts.push(`${action.title}: send-failed`);
      } finally {
        releasePoLock(lock);
      }
    }

    const summary = `gatekeeper (${config.repo}): ${summaryParts.join(', ') || 'no POs'}`;
    const status = {
      repo: config.repo,
      checkedAt: new Date(nowMs).toISOString(),
      dryRun,
      profile: profile || null,
      brainDir,
      agentApi: { file: agentApi.file, prefixArgs: agentApi.prefixArgs },
      profileAffinity: affinity,
      restartTimes,
      actions: actions.map((action) => ({
        title: action.title,
        conversationId: action.conversationId || null,
        skipped: action.skipped || null,
        reasons: action.reasons || [],
        woke: Boolean(action.message && !dryRun && !sendFailedTitles.has(action.title) && !lockedTitles.has(action.title) && !sendBackoffTitles.has(action.title)),
        wouldWake: Boolean(action.message && dryRun),
        sendFailed: sendFailedTitles.has(action.title),
        sendBackoff: sendBackoffTitles.has(action.title),
        locked: lockedTitles.has(action.title),
        consecutiveUnansweredWakes: action.consecutiveUnansweredWakes ?? 0,
      })),
      summary,
    };

    if (effectiveStateFile && !dryRun) {
      writeJsonStateAtomic(effectiveStateFile, {
        ...status,
        poStates: committedPoStates,
      });
    }

    return { summary, actions, status };
  } finally {
    releasePoLock(repoLock);
  }
}

export function parseCliArgs(argv) {
  const opts = { configPath: null, stateFile: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--state-file') {
      if (!argv[i + 1]) throw new Error('--state-file requires a path');
      opts.stateFile = argv[++i];
    } else if (arg.startsWith('--state-file=')) {
      opts.stateFile = arg.slice(13);
      if (!opts.stateFile) throw new Error('--state-file requires a path');
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (!opts.configPath) {
      opts.configPath = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
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
  if (!opts.configPath) {
    process.stderr.write('usage: node agy-gatekeeper.mjs <gatekeeper-config.json> [--dry-run] [--state-file <path>] [--json]\n');
    process.exit(2);
  }
  try {
    const { summary, status } = runGatekeeper(opts.configPath, {
      stateFile: opts.stateFile,
      dryRun: opts.dryRun,
    });
    process.stdout.write(`${opts.json ? JSON.stringify(status, null, 2) : summary}\n`);
  } catch (err) {
    process.stderr.write(`gatekeeper error: ${err.message}\n`);
    process.exit(1);
  }
}
