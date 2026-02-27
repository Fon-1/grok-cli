/**
 * Browser engine for grok-cli.
 *
 * Flow:
 *  1. Launch Chrome (or attach to existing via --remote-chrome)
 *  2. Inject stealth patches to avoid bot-detection fingerprints
 *  3. Set cookies for grok.com / x.com
 *  4. Navigate to grok.com
 *  5. Detect & handle challenges:
 *       a. Cloudflare Turnstile / JS challenge  → wait for auto-pass (non-headless)
 *       b. Arkose FunCaptcha (X login wall)      → pause, let user solve, then continue
 *       c. Any other captcha / wall              → pause + user prompt
 *  6. Verify auth
 *  7. Paste prompt bundle into textarea
 *  8. Submit
 *  9. Wait for and capture the response
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import type { LaunchedChrome } from 'chrome-launcher';
import type { CookieParam, GrokOptions } from './types.js';

// ─── CDP helpers ──────────────────────────────────────────────────────────────

type CDPClient = any;

export async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result != null) return result as T;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function promptUser(question: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, () => {
      rl.close();
      resolve();
    });
  });
}

// ─── Stealth: remove webdriver fingerprints ───────────────────────────────────

const STEALTH_SCRIPT = `
(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      arr.__proto__ = PluginArray.prototype;
      return arr;
    },
    configurable: true,
  });

  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });

  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      value: {
        app: { isInstalled: false, InstallState: {}, RunningState: {} },
        runtime: { connect: () => {}, sendMessage: () => {}, id: undefined },
        loadTimes: () => {},
        csi: () => {},
      },
      configurable: true,
    });
  }

  if (navigator.permissions) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params && params.name === 'notifications') return Promise.resolve({ state: 'denied', onchange: null });
      return origQuery(params);
    };
  }

  ['__webdriver_script_fn', '__driver_evaluate', '__webdriver_evaluate',
   '__selenium_evaluate', '__fxdriver_evaluate', '__driver_unwrapped',
   '__webdriver_unwrapped', '__selenium_unwrapped', '__fxdriver_unwrapped',
   '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium',
   '$cdc_asdjflasutopfhvcZLmcfl_', 'document.$cdc_asdjflasutopfhvcZLmcfl_',
   '__$webdriverAsyncExecutor', '__lastWatirAlert', '__lastWatirConfirm',
   '__lastWatirPrompt', '_WEBDRIVER_CLIENT_', '__webdriver_script_func',
  ].forEach(prop => { try { delete window[prop]; } catch {} });

  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParam.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParam2.call(this, param);
    };
  }
})();
`;

// ─── Challenge detection ───────────────────────────────────────────────────────

type ChallengeKind =
  | 'cloudflare-turnstile'
  | 'cloudflare-challenge'
  | 'arkose-funcaptcha'
  | 'recaptcha'
  | 'hcaptcha'
  | 'login-wall'
  | 'none';

async function detectChallenge(client: CDPClient): Promise<ChallengeKind> {
  const { Runtime } = client;
  try {
    const result = await Runtime.evaluate({
      expression: `
        (function() {
          const url = window.location.href;
          const title = document.title || '';
          const body = document.body?.innerText || '';

          if (title.includes('Just a moment') || body.includes('Checking your browser')) return 'cloudflare-challenge';
          if (document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
              document.querySelector('[class*="cf-turnstile"]') ||
              document.querySelector('input[name="cf-turnstile-response"]')) return 'cloudflare-turnstile';
          if (document.querySelector('iframe[src*="arkoselabs.com"]') ||
              document.querySelector('iframe[src*="funcaptcha.com"]') ||
              document.querySelector('#FunCaptcha') ||
              document.querySelector('[id*="arkose"]') ||
              document.querySelector('input[name="fc-token"]')) return 'arkose-funcaptcha';
          if (document.querySelector('iframe[src*="recaptcha"]') ||
              document.querySelector('.g-recaptcha') ||
              document.querySelector('[data-sitekey]')) return 'recaptcha';
          if (document.querySelector('iframe[src*="hcaptcha.com"]') ||
              document.querySelector('.h-captcha')) return 'hcaptcha';
          if (url.includes('x.com/login') || url.includes('twitter.com/login') ||
              url.includes('/i/flow/login') || url.includes('grok.com/login')) return 'login-wall';
          return 'none';
        })()
      `,
      returnByValue: true,
    });
    return (result.result?.value as ChallengeKind) ?? 'none';
  } catch {
    return 'none';
  }
}

async function handleChallenge(
  client: CDPClient,
  kind: ChallengeKind,
  opts: GrokOptions,
  log: (msg: string) => void,
): Promise<void> {
  if (kind === 'none') return;

  switch (kind) {
    case 'cloudflare-challenge':
    case 'cloudflare-turnstile': {
      log(`[captcha] Cloudflare challenge detected (${kind})`);
      if (opts.headless) {
        console.warn('\n  ⚠  Cloudflare challenge in headless mode — restart without --headless.\n');
      } else {
        log('[captcha] Waiting up to 30s for Cloudflare to auto-pass...');
      }
      const resolved = await waitForChallengeGone(client, kind, 30_000);
      if (resolved) {
        log('[captcha] Cloudflare challenge passed ✓');
      } else {
        console.log('\n  ⏸  Cloudflare challenge did not auto-pass.\n     Please solve it in the browser window, then press Enter here.\n');
        await promptUser('  Press Enter after the challenge is solved: ');
        log('[captcha] Continuing after user confirmation');
      }
      break;
    }
    case 'arkose-funcaptcha': {
      console.log('\n  ⏸  Arkose FunCaptcha detected (X.com security challenge)\n     1. Look at the browser window\n     2. Solve the image puzzle\n     3. Press Enter here once done\n');
      await promptUser('  Press Enter after solving the captcha: ');
      await sleep(2000);
      log('[captcha] Continuing after Arkose FunCaptcha');
      break;
    }
    case 'recaptcha':
    case 'hcaptcha': {
      console.log(`\n  ⏸  ${kind === 'recaptcha' ? 'reCAPTCHA' : 'hCaptcha'} detected.\n     Please solve it in the browser window, then press Enter here.\n`);
      await promptUser('  Press Enter after solving the captcha: ');
      await sleep(1500);
      log('[captcha] Continuing after captcha solve');
      break;
    }
    case 'login-wall': {
      console.log('\n  ✗  Redirected to login page.\n\n     Options:\n       1. grok cookies\n       2. Export cookies → ~/.grok/cookies.json\n       3. --manual-login\n       4. --inline-cookies-file\n');
      throw new Error('Redirected to login page — cookies missing or expired');
    }
  }
}

async function waitForChallengeGone(client: CDPClient, kind: ChallengeKind, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const current = await detectChallenge(client);
    if (current === 'none' || current !== kind) return true;
  }
  return false;
}

async function checkAndHandleChallenges(client: CDPClient, opts: GrokOptions, log: (msg: string) => void, maxRounds = 3): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const kind = await detectChallenge(client);
    if (kind === 'none') return;
    await handleChallenge(client, kind, opts, log);
    await sleep(1000);
  }
}

// ─── Chrome launch ────────────────────────────────────────────────────────────

async function launchChrome(opts: {
  chromePath?: string;
  profileDir?: string;
  headless?: boolean;
  port?: number;
  verbose?: boolean;
}): Promise<{ launcher: LaunchedChrome; port: number }> {
  const { launch } = await import('chrome-launcher');

  const flags = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-ipc-flooding-protection',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
    '--disable-sync',
    '--disable-extensions',
    '--window-size=1280,800',
    '--start-maximized',
  ];

  if (opts.profileDir) flags.push(`--user-data-dir=${opts.profileDir}`);

  if (opts.headless) {
    flags.push('--headless=new');
    flags.push('--disable-dev-shm-usage');
    flags.push('--no-sandbox');
  }

  const launcher = await launch({
    chromePath: opts.chromePath,
    chromeFlags: flags,
    port: opts.port,
    logLevel: opts.verbose ? 'verbose' : 'silent',
  });

  if (opts.verbose) console.log(`[browser] Chrome launched on port ${launcher.port}`);
  return { launcher, port: launcher.port };
}

async function connectCDP(port: number, verbose?: boolean): Promise<CDPClient> {
  const CDP = (await import('chrome-remote-interface')).default;
  let last: Error | undefined;
  for (let i = 0; i < 12; i++) {
    try {
      const client = await CDP({ port });
      if (verbose) console.log(`[browser] CDP connected on port ${port}`);
      return client;
    } catch (err) {
      last = err as Error;
      await sleep(600);
    }
  }
  throw new Error(`Could not connect to Chrome CDP: ${last?.message}`);
}

async function connectRemoteCDP(address: string, verbose?: boolean): Promise<CDPClient> {
  const match = address.match(/^\[(.+)\]:(\d+)$/) ?? address.match(/^([^:]+):(\d+)$/);
  const host = match?.[1] ?? 'localhost';
  const port = parseInt(match?.[2] ?? '9222', 10);
  const CDP = (await import('chrome-remote-interface')).default;
  const client = await CDP({ host, port });
  if (verbose) console.log(`[browser] Connected to remote Chrome at ${address}`);
  return client;
}

// ─── Cookie injection ─────────────────────────────────────────────────────────

async function setCookies(client: CDPClient, cookies: CookieParam[], verbose?: boolean) {
  const { Network } = client;
  let ok = 0;
  for (const cookie of cookies) {
    const params: Record<string, unknown> = {
      name: cookie.name,
      value: cookie.value,
      path: cookie.path ?? '/',
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
    };
    if (cookie.domain) params.domain = cookie.domain;
    if (cookie.url) params.url = cookie.url;
    if (cookie.expires) params.expires = cookie.expires;
    try {
      await Network.setCookie(params);
      ok++;
    } catch (err) {
      if (verbose) console.warn(`[browser] Failed to set cookie ${cookie.name}: ${(err as Error).message}`);
    }
  }
  if (verbose) console.log(`[browser] Set ${ok}/${cookies.length} cookies`);
}

// ─── Auth verification ────────────────────────────────────────────────────────

async function verifyGrokAuth(client: CDPClient, verbose?: boolean): Promise<boolean> {
  const { Runtime } = client;
  try {
    const result = await Runtime.evaluate({
      expression: `
        (function() {
          const url = window.location.href;
          if (url.includes('/login') || url.includes('/i/flow/login')) return false;
          if (url.includes('grok.com') && !url.includes('/login')) return true;
          return false;
        })()
      `,
      returnByValue: true,
    });
    const ok = result.result?.value === true;
    if (verbose) console.log(`[browser] Auth check: ${ok}`);
    return ok;
  } catch {
    return false;
  }
}

// ─── Grok.com UI selectors ────────────────────────────────────────────────────

const TEXTAREA_SELECTORS = [
  'textarea[data-testid="grok-compose-input"]',
  'div[data-testid="grok-compose-input"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="Type"]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
  'textarea[aria-label*="message"]',
  'textarea[aria-label*="Ask"]',
  '#prompt-textarea',
  'textarea:not([readonly]):not([disabled])',
];

const SUBMIT_SELECTORS = [
  'button[data-testid="grok-compose-submit"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[aria-label*="Submit"]',
  'button[type="submit"]',
  'button[data-testid*="send"]',
];

// Order matters: more specific first
const RESPONSE_SELECTORS = [
  '[class*="response"][class*="content"]',
  '[data-testid="grok-response-content"]',
  '[data-testid="responseText"]',
  '[data-testid="response-content"]',
  '[data-testid="message-content"]',
  '[data-testid="assistant-message"]',
  '[data-message-role="assistant"]',
  '[data-role="assistant"]',
  '.response-content',
  '.message-content',
  'article[data-testid*="response"]',
  'article[data-testid*="message"]',
  '[role="article"]',
  '.prose',
  '.markdown-body',
  '[class*="message"][class*="assistant"]',
  '[class*="assistant"] [class*="content"]',
  'div[class*="markdown"]',
  'main article',
  'section[role="region"] article',
];

// Loading indicators — excludes Stop button (stays visible after generation)
const LOADING_SELECTORS = [
  '[data-testid="grok-streaming-indicator"]',
  '[data-testid="loading"]',
  '[data-testid*="loading"]',
  '[data-testid*="thinking"]',
  '[data-testid*="generating"]',
  '[aria-label*="Loading"]',
  '[aria-label*="Generating"]',
  '[aria-label*="Thinking"]',
  'svg[class*="animate-spin"]',
  'svg[class*="spinner"]',
  '.loading-indicator',
  '[class*="streaming"]',
  '[class*="thinking"]',
  '[class*="generating"]',
];

// ─── DOM helpers ──────────────────────────────────────────────────────────────

async function findElement(client: CDPClient, selectors: string[]): Promise<string | null> {
  const { Runtime } = client;
  for (const sel of selectors) {
    try {
      const result = await Runtime.evaluate({
        expression: `document.querySelector(${JSON.stringify(sel)}) !== null`,
        returnByValue: true,
      });
      if (result.result?.value === true) return sel;
    } catch { /* ignore */ }
  }
  return null;
}

async function clickElement(client: CDPClient, selector: string): Promise<void> {
  const { Runtime } = client;
  await Runtime.evaluate({
    expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
  });
}

async function pasteText(client: CDPClient, selector: string, text: string, verbose?: boolean): Promise<void> {
  const { Runtime } = client;

  await Runtime.evaluate({ expression: `document.querySelector(${JSON.stringify(selector)})?.focus()` });
  await sleep(200);

  const isContentEditable = await Runtime.evaluate({
    expression: `document.querySelector(${JSON.stringify(selector)})?.getAttribute('contenteditable') !== null`,
    returnByValue: true,
  });

  if (isContentEditable.result?.value) {
    await Runtime.evaluate({
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.focus();
          el.innerHTML = '';
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, ${JSON.stringify(text)});
          return true;
        })()
      `,
      returnByValue: true,
    });
  } else {
    await Runtime.evaluate({
      expression: `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          nativeSetter?.call(el, ${JSON.stringify(text)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `,
      returnByValue: true,
    });
  }

  if (verbose) console.log(`[browser] Pasted ${text.length.toLocaleString()} chars into ${selector}`);
  await sleep(300);
}

// ─── Mode toggles ─────────────────────────────────────────────────────────────

async function enableThinkMode(client: CDPClient, log: (msg: string) => void): Promise<void> {
  const { Runtime } = client;
  const THINK_SELECTORS = [
    'button[data-testid="think-toggle"]',
    'button[aria-label*="Think"]',
    'button[aria-label*="think"]',
    'button[title*="Think"]',
    '[data-testid*="think"]',
    'button[class*="think"]',
  ];
  const result = await Runtime.evaluate({
    expression: `
      (function() {
        const sels = ${JSON.stringify(THINK_SELECTORS)};
        for (const sel of sels) {
          try {
            const btn = document.querySelector(sel);
            if (btn) {
              const isActive = btn.getAttribute('aria-pressed') === 'true'
                || btn.classList.contains('active')
                || btn.getAttribute('data-active') === 'true';
              if (!isActive) btn.click();
              return sel;
            }
          } catch {}
        }
        return null;
      })()
    `,
    returnByValue: true,
  });
  if (result.result?.value) {
    log(`[mode] Think mode enabled (${result.result.value})`);
    await sleep(500);
  } else {
    log('[mode] Think toggle not found — may already be active or selector changed');
  }
}

async function enableDeepSearch(client: CDPClient, log: (msg: string) => void): Promise<void> {
  const { Runtime } = client;
  const DEEPSEARCH_SELECTORS = [
    'button[data-testid="deepsearch-toggle"]',
    'button[data-testid="deep-search-toggle"]',
    'button[aria-label*="DeepSearch"]',
    'button[aria-label*="Deep Search"]',
    'button[aria-label*="deep search"]',
    'button[title*="DeepSearch"]',
    'button[title*="Deep Search"]',
    '[data-testid*="deepsearch"]',
    '[data-testid*="deep-search"]',
    'button[class*="deepsearch"]',
    'button[class*="deep-search"]',
  ];
  const result = await Runtime.evaluate({
    expression: `
      (function() {
        const sels = ${JSON.stringify(DEEPSEARCH_SELECTORS)};
        for (const sel of sels) {
          try {
            const btn = document.querySelector(sel);
            if (btn) {
              const isActive = btn.getAttribute('aria-pressed') === 'true'
                || btn.classList.contains('active')
                || btn.getAttribute('data-active') === 'true';
              if (!isActive) btn.click();
              return sel;
            }
          } catch {}
        }
        return null;
      })()
    `,
    returnByValue: true,
  });
  if (result.result?.value) {
    log(`[mode] DeepSearch enabled (${result.result.value})`);
    await sleep(500);
  } else {
    log('[mode] DeepSearch toggle not found — may already be active or selector changed');
  }
}

// ─── Submit helper ────────────────────────────────────────────────────────────

async function submitPrompt(client: CDPClient, textareaSel: string, log: (msg: string) => void): Promise<void> {
  const { Runtime, Input } = client;
  log('[browser] Submitting...');

  try {
    const submitSel = await waitFor(
      async () => {
        for (const sel of SUBMIT_SELECTORS) {
          const result = await Runtime.evaluate({
            expression: `
              (function() {
                const btn = document.querySelector(${JSON.stringify(sel)});
                return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' ? true : null;
              })()
            `,
            returnByValue: true,
          });
          if (result.result?.value === true) return sel;
        }
        return null;
      },
      12_000,
      400,
    );
    await clickElement(client, submitSel);
    log(`[browser] Clicked submit: ${submitSel}`);
  } catch {
    log('[browser] Submit button not found — trying Enter key');
    await Runtime.evaluate({ expression: `document.querySelector(${JSON.stringify(textareaSel)})?.focus()` });
    await sleep(100);
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(80);
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
}

// ─── Image generation ─────────────────────────────────────────────────────────

async function captureGeneratedImage(client: CDPClient, timeoutMs: number, log: (msg: string) => void): Promise<string | null> {
  const { Runtime } = client;
  const deadline = Date.now() + timeoutMs;
  log('[imagine] Waiting for generated image...');

  while (Date.now() < deadline) {
    try {
      const result = await Runtime.evaluate({
        expression: `
          (function() {
            const imgs = document.querySelectorAll([
              '[data-testid*="generated-image"] img',
              '[data-testid*="image-result"] img',
              '.response-content img',
              '[class*="generated"] img',
              '[class*="image-result"] img',
              'article img[src*="blob:"]',
              'article img[src*="http"]',
              '[role="article"] img',
            ].join(','));
            for (const img of imgs) {
              const src = img.src || img.getAttribute('src') || '';
              const w = img.naturalWidth || img.width || 0;
              const h = img.naturalHeight || img.height || 0;
              if (src && (w > 100 || h > 100 || src.includes('blob:'))) return src;
            }
            const links = document.querySelectorAll('a[download][href*="blob:"], a[download][href*=".png"], a[download][href*=".jpg"]');
            if (links.length > 0) return (links[0] as HTMLAnchorElement).href;
            return null;
          })()
        `,
        returnByValue: true,
      });
      const url = result.result?.value as string | null;
      if (url) {
        log(`[imagine] Image found: ${url.slice(0, 80)}...`);
        return url;
      }
    } catch (err) {
      log(`[imagine] Poll error: ${(err as Error).message}`);
    }
    await sleep(1000);
  }
  log('[imagine] Timed out waiting for image');
  return null;
}

async function downloadImage(url: string, outputPath: string, log: (msg: string) => void): Promise<void> {
  const fsMod = await import('fs');
  const pathMod = await import('path');
  fsMod.default.mkdirSync(pathMod.default.dirname(outputPath), { recursive: true });

  if (url.startsWith('http')) {
    const https = await import('https');
    const http = await import('http');
    const protocol = url.startsWith('https') ? https.default : http.default;
    await new Promise<void>((resolve, reject) => {
      const file = fsMod.default.createWriteStream(outputPath);
      protocol.get(url, (res) => {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });
    log(`[imagine] Image saved to: ${outputPath}`);
  } else {
    log(`[imagine] Blob URL — open browser to save manually`);
    log(`[imagine] Blob URL: ${url}`);
  }
}

// ─── Read Aloud ───────────────────────────────────────────────────────────────

/**
 * Read Aloud — thực tế của grok.com (cập nhật 2026-02):
 *
 * SAU KHI KIỂM TRA DOM THỰC TẾ:
 *   - grok.com có feature flag "enable_text_to_speech": false → DISABLED trên web
 *   - Read Aloud chỉ có trên Android app (ra mắt 22/2/2026), chưa có trên web
 *   - grok.com có Voice Mode qua WebSocket wss://grok-v2.x.ai/ws/app_chat/stream_audio
 *     nhưng đây là voice CHAT 2 chiều, không phải đọc response
 *
 * GIẢI PHÁP THAY THẾ:
 *   Dùng Web Speech API (speechSynthesis) trong Chrome để đọc text response.
 *   → Không cần button trên UI, không cần premium
 *   → Nghe trực tiếp trong Chrome window
 *   → Có thể export audio qua MediaRecorder API
 */
async function triggerReadAloud(
  client: CDPClient,
  outputPath: string,
  log: (msg: string) => void,
): Promise<void> {
  const { Runtime } = client;
  const fsMod = await import('fs');
  const pathMod = await import('path');

  // ── Bước 1: Lấy text của response cuối cùng ───────────────────────────────
  log('[read-aloud] Extracting last response text...');

  const textResult = await Runtime.evaluate({
    expression: `
      (function() {
        const sels = ${JSON.stringify(RESPONSE_SELECTORS)};
        for (const sel of sels) {
          try {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
              const last = els[els.length - 1];
              const text = (last.innerText || last.textContent || '').trim();
              if (text.length > 10) return text;
            }
          } catch {}
        }
        // Fallback: last article
        const arts = document.querySelectorAll('[role="article"], article');
        if (arts.length > 0) {
          return (arts[arts.length - 1].innerText || '').trim();
        }
        return null;
      })()
    `,
    returnByValue: true,
  });

  const responseText = textResult.result?.value as string | null;

  if (!responseText || responseText.length < 10) {
    log('[read-aloud] No response text found to read. Send a prompt first.');
    return;
  }

  log(`[read-aloud] Got ${responseText.length} chars to read aloud`);

  // ── Bước 2: Inject Web Speech API vào Chrome ───────────────────────────────
  // grok.com web không có Read Aloud button (enable_text_to_speech: false)
  // → dùng window.speechSynthesis trực tiếp trong Chrome
  log('[read-aloud] Injecting Web Speech API into Chrome...');

  const speakResult = await Runtime.evaluate({
    expression: `
      (function() {
        if (!window.speechSynthesis) return { ok: false, reason: 'speechSynthesis not available' };

        // Stop bất kỳ speech nào đang chạy
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(${JSON.stringify(responseText)});
        utterance.lang = 'en-US';
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        // Lưu vào window để có thể stop sau
        window.__grokReadAloudUtterance = utterance;

        window.speechSynthesis.speak(utterance);
        return { ok: true, length: ${responseText.length} };
      })()
    `,
    returnByValue: true,
  });

  const speakData = speakResult.result?.value as any;

  if (!speakData?.ok) {
    log(`[read-aloud] Speech failed: ${speakData?.reason ?? 'unknown'}`);
    log('[read-aloud] Note: grok.com web does not have a native Read Aloud button.');
    log('[read-aloud] Web Speech API is the only available method on web.');
    return;
  }

  log('[read-aloud] ✓ Chrome is now reading the response aloud.');
  log('[read-aloud] Listen in the browser window.');
  log('[read-aloud] To stop: window.speechSynthesis.cancel() in browser console.');

  // ── Bước 3: Lưu text ra file (để user đọc / dùng TTS khác) ──────────────
  fsMod.default.mkdirSync(pathMod.default.dirname(outputPath), { recursive: true });

  if (outputPath.endsWith('.txt') || outputPath.endsWith('.md') || !outputPath.includes('.')) {
    // Lưu text để user dùng TTS tool khác nếu cần
    const content = [
      `# Grok Read Aloud — ${new Date().toISOString()}`,
      '',
      responseText,
      '',
      '---',
      'Generated by grok-cli --read-aloud',
      'Web Speech API was used to read this text in Chrome.',
    ].join('\n');
    fsMod.default.writeFileSync(outputPath, content, 'utf-8');
    log(`[read-aloud] Response text saved to: ${outputPath}`);

  } else if (outputPath.endsWith('.mp3') || outputPath.endsWith('.wav')) {
    // Không thể capture audio từ speechSynthesis trong Node
    // Thay vào đó hướng dẫn dùng xAI TTS API nếu có
    const note = [
      'NOTE: grok.com web does not support audio file export.',
      'The response text has been saved below.',
      'Use any local TTS tool to convert to audio:',
      '  macOS:   say -o output.aiff "text..."  OR  say -f this-file.txt',
      '  Windows: PowerShell: Add-Type -AssemblyName System.Speech; ...',
      '  Linux:   espeak-ng -f this-file.txt -w output.wav',
      '',
      'Response text:',
      '',
      responseText,
    ].join('\n');
    // Lưu txt thay vì mp3
    const txtPath = outputPath.replace(/\.(mp3|wav)$/, '.txt');
    fsMod.default.writeFileSync(txtPath, note, 'utf-8');
    log(`[read-aloud] Cannot export MP3 from browser TTS. Text saved to: ${txtPath}`);
    log('[read-aloud] See file for instructions on generating audio.');
  } else {
    fsMod.default.writeFileSync(outputPath, responseText, 'utf-8');
    log(`[read-aloud] Response text saved to: ${outputPath}`);
  }

  // ── Bước 4: Đợi speech xong (optional, không block quá 5 phút) ───────────
  const estimatedDurationMs = Math.min((responseText.length / 15) * 1000, 300_000);
  log(`[read-aloud] Estimated reading time: ~${Math.round(estimatedDurationMs / 1000)}s`);
}

// ─── Response capture ─────────────────────────────────────────────────────────

async function captureResponse(client: CDPClient, timeoutMs: number, verbose?: boolean): Promise<string> {
  const { Runtime } = client;
  const deadline = Date.now() + timeoutMs;
  const startTime = Date.now();
  let lastText = '';
  let stableCount = 0;
  const STABLE_NEEDED = 3;                        // 3 × 300ms ≈ 1s stable
  const STABLE_IGNORE_LOADING_AFTER_MS = 4_000;   // after 4s ignore loading indicator
  const POLL_MS = 300;

  if (verbose) console.log('[browser] Polling for response...');
  let matchedSelector = '';
  let lastDomHintBucket = -1;

  while (Date.now() < deadline) {
    try {
      const result = await Runtime.evaluate({
        expression: `
          (function() {
            const sels = ${JSON.stringify(RESPONSE_SELECTORS)};
            for (const sel of sels) {
              try {
                const els = document.querySelectorAll(sel);
                if (els.length > 0) {
                  const last = els[els.length - 1];
                  const text = (last.innerText || last.textContent || '').trim();
                  if (text.length > 20) return { text, sel };
                }
              } catch(e) {}
            }
            // Fallback: largest text block not in input area
            const allDivs = document.querySelectorAll('div, section, main');
            let best = { text: '', sel: '', len: 0 };
            for (const el of allDivs) {
              if (el.querySelector('textarea, [contenteditable]')) continue;
              if (el.closest('textarea, [contenteditable], form, header, nav, footer')) continue;
              const text = (el.innerText || '').trim();
              if (text.length > best.len && text.length > 50) {
                best = { text, sel: el.tagName + '.' + el.className.slice(0,40), len: text.length };
              }
            }
            if (best.len > 50) return best;
            return null;
          })()
        `,
        returnByValue: true,
      });

      const val = result.result?.value as { text: string; sel: string } | null;
      const currentText = val?.text ?? '';
      if (val?.sel && val.sel !== matchedSelector) {
        matchedSelector = val.sel;
        if (verbose) console.log(`[browser] Matched selector: ${matchedSelector}`);
      }

      const loadResult = await Runtime.evaluate({
        expression: `
          (function() {
            const loadSels = ${JSON.stringify(LOADING_SELECTORS)};
            if (loadSels.some(s => { try { return document.querySelector(s) !== null; } catch { return false; } })) return true;
            const submitSels = ${JSON.stringify(SUBMIT_SELECTORS)};
            for (const s of submitSels) {
              try {
                const btn = document.querySelector(s);
                if (btn && (btn.disabled || btn.getAttribute('aria-disabled') === 'true')) return true;
              } catch {}
            }
            return false;
          })()
        `,
        returnByValue: true,
      });
      const isLoading = loadResult.result?.value === true;
      const elapsed = Date.now() - startTime;
      const acceptStableDespiteLoading = elapsed > STABLE_IGNORE_LOADING_AFTER_MS;

      if (verbose && currentText.length > 0 && currentText.length !== lastText.length) {
        process.stdout.write(`\r[browser] ${currentText.length} chars received...`);
      }

      if (currentText.length > 20) {
        const isStable = currentText === lastText;
        const considerDone = isStable && (!isLoading || acceptStableDespiteLoading);
        if (isStable) {
          stableCount++;
          if (verbose) process.stdout.write(`\r[browser] Stable ${stableCount}/${STABLE_NEEDED}...`);
          if (stableCount >= STABLE_NEEDED && considerDone) {
            if (verbose) console.log(`\n[browser] Response complete (${currentText.length} chars)`);
            return currentText;
          }
        } else {
          stableCount = 0;
          lastText = currentText;
        }
      } else if (currentText.length === 0 && lastText.length === 0) {
        const midChallenge = await detectChallenge(client);
        if (midChallenge !== 'none') {
          console.log(`\n  ⏸  Challenge appeared: ${midChallenge}`);
          await promptUser('  Press Enter after solving: ');
          await sleep(2000);
        }

        if (verbose) {
          const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
          const bucket = Math.floor(elapsedSec / 10);
          if (bucket > lastDomHintBucket) {
            lastDomHintBucket = bucket;
            const domHint = await Runtime.evaluate({
              expression: `
                (function() {
                  const result = [];
                  const els = document.querySelectorAll('[class*="message"],[class*="response"],[class*="chat"],[class*="answer"],[role="article"],[role="main"],article,main');
                  for (const el of els) {
                    const text = (el.innerText || '').trim().slice(0, 60);
                    if (text.length > 5) result.push(el.tagName + '[' + (el.getAttribute('class') || '').slice(0,50) + '] = "' + text + '"');
                  }
                  return result.slice(0, 8).join('\\n');
                })()
              `,
              returnByValue: true,
            });
            if (domHint.result?.value) console.log('\n[browser] DOM hint:\n' + domHint.result.value);
          }
        }
      }
    } catch (err) {
      if (verbose) console.warn(`\n[browser] Poll error: ${(err as Error).message}`);
    }

    await sleep(POLL_MS);
  }

  if (lastText) {
    console.warn('\n[browser] Timed out — returning partial response');
    return lastText;
  }

  try {
    const dump = await Runtime.evaluate({ expression: `document.body?.innerText?.slice(0, 2000) ?? ''`, returnByValue: true });
    const bodyText = (dump.result?.value as string) ?? '';
    if (bodyText.length > 100) { console.warn('[browser] Page body preview:'); console.warn(bodyText.slice(0, 500)); }
  } catch { /* ignore */ }

  throw new Error(`Response capture timed out after ${timeoutMs}ms.\n  Tip: run with -v to see DOM hints.\n  Bug: https://github.com/Fon-1/grok-cli/issues`);
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export interface BrowserRunResult {
  answer: string;
  durationMs: number;
}

export async function runGrokBrowser(
  bundleText: string,
  opts: GrokOptions,
  onProgress?: (msg: string) => void,
): Promise<BrowserRunResult> {
  const log = (msg: string) => {
    if (opts.verbose) console.log(msg);
    onProgress?.(msg);
  };

  const startTime = Date.now();
  let launcher: LaunchedChrome | undefined;
  let client: CDPClient | undefined;

  try {
    // ── 1. Launch or attach Chrome ─────────────────────────────────────────
    if (opts.remoteChrome) {
      log(`[browser] Attaching to remote Chrome at ${opts.remoteChrome}`);
      client = await connectRemoteCDP(opts.remoteChrome, opts.verbose);
    } else {
      let profileDir = opts.chromeProfile;
      if (!profileDir && opts.manualLogin) {
        profileDir = path.join(os.homedir(), '.grok', 'browser-profile');
        fs.mkdirSync(profileDir, { recursive: true });
        log(`[browser] Using persistent profile: ${profileDir}`);
      }
      const { launcher: l, port } = await launchChrome({
        chromePath: opts.chromePath,
        profileDir,
        headless: opts.headless,
        verbose: opts.verbose,
      });
      launcher = l;
      await sleep(1200);
      client = await connectCDP(port, opts.verbose);
    }

    const { Network, Page, Runtime } = client;
    await Network.enable();
    await Page.enable();
    await Runtime.enable();

    // ── 2. Inject stealth patches ──────────────────────────────────────────
    await Page.addScriptToEvaluateOnNewDocument({ source: STEALTH_SCRIPT });
    log('[browser] Stealth patches injected');

    // ── 3. Resolve and set cookies ─────────────────────────────────────────
    const cookies = await resolveCookies(opts, log);
    if (cookies.length > 0) await setCookies(client, cookies, opts.verbose);

    // ── 4. Navigate to grok.com ────────────────────────────────────────────
    const grokUrl = opts.grokUrl || 'https://grok.com';
    log(`[browser] Navigating to ${grokUrl}`);
    await Page.navigate({ url: grokUrl });
    try { await Promise.race([Page.loadEventFired(), sleep(15_000)]); } catch { /* ignore */ }
    await sleep(2500);

    // ── 5. Handle challenges ───────────────────────────────────────────────
    log('[browser] Checking for challenges...');
    await checkAndHandleChallenges(client, opts, log);
    await sleep(1000);

    // ── 6. Manual login wait ───────────────────────────────────────────────
    if (opts.manualLogin) {
      console.log('\n  ⏸  Manual login mode\n     Please sign in to grok.com, then wait...\n');
      await waitFor(
        async () => {
          const ch = await detectChallenge(client);
          if (ch !== 'none') await handleChallenge(client, ch, opts, log);
          return (await verifyGrokAuth(client, opts.verbose)) ? true : null;
        },
        opts.browserTimeout,
        3000,
      );
      log('[browser] Authenticated ✓');
    } else {
      const authed = await verifyGrokAuth(client, opts.verbose);
      log(authed ? '[browser] Authenticated ✓' : '[browser] Warning: auth not confirmed — proceeding');
    }

    // ── 7. Find textarea ───────────────────────────────────────────────────
    log('[browser] Looking for input area...');
    let textareaSel: string;
    try {
      textareaSel = await waitFor(() => findElement(client, TEXTAREA_SELECTORS), 30_000, 1000);
    } catch {
      await checkAndHandleChallenges(client, opts, log);
      textareaSel = await waitFor(() => findElement(client, TEXTAREA_SELECTORS), 15_000, 1000);
    }
    log(`[browser] Found input: ${textareaSel}`);

    // ── 8. Enable mode toggles ─────────────────────────────────────────────
    if (opts.think) await enableThinkMode(client, log);
    if (opts.deepSearch) await enableDeepSearch(client, log);

    // ── 9. Imagine mode ────────────────────────────────────────────────────
    if (opts.imagine) {
      log('[browser] Image generation mode (--imagine)');
      await pasteText(client, textareaSel, bundleText, opts.verbose);
      await submitPrompt(client, textareaSel, log);
      await sleep(2000);
      const imageUrl = await captureGeneratedImage(client, opts.responseTimeout, log);
      if (imageUrl) await downloadImage(imageUrl, opts.imagine, log);
      const durationMs = Date.now() - startTime;
      return { answer: `Image saved to: ${opts.imagine}\nSource: ${imageUrl ?? 'unknown'}`, durationMs };
    }

    // ── 10. Paste + Submit ─────────────────────────────────────────────────
    log(`[browser] Pasting bundle (${bundleText.length.toLocaleString()} chars)...`);
    await pasteText(client, textareaSel, bundleText, opts.verbose);
    await submitPrompt(client, textareaSel, log);
    await sleep(1500);

    // ── 11. Capture response ───────────────────────────────────────────────
    log('[browser] Waiting for Grok response...');
    const answer = await captureResponse(client, opts.responseTimeout, opts.verbose);

    // ── 12. Read Aloud (optional) ──────────────────────────────────────────
    if (opts.readAloud) await triggerReadAloud(client, opts.readAloud, log);

    const durationMs = Date.now() - startTime;
    log(`[browser] Done in ${(durationMs / 1000).toFixed(1)}s`);
    return { answer, durationMs };

  } finally {
    if (!opts.keepBrowser) {
      try { await client?.close(); } catch { /* ignore */ }
      try { launcher?.kill(); } catch { /* ignore */ }
    } else {
      log('[browser] Keeping browser open (--keep-browser)');
      try { await client?.close(); } catch { /* ignore */ }
    }
  }
}

// ─── Cookie resolution helper ─────────────────────────────────────────────────

async function resolveCookies(opts: GrokOptions, log: (msg: string) => void): Promise<CookieParam[]> {
  if (opts.inlineCookies) {
    const { parseCookiePayload } = await import('./cookies.js');
    const cookies = parseCookiePayload(opts.inlineCookies);
    log(`[browser] Using ${cookies.length} inline cookies`);
    return cookies;
  }

  if (opts.inlineCookiesFile) {
    const { loadCookiesFromFile } = await import('./cookies.js');
    const cookies = loadCookiesFromFile(opts.inlineCookiesFile);
    log(`[browser] Loaded ${cookies.length} cookies from ${opts.inlineCookiesFile}`);
    return cookies;
  }

  const grokHome = path.join(os.homedir(), '.grok');
  const { autoLoadCookies } = await import('./cookies.js');
  const autoCookies = autoLoadCookies(grokHome);
  if (autoCookies && autoCookies.length > 0) {
    log(`[browser] Auto-loaded ${autoCookies.length} cookies from ~/.grok/cookies.json`);
    return autoCookies;
  }

  if (!opts.manualLogin && !opts.remoteChrome) {
    const { getDefaultChromeCookiePaths, readChromeCookies } = await import('./cookies.js');
    const cookieDbPaths = opts.cookiePath ? [opts.cookiePath] : getDefaultChromeCookiePaths();
    for (const dbPath of cookieDbPaths) {
      if (!fs.existsSync(dbPath)) continue;
      try {
        const [grokCookies, xCookies] = await Promise.all([
          readChromeCookies(dbPath, 'grok.com', opts.verbose),
          readChromeCookies(dbPath, 'x.com', opts.verbose),
        ]);
        const all = [...(grokCookies ?? []), ...(xCookies ?? [])];
        if (all.length > 0) {
          log(`[browser] Read ${all.length} cookies from Chrome profile: ${dbPath}`);
          return all;
        }
      } catch (err) {
        if (opts.verbose) console.warn(`[browser] Cookie read error for ${dbPath}: ${(err as Error).message}`);
      }
      break;
    }
  }

  log('[browser] No cookies found — relying on browser session');
  return [];
}
