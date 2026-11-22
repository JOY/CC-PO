#!/usr/bin/env node
// Cross-platform PostToolUse hook & CLI for Claude Code and Antigravity.
// Enforces the 6144-byte (6 KB) rolling cap on *-po-checkin.md files by
// safely rotating historical/completed entries into a sibling
// *-po-checkin-archive.md file while preserving metadata headers,
// "On every wake" instructions, and active/pending/waiting live state.
// Uses O(N) incremental byte accounting and atomic tmp+rename writes.
// Always fail-open (exit 0) so tool completion is never disrupted.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHECKIN_CAP_BYTES = 6144;

const MD_HEADING_RE = /^#{2,6}\s+/;
const PLAIN_SECTION_RE = /^(?:live\s+state|state|recently\s+closed|completed|previously\s+completed|history|archived?|closed|retired|digest|waiting\s+on|pending\s+po\s+work)\b[^\n]*:\s*$/i;
const ARCHIVE_HEADING_RE = /^(?:#{2,6}\s+)?(?:recently\s+closed|completed(?:\b|\s*\()|previously\s+completed|history|archived?|closed|retired|digest)\b/i;
const DATED_HEADING_RE = /^#{2,6}\s+\d{4}-\d{2}-\d{2}(?:$|\b|T\d{2}:\d{2})/;
const LIVE_STATE_HEADING_RE = /^(?:#{2,6}\s+)?(?:live\s+state|state)\b/i;
const PROTECTED_WAKE_HEADING_RE = /^(?:#{2,6}\s+)?(?:on\s+every\s+wake|steps?\s+each\s+wake|checklist\s+per\s+wake|check-?in\s+steps|wake-?ups?|standing\s+owner\s+instructions|owner\s+decisions(?:\s+recorded)?)\b/i;
const PROTECTED_WAITING_HEADING_RE = /^(?:#{2,6}\s+)?(?:waiting\s+on|pending\s+po\s+work|active\s+sub-?sessions)\b/i;
const MARKER_LINE_RE = /^-\s+\((?:older\s+archived\s+items|archived\s+\d+\s+item)/i;
const COMPLETED_ENTRY_RE = /\b(?:merged|closed|archived|retired|completed|complete|deployed|released|done|superseded|squash-merged|closed\s+pr)\b/i;
const ACTIVE_ENTRY_RE = /\b(?:in[- ]flight|in[- ]progress|active\s+pr|active\s+sub-?sessions?|running|waiting\s+on|waiting\s+for|waits?\s+for|pending|blocked|next:|todo|unblocked|held\s+at|paused\s+awaiting|open\s+ready\s+prs?|ask\s+joy|owner\s+decision\s+still\s+open|auto-refill\s+queue|still\s+open)\b/i;
const DATED_ENTRY_RE = /^[-*]\s+(?:\*\*)?(?:20\d{2}-\d{2}-\d{2}(?:$|\b|T\d{2}:\d{2})|~?\d{1,2}:(?:\d{2}|xx)Z\b)/i;

export function getArchivePath(filePath) {
  const dir = dirname(filePath);
  const name = basename(filePath);
  const archiveName = /\.md$/i.test(name) ? name.replace(/\.md$/i, '-archive.md') : `${name}-archive.md`;
  return join(dir, archiveName);
}

export function isAntigravityPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.toolCall && typeof payload.toolCall === 'object') return true;
  if ((payload.conversationId || payload.hookEventName) && !payload.tool_input && !payload.tool_response) return true;
  return false;
}

export function extractTargetPath(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const toolInput = payload.tool_input;
  const toolResponse = payload.tool_response;
  const agyArgs = payload.toolCall?.args;
  const input = payload.input;
  const args = payload.args;

  const candidates = [
    toolInput?.file_path,
    toolInput?.path,
    toolInput?.filePath,
    toolInput?.Path,
    toolInput?.TargetFile,
    toolResponse?.filePath,
    toolResponse?.file_path,
    agyArgs?.Path,
    agyArgs?.TargetFile,
    agyArgs?.file_path,
    agyArgs?.path,
    agyArgs?.filePath,
    input?.Path,
    input?.TargetFile,
    input?.file_path,
    input?.path,
    args?.Path,
    args?.TargetFile,
    args?.file_path,
    args?.path,
  ];

  const raw = candidates.find((v) => typeof v === 'string' && v.trim() !== '') || '';
  if (!raw) return null;
  const trimmed = raw.trim();
  if (isAbsolute(trimmed)) return trimmed;
  const baseDir = (typeof payload.cwd === 'string' && payload.cwd.trim())
    || (Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === 'string' && payload.workspacePaths[0].trim())
    || process.cwd();
  return join(baseDir, trimmed);
}

export function isCheckInFile(filePath) {
  return typeof filePath === 'string' && /-po-checkin\.md$/i.test(basename(filePath));
}

function isSectionHeadingLine(line) {
  return MD_HEADING_RE.test(line) || PLAIN_SECTION_RE.test(line.trim());
}

function parseEntries(bodyLines, eol) {
  const entries = [];
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    if (MARKER_LINE_RE.test(trimmed)) {
      i += 1;
      continue;
    }
    const startLines = [line];
    const isList = /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
    i += 1;
    if (isList) {
      while (i < bodyLines.length) {
        const next = bodyLines[i];
        if (/^[ \t]+\S/.test(next)) {
          startLines.push(next);
          i += 1;
          continue;
        }
        // Keep single blank line inside an indented sub-list only if followed by indented text.
        if (next.trim() === '' && i + 1 < bodyLines.length && /^[ \t]+\S/.test(bodyLines[i + 1])) {
          startLines.push(next);
          i += 1;
          continue;
        }
        break;
      }
    } else {
      while (i < bodyLines.length) {
        const next = bodyLines[i];
        if (next.trim() === '' || /^[-*]\s+/.test(next) || /^\d+[.)]\s+/.test(next)) break;
        startLines.push(next);
        i += 1;
      }
    }
    const text = startLines.join('\n');
    const bytes = Buffer.byteLength(eol === '\n' ? text : text.replace(/\n/g, eol), 'utf8');
    entries.push({
      lines: startLines,
      text,
      bytes,
      isList,
      isDated: DATED_ENTRY_RE.test(text),
      isActive: ACTIVE_ENTRY_RE.test(text),
      isCompleted: COMPLETED_ENTRY_RE.test(text),
      archived: false,
    });
  }
  return entries;
}

function parseDocument(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const eolBytes = Buffer.byteLength(eol, 'utf8');
  const hadTrailingNewline = text.endsWith('\n');
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  if (hadTrailingNewline) rawLines.pop();

  const preambleLines = [];
  const sections = [];
  let current = null;

  for (const line of rawLines) {
    if (isSectionHeadingLine(line)) {
      if (current) sections.push(current);
      current = { heading: line, rawBodyLines: [], archivedWhole: false };
    } else if (current) {
      current.rawBodyLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);

  const preambleText = preambleLines.join('\n').replace(/\n+$/, '');
  const preambleBytes = preambleText
    ? Buffer.byteLength(eol === '\n' ? preambleText : preambleText.replace(/\n/g, eol), 'utf8')
    : 0;

  for (const sec of sections) {
    const trimmedHeading = sec.heading.trim();
    sec.entries = parseEntries(sec.rawBodyLines, eol);
    sec.headingBytes = Buffer.byteLength(sec.heading, 'utf8');
    sec.keptCount = sec.entries.length;
    sec.keptBytes = sec.entries.reduce((sum, e) => sum + e.bytes, 0);
    sec.isArchiveSection = ARCHIVE_HEADING_RE.test(trimmedHeading);
    sec.isDatedSection = DATED_HEADING_RE.test(trimmedHeading);
    sec.isLiveState = LIVE_STATE_HEADING_RE.test(trimmedHeading);
    sec.isProtectedWake = PROTECTED_WAKE_HEADING_RE.test(trimmedHeading);
    sec.isProtectedWaiting = PROTECTED_WAITING_HEADING_RE.test(trimmedHeading);
  }

  return { eol, eolBytes, hadTrailingNewline, preambleText, preambleBytes, sections };
}

function buildMarker(trimmedCount, maxBytes, archiveFilename) {
  if (archiveFilename) {
    return `- (archived ${trimmedCount} item(s) to \`${archiveFilename}\` to keep check-in <= ${maxBytes} bytes)`;
  }
  return `- (older archived items trimmed: ${trimmedCount} item(s) rotated to keep check-in <= ${maxBytes} bytes)`;
}

function computeSectionBytes(sec, eolBytes, maxBytes, archiveFilename) {
  if (sec.archivedWhole) return 0;
  if (sec.keptCount === 0 && (sec.isArchiveSection || sec.isDatedSection)) return 0;
  if (sec.keptCount > 0) {
    return sec.headingBytes + (sec.keptCount * eolBytes) + sec.keptBytes;
  }
  if (sec.entries.length > 0) {
    const markerBytes = Buffer.byteLength(buildMarker(sec.entries.length, maxBytes, archiveFilename), 'utf8');
    return sec.headingBytes + eolBytes + markerBytes;
  }
  return sec.headingBytes;
}

function renderDocument(doc, trimmedCount, maxBytes, archiveFilename) {
  const chunks = [];
  if (doc.preambleText) chunks.push(doc.preambleText);

  for (const sec of doc.sections) {
    if (sec.archivedWhole) continue;
    const kept = sec.entries.filter((e) => !e.archived);
    if (kept.length === 0 && (sec.isArchiveSection || sec.isDatedSection)) {
      continue;
    }
    const secLines = [sec.heading];
    if (kept.length > 0) {
      secLines.push(...kept.map((e) => e.text));
    } else if (sec.entries.length > 0) {
      secLines.push(buildMarker(sec.entries.length, maxBytes, archiveFilename));
    }
    chunks.push(secLines.join('\n'));
  }

  if (trimmedCount > 0) {
    const marker = buildMarker(trimmedCount, maxBytes, archiveFilename);
    const renderedSoFar = chunks.join('\n\n');
    if (!renderedSoFar.includes(marker)) {
      chunks.push(marker);
    }
  }

  const joined = chunks.join('\n\n');
  const withEol = doc.eol === '\n' ? joined : joined.replace(/\n/g, doc.eol);
  return withEol + (doc.hadTrailingNewline ? doc.eol : '');
}

function renderArchivedBlocks(archivedGroups, eol) {
  if (archivedGroups.length === 0) return '';
  const parts = [];
  for (const group of archivedGroups) {
    if (group.wholeSection) {
      parts.push([group.heading, ...group.items].join('\n'));
    } else {
      parts.push([`### From: ${group.heading}`, ...group.items].join('\n'));
    }
  }
  const joined = parts.join('\n\n');
  return eol === '\n' ? joined : joined.replace(/\n/g, eol);
}

// Safely rotates historical sections and completed/dated non-active log entries
// out of a check-in document until it fits within maxBytes (default 6144),
// while preserving metadata headers, "On every wake", Waiting/Active sections,
// undated bullets, and all active/pending/waiting/in-flight state.
export function compactCheckInContent(text, maxBytes = CHECKIN_CAP_BYTES, options = {}) {
  const currentBytes = Buffer.byteLength(text, 'utf8');
  if (currentBytes <= maxBytes) {
    return {
      changed: false,
      compacted: false,
      withinCap: true,
      text,
      archivedText: '',
      beforeBytes: currentBytes,
      afterBytes: currentBytes,
      trimmedCount: 0,
      archivedSections: [],
    };
  }

  const archiveFilename = typeof options.archiveFilename === 'string' && options.archiveFilename.trim()
    ? options.archiveFilename.trim()
    : '';
  const doc = parseDocument(text);
  const { eolBytes } = doc;
  const trailingBytes = doc.hadTrailingNewline ? eolBytes : 0;

  let trimmedCount = 0;
  const archivedByHeading = new Map();
  const archivedSectionNames = new Set();

  // O(1) incremental byte accounting across all sections.
  let activeSectionChunks = 0;
  let totalSectionBytes = 0;
  for (const sec of doc.sections) {
    sec.renderedBytes = computeSectionBytes(sec, eolBytes, maxBytes, archiveFilename);
    if (sec.renderedBytes > 0) activeSectionChunks += 1;
    totalSectionBytes += sec.renderedBytes;
  }

  const updateSectionBytes = (sec) => {
    const oldBytes = sec.renderedBytes;
    const newBytes = computeSectionBytes(sec, eolBytes, maxBytes, archiveFilename);
    if (oldBytes > 0) activeSectionChunks -= 1;
    if (newBytes > 0) activeSectionChunks += 1;
    totalSectionBytes += (newBytes - oldBytes);
    sec.renderedBytes = newBytes;
  };

  const currentEstimatedBytes = () => {
    const chunkCount = (doc.preambleBytes > 0 ? 1 : 0) + activeSectionChunks;
    let total = doc.preambleBytes + totalSectionBytes + trailingBytes;
    if (chunkCount > 1) total += (chunkCount - 1) * 2 * eolBytes;
    if (trimmedCount > 0) {
      const markerBytes = Buffer.byteLength(buildMarker(trimmedCount, maxBytes, archiveFilename), 'utf8');
      total += (chunkCount > 0 ? 2 * eolBytes : 0) + markerBytes;
    }
    return total;
  };

  const recordArchived = (heading, itemText, wholeSection = false) => {
    const key = `${wholeSection ? 'W:' : 'P:'}${heading}`;
    if (!archivedByHeading.has(key)) {
      archivedByHeading.set(key, { heading, wholeSection, items: [] });
    }
    archivedByHeading.get(key).items.push(itemText);
    archivedSectionNames.add(heading.trim());
    trimmedCount += 1;
  };

  const archiveEntry = (sec, entry, wholeSection = false) => {
    entry.archived = true;
    sec.keptCount -= 1;
    sec.keptBytes -= entry.bytes;
    recordArchived(sec.heading, entry.text, wholeSection);
    updateSectionBytes(sec);
  };

  // Pass 1: Explicit archive / recently closed / completed / history / retired / digest sections.
  // Trim from the bottom of the last archive section first so newest archived items remain if possible.
  for (let s = doc.sections.length - 1; s >= 0 && currentEstimatedBytes() > maxBytes; s -= 1) {
    const sec = doc.sections[s];
    if (!sec.isArchiveSection || sec.archivedWhole) continue;
    for (let i = sec.entries.length - 1; i >= 0 && currentEstimatedBytes() > maxBytes; i -= 1) {
      const entry = sec.entries[i];
      if (entry.archived) continue;
      archiveEntry(sec, entry, false);
    }
    if (sec.keptCount === 0) {
      sec.archivedWhole = true;
      updateSectionBytes(sec);
    }
  }

  // Pass 2: Old dated chronological sections (## YYYY-MM-DD... including ISO-8601 ## YYYY-MM-DDTHH:MMZ),
  // oldest first, preserving the newest dated section for entry-level triage in Pass 3/4.
  if (currentEstimatedBytes() > maxBytes) {
    const datedIndices = doc.sections
      .map((sec, idx) => (sec.isDatedSection && !sec.isProtectedWake && !sec.isProtectedWaiting ? idx : -1))
      .filter((idx) => idx >= 0);
    const keepNewestDatedIdx = datedIndices.length > 0 ? datedIndices[datedIndices.length - 1] : -1;

    for (const idx of datedIndices) {
      if (idx === keepNewestDatedIdx) continue;
      if (currentEstimatedBytes() <= maxBytes) break;
      const sec = doc.sections[idx];
      if (sec.archivedWhole) continue;
      sec.archivedWhole = true;
      for (const entry of sec.entries) {
        if (!entry.archived) {
          entry.archived = true;
          sec.keptCount -= 1;
          sec.keptBytes -= entry.bytes;
          recordArchived(sec.heading, entry.text, true);
        }
      }
      if (sec.entries.length === 0) {
        recordArchived(sec.heading, '(empty section)', true);
      }
      updateSectionBytes(sec);
    }
  }

  // Pass 3: Completed / merged / closed / archived bullets inside Live state & non-wake sections,
  // strictly skipping entries that indicate active/pending/waiting/in-flight work and never emptying Live state.
  if (currentEstimatedBytes() > maxBytes) {
    for (const sec of doc.sections) {
      if (currentEstimatedBytes() <= maxBytes) break;
      if (sec.archivedWhole || sec.isProtectedWake || sec.isProtectedWaiting || sec.isArchiveSection) continue;
      for (const entry of sec.entries) {
        if (currentEstimatedBytes() <= maxBytes) break;
        if (entry.archived) continue;
        if (sec.isLiveState && sec.keptCount <= 1) break;
        if (entry.isCompleted && !entry.isActive) {
          archiveEntry(sec, entry, false);
        }
      }
    }
  }

  // Pass 4: Oldest dated/timestamped log entries (DATED_ENTRY_RE && !ACTIVE_ENTRY_RE) in non-protected
  // sections. Never touches undated bullets, never touches active/waiting/pending entries, and never
  // empties Live state.
  if (currentEstimatedBytes() > maxBytes) {
    for (const sec of doc.sections) {
      if (currentEstimatedBytes() <= maxBytes) break;
      if (sec.archivedWhole || sec.isProtectedWake || sec.isProtectedWaiting || sec.isArchiveSection) continue;
      for (const entry of sec.entries) {
        if (currentEstimatedBytes() <= maxBytes) break;
        if (entry.archived) continue;
        if (sec.isLiveState && sec.keptCount <= 1) break;
        if (entry.isDated && !entry.isActive) {
          archiveEntry(sec, entry, false);
        }
      }
    }
  }

  if (trimmedCount === 0) {
    return {
      changed: false,
      compacted: false,
      withinCap: false,
      text,
      archivedText: '',
      beforeBytes: currentBytes,
      afterBytes: currentBytes,
      trimmedCount: 0,
      archivedSections: [],
    };
  }

  const candidateText = renderDocument(doc, trimmedCount, maxBytes, archiveFilename);
  const afterBytes = Buffer.byteLength(candidateText, 'utf8');
  if (afterBytes >= currentBytes) {
    return {
      changed: false,
      compacted: false,
      withinCap: false,
      text,
      archivedText: '',
      beforeBytes: currentBytes,
      afterBytes: currentBytes,
      trimmedCount: 0,
      archivedSections: [],
    };
  }

  const archivedText = renderArchivedBlocks([...archivedByHeading.values()], doc.eol);
  return {
    changed: true,
    compacted: afterBytes <= maxBytes,
    withinCap: afterBytes <= maxBytes,
    text: candidateText,
    archivedText,
    beforeBytes: currentBytes,
    afterBytes,
    trimmedCount,
    archivedSections: [...archivedSectionNames],
  };
}

export function atomicWriteFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure.
    }
    throw err;
  }
}

function formatArchiveTimestamp(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function appendArchiveFile(archivePath, archivedText, now = new Date()) {
  if (!archivedText || !archivedText.trim()) return;
  const ts = formatArchiveTimestamp(now);
  const eol = archivedText.includes('\r\n') ? '\r\n' : '\n';
  const block = `## Archived ${ts}${eol}${eol}${archivedText.trimEnd()}${eol}`;
  const existing = existsSync(archivePath) ? readFileSync(archivePath, 'utf8') : '';
  const combined = existing.trim().length > 0
    ? `${existing.trimEnd()}${eol}${eol}${block}`
    : block;
  atomicWriteFile(archivePath, combined);
}

export function enforceCheckInCap(filePath, options = {}) {
  const capBytes = Number.isFinite(options.capBytes) && options.capBytes > 0
    ? Math.floor(options.capBytes)
    : CHECKIN_CAP_BYTES;
  const dryRun = Boolean(options.dryRun);
  const now = options.now ?? new Date();
  const archivePath = getArchivePath(filePath);

  if (!filePath || !existsSync(filePath)) {
    return {
      status: 'missing',
      changed: false,
      compacted: false,
      withinCap: true,
      filePath,
      archivePath,
      beforeBytes: 0,
      afterBytes: 0,
      trimmedCount: 0,
      archivedSections: [],
      dryRun,
    };
  }

  const original = readFileSync(filePath, 'utf8');
  const beforeBytes = Buffer.byteLength(original, 'utf8');
  if (beforeBytes <= capBytes) {
    return {
      status: 'ok',
      changed: false,
      compacted: false,
      withinCap: true,
      filePath,
      archivePath,
      beforeBytes,
      afterBytes: beforeBytes,
      trimmedCount: 0,
      archivedSections: [],
      dryRun,
    };
  }

  const result = compactCheckInContent(original, capBytes, { archiveFilename: basename(archivePath) });
  if (result.changed && !dryRun) {
    // Write archive FIRST so no historical data can be lost on a crash.
    appendArchiveFile(archivePath, result.archivedText, now);
    atomicWriteFile(filePath, result.text);
  }

  const status = result.compacted
    ? 'compacted'
    : (result.changed ? 'partial' : 'warning');

  return {
    status,
    ...result,
    filePath,
    archivePath,
    capBytes,
    dryRun,
  };
}

export function runHook(rawStdin, options = {}) {
  let payload;
  try {
    payload = rawStdin && rawStdin.trim() ? JSON.parse(rawStdin) : {};
  } catch {
    return null;
  }

  const isAgy = isAntigravityPayload(payload);
  const targetPath = extractTargetPath(payload);
  if (!targetPath || !isCheckInFile(targetPath) || !existsSync(targetPath)) {
    return isAgy ? {} : null;
  }

  const res = enforceCheckInCap(targetPath, options);
  if (isAgy) {
    // Antigravity PostToolUse contract expects an empty JSON object {}.
    return {};
  }

  if (res.status === 'ok' || res.status === 'missing') return null;

  const fileName = basename(targetPath);
  const archiveName = basename(res.archivePath);
  const cap = res.capBytes || CHECKIN_CAP_BYTES;

  if (res.status === 'compacted') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `CC-PO check-in cap: \`${fileName}\` exceeded ${cap} bytes (${res.beforeBytes} bytes) and was safely compacted to ${res.afterBytes} bytes by rotating ${res.trimmedCount} historical item(s) to \`${archiveName}\` while preserving header and live state.`,
      },
    };
  }

  if (res.status === 'partial') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `CC-PO check-in cap warning: \`${fileName}\` was partially rotated from ${res.beforeBytes} to ${res.afterBytes} bytes (${res.trimmedCount} historical item(s) moved to \`${archiveName}\`), but remaining active header/live state still exceeds ${cap} bytes. Tighten active prose or move resolved items out of live state.`,
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `CC-PO check-in cap warning: \`${fileName}\` is ${res.beforeBytes} bytes (exceeds ${cap}-byte cap) and had no safe historical/completed items to rotate automatically without touching active live state. Prune resolved/closed items into \`## Recently closed\` or rely on GitHub so the check-in stays <= ${cap} bytes.`,
    },
  };
}

export function parseCliArgs(argv) {
  const args = { file: '', dryRun: false, capBytes: CHECKIN_CAP_BYTES, json: false, cliMode: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--file' && i + 1 < argv.length) {
      args.file = argv[i + 1];
      args.cliMode = true;
      i += 1;
    } else if (token.startsWith('--file=')) {
      args.file = token.slice('--file='.length);
      args.cliMode = true;
    } else if (token === '--dry-run') {
      args.dryRun = true;
      args.cliMode = true;
    } else if (token === '--json') {
      args.json = true;
      args.cliMode = true;
    } else if (token === '--cap' && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) args.capBytes = parsed;
      args.cliMode = true;
      i += 1;
    } else if (token.startsWith('--cap=')) {
      const parsed = Number.parseInt(token.slice('--cap='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) args.capBytes = parsed;
      args.cliMode = true;
    }
  }
  return args;
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
    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.cliMode) {
      if (!cli.file) {
        process.stderr.write('Usage: node post-checkin-cap.mjs --file <path> [--dry-run] [--cap 6144] [--json]\n');
      } else {
        const res = enforceCheckInCap(cli.file, { capBytes: cli.capBytes, dryRun: cli.dryRun });
        if (cli.json) {
          const { text: _t, archivedText: _a, ...summary } = res;
          process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        } else {
          const mode = cli.dryRun ? '[dry-run] ' : '';
          process.stdout.write(
            `${mode}${basename(cli.file)}: status=${res.status} before=${res.beforeBytes}B after=${res.afterBytes}B cap=${cli.capBytes}B rotated=${res.trimmedCount} archive=${basename(res.archivePath)}\n`,
          );
        }
      }
    } else {
      const raw = readFileSync(0, 'utf8');
      const out = runHook(raw);
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    }
  } catch {
    // Fail-open: never break Write/Edit tool completion or CLI runs.
  }
  process.exitCode = 0;
}
