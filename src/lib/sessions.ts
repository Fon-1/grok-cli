import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { SessionMeta } from './types.js';

// ─── H-1 fix: validate session ID — chỉ cho phép 16 hex chars ────────────────
const SESSION_ID_RE = /^[0-9a-f]{16}$/;

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid session ID: "${sessionId}". Must be 16 hex characters.`);
  }
}

// ─── L-1 fix: validate GROK_HOME_DIR ─────────────────────────────────────────
export function getGrokHomeDir(): string {
  const envDir = process.env.GROK_HOME_DIR;
  if (envDir) {
    // Must be an absolute path and must not contain null bytes
    if (!path.isAbsolute(envDir) || envDir.includes('\0')) {
      throw new Error(`Invalid GROK_HOME_DIR: must be an absolute path. Got: "${envDir}"`);
    }
    return envDir;
  }
  return path.join(os.homedir(), '.grok');
}

export function getSessionsDir(): string {
  return path.join(getGrokHomeDir(), 'sessions');
}

export function generateSessionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ─── Path helpers (H-1: validated) ───────────────────────────────────────────
function sessionPath(sessionId: string): string {
  validateSessionId(sessionId);
  // Extra safety: resolve and confirm stays inside sessions dir
  const dir = getSessionsDir();
  const resolved = path.resolve(dir, `${sessionId}.json`);
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) {
    throw new Error(`Session path escapes sessions directory: ${resolved}`);
  }
  return resolved;
}

function bundlePath(sessionId: string): string {
  validateSessionId(sessionId);
  const dir = getSessionsDir();
  const resolved = path.resolve(dir, `${sessionId}-bundle.md`);
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) {
    throw new Error(`Bundle path escapes sessions directory: ${resolved}`);
  }
  return resolved;
}

// ─── M-2 fix: create dirs with mode 0o700, files with mode 0o600 ─────────────
export function saveSession(meta: SessionMeta): void {
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Strip bundlePath from saved metadata (L-6: no absolute path disclosure)
  const { bundlePath: _bp, ...metaToSave } = meta as any;
  fs.writeFileSync(
    sessionPath(meta.id),
    JSON.stringify(metaToSave, null, 2),
    { encoding: 'utf-8', mode: 0o600 },
  );
}

export function saveBundleText(sessionId: string, text: string): string {
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = bundlePath(sessionId);
  fs.writeFileSync(fp, text, { encoding: 'utf-8', mode: 0o600 });
  return fp;
}

export function loadSession(sessionId: string): SessionMeta | null {
  try {
    const fp = sessionPath(sessionId); // throws if invalid ID
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as SessionMeta;
  } catch {
    return null;
  }
}

export function loadBundle(sessionId: string): string | null {
  try {
    const fp = bundlePath(sessionId); // throws if invalid ID
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp, 'utf-8');
  } catch {
    return null;
  }
}

export function listSessions(hoursBack = 72): SessionMeta[] {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return [];

  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;

  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.includes('-bundle'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as SessionMeta;
      } catch {
        return null;
      }
    })
    .filter((s): s is SessionMeta => s !== null)
    .filter(s => new Date(s.createdAt).getTime() >= cutoff)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function updateSession(sessionId: string, updates: Partial<SessionMeta>): void {
  const existing = loadSession(sessionId);
  if (!existing) return;
  const updated: SessionMeta = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  saveSession(updated);
}

// ─── L-4 fix: only delete .json and -bundle.md files ─────────────────────────
export function clearSessions(hoursBack = 168): number {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return 0;

  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  let count = 0;

  for (const f of fs.readdirSync(dir)) {
    // Only touch session-related files, never other files
    if (!f.match(/^[0-9a-f]{16}(\.json|-bundle\.md)$/)) continue;

    const fp = path.join(dir, f);
    try {
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        count++;
      }
    } catch { /* ignore */ }
  }

  return count;
}
