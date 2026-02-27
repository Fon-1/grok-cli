import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { SessionMeta } from './types.js';

export function getGrokHomeDir(): string {
  return process.env.GROK_HOME_DIR ?? path.join(os.homedir(), '.grok');
}

export function getSessionsDir(): string {
  return path.join(getGrokHomeDir(), 'sessions');
}

export function generateSessionId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function sessionPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

function bundlePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}-bundle.md`);
}

export function saveSession(meta: SessionMeta): void {
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionPath(meta.id), JSON.stringify(meta, null, 2), 'utf-8');
}

export function saveBundleText(sessionId: string, text: string): string {
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const fp = bundlePath(sessionId);
  fs.writeFileSync(fp, text, 'utf-8');
  return fp;
}

export function loadSession(sessionId: string): SessionMeta | null {
  const fp = sessionPath(sessionId);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as SessionMeta;
  } catch {
    return null;
  }
}

export function loadBundle(sessionId: string): string | null {
  const fp = bundlePath(sessionId);
  if (!fs.existsSync(fp)) return null;
  try {
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

export function clearSessions(hoursBack = 168): number {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return 0;

  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  let count = 0;

  for (const f of fs.readdirSync(dir)) {
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
