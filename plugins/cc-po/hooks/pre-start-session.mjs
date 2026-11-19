#!/usr/bin/env node
// Claude Code PreToolUse hook for mcp__ccd_session__start_session.
// Advisory/validation only: always exits 0 (fail-open) and emits JSON
// additionalContext when a start_session call pins a brittle model snapshot
// or passes malformed PO start inputs.
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyModelSpec } from '../skills/product-owner/po-model-advisor.mjs';

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_INITIATIONS = new Set(['user_asked', 'own_initiative']);

export function evaluateStartSessionInput(payload) {
  const warnings = [];
  const input = payload?.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return warnings;
  }

  if (input.model !== undefined && input.model !== null) {
    if (typeof input.model !== 'string' || input.model.trim() === '') {
      warnings.push('start_session `model` is empty or non-string; omit it to inherit the PO model or pass a rolling series (`sonnet`, `opus`, `haiku`, `default`).');
    } else {
      const spec = classifyModelSpec(input.model);
      if (spec.stale) {
        warnings.push(`start_session pins snapshot model \`${spec.head}\`; prefer rolling series \`${spec.suggestedSeries || 'sonnet'}\` or \`family:${spec.suggestedSeries || 'sonnet'}\` (or omit to inherit config/PO model).`);
      }
    }
  }

  if (input.effort !== undefined && input.effort !== null) {
    if (typeof input.effort !== 'string' || !VALID_EFFORTS.has(input.effort.trim().toLowerCase())) {
      warnings.push('start_session `effort` should be one of `low`, `medium`, `high`, `xhigh`, or `max`.');
    }
  }

  if (input.allowedCommands !== undefined) {
    const ok = Array.isArray(input.allowedCommands)
      && input.allowedCommands.every((item) => typeof item === 'string' && item.trim().length > 0);
    if (!ok) {
      warnings.push('start_session `allowedCommands` looks malformed; expected an array of non-empty command pattern strings.');
    }
  }

  if (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.trim() === '')) {
    warnings.push('start_session `prompt` is empty; pass a self-contained sub-session brief.');
  }

  if (input.initiation !== undefined && (typeof input.initiation !== 'string' || !VALID_INITIATIONS.has(input.initiation))) {
    warnings.push('start_session `initiation` should normally be `user_asked` (or `own_initiative` only for a last-resort queued card).');
  }

  return warnings;
}

export function runHook(rawStdin) {
  let payload;
  try {
    payload = rawStdin && rawStdin.trim() ? JSON.parse(rawStdin) : {};
  } catch {
    return null;
  }
  const warnings = evaluateStartSessionInput(payload);
  if (warnings.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `CC-PO start_session advisory: ${warnings.join(' ')}`,
    },
  };
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const raw = readFileSync(0, 'utf8');
    const out = runHook(raw);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    // Fail-open: never block start_session on hook errors.
  }
  process.exitCode = 0;
}
