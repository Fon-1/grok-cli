/**
 * Cookie utilities: read from Chrome profile (cross-platform) or inline JSON.
 *
 * Supports:
 *  1. Inline JSON string / base64 (--inline-cookies)
 *  2. JSON file (--inline-cookies-file or auto ~/.grok/cookies.json)
 *  3. Chrome profile Cookies SQLite via node-sqlite3 (best-effort, macOS/Linux)
 *
 * On macOS the Cookies DB values are encrypted with DPAPI/Keychain.
 * We use the same approach as many tools: try to read the "v10" AES-128-CBC
 * encrypted cookies via the "Chrome Safe Storage" keychain key.
 * Falls back to reading unencrypted values (Chromium, some Linux builds).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import type { CookieParam } from './types.js';

// ─── Inline / file cookies ───────────────────────────────────────────────────

export function parseCookiePayload(raw: string): CookieParam[] {
  // Could be base64 or plain JSON
  let json = raw.trim();
  if (!json.startsWith('[') && !json.startsWith('{')) {
    // Try base64 decode
    try {
      json = Buffer.from(json, 'base64').toString('utf-8');
    } catch {
      // ignore
    }
  }
  // M-6 fix: proper error handling around JSON.parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid cookie JSON: ${(err as Error).message}. Expected a CookieParam[] array.`);
  }
  return Array.isArray(parsed) ? parsed as CookieParam[] : [parsed as CookieParam];
}

export function loadCookiesFromFile(filePath: string): CookieParam[] {
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  return parseCookiePayload(raw);
}

/** Auto-load ~/.grok/cookies.json or ~/.grok/cookies.base64 if present */
export function autoLoadCookies(grokHomeDir: string): CookieParam[] | null {
  const jsonPath = path.join(grokHomeDir, 'cookies.json');
  const b64Path = path.join(grokHomeDir, 'cookies.base64');
  if (fs.existsSync(jsonPath)) return loadCookiesFromFile(jsonPath);
  if (fs.existsSync(b64Path)) return loadCookiesFromFile(b64Path);
  return null;
}

// ─── Chrome profile cookie extraction ────────────────────────────────────────

export function getDefaultChromeCookiePaths(): string[] {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Google/Chrome/Default/Cookies'),
      path.join(home, 'Library/Application Support/Google/Chrome/Profile 1/Cookies'),
      path.join(home, 'Library/Application Support/Chromium/Default/Cookies'),
      path.join(home, 'Library/Application Support/Microsoft Edge/Default/Cookies'),
    ];
  } else if (platform === 'linux') {
    return [
      path.join(home, '.config/google-chrome/Default/Cookies'),
      path.join(home, '.config/chromium/Default/Cookies'),
      path.join(home, 'snap/chromium/common/chromium/Default/Cookies'),
    ];
  } else if (platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA ?? path.join(home, 'AppData/Local');
    return [
      path.join(localApp, 'Google/Chrome/User Data/Default/Cookies'),
      path.join(localApp, 'Microsoft/Edge/User Data/Default/Cookies'),
    ];
  }
  return [];
}

/** Get Chrome Safe Storage key on macOS via security CLI */
function getMacOSChromeKey(): Buffer | null {
  try {
    const out = execSync(
      'security find-generic-password -w -s "Chrome Safe Storage" 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    // Derive PBKDF2 key: Chrome uses "saltysalt", 1003 iterations, 16 bytes, sha1
    const nodeCrypto: typeof import('crypto') = require('crypto');
    const key = nodeCrypto.pbkdf2Sync(out, 'saltysalt', 1003, 16, 'sha1');
    return key;
  } catch {
    return null;
  }
}

/** Decrypt a Chrome cookie value (v10 AES-128-CBC) on macOS */
function decryptChromeValue(encryptedValue: Buffer, key: Buffer): string | null {
  try {
    const crypto = require('crypto') as typeof import('crypto');
    if (encryptedValue.length < 3) return null;
    const prefix = encryptedValue.slice(0, 3).toString();
    if (prefix !== 'v10' && prefix !== 'v11') return null;
    const iv = Buffer.alloc(16, ' ');
    const encrypted = encryptedValue.slice(3);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Read cookies for grok.com from a Chrome Cookies SQLite DB.
 * Uses `better-sqlite3` if installed, otherwise falls back to `sqlite3`.
 * If neither is available, returns null.
 */
export async function readChromeCookies(
  cookiePath: string,
  domain = 'grok.com',
  verbose = false,
): Promise<CookieParam[] | null> {
  if (!fs.existsSync(cookiePath)) {
    if (verbose) console.warn(`[cookies] Cookie DB not found: ${cookiePath}`);
    return null;
  }

  // We need to copy the DB first (Chrome may have it locked)
  // H-3 fix: use mkdtempSync for unpredictable temp directory (prevents TOCTOU symlink attack)
  let tmpDirCookies: string;
  let tmpCookies: string;
  try {
    tmpDirCookies = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cookies-'));
    tmpCookies = path.join(tmpDirCookies, 'cookies.db');
  } catch (err) {
    if (verbose) console.warn(`[cookies] Could not create temp dir: ${(err as Error).message}`);
    return null;
  }

  try {
    fs.copyFileSync(cookiePath, tmpCookies);
  } catch (err) {
    if (verbose) console.warn(`[cookies] Could not copy cookie DB: ${(err as Error).message}`);
    try { fs.rmSync(tmpDirCookies!, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }

  let db: any;
  try {
    // Try better-sqlite3 first (sync, simpler)
    const Database = (await import('better-sqlite3' as any)).default;
    db = new Database(tmpCookies, { readonly: true, fileMustExist: true });
  } catch {
    if (verbose) console.log('[cookies] better-sqlite3 not available, trying alternative method');
    try {
      fs.unlinkSync(tmpCookies);
    } catch { /* ignore */ }
    return null;
  }

  try {
    // Get macOS decryption key if needed
    let macKey: Buffer | null = null;
    if (os.platform() === 'darwin') {
      macKey = getMacOSChromeKey();
      if (verbose && macKey) console.log('[cookies] Got macOS Chrome key');
      if (verbose && !macKey) console.warn('[cookies] Could not get macOS Chrome key — encrypted cookies will be skipped');
    }

    const rows = db.prepare(
      `SELECT name, value, host_key, path, secure, is_httponly, expires_utc, encrypted_value
       FROM cookies
       WHERE host_key LIKE ?`
    ).all(`%${domain}%`) as Array<{
      name: string;
      value: string;
      host_key: string;
      path: string;
      secure: number;
      is_httponly: number;
      expires_utc: number;
      encrypted_value: Buffer;
    }>;

    const cookies: CookieParam[] = [];

    for (const row of rows) {
      let value = row.value;

      if ((!value || value === '') && row.encrypted_value && row.encrypted_value.length > 0) {
        if (macKey) {
          const decrypted = decryptChromeValue(row.encrypted_value, macKey);
          if (decrypted) value = decrypted;
        }
        // On Linux with kwallet/gnome-keyring support we'd need separate handling
        // For now, skip encrypted values we can't decrypt
        if (!value || value === '') {
          if (verbose) console.warn(`[cookies] Skipping encrypted cookie: ${row.name}`);
          continue;
        }
      }

      // Chrome stores expires as microseconds since Jan 1, 1601
      // Convert to Unix seconds
      let expires: number | undefined;
      if (row.expires_utc > 0) {
        expires = Math.floor((row.expires_utc - 11644473600000000) / 1000000);
      }

      cookies.push({
        name: row.name,
        value,
        domain: row.host_key,
        path: row.path || '/',
        secure: row.secure === 1,
        httpOnly: row.is_httponly === 1,
        expires,
      });
    }

    if (verbose) console.log(`[cookies] Loaded ${cookies.length} cookies for ${domain}`);
    return cookies;
  } finally {
    try { db.close(); } catch { /* ignore */ }
    // H-3 fix: clean up the entire temp directory, not just the file
    try { fs.rmSync(tmpDirCookies, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Key cookies needed for grok.com authentication */
export const GROK_COOKIE_NAMES = [
  'auth_token',
  'ct0',                     // CSRF token
  'twid',                    // Twitter/X user ID
  'guest_id',
  '_twitter_sess',
  'personalization_id',
  'd_prefs',
  'kdt',
  'remember_checked_on',
];

/** Filter to only the cookies needed for auth */
export function filterGrokCookies(cookies: CookieParam[]): CookieParam[] {
  // Include all grok.com / x.com / twitter.com domain cookies
  // that are auth-related
  return cookies.filter(c => {
    const name = c.name.toLowerCase();
    const dom = (c.domain ?? '').toLowerCase();
    const isRelevantDomain =
      dom.includes('grok.com') ||
      dom.includes('x.com') ||
      dom.includes('twitter.com');
    return isRelevantDomain;
  });
}
