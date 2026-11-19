#!/usr/bin/env node
// Runs one Antigravity Product Owner gatekeeper pass for a repository,
// matching gatekeeper-template.md without spawning sidebar conversations or
// spending model tokens. Supports macOS multi-profile setups, --dry-run,
// optional --state-file status snapshots, and --json structured output.
// No dependencies.
//
//   node agy-gatekeeper.mjs <gatekeeper-config.json> [--dry-run] [--state-file <path>] [--json]
//
// Config JSON schema (<po_check_in_dir>/<repo owner>-<repo>-agy-gatekeeper.json):
//   {
//     "repo": "<owner/repo>",
//     "owner": "<owner_name>",
//     "language": "<report_language>",
//     "activeMinutes": 60,        (a PO quiet this long is woken; a sub-session idle this long is listed)
//     "pos": [
//       { "title": "<PO session>", "conversationId": "<uuid>", "label": "line:<slug>", "checkInFile": "<path>" }
//     ]
//   }
// Unknown or legacy config keys (stateFile, quietHours, quietMinutes, coordinatorLabel, compactTokens, handoffTokens) are ignored:
// the gatekeeper keeps no state file unless --state-file is explicitly passed, and uses each PO's last activity as its memory.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { dirname, join } from 'node:path';
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

export function inferProfileName(...hints) {
  for (const hint of hints) {
    if (typeof hint !== 'string' || !hint) continue;
    const match = hint.match(/Antigravity Profiles[\\/]([^\\/]+)/i);
    if (match && match[1]) return match[1];
  }
  return null;
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
//   (c) quiet: the PO's last activity is activeMinutes or more before now,
//       whether or not its line has work in flight.
// No context notice is sent: a PO's context needs no owner action.
export function evaluateGatekeeper({ config, poInspections, restartTimes, openPrs, nowMs = Date.now() }) {
  const nowIso = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const activeMinutes = Number.isInteger(config.activeMinutes) ? config.activeMinutes : 60;
  const owner = config.owner || 'owner';
  const language = config.language || 'English';
  const activeWindowMs = activeMinutes * 60_000;

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
    if (validOpenPrs !== null) {
      const poLabels = Array.isArray(po.labels)
        ? po.labels
        : (po.label && po.label !== 'none' ? [po.label] : []);
      const ownPrs = validOpenPrs.filter((pr) => {
        const names = prLabelNames(pr);
        return poLabels.some((lbl) => names.includes(lbl));
      });
      readyPrs = ownPrs.filter((pr) => pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'UNSTABLE');
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
    if (idleMs >= activeWindowMs) reasons.push(`quiet for ${Math.floor(idleMs / 60_000)} minutes`);

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

    actions.push({
      title,
      conversationId: inspection.po.conversationId,
      reasons,
      message,
    });
  }

  return { actions };
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
      || inferProfileName(env?.ANTIGRAVITY_APP_DATA_DIR, options.appDataDir, options.brainDir, options.scriptPath);
    const profilesBase = options.profilesBase
      || inferProfilesBase(env?.ANTIGRAVITY_APP_DATA_DIR, options.appDataDir, options.brainDir, options.scriptPath)
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

function defaultQueryOpenPrs(repo) {
  if (!REPO_RE.test(repo)) throw new Error('invalid repo name');
  const res = spawnSync(
    'gh',
    ['pr', 'list', `--repo=${repo}`, '--state', 'open', '--search', 'draft:false', '--limit', '200', '--json', 'number,labels,mergeStateStatus,updatedAt'],
    { encoding: 'utf8', shell: false, timeout: 30_000 },
  );
  if (res.status !== 0) {
    throw new Error((res.stderr || res.error?.message || 'gh pr list failed').trim().split(/\r?\n/)[0]);
  }
  return JSON.parse(res.stdout || '[]');
}

function defaultSendMessage(conversationId, message, resolvedCmd = resolveAgentApiCommand()) {
  if (!UUID_RE.test(conversationId)) throw new Error('invalid conversationId');
  const cmd = resolvedCmd;
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
  const profile = rawEnvProfile || inferProfileName(env.ANTIGRAVITY_APP_DATA_DIR, config.appDataDir, brainDir, scriptPath);
  const agentApi = deps.agentApi ?? resolveAgentApiCommand(env, platform, home, {
    appDataDir: config.appDataDir,
    brainDir,
    scriptPath,
    profile,
  });

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

  const { actions } = evaluateGatekeeper({
    config,
    poInspections,
    restartTimes,
    openPrs,
    nowMs,
  });

  const send = deps.sendMessage ?? ((id, msg) => defaultSendMessage(id, msg, agentApi));
  const summaryParts = [];
  const sendFailedTitles = new Set();
  for (const action of actions) {
    if (!action.message) {
      summaryParts.push(`${action.title}: ${action.skipped}`);
      continue;
    }
    const tags = action.reasons.join(' + ');
    if (dryRun) {
      summaryParts.push(`${action.title}: would-wake (${tags})`);
      continue;
    }
    try {
      send(action.conversationId, action.message);
      summaryParts.push(`${action.title}: woke (${tags})`);
    } catch (err) {
      process.stderr.write(`gatekeeper send error (${action.title}): ${err.message}\n`);
      sendFailedTitles.add(action.title);
      summaryParts.push(`${action.title}: send-failed`);
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
    restartTimes,
    actions: actions.map((action) => ({
      title: action.title,
      conversationId: action.conversationId || null,
      skipped: action.skipped || null,
      reasons: action.reasons || [],
      woke: Boolean(action.message && !dryRun && !sendFailedTitles.has(action.title)),
      wouldWake: Boolean(action.message && dryRun),
      sendFailed: sendFailedTitles.has(action.title),
    })),
    summary,
  };

  if (deps.stateFile && !dryRun) {
    const outPath = expandHome(deps.stateFile, home);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  }

  return { summary, actions, status };
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
