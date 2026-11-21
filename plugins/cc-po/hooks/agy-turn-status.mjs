#!/usr/bin/env node
// Antigravity Stop (and optional PostInvocation) 0-token hook.
// Records the latest turn outcome ("ok" | "error" | "quota") atomically to
// ~/.claude/po-state/turn-status/<conversationId>.json (or $CC_PO_TURN_STATUS_DIR)
// so agy-gatekeeper.mjs can distinguish clean sleep from quota/error stops.
// Strictly fail-open: always writes valid JSON ({"decision":"allow"} for Stop,
// {} for other events) to stdout and exits 0.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TURN_STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PRUNE_MARKER_FILE = '.last-prune';
const SAFE_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const QUOTA_RE = /\b(?:quota|rate[_ -]?limit|429|529|overloaded|exhausted|resource_exhausted|too\s+many\s+requests|capacity)\b/i;
const ERROR_RE = /\b(?:error|failed|failure|exception|max_token_budget_exceeded|timed?\s*out|crash(?:ed)?)\b/i;

export function resolveTurnStatusDir(env = process.env) {
  const override = env?.CC_PO_TURN_STATUS_DIR;
  if (typeof override === 'string' && override.trim()) {
    return override.trim();
  }
  return join(homedir(), '.claude', 'po-state', 'turn-status');
}

export function extractConversationId(payload, env = process.env) {
  const candidates = [
    payload?.conversation_id,
    payload?.conversationId,
    payload?.session_id,
    payload?.sessionId,
    env?.ANTIGRAVITY_CONVERSATION_ID,
  ];
  for (const val of candidates) {
    if (typeof val !== 'string') continue;
    const trimmed = val.trim();
    if (trimmed && SAFE_ID_RE.test(trimmed) && trimmed !== '.' && trimmed !== '..') {
      return trimmed.toLowerCase();
    }
  }
  return null;
}

function normalizeErrorText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'object') {
    const parts = [val.message, val.code, val.status, val.reason, val.detail, val.error]
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .map(String);
    if (parts.length > 0) return parts.join(' ').trim();
    try {
      return JSON.stringify(val);
    } catch {
      return '';
    }
  }
  return String(val).trim();
}

export function classifyTurnStatus(payload) {
  if (!payload || typeof payload !== 'object') return 'ok';

  const errorText = normalizeErrorText(payload.error);
  const reasonText = [
    normalizeErrorText(payload.terminationReason),
    normalizeErrorText(payload.termination_reason),
    normalizeErrorText(payload.reason),
    normalizeErrorText(payload.status),
    normalizeErrorText(payload.message),
  ].filter(Boolean).join(' ');

  const combined = `${errorText} ${reasonText}`.trim();
  if (combined && QUOTA_RE.test(combined)) {
    return 'quota';
  }
  if (errorText) {
    return 'error';
  }
  if (reasonText && ERROR_RE.test(reasonText)) {
    return 'error';
  }
  return 'ok';
}

export function resolveEventName(payload, fallbackEvent = '') {
  const raw = typeof payload?.hookEventName === 'string' && payload.hookEventName.trim()
    ? payload.hookEventName.trim()
    : (typeof payload?.event === 'string' && payload.event.trim() ? payload.event.trim() : fallbackEvent);
  if (/^stop$/i.test(raw)) return 'Stop';
  if (/^postinvocation$/i.test(raw)) return 'PostInvocation';
  if (
    payload
    && typeof payload === 'object'
    && ('terminationReason' in payload || 'executionNum' in payload || 'fullyIdle' in payload || 'continuationActive' in payload)
  ) {
    return 'Stop';
  }
  return 'PostInvocation';
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}

export function pruneStaleTurnStatus(dir, options = {}) {
  let pruned = 0;
  try {
    if (!dir || !existsSync(dir)) return 0;
    const nowMs = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
    const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : TURN_STATUS_TTL_MS;
    const force = Boolean(options.force);
    const markerPath = join(dir, PRUNE_MARKER_FILE);

    if (!force && existsSync(markerPath)) {
      try {
        const mtimeMs = statSync(markerPath).mtimeMs;
        if (nowMs - mtimeMs < PRUNE_INTERVAL_MS) return 0;
      } catch {
        // Proceed to prune if marker stat fails.
      }
    }

    const cutoffMs = nowMs - ttlMs;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        if (st.isFile() && st.mtimeMs < cutoffMs) {
          unlinkSync(fullPath);
          pruned += 1;
        }
      } catch {
        // Fail-open on individual file races.
      }
    }

    try {
      writeFileSync(markerPath, `${new Date(nowMs).toISOString()}\n`, 'utf8');
    } catch {
      // Ignore marker update errors.
    }
  } catch {
    // Strictly fail-open.
  }
  return pruned;
}

export function recordTurnStatus(payload, options = {}) {
  const env = options.env || process.env;
  const conversationId = extractConversationId(payload, env);
  if (!conversationId) return null;

  const status = classifyTurnStatus(payload);
  const event = resolveEventName(payload, options.event || '');
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const updatedAt = now.toISOString();

  const record = {
    conversationId,
    status,
    updatedAt,
    event,
  };

  const dir = typeof options.dir === 'string' && options.dir.trim()
    ? options.dir.trim()
    : resolveTurnStatusDir(env);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${conversationId}.json`);
  atomicWriteJson(filePath, record);
  pruneStaleTurnStatus(dir, { now, ttlMs: options.ttlMs, force: Boolean(options.forcePrune) });

  return { filePath, record };
}

export function runHook(rawStdin, options = {}) {
  let payload = {};
  try {
    payload = rawStdin && rawStdin.trim() ? JSON.parse(rawStdin) : {};
  } catch {
    return {};
  }
  const event = resolveEventName(payload, options.event || '');
  try {
    recordTurnStatus(payload, options);
  } catch {
    // Fail-open: never disrupt Antigravity turn completion.
  }
  return event === 'Stop' ? { decision: 'allow' } : {};
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let out = {};
  try {
    const raw = readFileSync(0, 'utf8');
    out = runHook(raw) || {};
  } catch {
    // Fail-open: always return valid JSON and exit 0.
    out = {};
  }
  try {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    // Ignore stdout errors.
  }
  process.exitCode = 0;
}
