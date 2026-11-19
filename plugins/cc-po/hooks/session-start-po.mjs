#!/usr/bin/env node
// Claude Code SessionStart hook (startup|compact).
// When inside a repository with docs/product-owner-config.md (or Docs/...),
// emits a compact reminder to check the config, active check-in file, <= 6 KB
// check-in cap, and fingerprinted set_monitor retry hygiene. Fail-open (exit 0).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findPoConfig(startDir) {
  if (!startDir || typeof startDir !== 'string') return null;
  let dir;
  try {
    dir = resolve(startDir);
  } catch {
    return null;
  }
  for (;;) {
    for (const rel of ['docs/product-owner-config.md', 'Docs/product-owner-config.md']) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return { root: dir, configPath: candidate, relativePath: rel };
    }
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function runHook(rawStdin, fallbackCwd = process.cwd()) {
  let payload = {};
  try {
    payload = rawStdin && rawStdin.trim() ? JSON.parse(rawStdin) : {};
  } catch {
    payload = {};
  }
  const cwd = typeof payload?.cwd === 'string' && payload.cwd.trim() ? payload.cwd : fallbackCwd;
  const found = findPoConfig(cwd);
  if (!found) return null;

  const source = payload?.source ? ` (${payload.source})` : '';
  const context = [
    `CC-PO session reminder${source}:`,
    `Read \`${found.relativePath}\` and your active \`*-po-checkin.md\` file first (GitHub remains the source of truth).`,
    'Keep the check-in file <= 6 KB (6144 bytes) by archiving finished items out of live state.',
    'Keep `set_monitor` retry hygiene: fingerprint PR/head state, back off retries within budget, and fall back permanently to `status` on denial.',
  ].join(' ');

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
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
    // Fail-open on unreadable stdin or environment.
  }
  process.exitCode = 0;
}
