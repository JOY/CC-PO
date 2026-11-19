#!/usr/bin/env node
// Claude Code PostToolUse hook for Write|Edit|MultiEdit.
// Checks *-po-checkin.md against the 6144-byte (6 KB) rolling cap.
// Only compacts trailing bullet lines inside an explicit archived/history
// section while keeping the metadata header and all active state intact;
// otherwise leaves the file untouched and emits a structured warning.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHECKIN_CAP_BYTES = 6144;
const ARCHIVE_HEADING_RE = /^##+\s+(?:recently\s+closed|completed|history|archived?|closed)\b/i;

export function extractTargetPath(payload) {
  const input = payload?.tool_input;
  const response = payload?.tool_response;
  const raw = input?.file_path || input?.path || input?.filePath || response?.filePath || response?.file_path || '';
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  if (isAbsolute(trimmed)) return trimmed;
  const cwd = typeof payload?.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : process.cwd();
  return join(cwd, trimmed);
}

export function isCheckInFile(filePath) {
  return typeof filePath === 'string' && /-po-checkin\.md$/i.test(basename(filePath));
}

// Attempts safe compaction ONLY when the trailing section is an explicit
// archived/history heading containing bullet lines, and trimming trailing
// bullets reduces total UTF-8 size to <= maxBytes without touching any header
// or active section.
export function compactCheckInContent(text, maxBytes = CHECKIN_CAP_BYTES) {
  const currentBytes = Buffer.byteLength(text, 'utf8');
  if (currentBytes <= maxBytes) {
    return { changed: false, compacted: false, text, beforeBytes: currentBytes, afterBytes: currentBytes, trimmedCount: 0 };
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = text.endsWith('\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (hadTrailingNewline) lines.pop();

  let lastHeadingIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##+\s+/.test(lines[i])) lastHeadingIdx = i;
  }

  if (lastHeadingIdx === -1 || !ARCHIVE_HEADING_RE.test(lines[lastHeadingIdx].trim())) {
    return { changed: false, compacted: false, text, beforeBytes: currentBytes, afterBytes: currentBytes, trimmedCount: 0 };
  }

  const prefixLines = lines.slice(0, lastHeadingIdx + 1);
  const archiveLines = lines.slice(lastHeadingIdx + 1);

  // Require the archive body to consist only of blank lines, bullets, or a
  // prior compaction note so prose/non-list state is never silently dropped.
  const bulletIndices = [];
  for (let i = 0; i < archiveLines.length; i += 1) {
    const t = archiveLines[i].trim();
    if (!t || /^<!--\s*compacted\b/i.test(t) || /^\*\(compacted\b/i.test(t) || /^-\s+\(older archived items/i.test(t)) continue;
    if (/^[-*]\s+/.test(t)) {
      bulletIndices.push(i);
      continue;
    }
    return { changed: false, compacted: false, text, beforeBytes: currentBytes, afterBytes: currentBytes, trimmedCount: 0 };
  }

  if (bulletIndices.length === 0) {
    return { changed: false, compacted: false, text, beforeBytes: currentBytes, afterBytes: currentBytes, trimmedCount: 0 };
  }

  // Keep leading items (or trim from the bottom of the trailing archive list).
  for (let keep = bulletIndices.length - 1; keep >= 0; keep -= 1) {
    const cutBefore = keep === 0 ? 0 : bulletIndices[keep - 1] + 1;
    const keptArchive = archiveLines
      .slice(0, cutBefore)
      .filter((l) => !/^-\s+\(older archived items/i.test(l.trim()));
    const trimmedCount = bulletIndices.length - keep;
    const marker = `- (older archived items trimmed: ${trimmedCount} item(s) removed to keep check-in <= ${maxBytes} bytes)`;
    const candidateLines = [...prefixLines, ...keptArchive, marker];
    const candidateText = candidateLines.join(eol) + (hadTrailingNewline ? eol : '');
    const afterBytes = Buffer.byteLength(candidateText, 'utf8');
    if (afterBytes <= maxBytes) {
      return {
        changed: true,
        compacted: true,
        text: candidateText,
        beforeBytes: currentBytes,
        afterBytes,
        trimmedCount,
      };
    }
  }

  return { changed: false, compacted: false, text, beforeBytes: currentBytes, afterBytes: currentBytes, trimmedCount: 0 };
}

export function runHook(rawStdin) {
  let payload;
  try {
    payload = rawStdin && rawStdin.trim() ? JSON.parse(rawStdin) : {};
  } catch {
    return null;
  }

  const targetPath = extractTargetPath(payload);
  if (!targetPath || !isCheckInFile(targetPath) || !existsSync(targetPath)) {
    return null;
  }

  const original = readFileSync(targetPath, 'utf8');
  const bytes = Buffer.byteLength(original, 'utf8');
  if (bytes <= CHECKIN_CAP_BYTES) return null;

  const result = compactCheckInContent(original, CHECKIN_CAP_BYTES);
  if (result.compacted) {
    writeFileSync(targetPath, result.text, 'utf8');
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `CC-PO check-in cap: \`${basename(targetPath)}\` exceeded ${CHECKIN_CAP_BYTES} bytes (${result.beforeBytes} bytes) and was safely compacted to ${result.afterBytes} bytes by trimming ${result.trimmedCount} trailing archived bullet(s) while preserving header and live state.`,
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `CC-PO check-in cap warning: \`${basename(targetPath)}\` is ${bytes} bytes (exceeds ${CHECKIN_CAP_BYTES}-byte cap) and had no safe trailing archived section to trim automatically. Prune resolved/closed items into a trailing \`## Recently closed\` section or rely on GitHub so the check-in stays <= ${CHECKIN_CAP_BYTES} bytes.`,
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
    // Fail-open: never break Write/Edit tool completion.
  }
  process.exitCode = 0;
}
