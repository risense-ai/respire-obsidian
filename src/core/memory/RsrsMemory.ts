import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import crossSpawn from 'cross-spawn';

import type { RsrsImportance, RsrsMemorySettings } from '@/core/types/settings';

const RSRS_MEMORY_TAG = 'rsrs-memory';
const RECALL_QUERY_CHARS = 300;
const RECALL_ENTRY_CHARS = 600;
const REMEMBER_MIN_REPLY_CHARS = 40;
const REMEMBER_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 120_000;
const RECENT_REMEMBER_TTL_MS = 10 * 60_000;
const RECENT_REMEMBER_LIMIT = 200;
const OUTPUT_LIMIT_CHARS = 2_000_000;

const recentRememberKeys = new Map<string, number>();

/** The test suite must never read or mutate the user's external memory store. */
function isTestEnvironment(): boolean {
  return Boolean(process.env.VITEST);
}

export interface RsrsRecallEntry {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly device: string;
  readonly importance: string;
  readonly score?: number;
}

export interface RsrsRecallOutcome {
  readonly ok: boolean;
  readonly block: string;
  readonly entries: number;
  readonly binary: string;
  readonly missing: boolean;
  readonly error?: string;
}

export interface RsrsProbeOutcome {
  readonly ok: boolean;
  readonly binary: string;
  readonly missing: boolean;
  readonly version?: string;
  readonly error?: string;
}

export interface RsrsRememberOutcome {
  readonly status: 'stored' | 'pending' | 'skipped' | 'failed';
  readonly importance: RsrsImportance;
  readonly missing: boolean;
  readonly error?: string;
}

export interface RsrsTurnMemoryRecord {
  readonly content: string;
  readonly title: string;
  readonly importance: RsrsImportance;
}

export interface RsrsTestOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly binary: string;
}

export interface RsrsExtractOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export interface ClaudianTurnMemory {
  readonly query: string;
  readonly reply: string;
  readonly vaultPath?: string;
}

interface RsrsRunResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly missing: boolean;
  readonly error?: string;
}

function normalizeWhitespace(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/gu, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function sanitizeMemoryText(value: string): string {
  return value.replace(/<\/?rsrs-memory\b[^>]*>/giu, '[rsrs-memory]');
}

function expandHome(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** Resolve the CLI without relying on an Electron GUI inheriting the shell PATH. */
export function resolveRsrsBinary(settings: RsrsMemorySettings): string {
  const candidates = [
    expandHome(settings.binaryPath),
    expandHome(process.env.RSRS_BIN ?? ''),
  ];
  if (process.platform === 'win32') {
    candidates.push(join(homedir(), '.rsrs', 'bin', 'rsrs.exe'));
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) candidates.push(join(localAppData, 'Programs', 'rsrs', 'rsrs.exe'));
  } else {
    candidates.push(join(homedir(), '.rsrs', 'bin', 'rsrs'));
    candidates.push(join(homedir(), '.cargo', 'bin', 'rsrs'));
    candidates.push('/usr/local/bin/rsrs', '/opt/homebrew/bin/rsrs');
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return 'rsrs';
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runRsrs(
  settings: RsrsMemorySettings,
  args: readonly string[],
  timeoutMs: number,
): Promise<RsrsRunResult> {
  const binary = resolveRsrsBinary(settings);
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = crossSpawn(binary, [...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      resolve({
        ok: false, code: null, stdout: '', stderr: '', missing: false, error: toErrorMessage(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, error?: string, missing = false): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve({
        ok: code === 0 && !error, code, stdout, stderr: stderr.slice(0, 4_000), missing, error,
      });
    };
    const timer = window.setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may have exited between the timeout and the kill.
      }
      finish(null, `rsrs ${args[0] ?? ''} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < OUTPUT_LIMIT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => finish(null, error.message, error.code === 'ENOENT'));
    child.on('close', code => finish(code));
  });
}

function parseRecallEntries(stdout: string): RsrsRecallEntry[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object') return [];
  const details = (payload as { details?: unknown }).details;
  if (!Array.isArray(details)) return [];

  const entries: RsrsRecallEntry[] = [];
  const seen = new Set<string>();
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    const entry = (detail as { entry?: unknown }).entry;
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = normalizeWhitespace(record.id);
    const content = normalizeWhitespace(record.content);
    if (!id || !content || seen.has(id)) continue;
    seen.add(id);
    const score = typeof (detail as { score?: unknown }).score === 'number'
      ? (detail as { score: number }).score
      : undefined;
    entries.push({
      id,
      title: normalizeWhitespace(record.title) || '(untitled)',
      content: sanitizeMemoryText(content),
      device: normalizeWhitespace(record.device || record.computer),
      importance: normalizeWhitespace(record.importance),
      ...(score === undefined ? {} : { score }),
    });
  }
  return entries;
}

function formatRecallBlock(
  entries: readonly RsrsRecallEntry[],
  query: string,
  maxChars: number,
): string {
  if (entries.length === 0) return '';
  const header = `[rsrs 长期记忆 · ${entries.length} 条 · 仅作参考；与当前会话或文件事实冲突时以当前为准]`;
  const lines = [`<${RSRS_MEMORY_TAG} source="rsrs" query="${escapeAttribute(query)}">`, header];
  let total = header.length + 80;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const meta = [
      entry.device,
      entry.importance,
      entry.score === undefined ? '' : entry.score.toFixed(2),
    ].filter(Boolean).join(', ');
    const block = `${index + 1}. [${entry.id.slice(0, 8)}] ${sanitizeMemoryText(entry.title)}${meta ? ` (${meta})` : ''}\n   ${truncate(entry.content, RECALL_ENTRY_CHARS)}`;
    if (total + block.length > maxChars) break;
    lines.push(block);
    total += block.length;
  }
  lines.push(`</${RSRS_MEMORY_TAG}>`);
  return lines.length > 2 ? lines.join('\n') : '';
}

export async function probeRsrsMemory(settings: RsrsMemorySettings): Promise<RsrsProbeOutcome> {
  const binary = resolveRsrsBinary(settings);
  const result = await runRsrs(settings, ['--version'], 5_000);
  if (!result.ok) {
    return { ok: false, binary, missing: result.missing, error: result.error || result.stderr };
  }
  const version = result.stdout.trim().split(/\s+/u).pop();
  return { ok: true, binary, missing: false, ...(version ? { version } : {}) };
}

export async function recallRsrsMemory(
  settings: RsrsMemorySettings,
  rawQuery: string,
): Promise<RsrsRecallOutcome> {
  const binary = resolveRsrsBinary(settings);
  // rsrs policy expects the project name in routine queries; --project only scopes the store.
  const raw = settings.project ? `${settings.project} ${rawQuery}` : rawQuery;
  const query = truncate(normalizeWhitespace(redactSecrets(raw)), RECALL_QUERY_CHARS);
  if (isTestEnvironment() || !settings.enabled || query.length < 2 || query.startsWith('/')) {
    return { ok: false, block: '', entries: 0, binary, missing: false };
  }

  const args = [
    '--client-only', 'recall', query,
    '--limit', String(settings.recallLimit),
    '--json',
  ];
  if (settings.project) args.push('--project', settings.project);

  const result = await runRsrs(settings, args, settings.recallTimeoutMs);
  if (!result.ok) {
    return {
      ok: false,
      block: '',
      entries: 0,
      binary,
      missing: result.missing,
      error: result.error || result.stderr,
    };
  }
  const entries = parseRecallEntries(result.stdout);
  return {
    ok: true,
    block: formatRecallBlock(entries, query, settings.maxRecallChars),
    entries: entries.length,
    binary,
    missing: false,
  };
}

export async function testRsrsMemory(settings: RsrsMemorySettings): Promise<RsrsTestOutcome> {
  if (!settings.enabled) {
    return { ok: false, message: 'rsrs memory is disabled in Respire settings.', binary: resolveRsrsBinary(settings) };
  }
  const outcome = await recallRsrsMemory(settings, 'Respire rsrs memory connection test');
  if (!outcome.ok) {
    return {
      ok: false,
      message: `rsrs failed: ${truncate(outcome.error || 'unknown error', 240)} (${outcome.binary})`,
      binary: outcome.binary,
    };
  }
  return {
    ok: true,
    message: `rsrs OK · ${outcome.entries} hit(s) · ${outcome.binary}`,
    binary: outcome.binary,
  };
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[redacted private key]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gu, '[redacted token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, '[redacted token]'],
  [/\bAKIA[0-9A-Z]{16}\b/gu, '[redacted key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}\b/giu, 'Bearer [redacted]'],
];

/** Best-effort scrub before a prompt or reply leaves the plugin for the store. */
export function redactSecrets(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? value;
}

function firstClause(value: string): string {
  return normalizeWhitespace(value).split(/[。！？!?\n]/u)[0] ?? value;
}

function stripLeadingPoliteness(value: string): string {
  const cleaned = value
    .replace(/^#{1,6}\s*/u, '')
    .replace(/^[-*>]\s*/u, '')
    .replace(/^\d+[.)]\s*/u, '')
    .trim();
  return cleaned.replace(/^(?:请?帮我|请你?|麻烦你?|能不能|可以|我想|我要)\s*/u, '').trim() || cleaned;
}

function formatStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * A completed turn is a diary trajectory unless the user opts into important storage.
 * Trivial turns use the diary shape (time-first title, "本回合" body) and need no parent;
 * important turns use the required three markers and must be attached to a same-topic parent.
 */
export function buildTurnMemory(
  turn: ClaudianTurnMemory,
  importance: RsrsImportance,
  now = new Date(),
): RsrsTurnMemoryRecord {
  const query = redactSecrets(normalizeWhitespace(turn.query));
  const reply = redactSecrets(normalizeWhitespace(turn.reply));
  const stamp = formatStamp(now);
  if (importance === 'trivial') {
    return {
      importance,
      title: truncate(`${stamp} Respire 回合 · ${truncate(firstLine(query), 16)}`, 48),
      content: [
        `本回合 ${stamp}${turn.vaultPath ? `（${turn.vaultPath}）` : ''}用户问：${truncate(query, 800)}`,
        `助手答：${truncate(reply, 2_000)}`,
      ].join('\n'),
    };
  }
  const topic = truncate(stripLeadingPoliteness(firstClause(query)), 12);
  const answer = truncate(firstClause(reply), 10);
  return {
    importance,
    title: truncate(`用户问${topic}，答复${answer}`, 23),
    content: [
      `【前因】用户在 Respire 会话${turn.vaultPath ? `（${turn.vaultPath}）` : ''}提出问题：${truncate(query, 800)}`,
      `【行为】助手作答：${truncate(reply, 2_000)}`,
      `【后果】助手给出上述答复，本回合完成于 ${stamp}。`,
    ].join('\n'),
  };
}

interface CandidateBill {
  readonly mergeId: string;
  readonly parentId: string;
}

async function readCandidateBill(settings: RsrsMemorySettings, content: string): Promise<CandidateBill> {
  const result = await runRsrs(settings, ['--client-only', 'candidates', content, '--json'], 15_000);
  if (!result.ok) return { mergeId: '', parentId: '' };
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { mergeId: '', parentId: '' };
  }
  const details = payload && typeof payload === 'object'
    ? (payload as { details?: unknown }).details
    : undefined;
  const readFirstId = (value: unknown): string => {
    if (!Array.isArray(value)) return '';
    for (const item of value) {
      const entry = item && typeof item === 'object'
        ? (item as { entry?: unknown }).entry
        : undefined;
      const id = entry && typeof entry === 'object'
        ? normalizeWhitespace((entry as Record<string, unknown>).id)
        : '';
      if (id) return id;
    }
    return '';
  };
  const record = details && typeof details === 'object' ? details as Record<string, unknown> : {};
  return { mergeId: readFirstId(record.merge), parentId: readFirstId(record.parent) };
}

function pruneRecentRememberKeys(now: number): void {
  for (const [key, timestamp] of recentRememberKeys) {
    if (now - timestamp > RECENT_REMEMBER_TTL_MS) recentRememberKeys.delete(key);
  }
  while (recentRememberKeys.size > RECENT_REMEMBER_LIMIT) {
    const oldest = recentRememberKeys.keys().next().value;
    if (oldest === undefined) break;
    recentRememberKeys.delete(oldest);
  }
}

/**
 * Store one finished Claudian turn without bypassing judge-then-store. Important turns are
 * attached to a same-topic parent; when no parent exists the turn stays a diary entry rather
 * than becoming an orphan important root. Duplicate candidates are left for manual review.
 */
export async function rememberClaudianTurn(
  settings: RsrsMemorySettings,
  turn: ClaudianTurnMemory,
): Promise<RsrsRememberOutcome> {
  const importance = settings.rememberImportance;
  if (isTestEnvironment() || !settings.enabled || !settings.autoRemember) {
    return { status: 'skipped', importance, missing: false };
  }
  const query = normalizeWhitespace(turn.query);
  const reply = normalizeWhitespace(turn.reply);
  if (query.length < 2 || reply.length < REMEMBER_MIN_REPLY_CHARS || query.startsWith('/')) {
    return { status: 'skipped', importance, missing: false };
  }
  if (reply === '(interrupted)' || reply === '(error)' || reply === '(no reply)') {
    return { status: 'skipped', importance, missing: false };
  }

  const key = `${query.slice(0, 200)}\u0000${reply.slice(0, 200)}`;
  const now = Date.now();
  pruneRecentRememberKeys(now);
  const previous = recentRememberKeys.get(key);
  if (previous !== undefined && now - previous < RECENT_REMEMBER_TTL_MS) {
    return { status: 'skipped', importance, missing: false };
  }
  recentRememberKeys.set(key, now);

  let record = buildTurnMemory(turn, importance);
  let parentId = '';
  if (record.importance === 'important') {
    const bill = await readCandidateBill(settings, record.content);
    if (bill.mergeId) {
      // A near-identical memory already exists; forcing a second copy would break dedup.
      return { status: 'pending', importance, missing: false };
    }
    parentId = bill.parentId;
    if (!parentId) {
      record = buildTurnMemory(turn, 'trivial');
    }
  }

  const args = [
    'remember', record.content,
    '--title', record.title,
    '--importance', record.importance,
    '--type', 'context',
  ];
  if (parentId) args.push('--parent', parentId);
  if (settings.project) args.push('--project', settings.project);

  const result = await runRsrs(settings, [...args, '--json'], REMEMBER_TIMEOUT_MS);
  if (result.ok) {
    return { status: 'stored', importance: record.importance, missing: false };
  }
  if (result.stdout.includes('"status":"pending"')) {
    recentRememberKeys.set(key, now);
    return { status: 'pending', importance: record.importance, missing: false };
  }
  recentRememberKeys.delete(key);
  return {
    status: 'failed',
    importance: record.importance,
    missing: result.missing,
    error: result.error || result.stderr,
  };
}

export async function extractRsrsSessions(
  settings: RsrsMemorySettings,
  vaultPath: string,
): Promise<RsrsExtractOutcome> {
  if (!settings.enabled) {
    return { ok: false, message: 'rsrs memory is disabled in Respire settings.' };
  }
  const args = [
    'extract',
    '--since', settings.extractSince,
    '--limit', String(settings.extractLimit),
    '--importance', settings.extractImportance,
    '--json',
  ];
  const source = settings.extractSource.trim();
  if (source && source !== 'all') args.push('--id', source);
  if (settings.extractCwdToVault && vaultPath.trim()) args.push('--cwd', vaultPath.trim());

  const result = await runRsrs(settings, args, EXTRACT_TIMEOUT_MS);
  if (!result.ok) {
    return {
      ok: false,
      message: `rsrs extract failed: ${truncate(result.error || result.stderr || 'unknown error', 300)}`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { ok: false, message: 'rsrs extract returned unreadable output.' };
  }
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const summary = root.summary && typeof root.summary === 'object'
    ? root.summary as Record<string, unknown>
    : {};
  const number = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
  );
  const scanned = number(summary.scanned);
  const pending = number(summary.pending);
  const imported = number(summary.imported);
  const platforms = Array.isArray(summary.by_platform)
    ? summary.by_platform
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const record = item as Record<string, unknown>;
        return `${normalizeWhitespace(record.id)}:${number(record.count) ?? 0}`;
      })
      .join(' · ')
    : '';
  const errors = Array.isArray(root.errors) ? root.errors : [];

  const parts = ['rsrs extract'];
  if (imported !== null) parts.push(`导入 ${imported}`);
  if (pending !== null) parts.push(`待导入 ${pending}`);
  if (scanned !== null) parts.push(`扫描 ${scanned}`);
  if (platforms) parts.push(platforms);
  if (errors.length) parts.push(`错误 ${errors.length}`);
  return { ok: errors.length === 0, message: parts.join(' · ') };
}
