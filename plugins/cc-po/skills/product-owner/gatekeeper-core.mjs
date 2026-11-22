// Shared 0-token multi-signal evaluation engine for CC-PO v2.18.0.
// Used by both Antigravity (agy-gatekeeper.mjs) and Claude Desktop (claude-gatekeeper-eval.mjs).
// Zero external dependencies, pure ESM Node.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_HEARTBEAT_ACTIVE_MINUTES = 180;
export const DEFAULT_HEARTBEAT_IDLE_MINUTES = 720;
export const DEFAULT_SUBAGENT_STALL_MINUTES = 30;
export const DEFAULT_SUBAGENT_COOLDOWN_MINUTES = 120;
export const DEFAULT_ISSUE_COOLDOWN_MINUTES = 30;
export const DEFAULT_SUB_SESSIONS_NORMAL = 3;
export const DEFAULT_BACKOFF_BASE_MINUTES = 60;
export const DEFAULT_BACKOFF_MAX_MINUTES = 240;
export const DEFAULT_QUOTA_PROBE_BASE_MINUTES = 30;
export const DEFAULT_QUOTA_PROBE_MAX_MINUTES = 120;
export const MAX_SUBAGENT_QUOTA_PROBES = 3;
export const DEFAULT_DEBOUNCE_MS = 90_000;
export const DEFAULT_STALE_RUNNING_MS = 15 * 60_000;
export const DEFAULT_LOCK_TTL_MS = 120_000;

const FAIL_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
]);
const PASS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED']);
const PR_ATTENTION_STATUSES = new Set(['CLEAN', 'UNSTABLE', 'CHANGES_REQUESTED', 'DIRTY']);
const BLOCKED_ISSUE_LABEL_RE = /^(?:blocked|status:blocked|on-hold|waiting|in-progress|claimed)$/i;
const HANDOFF_COMMENT_RE = /(?:^|\n)\s*handoff\s*:/i;
const CLAIM_OR_CHECKPOINT_RE = /(?:^|\n)\s*(?:claim|checkpoint)\s*:/i;
const RELEASE_OR_DONE_RE = /(?:^|\n)\s*(?:release|handoff|done)\s*:/i;
const AGENT_PROTOCOL_COMMENT_RE = /^(?:\s*(?:>\s*)?(?:\*\*|__)?(?:(?:claim|checkpoint|done|release|po\s+acceptance|blocked|status|waiting|review|effort-exception|model-exception|progress|update|reopen|summary|audit|triage|security\s+review|shared-core\s+review)\s*[:(]|waiting\s+for\b|gatekeeper\s+wake\b)|##\s*(?:shared-core review|sprint review|po\s+digest|status|summary|review)\b)/i;
const PEER_PO_COMMENT_RE = /(?:^|\n)\s*(?:security review requested\s*\(|peer\s+po\b|##\s*shared-core review|from\s+.+\bpo\b)/i;

export function expandHome(filePath, home = homedir()) {
  if (typeof filePath !== 'string') return '';
  if (filePath === '~') return home;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

export function parseTimeMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (!value || value === 'none' || value === 'never') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function inferProfileName(...hints) {
  for (const hint of hints) {
    if (typeof hint !== 'string' || !hint) continue;
    const match = hint.match(/Antigravity Profiles[\\/]([^\\/]+)/i);
    if (match && match[1]) return match[1];
  }
  return null;
}

export function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  const names = [];
  for (const item of labels) {
    const name = typeof item === 'string' ? item : item?.name;
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }
  return names;
}

export function normalizePoLabels(po) {
  if (Array.isArray(po?.labels)) {
    return po.labels
      .map((l) => (typeof l === 'string' ? l.trim() : ''))
      .filter((l) => l && l !== 'none');
  }
  if (typeof po?.label === 'string' && po.label.trim() && po.label.trim() !== 'none') {
    return [po.label.trim()];
  }
  return [];
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function summarizeStatusChecks(rollup) {
  const items = Array.isArray(rollup)
    ? rollup
    : (Array.isArray(rollup?.nodes) ? rollup.nodes : []);
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const conclusion = String(item.conclusion ?? '').toUpperCase();
    const state = String(item.state ?? '').toUpperCase();
    const status = String(item.status ?? '').toUpperCase();
    if (FAIL_CONCLUSIONS.has(conclusion) || FAIL_CONCLUSIONS.has(state)) {
      fail += 1;
    } else if (PASS_CONCLUSIONS.has(conclusion) || state === 'SUCCESS') {
      pass += 1;
    } else if (PENDING_STATES.has(status) || PENDING_STATES.has(state) || (!conclusion && status && status !== 'COMPLETED')) {
      pending += 1;
    }
  }
  return { pass, fail, pending, total: items.length };
}

export function summarizeComments(comments) {
  const list = Array.isArray(comments)
    ? comments
    : (Array.isArray(comments?.nodes) ? comments.nodes : []);
  const count = Number.isInteger(comments?.totalCount)
    ? Math.max(comments.totalCount, list.length)
    : list.length;
  let latest = null;
  let latestMs = -1;
  let latestAt = '';
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const ts = c.updatedAt || c.createdAt || '';
    const ms = parseTimeMs(ts) ?? 0;
    if (latest === null || ms >= latestMs) {
      latest = c;
      latestMs = ms;
      latestAt = ts;
    }
  }
  const latestAuthor = typeof latest?.author === 'string'
    ? latest.author
    : (latest?.author?.login || latest?.user?.login || '');
  return {
    count,
    latest,
    latestAt,
    latestMs: latestMs >= 0 ? latestMs : null,
    latestAuthor,
  };
}

export function classifyIssueComment(comment, { owner = '', peerPoLogins = [] } = {}) {
  if (!comment || typeof comment !== 'object') {
    return {
      isHandoff: false,
      isOwner: false,
      isPeerPo: false,
      isAgentProtocol: false,
      isClaimOrCheckpoint: false,
      tag: 'none',
    };
  }
  const body = String(comment.body ?? '');
  const author = String(
    typeof comment.author === 'string'
      ? comment.author
      : (comment.author?.login || comment.user?.login || ''),
  ).trim();
  const ownerNorm = String(owner || '').trim().toLowerCase();
  const authorNorm = author.toLowerCase();
  const peerSet = new Set(
    (Array.isArray(peerPoLogins) ? peerPoLogins : [])
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean),
  );

  const isHandoff = HANDOFF_COMMENT_RE.test(body);
  const isClaimOrCheckpoint = CLAIM_OR_CHECKPOINT_RE.test(body);
  const isPeerPo = Boolean((authorNorm && peerSet.has(authorNorm)) || PEER_PO_COMMENT_RE.test(body));
  // Agents running gh under the owner's GitHub token post protocol comments (claim:, checkpoint:,
  // done:, release:, PO acceptance:, blocked:, waiting:, etc.) as the owner account; never treat
  // those as genuine human owner replies (while keeping handoff: and peer-PO signals active).
  const isAgentProtocol = !isHandoff && !isPeerPo && (AGENT_PROTOCOL_COMMENT_RE.test(body) || isClaimOrCheckpoint);
  const isOwner = Boolean(
    !isAgentProtocol
    && !isHandoff
    && !isPeerPo
    && ownerNorm
    && authorNorm
    && (authorNorm === ownerNorm || ownerNorm.split(/\s+/)[0] === authorNorm),
  );

  let tag = 'comment';
  if (isHandoff) tag = 'handoff';
  else if (isOwner) tag = 'owner';
  else if (isPeerPo) tag = 'peer-po';
  else if (isAgentProtocol) tag = 'protocol';

  return { isHandoff, isOwner, isPeerPo, isAgentProtocol, isClaimOrCheckpoint, tag };
}

export function extractIssueLabelsFromFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint) return [];
  const part = fingerprint.split('|').find((p) => p.startsWith('lbl:'));
  if (!part) return [];
  return part.slice(4).split(',').map((s) => s.trim()).filter(Boolean);
}

function hasActiveClaimComment(comments) {
  const list = Array.isArray(comments)
    ? comments
    : (Array.isArray(comments?.nodes) ? comments.nodes : []);
  let claimed = false;
  for (const c of list) {
    const body = String(c?.body ?? '');
    if (CLAIM_OR_CHECKPOINT_RE.test(body)) claimed = true;
    else if (RELEASE_OR_DONE_RE.test(body)) claimed = false;
  }
  return claimed;
}

export function buildPrFingerprint(pr) {
  const num = Number.isInteger(pr?.number) ? pr.number : 0;
  const mergeState = String(pr?.mergeStateStatus ?? '').toUpperCase();
  const reviewDecision = String(pr?.reviewDecision ?? '').toUpperCase();
  const headRefOid = String(pr?.headRefOid ?? '');
  const updatedAt = String(pr?.updatedAt ?? '');
  const ci = summarizeStatusChecks(pr?.statusCheckRollup);
  const c = summarizeComments(pr?.comments);
  return `pr:${num}|ms:${mergeState}|rd:${reviewDecision}|sha:${headRefOid}|upd:${updatedAt}|ci:${ci.pass}/${ci.fail}/${ci.pending}/${ci.total}|c:${c.count}@${c.latestAt}:${c.latestAuthor}`;
}

export function extractPrStructuralKey(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint) return '';
  return fingerprint
    .split('|')
    .filter((part) => !part.startsWith('upd:') && !part.startsWith('c:'))
    .join('|');
}

export function buildIssueFingerprint(issue, options = {}) {
  const num = Number.isInteger(issue?.number) ? issue.number : 0;
  const state = String(issue?.state ?? 'OPEN').toUpperCase();
  const labels = [...new Set(normalizeLabelNames(issue?.labels))].sort();
  const updatedAt = String(issue?.updatedAt ?? '');
  const c = summarizeComments(issue?.comments);
  const cls = classifyIssueComment(c.latest, options);
  return `issue:${num}|st:${state}|lbl:${labels.join(',')}|upd:${updatedAt}|c:${c.count}@${c.latestAt}:${c.latestAuthor}:${cls.tag}`;
}

export function computeBackoffMs(consecutiveUnanswered, baseMinutes = DEFAULT_BACKOFF_BASE_MINUTES, maxMinutes = DEFAULT_BACKOFF_MAX_MINUTES) {
  const n = Number(consecutiveUnanswered);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const base = Number.isFinite(Number(baseMinutes)) && Number(baseMinutes) > 0 ? Number(baseMinutes) : DEFAULT_BACKOFF_BASE_MINUTES;
  const max = Number.isFinite(Number(maxMinutes)) && Number(maxMinutes) > 0 ? Number(maxMinutes) : DEFAULT_BACKOFF_MAX_MINUTES;
  const exp = Math.min(Math.floor(n) - 1, 20);
  const minutes = Math.min(base * (2 ** exp), max);
  return Math.round(minutes * 60_000);
}

export function checkProfileAffinity({
  envProfile = '',
  appDataDir = '',
  execDataDir = '',
  brainDir = '',
  scriptPath = '',
} = {}) {
  const trimmedEnv = typeof envProfile === 'string' ? envProfile.trim() : '';
  const sidecarProfile = trimmedEnv || inferProfileName(appDataDir, execDataDir, scriptPath) || null;
  const targetProfile = inferProfileName(brainDir) || null;

  if (sidecarProfile && targetProfile && sidecarProfile.toLowerCase() !== targetProfile.toLowerCase()) {
    return {
      ok: false,
      sidecarProfile,
      targetProfile,
      reason: `profile-mismatch: sidecar=${sidecarProfile} target=${targetProfile}`,
    };
  }
  return {
    ok: true,
    sidecarProfile,
    targetProfile,
    reason: null,
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function sanitizeLockKey(key) {
  return String(key || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'default';
}

function readLockMetadata(filePath) {
  try {
    const stat = statSync(filePath);
    let holderPid = null;
    let holderToken = null;
    let lockCreatedMs = stat.mtimeMs;
    try {
      const existing = JSON.parse(readFileSync(filePath, 'utf8'));
      if (Number.isInteger(existing?.pid) && existing.pid > 0) holderPid = existing.pid;
      if (typeof existing?.token === 'string' && existing.token) holderToken = existing.token;
      if (typeof existing?.acquiredAtMs === 'number' && Number.isFinite(existing.acquiredAtMs)) {
        lockCreatedMs = existing.acquiredAtMs;
      }
    } catch {
      // Corrupt/unparseable lockfile: rely on mtime TTL.
    }
    return { exists: true, holderPid, holderToken, lockCreatedMs };
  } catch (err) {
    if (err?.code === 'ENOENT') return { exists: false, holderPid: null, holderToken: null, lockCreatedMs: 0 };
    return { exists: true, holderPid: null, holderToken: null, lockCreatedMs: Date.now() };
  }
}

export function acquirePoLock(lockDir, key, ttlMs = DEFAULT_LOCK_TTL_MS, nowMs = Date.now()) {
  if (!lockDir || typeof lockDir !== 'string' || !lockDir.trim() || !key) {
    return { acquired: true, lockPath: null, token: null, disabled: true, staleRemoved: false };
  }
  const resolvedDir = expandHome(lockDir.trim());
  const lockPath = join(resolvedDir, `${sanitizeLockKey(key)}.lock`);
  const token = randomBytes(12).toString('hex');
  const payload = `${JSON.stringify({ pid: process.pid, token, key: String(key), acquiredAt: new Date(nowMs).toISOString(), acquiredAtMs: nowMs })}\n`;

  try {
    mkdirSync(resolvedDir, { recursive: true });
  } catch (err) {
    return { acquired: true, lockPath: null, token: null, disabled: false, staleRemoved: false, error: err.message };
  }

  try {
    writeFileSync(lockPath, payload, { flag: 'wx', encoding: 'utf8' });
    return { acquired: true, lockPath, token, disabled: false, staleRemoved: false };
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      return { acquired: true, lockPath: null, token: null, disabled: false, staleRemoved: false, error: err.message };
    }
  }

  // Lock already exists: check whether it is stale (expired TTL or dead PID).
  const meta = readLockMetadata(lockPath);
  const expired = meta.exists && (nowMs - meta.lockCreatedMs) > ttlMs;
  const deadOwner = meta.exists && meta.holderPid !== null && !isProcessAlive(meta.holderPid);
  const isStale = !meta.exists || expired || deadOwner;

  if (!isStale) {
    return { acquired: false, lockPath, token: null, disabled: false, staleRemoved: false, reason: 'locked', holderPid: meta.holderPid };
  }

  // Rename-before-unlink avoids TOCTOU where another process acquires a fresh lock
  // between our staleness check and unlinkSync.
  let staleRemoved = false;
  if (meta.exists) {
    const stalePath = `${lockPath}.stale.${process.pid}.${token}`;
    try {
      renameSync(lockPath, stalePath);
      const renamedMeta = readLockMetadata(stalePath);
      const renamedExpired = (nowMs - renamedMeta.lockCreatedMs) > ttlMs;
      const renamedDead = renamedMeta.holderPid !== null && !isProcessAlive(renamedMeta.holderPid);
      if (renamedMeta.exists && !renamedExpired && !renamedDead && renamedMeta.holderToken !== meta.holderToken) {
        // A concurrent live owner replaced the lock right before our rename: restore it.
        try {
          renameSync(stalePath, lockPath);
        } catch {
          // Another process already holds lockPath; clean up our stalePath if needed.
        }
        return { acquired: false, lockPath, token: null, disabled: false, staleRemoved: false, reason: 'locked', holderPid: renamedMeta.holderPid };
      }
      staleRemoved = true;
      try {
        unlinkSync(stalePath);
      } catch {
        // Ignore cleanup failure on already-unlinked stale file.
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        return { acquired: false, lockPath, token: null, disabled: false, staleRemoved: false, reason: 'locked', holderPid: meta.holderPid };
      }
    }
  }

  try {
    writeFileSync(lockPath, payload, { flag: 'wx', encoding: 'utf8' });
    return { acquired: true, lockPath, token, disabled: false, staleRemoved };
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { acquired: false, lockPath, token: null, disabled: false, staleRemoved: false, reason: 'locked', holderPid: meta.holderPid };
    }
    return { acquired: true, lockPath: null, token: null, disabled: false, staleRemoved: false, error: err.message };
  }
}

export function releasePoLock(lockOrPath, expectedToken = null) {
  const lockPath = typeof lockOrPath === 'string'
    ? lockOrPath
    : (lockOrPath && typeof lockOrPath.lockPath === 'string' ? lockOrPath.lockPath : null);
  const token = expectedToken ?? (lockOrPath && typeof lockOrPath === 'object' ? lockOrPath.token : null);
  if (!lockPath) return false;
  try {
    const meta = readLockMetadata(lockPath);
    if (!meta.exists) return false;
    if (token) {
      if (meta.holderToken && meta.holderToken !== token) return false;
    } else if (meta.holderPid !== null && meta.holderPid !== process.pid && isProcessAlive(meta.holderPid)) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export function readJsonState(statePath) {
  if (!statePath || typeof statePath !== 'string') return null;
  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeJsonStateAtomic(statePath, data) {
  if (!statePath || typeof statePath !== 'string') return false;
  const dir = dirname(statePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, statePath);
    return true;
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error.
    }
    throw err;
  }
}

export function isSessionLiveRunning(session, latestRestartMs, nowMs, staleRunningMs = DEFAULT_STALE_RUNNING_MS) {
  if (!session) return false;
  const stepMs = typeof session.lastStepMs === 'number' ? session.lastStepMs : session.lastActivityMs;
  const mtimeMs = typeof session.mtimeMs === 'number' ? session.mtimeMs : stepMs;
  const latestTouchMs = Math.max(stepMs ?? 0, mtimeMs ?? 0);
  if (typeof session.stepRunning === 'boolean' || typeof session.mtimeRunning === 'boolean') {
    const postRestartMtime = Boolean(session.mtimeRunning) && (latestRestartMs <= 0 || mtimeMs >= latestRestartMs);
    const postRestartStep = Boolean(session.stepRunning)
      && (latestRestartMs <= 0 || stepMs >= latestRestartMs)
      && (nowMs - latestTouchMs < staleRunningMs);
    return postRestartMtime || postRestartStep;
  }
  if (!session.isRunning) return false;
  if (latestRestartMs > 0 && latestRestartMs > latestTouchMs) return false;
  return (nowMs - latestTouchMs) < staleRunningMs;
}

// Consistent across --dry-run, Run 1, and Run 2: multi-signal is the v2.18.0 default
// unless explicitly opted out via config.multiSignal === false or legacyMode === true.
export function isMultiSignalMode(config = {}, options = {}) {
  if (config?.multiSignal === false || options?.multiSignal === false || options?.legacyMode === true) {
    return false;
  }
  return true;
}

// 6-signal 0-token evaluator shared across Antigravity & Claude Desktop.
export function evaluateSignals({
  po = {},
  session = null,
  subSessions = [],
  restartTimes = {},
  openPrs = null,
  openIssues = null,
  prevPoState = null,
  config = {},
  nowMs = Date.now(),
  multiSignal,
} = {}) {
  if (!session) {
    return {
      shouldWake: false,
      skipped: 'missing-session',
      reasons: [],
      signals: {},
      readyPrs: null,
      changedPrs: [],
      stalledSubs: [],
      triggeredIssues: [],
      idleSubs: [],
      restartAfterActivity: false,
      consecutiveUnansweredWakes: 0,
      shouldAlertBackoff: false,
      nextPoState: prevPoState ? { ...prevPoState } : {},
    };
  }

  const useMultiSignal = typeof multiSignal === 'boolean'
    ? multiSignal
    : (config?.multiSignal !== false);

  const bootMs = parseTimeMs(restartTimes?.bootTime);
  const appStartMs = parseTimeMs(restartTimes?.appStartTime);
  const latestRestartMs = Math.max(bootMs ?? -1, appStartMs ?? -1);

  const lastPlannerMs = typeof session.lastPlannerMs === 'number'
    ? session.lastPlannerMs
    : (typeof session.lastActivityMs === 'number' ? session.lastActivityMs : 0);

  const debounceMs = Number.isFinite(Number(config?.debounceMs))
    ? Number(config.debounceMs)
    : (Number.isFinite(Number(config?.debounceSeconds)) ? Number(config.debounceSeconds) * 1000 : DEFAULT_DEBOUNCE_MS);

  const preservedState = prevPoState ? { ...prevPoState } : {};
  const prevSentAtMs = typeof prevPoState?.lastSentAtMs === 'number' ? prevPoState.lastSentAtMs : 0;
  const poAnsweredSinceLastSend = prevSentAtMs > 0 && lastPlannerMs > prevSentAtMs;
  if (poAnsweredSinceLastSend) {
    preservedState.unansweredSendsSincePlanner = 0;
  }

  if (isSessionLiveRunning(session, latestRestartMs, nowMs)) {
    return {
      shouldWake: false,
      skipped: 'running',
      reasons: [],
      signals: {},
      readyPrs: null,
      changedPrs: [],
      stalledSubs: [],
      triggeredIssues: [],
      idleSubs: [],
      restartAfterActivity: false,
      consecutiveUnansweredWakes: Number(session.consecutiveUnansweredWakes ?? 0) || 0,
      shouldAlertBackoff: false,
      nextPoState: preservedState,
    };
  }

  if (prevSentAtMs > 0 && prevSentAtMs >= lastPlannerMs && (nowMs - prevSentAtMs) >= 0 && (nowMs - prevSentAtMs) < debounceMs) {
    return {
      shouldWake: false,
      skipped: 'debounced',
      reasons: [],
      signals: {},
      readyPrs: null,
      changedPrs: [],
      stalledSubs: [],
      triggeredIssues: [],
      idleSubs: [],
      restartAfterActivity: false,
      consecutiveUnansweredWakes: Number(session.consecutiveUnansweredWakes ?? 0) || 0,
      shouldAlertBackoff: false,
      nextPoState: preservedState,
    };
  }

  const transcriptUnanswered = Math.max(0, Number(session.consecutiveUnansweredWakes ?? 0) || 0);
  // Also count wakes recorded in state.json after lastPlannerMs, even when Antigravity queues
  // agentapi send-message in memory without immediately writing a SYSTEM_MESSAGE to transcript.jsonl.
  const rawStateUnanswered = poAnsweredSinceLastSend
    ? 0
    : Math.max(0, Number(prevPoState?.unansweredSendsSincePlanner ?? 0) || 0);
  const stateUnanswered = rawStateUnanswered > 0
    ? rawStateUnanswered
    : (prevSentAtMs > 0 && prevSentAtMs > lastPlannerMs ? 1 : 0);
  preservedState.unansweredSendsSincePlanner = stateUnanswered;
  const consecutiveUnanswered = Math.max(transcriptUnanswered, stateUnanswered);
  const lastTurnStatus = session.lastTurnStatus ?? session.lastErrorType ?? null;
  const poIsQuotaOrError = lastTurnStatus === 'quota' || lastTurnStatus === 'error';
  const freshQuotaSubs = (subSessions ?? []).filter((s) => {
    if (s?.lastTurnStatus !== 'quota') return false;
    const subMs = typeof s.lastActivityMs === 'number' ? s.lastActivityMs : (s.lastPlannerMs ?? 0);
    return lastPlannerMs <= 0 || subMs > lastPlannerMs;
  });
  const hasSubagentQuotaError = freshQuotaSubs.length > 0;
  const maxFreshSubQuotaMs = freshQuotaSubs.reduce((acc, s) => {
    const subMs = typeof s.lastActivityMs === 'number' ? s.lastActivityMs : (s.lastPlannerMs ?? 0);
    return Math.max(acc, subMs);
  }, 0);
  const lastAttemptMs = Math.max(
    typeof session.lastWakeAtMs === 'number' ? session.lastWakeAtMs : 0,
    prevSentAtMs,
  );

  const backoffBaseMin = positiveInt(config?.backoffBaseMinutes, DEFAULT_BACKOFF_BASE_MINUTES);
  const backoffMaxMin = positiveInt(config?.backoffMaxMinutes, DEFAULT_BACKOFF_MAX_MINUTES);
  const quotaBaseMin = positiveInt(config?.quotaProbeBaseMinutes, DEFAULT_QUOTA_PROBE_BASE_MINUTES);
  const quotaMaxMin = positiveInt(config?.quotaProbeMaxMinutes, DEFAULT_QUOTA_PROBE_MAX_MINUTES);

  // Backoff gate when previous wake(s) went unanswered by the PO.
  // A fresh restart occurring after the last failed wake bypasses backoff so recovery isn't delayed.
  if (consecutiveUnanswered > 0 && lastAttemptMs > 0) {
    const requiredBackoffMs = poIsQuotaOrError
      ? computeBackoffMs(consecutiveUnanswered + 1, quotaBaseMin, quotaMaxMin)
      : computeBackoffMs(consecutiveUnanswered, backoffBaseMin, backoffMaxMin);
    const restartSinceLastAttempt = latestRestartMs > lastAttemptMs;
    const elapsedSinceAttempt = nowMs - lastAttemptMs;
    if (!restartSinceLastAttempt && elapsedSinceAttempt >= 0 && elapsedSinceAttempt < requiredBackoffMs) {
      return {
        shouldWake: false,
        skipped: 'backoff',
        backoffRemainingMs: requiredBackoffMs - elapsedSinceAttempt,
        reasons: [],
        signals: { backoff: { consecutiveUnanswered, requiredBackoffMs, elapsedSinceAttempt } },
        readyPrs: null,
        changedPrs: [],
        stalledSubs: [],
        triggeredIssues: [],
        idleSubs: [],
        restartAfterActivity: false,
        consecutiveUnansweredWakes: consecutiveUnanswered,
        shouldAlertBackoff: consecutiveUnanswered >= 2,
        nextPoState: preservedState,
      };
    }
  }

  const poLabels = normalizePoLabels(po);
  const validOpenPrs = Array.isArray(openPrs)
    ? openPrs.filter((pr) => Number.isInteger(pr?.number) && pr.number > 0)
    : null;

  let ownPrs = null;
  let readyPrs = null;
  const currentPrFingerprints = {};
  if (validOpenPrs !== null) {
    ownPrs = validOpenPrs.filter((pr) => {
      const names = normalizeLabelNames(pr.labels);
      return poLabels.some((lbl) => names.includes(lbl));
    });
    readyPrs = ownPrs.filter((pr) => pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'UNSTABLE');
    for (const pr of ownPrs) {
      currentPrFingerprints[String(pr.number)] = buildPrFingerprint(pr);
    }
  }

  const reasons = [];
  const signals = {};

  // Signal 1: restart (compared against lastPlannerMs, never SYSTEM_MESSAGE).
  const restartAfterActivity = latestRestartMs > 0 && latestRestartMs > lastPlannerMs;
  if (restartAfterActivity) {
    reasons.push('restart');
    signals.restart = { latestRestartMs, lastPlannerMs };
  }

  // Signal 2: pr-state-changed (or legacy 'unseen ready PR').
  const changedPrs = [];
  if (ownPrs !== null) {
    if (!useMultiSignal) {
      const unseen = readyPrs.filter((pr) => {
        const updatedMs = parseTimeMs(pr.updatedAt);
        return updatedMs !== null && updatedMs > lastPlannerMs;
      });
      if (unseen.length > 0) {
        reasons.push('unseen ready PR');
        signals.prStateChanged = unseen.map((pr) => ({ number: pr.number, status: pr.mergeStateStatus }));
        changedPrs.push(...unseen);
      }
    } else {
      const prevPrFps = prevPoState?.prFingerprints && typeof prevPoState.prFingerprints === 'object'
        ? prevPoState.prFingerprints
        : null;
      for (const pr of ownPrs) {
        const fp = currentPrFingerprints[String(pr.number)];
        const updatedMs = parseTimeMs(pr.updatedAt);
        const mergeState = String(pr.mergeStateStatus ?? '').toUpperCase();
        const reviewDecision = String(pr.reviewDecision ?? '').toUpperCase();
        const ci = summarizeStatusChecks(pr.statusCheckRollup);
        const comments = summarizeComments(pr.comments);
        const latestCommentMs = comments.latestMs;
        const hasNewComment = latestCommentMs !== null && latestCommentMs > lastPlannerMs;
        const isActionable = PR_ATTENTION_STATUSES.has(mergeState)
          || reviewDecision === 'CHANGES_REQUESTED'
          || ci.fail > 0
          || hasNewComment;

        if (!isActionable) continue;

        if (prevPrFps) {
          const prevFp = prevPrFps[String(pr.number)];
          if (prevFp === fp) continue; // Identical fingerprint -> already handled/seen.
          const updatedAfterPlanner = (updatedMs !== null && updatedMs > lastPlannerMs) || hasNewComment;
          if (prevFp === undefined) {
            if (updatedMs !== null && !updatedAfterPlanner) continue;
          } else {
            // Prevent self-echo when PO itself updated/commented on the PR during its last turn
            // (updatedMs <= lastPlannerMs): require either a newer update/comment after lastPlannerMs,
            // or a genuine structural change (mergeState/reviewDecision/headRefOid/CI) observed after lastPlannerMs.
            const structuralChanged = extractPrStructuralKey(prevFp) !== extractPrStructuralKey(fp);
            const prevStateAtMs = typeof prevPoState?.lastEvaluatedAtMs === 'number' ? prevPoState.lastEvaluatedAtMs : null;
            const structuralAfterPlanner = structuralChanged
              && (updatedAfterPlanner || updatedMs === null || (prevStateAtMs !== null && prevStateAtMs >= lastPlannerMs));
            if (!updatedAfterPlanner && !structuralAfterPlanner) continue;
          }
          changedPrs.push({
            number: pr.number,
            mergeStateStatus: mergeState || 'UNKNOWN',
            reviewDecision: reviewDecision || null,
            ciFail: ci.fail,
            hasNewComment,
            fingerprint: fp,
          });
        } else {
          // Stateless fallback: actionable PR updated (or commented) after lastPlannerMs.
          const isNewer = (updatedMs !== null && updatedMs > lastPlannerMs) || hasNewComment;
          if (isNewer) {
            changedPrs.push({
              number: pr.number,
              mergeStateStatus: mergeState || 'UNKNOWN',
              reviewDecision: reviewDecision || null,
              ciFail: ci.fail,
              hasNewComment,
              fingerprint: fp,
            });
          }
        }
      }
      if (changedPrs.length > 0) {
        reasons.push('pr-state-changed');
        signals.prStateChanged = changedPrs;
      }
    }
  }

  // Signal 3: subagent-stalled-or-errored (multi-signal mode).
  const activeMinutes = positiveInt(config?.activeMinutes, 60);
  const activeWindowMs = activeMinutes * 60_000;
  const stallMinutes = positiveInt(config?.subagentStallMinutes, DEFAULT_SUBAGENT_STALL_MINUTES);
  const stallMs = stallMinutes * 60_000;
  const subCooldownMinutes = positiveInt(config?.subagentCooldownMinutes, DEFAULT_SUBAGENT_COOLDOWN_MINUTES);
  const subCooldownMs = subCooldownMinutes * 60_000;
  const prevSubAlerts = prevPoState?.subagentAlertedAt && typeof prevPoState.subagentAlertedAt === 'object'
    ? prevPoState.subagentAlertedAt
    : {};

  const idleSubs = (subSessions ?? []).filter(
    (sub) => !isSessionLiveRunning(sub, latestRestartMs, nowMs) && (nowMs - (sub.lastActivityMs ?? 0)) > (useMultiSignal ? stallMs : activeWindowMs),
  );

  const allowSilentStall = config?.allowSilentSubagentStall !== false;
  const stalledSubs = [];
  if (useMultiSignal && Array.isArray(subSessions)) {
    for (const sub of subSessions) {
      if (!sub || isSessionLiveRunning(sub, latestRestartMs, nowMs)) continue;
      const subId = sub.conversationId || sub.id || '';
      const subLastMs = typeof sub.lastActivityMs === 'number' ? sub.lastActivityMs : (sub.lastPlannerMs ?? 0);
      const subIdleMs = nowMs - subLastMs;
      const isErrored = Boolean(sub.hasError || sub.lastTurnStatus === 'error' || sub.lastTurnStatus === 'quota');
      const isWaiting = Boolean(sub.waitingForUser);
      const silentStallAllowed = allowSilentStall || sub.sentMessageToPoAfterLastTurn === false;
      const isStalled = silentStallAllowed && subIdleMs >= stallMs && !sub.sentMessageToPoAfterLastTurn;

      if (!isErrored && !isWaiting && !isStalled) continue;

      const freshErrorOrWait = (isErrored || isWaiting) && (lastPlannerMs <= 0 || subLastMs > lastPlannerMs);
      const freshStall = isStalled && (lastPlannerMs <= 0 || (subLastMs + stallMs) > lastPlannerMs);
      if (!freshErrorOrWait && !freshStall) continue;

      const lastAlertMs = subId && typeof prevSubAlerts[subId] === 'number' ? prevSubAlerts[subId] : 0;
      if (lastAlertMs > 0 && (nowMs - lastAlertMs) < subCooldownMs) continue;

      const kind = isErrored ? 'errored' : (isWaiting ? 'waiting-for-user' : 'stalled');
      stalledSubs.push({
        conversationId: subId,
        role: sub.role || (subId ? subId.slice(0, 8) : 'subagent'),
        kind,
        idleMinutes: Math.max(0, Math.floor(subIdleMs / 60_000)),
      });
    }
    if (stalledSubs.length > 0) {
      reasons.push('subagent-stalled-or-errored');
      signals.subagentStalledOrErrored = stalledSubs;
    }
  }

  // Signal 4: issue-dispatchable-or-owner-reply (multi-signal mode).
  const currentIssueFingerprints = {};
  const triggeredIssues = [];
  const issueCooldownMinutes = positiveInt(config?.issueCooldownMinutes, DEFAULT_ISSUE_COOLDOWN_MINUTES);
  const issueCooldownMs = issueCooldownMinutes * 60_000;
  const prevIssueAlerts = prevPoState?.issueAlertedAt && typeof prevPoState.issueAlertedAt === 'object'
    ? prevPoState.issueAlertedAt
    : {};
  const nextIssueAlerts = { ...prevIssueAlerts };

  if (useMultiSignal && Array.isArray(openIssues)) {
    const validIssues = openIssues.filter((issue) => Number.isInteger(issue?.number) && issue.number > 0);
    const ownIssues = validIssues.filter((issue) => {
      const state = String(issue.state ?? 'OPEN').toUpperCase();
      if (state !== 'OPEN') return false;
      const names = normalizeLabelNames(issue.labels);
      return poLabels.length === 0 || poLabels.some((lbl) => names.includes(lbl));
    });
    const subSessionsNormal = positiveInt(config?.subSessionsNormal ?? po?.subSessionsNormal, DEFAULT_SUB_SESSIONS_NORMAL);
    const activeSubCount = Array.isArray(subSessions) ? subSessions.length : 0;
    const hasFreeSlot = activeSubCount < subSessionsNormal;
    const prevIssueFps = prevPoState?.issueFingerprints && typeof prevPoState.issueFingerprints === 'object'
      ? prevPoState.issueFingerprints
      : null;
    const commentOpts = { owner: config?.owner || '', peerPoLogins: config?.peerPoLogins || [] };

    for (const issue of ownIssues) {
      const fp = buildIssueFingerprint(issue, commentOpts);
      currentIssueFingerprints[String(issue.number)] = fp;
      const prevFp = prevIssueFps ? prevIssueFps[String(issue.number)] : undefined;
      if (prevIssueFps && prevFp === fp) continue;

      const updatedMs = parseTimeMs(issue.updatedAt);
      const comments = summarizeComments(issue.comments);
      const cls = classifyIssueComment(comments.latest, commentOpts);
      const hasNewSpecialComment = Boolean(
        (cls.isHandoff || cls.isOwner || cls.isPeerPo)
        && comments.latestMs !== null
        && comments.latestMs > lastPlannerMs,
      );

      const labels = normalizeLabelNames(issue.labels);
      const isBlocked = labels.some((l) => BLOCKED_ISSUE_LABEL_RE.test(l));
      const isFresh = updatedMs !== null && updatedMs > lastPlannerMs;
      const wasBlocked = prevFp !== undefined
        && extractIssueLabelsFromFingerprint(prevFp).some((l) => BLOCKED_ISSUE_LABEL_RE.test(l));
      const isNewlyOnLine = prevIssueFps ? (prevFp === undefined && isFresh) : isFresh;
      const justUnblocked = Boolean(prevIssueFps && prevFp !== undefined && wasBlocked && !isBlocked);
      const isDispatchable = hasFreeSlot
        && !isBlocked
        && !cls.isClaimOrCheckpoint
        && !hasActiveClaimComment(issue.comments)
        && (isNewlyOnLine || justUnblocked);

      if (hasNewSpecialComment || isDispatchable) {
        const trigger = hasNewSpecialComment
          ? (cls.isHandoff ? 'handoff' : (cls.isOwner ? 'owner-reply' : 'peer-po'))
          : (justUnblocked ? 'unblocked' : 'dispatchable');
        const alertKey = `${issue.number}:${trigger}`;
        const lastAlertMs = typeof prevIssueAlerts[alertKey] === 'number' ? prevIssueAlerts[alertKey] : 0;
        if (lastAlertMs > 0 && (nowMs - lastAlertMs) < issueCooldownMs) continue;
        nextIssueAlerts[alertKey] = nowMs;
        triggeredIssues.push({
          number: issue.number,
          trigger,
          fingerprint: fp,
        });
      }
    }
    if (triggeredIssues.length > 0) {
      reasons.push('issue-dispatchable-or-owner-reply');
      signals.issueDispatchableOrOwnerReply = triggeredIssues;
    }
  }

  // Signal 5: quota-recovery-probe (only when PO/subagent hit quota/error or unanswered wakes exist).
  // For subagent-only quota errors, track probe count/timestamp in prevPoState (30m -> 60m -> 120m,
  // capped at MAX_SUBAGENT_QUOTA_PROBES) and drop to safety-heartbeat when no newer error occurred after lastPlannerMs.
  const prevSubQuota = prevPoState?.subagentQuotaProbe && typeof prevPoState.subagentQuotaProbe === 'object'
    ? prevPoState.subagentQuotaProbe
    : null;
  let nextSubQuotaProbe = prevSubQuota;
  if (!hasSubagentQuotaError) {
    nextSubQuotaProbe = null;
  }

  if (poIsQuotaOrError || consecutiveUnanswered > 0) {
    const refMs = Math.max(lastPlannerMs, lastAttemptMs);
    const probeWaitMs = poIsQuotaOrError
      ? computeBackoffMs(consecutiveUnanswered + 1, quotaBaseMin, quotaMaxMin)
      : computeBackoffMs(consecutiveUnanswered, backoffBaseMin, backoffMaxMin);
    if (refMs > 0 && (nowMs - refMs) >= probeWaitMs) {
      reasons.push('quota-recovery-probe');
      signals.quotaRecoveryProbe = {
        source: 'po',
        lastTurnStatus,
        consecutiveUnanswered,
        probeWaitMinutes: Math.round(probeWaitMs / 60_000),
      };
    }
  } else if (hasSubagentQuotaError) {
    const sameIncident = prevSubQuota && prevSubQuota.errorAtMs === maxFreshSubQuotaMs;
    const probeCount = sameIncident && Number.isInteger(prevSubQuota.count) ? prevSubQuota.count : 0;
    const maxProbes = positiveInt(config?.maxSubagentQuotaProbes, MAX_SUBAGENT_QUOTA_PROBES);
    if (probeCount < maxProbes) {
      const refMs = sameIncident && typeof prevSubQuota.lastProbeAtMs === 'number' && prevSubQuota.lastProbeAtMs > 0
        ? prevSubQuota.lastProbeAtMs
        : Math.max(lastPlannerMs, maxFreshSubQuotaMs);
      const probeWaitMs = computeBackoffMs(probeCount + 1, quotaBaseMin, quotaMaxMin);
      if (refMs > 0 && (nowMs - refMs) >= probeWaitMs) {
        reasons.push('quota-recovery-probe');
        signals.quotaRecoveryProbe = {
          source: 'subagent',
          lastTurnStatus: 'quota',
          probeCount: probeCount + 1,
          probeWaitMinutes: Math.round(probeWaitMs / 60_000),
        };
        nextSubQuotaProbe = {
          errorAtMs: maxFreshSubQuotaMs,
          count: probeCount + 1,
          lastProbeAtMs: nowMs,
        };
      } else {
        nextSubQuotaProbe = sameIncident ? prevSubQuota : { errorAtMs: maxFreshSubQuotaMs, count: 0, lastProbeAtMs: 0 };
      }
    }
  }

  // Signal 6: safety-heartbeat (replaces legacy quiet in multi-signal mode).
  // Gate on max(lastPlannerMs, prevSentAtMs) so a queued wake can never re-fire safety-heartbeat every 10m.
  const idleMs = nowMs - lastPlannerMs;
  const heartbeatIdleMs = nowMs - Math.max(lastPlannerMs, prevSentAtMs);
  if (!useMultiSignal) {
    if (idleMs >= activeWindowMs) {
      reasons.push(`quiet for ${Math.floor(idleMs / 60_000)} minutes`);
      signals.quiet = { idleMinutes: Math.floor(idleMs / 60_000), activeMinutes };
    }
  } else {
    const hasWorkInFlight = Boolean((ownPrs && ownPrs.length > 0) || (Array.isArray(subSessions) && subSessions.length > 0));
    const hbActiveMin = positiveInt(
      config?.heartbeatActiveMinutes ?? config?.gatekeeperHeartbeatActiveMinutes,
      DEFAULT_HEARTBEAT_ACTIVE_MINUTES,
    );
    const hbIdleMin = positiveInt(
      config?.heartbeatIdleMinutes ?? config?.gatekeeperHeartbeatIdleMinutes,
      DEFAULT_HEARTBEAT_IDLE_MINUTES,
    );
    const thresholdMin = hasWorkInFlight ? hbActiveMin : hbIdleMin;
    if (heartbeatIdleMs >= thresholdMin * 60_000) {
      reasons.push(`safety-heartbeat (${hasWorkInFlight ? 'active' : 'idle'}, ${Math.floor(idleMs / 60_000)}m)`);
      signals.safetyHeartbeat = {
        mode: hasWorkInFlight ? 'active' : 'idle',
        idleMinutes: Math.floor(idleMs / 60_000),
        thresholdMinutes: thresholdMin,
      };
    }
  }

  const nextSubAlerts = { ...prevSubAlerts };
  for (const s of stalledSubs) {
    if (s.conversationId) nextSubAlerts[s.conversationId] = nowMs;
  }

  const nextPoState = {
    ...preservedState,
    prFingerprints: validOpenPrs !== null ? currentPrFingerprints : (preservedState.prFingerprints ?? {}),
    issueFingerprints: Array.isArray(openIssues) ? currentIssueFingerprints : (preservedState.issueFingerprints ?? {}),
    subagentAlertedAt: nextSubAlerts,
    issueAlertedAt: nextIssueAlerts,
    subagentQuotaProbe: nextSubQuotaProbe,
    lastEvaluatedAtMs: nowMs,
  };

  if (reasons.length === 0) {
    return {
      shouldWake: false,
      skipped: 'no-reason',
      reasons: [],
      signals,
      readyPrs,
      changedPrs,
      stalledSubs,
      triggeredIssues,
      idleSubs,
      restartAfterActivity,
      consecutiveUnansweredWakes: consecutiveUnanswered,
      shouldAlertBackoff: consecutiveUnanswered >= 2,
      nextPoState,
    };
  }

  return {
    shouldWake: true,
    skipped: null,
    reasons,
    signals,
    readyPrs,
    changedPrs,
    stalledSubs,
    triggeredIssues,
    idleSubs,
    restartAfterActivity,
    consecutiveUnansweredWakes: consecutiveUnanswered,
    shouldAlertBackoff: consecutiveUnanswered >= 2,
    nextPoState,
  };
}
