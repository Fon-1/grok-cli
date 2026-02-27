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
 * Read Aloud flow:
 *
 * Grok.com dùng một trong 2 cách để phát audio:
 *   A) Fetch audio file (MP3/WAV) qua HTTP → inject vào <audio> element
 *   B) Web Speech API (speechSynthesis) — hoàn toàn browser-side, không có network request
 *
 * Strategy:
 *   1. Intercept Network requests để bắt audio URL (cách A)
 *   2. Poll DOM để tìm <audio> element xuất hiện (cách A + B)
 *   3. Nếu bắt được URL → download hoặc lưu URL
 *   4. Nếu chỉ có <audio> element với blob: src → lưu URL blob
 *   5. Nếu dùng speechSynthesis → không capture được audio data,
 *      chỉ có thể trigger và để Chrome tự đọc
 */
async function triggerReadAloud(
  client: CDPClient,
  outputPath: string,
  log: (msg: string) => void,
): Promise<void> {
  const { Runtime, Network } = client;

  const READ_ALOUD_SELECTORS = [
    // Theo data-testid (ổn định nhất)
    'button[data-testid="read-aloud-button"]',
    'button[data-testid*="read-aloud"]',
    'button[data-testid*="readAloud"]',
    'button[data-testid*="tts"]',
    'button[data-testid*="speak"]',
    // Theo aria-label
    'button[aria-label="Read aloud"]',
    'button[aria-label="Read Aloud"]',
    'button[aria-label*="Read aloud"]',
    'button[aria-label*="Speak"]',
    'button[aria-label*="Listen"]',
    // Theo title
    'button[title="Read aloud"]',
    'button[title*="Read aloud"]',
    // Theo class
    '[class*="read-aloud"] button',
    '[class*="readAloud"] button',
    '[class*="tts-button"]',
    '[class*="speak-button"]',
    // Fallback icon button trong message actions
    '[data-testid="message-actions"] button:last-child',
  ];

  log('[read-aloud] Setting up network intercept...');

  // ── 1. Intercept network requests để bắt audio URL ──────────────────────
  let capturedAudioUrl: string | null = null;

  // Dùng CDP event đúng cách với chrome-remote-interface
  Network.requestWillBeSent((params: any) => {
    const url: string = params.request?.url ?? '';
    const resourceType: string = params.type ?? '';
    // Bắt audio/media requests
    if (
      resourceType === 'Media' ||
      resourceType === 'XHR' ||
      resourceType === 'Fetch' ||
      url.includes('.mp3') ||
      url.includes('.wav') ||
      url.includes('.ogg') ||
      url.includes('audio') ||
      url.includes('/tts') ||
      url.includes('/speech') ||
      url.includes('/synthesize') ||
      url.includes('text-to-speech')
    ) {
      if (!capturedAudioUrl) {
        capturedAudioUrl = url;
        log(`[read-aloud] Audio request intercepted: ${url.slice(0, 100)}`);
      }
    }
  });

  // Enable Media domain để track audio elements
  try {
    await client.Media?.enable?.();
  } catch { /* Media domain optional */ }

  // ── 2. Tìm và click nút Read Aloud ──────────────────────────────────────
  log('[read-aloud] Looking for Read Aloud button...');

  const clickResult = await Runtime.evaluate({
    expression: `
      (function() {
        const sels = ${JSON.stringify(READ_ALOUD_SELECTORS)};

        // Thử trong last message trước
        const articles = document.querySelectorAll('[role="article"], article, [data-testid*="message"]');
        const lastArticle = articles[articles.length - 1];

        for (const sel of sels) {
          try {
            // Tìm trong last message
            if (lastArticle) {
              const btn = lastArticle.querySelector(sel);
              if (btn && !btn.disabled) {
                btn.click();
                return { found: true, sel, scope: 'last-message' };
              }
            }
            // Tìm trên toàn trang
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled) {
              btn.click();
              return { found: true, sel, scope: 'document' };
            }
          } catch {}
        }

        // Debug: liệt kê các button trong last message
        const buttons = lastArticle
          ? Array.from(lastArticle.querySelectorAll('button')).map(b => ({
              text: b.textContent?.trim().slice(0, 30),
              label: b.getAttribute('aria-label'),
              testid: b.getAttribute('data-testid'),
              title: b.title,
            }))
          : [];

        return { found: false, buttons };
      })()
    `,
    returnByValue: true,
  });

  const clickData = clickResult.result?.value as any;

  if (!clickData?.found) {
    // Không tìm thấy button — log debug info
    log('[read-aloud] Read Aloud button not found on this page.');
    if (clickData?.buttons?.length > 0) {
      log('[read-aloud] Buttons found in last message:');
      for (const b of clickData.buttons) {
        log(`  - text="${b.text}" aria-label="${b.label}" data-testid="${b.testid}"`);
      }
      log('[read-aloud] → Copy button info above and open an issue to update selectors.');
    } else {
      log('[read-aloud] No buttons found in last message — page may not have loaded fully.');
    }
    return;
  }

  log(`[read-aloud] Clicked Read Aloud button (${clickData.sel}, scope: ${clickData.scope})`);

  // ── 3. Đợi audio bắt đầu phát (poll <audio> element + network) ──────────
  log('[read-aloud] Waiting for audio to start...');
  const deadline = Date.now() + 20_000;
  let audioElementSrc: string | null = null;
  let isPlaying = false;

  while (Date.now() < deadline) {
    await sleep(400);

    // Check network đã bắt được URL chưa
    if (capturedAudioUrl) break;

    // Poll <audio> element trong DOM
    const audioCheck = await Runtime.evaluate({
      expression: `
        (function() {
          const audios = document.querySelectorAll('audio');
          for (const a of audios) {
            if (a.src && a.src !== '' && !a.src.startsWith('data:')) {
              return { src: a.src, paused: a.paused, currentTime: a.currentTime };
            }
          }
          // Check speechSynthesis
          const synth = window.speechSynthesis;
          if (synth && synth.speaking) return { src: null, speaking: true };
          return null;
        })()
      `,
      returnByValue: true,
    });

    const audioData = audioCheck.result?.value as any;
    if (audioData) {
      if (audioData.src) {
        audioElementSrc = audioData.src;
        isPlaying = !audioData.paused;
        log(`[read-aloud] Audio element found: ${audioData.src.slice(0, 80)}`);
        break;
      }
      if (audioData.speaking) {
        log('[read-aloud] speechSynthesis is speaking (browser TTS — no audio file to capture)');
        isPlaying = true;
        break;
      }
    }
  }

  // ── 4. Xử lý kết quả ────────────────────────────────────────────────────
  const fsMod = await import('fs');
  const pathMod = await import('path');

  const finalUrl = capturedAudioUrl ?? audioElementSrc;

  if (finalUrl) {
    fsMod.default.mkdirSync(pathMod.default.dirname(outputPath), { recursive: true });

    if (finalUrl.startsWith('blob:')) {
      // Blob URL — không download được từ Node, lưu URL để user dùng thủ công
      fsMod.default.writeFileSync(outputPath, finalUrl, 'utf-8');
      log(`[read-aloud] Blob audio URL saved to: ${outputPath}`);
      log('[read-aloud] Note: Blob URLs expire — open in browser to play/download');

    } else if (outputPath.endsWith('.mp3') || outputPath.endsWith('.wav') || outputPath.endsWith('.ogg')) {
      // Download audio file
      await downloadImage(finalUrl, outputPath, log);
      log(`[read-aloud] Audio downloaded to: ${outputPath}`);

    } else {
      // Lưu URL vào text file
      fsMod.default.writeFileSync(outputPath, finalUrl, 'utf-8');
      log(`[read-aloud] Audio URL saved to: ${outputPath}`);
    }

  } else if (isPlaying) {
    // speechSynthesis đang chạy — không có file để lưu
    log('[read-aloud] Grok is reading aloud via browser speech synthesis.');
    log('[read-aloud] This uses Web Speech API — no audio file is generated.');
    log('[read-aloud] You can hear the audio directly in the browser window.');
    // Lưu note vào file
    fsMod.default.mkdirSync(pathMod.default.dirname(outputPath), { recursive: true });
    fsMod.default.writeFileSync(
      outputPath,
      'Read Aloud triggered via Web Speech API (browser TTS)\nNo audio file available — listen in browser window.\n',
      'utf-8',
    );

  } else {
    log('[read-aloud] Audio did not start within 20s.');
    log('[read-aloud] Possible reasons:');
    log('  1. Read Aloud requires Grok Premium subscription');
    log('  2. Button selector changed — run with -v and check DOM hint');
    log('  3. Response was too short to trigger Read Aloud');
  }
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
