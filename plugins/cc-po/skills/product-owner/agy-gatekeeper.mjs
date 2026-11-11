#!/usr/bin/env node
// Runs one Antigravity Product Owner gatekeeper pass for a repository,
// matching gatekeeper-template.md without spawning sidebar conversations or
// spending model tokens. No dependencies.
//
//   node agy-gatekeeper.mjs <gatekeeper-config.json>
//
// Config JSON schema (<po_check_in_dir>/<repo owner>-<repo>-agy-gatekeeper.json):
//   {
//     "repo": "<owner/repo>",
//     "owner": "<owner_name>",
//     "language": "<report_language>",
//     "activeMinutes": 60,        (a sub-session idle this long is listed in the wake)
//     "quietMinutes": 180,        (a PO with work in flight is woken after this much quiet)
//     "compactTokens": 500000,    (compaction notice for a sub-session above this)
//     "handoffTokens": 250000,    (handoff notice for a PO above this; "none" for no notice)
//     "pos": [
//       { "title": "<PO session>", "conversationId": "<uuid>", "label": "line:<slug>", "checkInFile": "<path>" }
//     ]
//   }
// Unknown or old keys (stateFile, quietHours, coordinatorLabel) are ignored: the
// gatekeeper keeps no state file, and uses each PO's last activity as its memory.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARE_UUID_GLOBAL_RE = /(?<![A-Za-z0-9_-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_-])/gi;
const REPO_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACTIVE_STEP_STATUSES = new Set(['RUNNING', 'PENDING', 'IN_PROGRESS']);
const RUNNING_MTIME_WINDOW_MS = 15_000;
const STALE_RUNNING_MS = 15 * 60_000;

export function expandHome(filePath, home = homedir()) {
  if (typeof filePath !== 'string') return '';
  if (filePath === '~') return home;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

function parseTimeMs(value) {
  if (!value || value === 'none' || value === 'never') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

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

export function inspectConversation(brainDir, conversationId, nowMs = Date.now()) {
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
  let contextTokens = null;
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
    if (step.type === 'PLANNER_RESPONSE') {
      if (typeof step.input_tokens === 'number' || typeof step.cache_read_tokens === 'number') {
        contextTokens = (step.input_tokens || 0) + (step.cache_read_tokens || 0);
      }
      if (Array.isArray(step.tool_calls)) {
        pendingByStepIndex.clear();
        pendingSubagentQueue.length = 0;
        const baseIndex = Number.isInteger(step.step_index) ? step.step_index : null;
        for (let i = 0; i < step.tool_calls.length; i += 1) {
          const call = step.tool_calls[i];
          if (call?.name === 'invoke_subagent') {
            const spec = {
              typeName: unquoteArg(call.args?.TypeName),
              role: unquoteArg(call.args?.Role) || 'subagent',
            };
            if (baseIndex !== null) {
              pendingByStepIndex.set(baseIndex + 1 + i, spec);
            }
            pendingSubagentQueue.push(spec);
          }
        }
      }
    } else if ((pendingByStepIndex.size > 0 || pendingSubagentQueue.length > 0) && typeof step.content === 'string') {
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
      } else if (step.status === 'ERROR' && /subagent/i.test(step.content)) {
        pendingSubagentQueue.shift();
      }
    }
  }

  const stepMs = parseTimeMs(lastStep?.created_at);
  const lastActivityMs = stepMs ?? stat.mtimeMs;
  const latestTouchMs = Math.max(lastActivityMs, stat.mtimeMs);
  const stepRunning = ACTIVE_STEP_STATUSES.has(String(lastStep?.status ?? '').toUpperCase());
  const mtimeRunning = nowMs - stat.mtimeMs >= 0 && nowMs - stat.mtimeMs < RUNNING_MTIME_WINDOW_MS;
  const freshStepRunning = stepRunning && (nowMs - latestTouchMs < STALE_RUNNING_MS);

  return {
    conversationId: id,
    lastActivityMs,
    mtimeMs: stat.mtimeMs,
    lastActivityAt: new Date(lastActivityMs).toISOString(),
    stepRunning,
    mtimeRunning,
    isRunning: freshStepRunning || mtimeRunning,
    contextTokens,
    spawnedSubagents,
  };
}

function isSessionLiveRunning(session, latestRestartMs, nowMs) {
  if (!session) return false;
  const mtimeMs = typeof session.mtimeMs === 'number' ? session.mtimeMs : session.lastActivityMs;
  const latestTouchMs = Math.max(session.lastActivityMs, mtimeMs);
  if (typeof session.stepRunning === 'boolean' || typeof session.mtimeRunning === 'boolean') {
    const postRestartMtime = Boolean(session.mtimeRunning) && (latestRestartMs <= 0 || mtimeMs >= latestRestartMs);
    const postRestartStep = Boolean(session.stepRunning)
      && (latestRestartMs <= 0 || session.lastActivityMs >= latestRestartMs)
      && (nowMs - latestTouchMs < STALE_RUNNING_MS);
    return postRestartMtime || postRestartStep;
  }
  if (!session.isRunning) return false;
  if (latestRestartMs > 0 && latestRestartMs > latestTouchMs) return false;
  return (nowMs - latestTouchMs) < STALE_RUNNING_MS;
}

function prLabelNames(pr) {
  return (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

// Wake rule (matches gatekeeper-template.md): for each PO that is not running,
// wake it when ANY of these holds, and name all that hold:
//   (a) restart: boot or app start is later than the PO's last activity;
//   (b) unseen ready PR: an open, non-draft PR carrying one of the PO's own line
//       labels is CLEAN or UNSTABLE and was updated after the PO's last activity
//       (no waiting time); no other PO's PR counts;
//   (c) quiet: the PO's last activity is quietMinutes or more before now AND its
//       line has work in flight (an open PR of the line, draft or ready, or an
//       in-flight sub-session).
// A PO whose own context is above handoffTokens gets a handoff notice.
export function evaluateGatekeeper({ config, poInspections, restartTimes, openPrs, nowMs = Date.now() }) {
  const nowIso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const activeMinutes = Number.isInteger(config.activeMinutes) ? config.activeMinutes : 60;
  const quietMinutes = Number.isInteger(config.quietMinutes) ? config.quietMinutes : 180;
  const compactTokens = Number.isInteger(config.compactTokens) ? config.compactTokens : 500_000;
  const handoffTokens = Number.isInteger(config.handoffTokens)
    ? config.handoffTokens
    : (String(config.handoffTokens).toLowerCase() === 'none' ? null : 250_000);
  const owner = config.owner || 'owner';
  const language = config.language || 'English';
  const activeWindowMs = activeMinutes * 60_000;
  const quietWindowMs = quietMinutes * 60_000;

  const bootMs = parseTimeMs(restartTimes?.bootTime);
  const appStartMs = parseTimeMs(restartTimes?.appStartTime);
  const latestRestartMs = Math.max(bootMs ?? -1, appStartMs ?? -1);

  const validOpenPrs = Array.isArray(openPrs)
    ? openPrs.filter((pr) => Number.isInteger(pr?.number) && pr.number > 0)
    : null;

  const actions = [];

  for (const po of config.pos ?? []) {
    const title = cleanCellTitle(po.title);
    if (!title) continue;
    const inspection = poInspections.get(title);
    if (!inspection) {
      actions.push({ title, skipped: 'missing-session' });
      continue;
    }

    const lastActivityMs = inspection.po.lastActivityMs;
    if (isSessionLiveRunning(inspection.po, latestRestartMs, nowMs)) {
      actions.push({ title, skipped: 'running' });
      continue;
    }

    // The line's ready PRs (all of them, for the message) and the unseen ones (for reason b).
    let readyPrs = null;
    let lineHasOpenPr = false;
    if (validOpenPrs !== null) {
      const poLabels = Array.isArray(po.labels)
        ? po.labels
        : (po.label && po.label !== 'none' ? [po.label] : []);
      const ownPrs = validOpenPrs.filter((pr) => {
        const names = prLabelNames(pr);
        return poLabels.some((lbl) => names.includes(lbl));
      });
      lineHasOpenPr = ownPrs.length > 0;
      readyPrs = ownPrs.filter((pr) => pr.isDraft !== true
        && (pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'UNSTABLE'));
    }

    const reasons = [];
    const restartAfterActivity = latestRestartMs > 0 && latestRestartMs > lastActivityMs;
    if (restartAfterActivity) reasons.push('restart');
    const unseen = (readyPrs ?? []).filter((pr) => {
      const updatedMs = parseTimeMs(pr.updatedAt);
      return updatedMs !== null && updatedMs > lastActivityMs;
    });
    if (unseen.length > 0) reasons.push('unseen ready PR');
    const idleMs = nowMs - lastActivityMs;
    const workInFlight = lineHasOpenPr || (inspection.subSessions ?? []).length > 0;
    if (idleMs >= quietWindowMs && workInFlight) reasons.push(`quiet for ${Math.floor(idleMs / 60_000)} minutes with work in flight`);

    if (reasons.length === 0) {
      actions.push({ title, skipped: 'no-reason' });
      continue;
    }

    const idleSubs = (inspection.subSessions ?? []).filter(
      (sub) => !isSessionLiveRunning(sub, latestRestartMs, nowMs) && (nowMs - sub.lastActivityMs) > activeWindowMs,
    );
    const readyText = readyPrs === null
      ? 'unknown, the gh query failed'
      : (readyPrs.length > 0 ? readyPrs.map((pr) => `#${pr.number} (${pr.mergeStateStatus})`).join(', ') : 'none');
    const idleText = idleSubs.length > 0
      ? idleSubs
        .map((sub) => `${sub.role || sub.conversationId.slice(0, 8)} (${sub.conversationId}, idle ${Math.floor((nowMs - sub.lastActivityMs) / 60_000)} min)`)
        .join('; ')
      : 'none';

    let message = `Gatekeeper wake at ${nowIso} (reasons: ${reasons.join(', ')}). Ready PRs of your line: ${readyText}. Idle sub-sessions of your line: ${idleText}. Do one short turn: merge or review the ready PRs, feed or archive the idle sub-sessions, resume work a crash cut off, answer messages. Then end the turn. Keep no check-in schedule loop: the gatekeeper and real events wake you. Your check-in file is ${po.checkInFile || 'none'}; use the one you already keep if it differs. Read only what this needs.`;
    if (restartAfterActivity) {
      message += ` Machine boot ${restartTimes?.bootTime || 'unknown'}, app start ${restartTimes?.appStartTime || 'unknown'}. A restart stopped active processes and subagents. Tell ${owner} in ${language} on the first line that you are back and how long you were away, recreate any one-shot you had pending, and resume every subagent that had pending work.`;
    }

    // Context notices, only in the message of a PO that is woken in this run.
    const handoff = handoffTokens !== null
      && typeof inspection.po.contextTokens === 'number' && inspection.po.contextTokens > handoffTokens;
    if (handoff) {
      message += `\n\nHandoff notice at ${nowIso}: your own context is ${inspection.po.contextTokens} tokens, above the ${handoffTokens} limit. Hand your line to a fresh PO session now, as the product-owner skill's 'PO handoff' says: finish only the step you are in, write the handoff state, tell ${owner} in ${language} on the first line to open a fresh PO session with the exact title ${title}, and name the retired conversation (${inspection.po.conversationId}) in the first message for the new one. Do not read more, and start no new sub-session.`;
    }
    const large = [];
    for (const sub of inspection.subSessions ?? []) {
      if (!isSessionLiveRunning(sub, latestRestartMs, nowMs) && typeof sub.contextTokens === 'number' && sub.contextTokens > compactTokens) {
        large.push(`${sub.role || 'subagent'} (${sub.conversationId}, ${sub.contextTokens} tokens)`);
      }
    }
    if (large.length > 0) {
      message += `\n\nContext notice at ${nowIso}: these sessions of your line hold more than ${compactTokens} tokens of context: ${large.join('; ')}. A session cannot compact itself, and '/compact' sent as a message is read as text, not as a command. In your next report, tell ${owner} in ${language} to compact each of them in the app. Do not wait for it, and do not read more because of it.`;
    }

    actions.push({
      title,
      conversationId: inspection.po.conversationId,
      reasons,
      notice: large.length > 0,
      handoffNotice: handoff,
      message,
    });
  }

  return { actions };
}

export function resolveAgentApiCommand(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const directExe = join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
    if (existsSync(directExe)) return { file: directExe, prefixArgs: ['agentapi'] };
    const batPath = join(home, '.gemini', 'antigravity', 'bin', 'agentapi.bat');
    if (existsSync(batPath)) {
      try {
        const bat = readFileSync(batPath, 'utf8');
        const m = bat.match(/"([^"]*language_server\.exe)"\s+agentapi/i);
        if (m && existsSync(m[1])) return { file: m[1], prefixArgs: ['agentapi'] };
      } catch {
        // Fall through to PATH lookup.
      }
    }
  } else {
    const binPath = join(home, '.gemini', 'antigravity', 'bin', 'agentapi');
    if (existsSync(binPath)) return { file: binPath, prefixArgs: [] };
  }
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

function defaultRestartTimes() {
  const bootIso = new Date(Date.now() - uptime() * 1000).toISOString();
  if (process.platform === 'win32') {
    const ps = spawnSync(
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
    const sh = spawnSync(
      '/bin/sh',
      [
        '-c',
        'export LC_ALL=C; g="$(pgrep -ox Antigravity | head -n 1)"; s="$(pgrep -f \'[a]ntigravity.*language_server|[l]anguage_server\' | head -n 1)"; [ -n "$g" ] && echo "GUI=$(date -u -r "$(date -j -f \'%a %b %e %T %Y\' "$(ps -o lstart= -p "$g")" +%s)" +%Y-%m-%dT%H:%M:%SZ)"; [ -n "$s" ] && echo "SRV=$(date -u -r "$(date -j -f \'%a %b %e %T %Y\' "$(ps -o lstart= -p "$s")" +%s)" +%Y-%m-%dT%H:%M:%SZ)"',
      ],
      { encoding: 'utf8', shell: false, timeout: 10_000 },
    );
    if (sh.status === 0 && sh.stdout) {
      return parseTaggedRestartOutput(sh.stdout, bootIso);
    }
    return { bootTime: bootIso, appStartTime: '' };
  }
  if (process.platform === 'linux') {
    const sh = spawnSync(
      '/bin/sh',
      [
        '-c',
        's="$(pgrep -f \'[a]ntigravity.*language_server|[l]anguage_server\' | head -n 1)"; if [ -n "$s" ]; then e="$(ps -o etimes= -p "$s" | tr -d \' \')"; [ -n "$e" ] && date -u -d "@$(( $(date +%s) - e ))" +"SRV=%Y-%m-%dT%H:%M:%SZ"; fi',
      ],
      { encoding: 'utf8', shell: false, timeout: 10_000 },
    );
    if (sh.status === 0 && sh.stdout) {
      return parseTaggedRestartOutput(sh.stdout, bootIso);
    }
  }
  return { bootTime: bootIso, appStartTime: '' };
}

function defaultQueryOpenPrs(repo) {
  if (!REPO_RE.test(repo)) throw new Error('invalid repo name');
  const res = spawnSync(
    'gh',
    ['pr', 'list', `--repo=${repo}`, '--state', 'open', '--limit', '200', '--json', 'number,labels,isDraft,mergeStateStatus,updatedAt'],
    { encoding: 'utf8', shell: false, timeout: 30_000 },
  );
  if (res.status !== 0) {
    throw new Error((res.stderr || res.error?.message || 'gh pr list failed').trim().split(/\r?\n/)[0]);
  }
  return JSON.parse(res.stdout || '[]');
}

function defaultSendMessage(conversationId, message) {
  if (!UUID_RE.test(conversationId)) throw new Error('invalid conversationId');
  const cmd = resolveAgentApiCommand();
  const res = spawnSync(
    cmd.file,
    [...cmd.prefixArgs, 'send-message', conversationId, message],
    { encoding: 'utf8', shell: false, timeout: 30_000 },
  );
  if (res.status !== 0) {
    throw new Error((res.stderr || res.error?.message || `agentapi exited ${res.status}`).trim().split(/\r?\n/)[0]);
  }
}

function selectPoInspection(brainDir, po, checkInText, nowMs) {
  const candidates = [];
  const headerId = resolvePoConversationId({ conversationId: '' }, checkInText);
  const configId = typeof po?.conversationId === 'string' && UUID_RE.test(po.conversationId.trim())
    ? po.conversationId.trim().toLowerCase()
    : null;
  if (configId) candidates.push(configId);
  if (headerId && !candidates.includes(headerId)) candidates.push(headerId);

  let best = null;
  for (const id of candidates) {
    const info = inspectConversation(brainDir, id, nowMs);
    if (!info) continue;
    if (!best || info.lastActivityMs > best.lastActivityMs) {
      best = info;
    }
  }
  return best;
}

export function runGatekeeper(configPath, deps = {}) {
  const nowMs = deps.nowMs ?? Date.now();
  const resolvedConfigPath = expandHome(configPath);
  const config = JSON.parse(readFileSync(resolvedConfigPath, 'utf8'));
  if (!config?.repo || !REPO_RE.test(config.repo)) {
    throw new Error('gatekeeper config requires a valid owner/repo');
  }

  const brainDir = expandHome(config.brainDir || deps.brainDir || join(homedir(), '.gemini', 'antigravity', 'brain'));

  const excludedPoIds = new Set();
  const rawEntries = [];
  for (const po of config.pos ?? []) {
    const title = cleanCellTitle(po?.title);
    if (!title) continue;
    if (typeof po.conversationId === 'string' && UUID_RE.test(po.conversationId.trim())) {
      excludedPoIds.add(po.conversationId.trim().toLowerCase());
    }
    const checkInPath = po.checkInFile ? expandHome(po.checkInFile) : '';
    const checkInText = checkInPath && existsSync(checkInPath) ? readFileSync(checkInPath, 'utf8') : '';
    const poInfo = selectPoInspection(brainDir, po, checkInText, nowMs);
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
      const subInfo = inspectConversation(brainDir, spawned.conversationId, nowMs);
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
      const subInfo = inspectConversation(brainDir, activeId, nowMs);
      if (subInfo) subMap.set(activeId, { ...subInfo, role: `session ${activeId.slice(0, 8)}` });
    }

    poInspections.set(title, { po: poInfo, subSessions: [...subMap.values()] });
  }

  let restartTimes = { bootTime: '', appStartTime: '' };
  try {
    restartTimes = (deps.getRestartTimes ?? defaultRestartTimes)();
  } catch (err) {
    process.stderr.write(`gatekeeper restart check error: ${err.message}\n`);
  }

  let openPrs = null;
  try {
    openPrs = (deps.queryOpenPrs ?? defaultQueryOpenPrs)(config.repo);
  } catch (err) {
    process.stderr.write(`gatekeeper gh pr list error: ${err.message}\n`);
  }

  const { actions } = evaluateGatekeeper({
    config,
    poInspections,
    restartTimes,
    openPrs,
    nowMs,
  });

  const send = deps.sendMessage ?? defaultSendMessage;
  const summaryParts = [];
  for (const action of actions) {
    if (!action.message) {
      summaryParts.push(`${action.title}: ${action.skipped}`);
      continue;
    }
    try {
      send(action.conversationId, action.message);
      const tags = [action.reasons.join(' + '), action.notice ? 'compact-notice' : null, action.handoffNotice ? 'handoff-notice' : null].filter(Boolean).join('+');
      summaryParts.push(`${action.title}: woke (${tags})`);
    } catch (err) {
      process.stderr.write(`gatekeeper send error (${action.title}): ${err.message}\n`);
      summaryParts.push(`${action.title}: send-failed`);
    }
  }

  const summary = `gatekeeper (${config.repo}): ${summaryParts.join(', ') || 'no POs'}`;
  return { summary, actions };
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const configPath = process.argv[2];
  if (!configPath) {
    process.stderr.write('usage: node agy-gatekeeper.mjs <gatekeeper-config.json>\n');
    process.exit(2);
  }
  try {
    const { summary } = runGatekeeper(configPath);
    process.stdout.write(`${summary}\n`);
  } catch (err) {
    process.stderr.write(`gatekeeper error: ${err.message}\n`);
    process.exit(1);
  }
}
