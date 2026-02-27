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

/**
 * Injected into every page before any scripts run (Page.addScriptToEvaluateOnNewDocument).
 * Removes the most common automation signals Cloudflare / Arkose look for.
 */
const STEALTH_SCRIPT = `
(function() {
  // 1. Remove navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // 2. Fake plugins array (empty = headless giveaway)
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

  // 3. Fake languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });

  // 4. Chrome runtime (missing in headless)
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      value: {
        app: { isInstalled: false, InstallState: {}, RunningState: {} },
        runtime: {
          connect: () => {},
          sendMessage: () => {},
          id: undefined,
        },
        loadTimes: () => {},
        csi: () => {},
      },
      configurable: true,
    });
  }

  // 5. Permissions API — make geolocation appear "prompt" not "denied"
  if (navigator.permissions) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: 'denied', onchange: null });
      }
      return origQuery(params);
    };
  }

  // 6. Hide automation-specific properties
  ['__webdriver_script_fn', '__driver_evaluate', '__webdriver_evaluate',
   '__selenium_evaluate', '__fxdriver_evaluate', '__driver_unwrapped',
   '__webdriver_unwrapped', '__selenium_unwrapped', '__fxdriver_unwrapped',
   '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium',
   '$cdc_asdjflasutopfhvcZLmcfl_', 'document.$cdc_asdjflasutopfhvcZLmcfl_',
   '__$webdriverAsyncExecutor', '__lastWatirAlert', '__lastWatirConfirm',
   '__lastWatirPrompt', '_WEBDRIVER_CLIENT_', '__webdriver_script_func',
  ].forEach(prop => {
    try { delete window[prop]; } catch {}
  });

  // 7. WebGL vendor/renderer spoofing
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
  | 'cloudflare-turnstile'   // CF Turnstile widget
  | 'cloudflare-challenge'   // CF "Just a moment..." JS challenge page
  | 'arkose-funcaptcha'      // Arkose / FunCaptcha (X.com login)
  | 'recaptcha'              // reCAPTCHA v2/v3
  | 'hcaptcha'               // hCaptcha
  | 'login-wall'             // Redirected to x.com/login
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

          // Cloudflare "Just a moment..." interstitial
          if (title.includes('Just a moment') || body.includes('Checking your browser')) {
            return 'cloudflare-challenge';
          }

          // Cloudflare Turnstile widget
          if (document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
              document.querySelector('[class*="cf-turnstile"]') ||
              document.querySelector('input[name="cf-turnstile-response"]')) {
            return 'cloudflare-turnstile';
          }

          // Arkose FunCaptcha (used by X.com login)
          if (document.querySelector('iframe[src*="arkoselabs.com"]') ||
              document.querySelector('iframe[src*="funcaptcha.com"]') ||
              document.querySelector('#FunCaptcha') ||
              document.querySelector('[id*="arkose"]') ||
              document.querySelector('input[name="fc-token"]')) {
            return 'arkose-funcaptcha';
          }

          // reCAPTCHA
          if (document.querySelector('iframe[src*="recaptcha"]') ||
              document.querySelector('.g-recaptcha') ||
              document.querySelector('[data-sitekey]')) {
            return 'recaptcha';
          }

          // hCaptcha
          if (document.querySelector('iframe[src*="hcaptcha.com"]') ||
              document.querySelector('.h-captcha')) {
            return 'hcaptcha';
          }

          // Redirected to login page
          if (url.includes('x.com/login') || url.includes('twitter.com/login') ||
              url.includes('/i/flow/login') || url.includes('grok.com/login')) {
            return 'login-wall';
          }

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

/**
 * Handle any challenge that appears.
 *
 * Strategy:
 * - cloudflare-challenge: wait up to 30s for CF to auto-pass (works in non-headless + stealth)
 * - cloudflare-turnstile: same — Turnstile often passes automatically with a real browser
 * - arkose-funcaptcha / recaptcha / hcaptcha: pause, print instructions, wait for user
 * - login-wall: tell user to provide cookies or use --manual-login
 */
async function handleChallenge(
  client: CDPClient,
  kind: ChallengeKind,
  opts: GrokOptions,
  log: (msg: string) => void,
): Promise<void> {
  if (kind === 'none') return;

  const { Runtime, Page } = client;

  switch (kind) {
    case 'cloudflare-challenge':
    case 'cloudflare-turnstile': {
      log(`[captcha] Cloudflare challenge detected (${kind})`);
      if (opts.headless) {
        console.warn(
          '\n  ⚠  Cloudflare challenge detected in headless mode.\n' +
          '     Headless browsers are often blocked by Cloudflare.\n' +
          '     Restart without --headless to let Chrome solve it automatically.\n'
        );
      } else {
        log('[captcha] Waiting up to 30s for Cloudflare to auto-pass...');
      }

      // Wait for challenge to resolve (URL changes away from challenge page)
      const resolved = await waitForChallengeGone(client, kind, 30_000);
      if (resolved) {
        log('[captcha] Cloudflare challenge passed ✓');
      } else {
        // Non-headless: pause and let user handle it
        console.log(
          '\n  ⏸  Cloudflare challenge did not auto-pass.\n' +
          '     Please solve it in the browser window, then press Enter here.\n'
        );
        await promptUser('  Press Enter after the challenge is solved: ');
        log('[captcha] Continuing after user confirmation');
      }
      break;
    }

    case 'arkose-funcaptcha': {
      console.log(
        '\n  ⏸  Arkose FunCaptcha detected (X.com security challenge)\n' +
        '     This requires human interaction.\n\n' +
        '     1. Look at the browser window\n' +
        '     2. Solve the image puzzle\n' +
        '     3. Press Enter here once done\n'
      );
      await promptUser('  Press Enter after solving the captcha: ');
      // Give the page a moment to process the solution
      await sleep(2000);
      log('[captcha] Continuing after Arkose FunCaptcha');
      break;
    }

    case 'recaptcha':
    case 'hcaptcha': {
      console.log(
        `\n  ⏸  ${kind === 'recaptcha' ? 'reCAPTCHA' : 'hCaptcha'} detected.\n` +
        '     Please solve it in the browser window, then press Enter here.\n'
      );
      await promptUser('  Press Enter after solving the captcha: ');
      await sleep(1500);
      log('[captcha] Continuing after captcha solve');
      break;
    }

    case 'login-wall': {
      console.log(
        '\n  ✗  Redirected to login page.\n\n' +
        '     Your session cookies are missing or expired.\n\n' +
        '     Options:\n' +
        '       1. Run: grok cookies   — check what cookies were found\n' +
        '       2. Export cookies from Chrome → ~/.grok/cookies.json\n' +
        '       3. Use --manual-login to log in via the browser\n' +
        '       4. Use --inline-cookies-file path/to/cookies.json\n'
      );
      throw new Error('Redirected to login page — cookies missing or expired');
    }
  }
}

/**
 * Wait for the challenge page to go away (URL changes or CF elements disappear).
 */
async function waitForChallengeGone(
  client: CDPClient,
  kind: ChallengeKind,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const current = await detectChallenge(client);
    if (current === 'none' || current !== kind) return true;
  }
  return false;
}

/**
 * After navigation, run the challenge detection loop.
 * Keeps checking for up to `timeoutMs` in case a challenge appears mid-session.
 */
async function checkAndHandleChallenges(
  client: CDPClient,
  opts: GrokOptions,
  log: (msg: string) => void,
  maxRounds = 3,
): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const kind = await detectChallenge(client);
    if (kind === 'none') return;
    await handleChallenge(client, kind, opts, log);
    await sleep(1000);
    // After handling, re-check in case another challenge appeared
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
    // Basic
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',

    // Anti-detection: avoid headless/automation-specific flags
    '--disable-blink-features=AutomationControlled',

    // Performance / stability
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-ipc-flooding-protection',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
    '--disable-sync',

    // Avoid extension detection
    '--disable-extensions',

    // Window size (needed for non-headless to avoid detection of tiny window)
    '--window-size=1280,800',
    '--start-maximized',
  ];

  if (opts.profileDir) {
    flags.push(`--user-data-dir=${opts.profileDir}`);
  }

  if (opts.headless) {
    // Use new headless — slightly less detectable than old --headless
    flags.push('--headless=new');
    // In headless, these help avoid some fingerprint checks
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
  // Support [ipv6]:port format
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
          // Not on login page
          if (url.includes('/login') || url.includes('/i/flow/login')) return false;
          // On grok.com without login redirect
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

// ─── Grok.com UI automation ───────────────────────────────────────────────────

/**
 * Selectors tried in priority order.
 * Update these if grok.com changes its DOM.
 */
const TEXTAREA_SELECTORS = [
  // Grok-specific
  'textarea[data-testid="grok-compose-input"]',
  'div[data-testid="grok-compose-input"]',
  // Common patterns
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Message"]',
  'textarea[placeholder*="Type"]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
  // Fallbacks
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

const RESPONSE_SELECTORS = [
  // Grok-specific (inspect và update nếu DOM thay đổi)
  '[data-testid="grok-response-content"]',
  '[data-testid="responseText"]',
  '[data-testid="response-content"]',
  '[data-testid="message-content"]',
  '[data-testid="assistant-message"]',
  // Generic message containers
  '[data-message-role="assistant"]',
  '[data-role="assistant"]',
  '.response-content',
  '.message-content',
  // Article-based layouts
  'article[data-testid*="response"]',
  'article[data-testid*="message"]',
  '[role="article"]',
  // Common AI chat patterns
  '.prose',
  '.markdown-body',
  '[class*="message"][class*="assistant"]',
  '[class*="response"][class*="content"]',
  '[class*="assistant"][class*="message"]',
];

// Selectors indicating Grok is still generating
const LOADING_SELECTORS = [
  '[data-testid="grok-streaming-indicator"]',
  '[data-testid="loading"]',
  '[data-testid*="loading"]',
  '[data-testid*="thinking"]',
  '[data-testid*="generating"]',
  '[aria-label*="Loading"]',
  '[aria-label*="Generating"]',
  '[aria-label*="Thinking"]',
  '[aria-label*="Stop"]',          // "Stop generating" button
  'button[aria-label*="Stop"]',
  'svg[class*="animate-spin"]',
  'svg[class*="spinner"]',
  '.loading-indicator',
  '[class*="streaming"]',
  '[class*="thinking"]',
  '[class*="generating"]',
];

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

async function pasteText(
  client: CDPClient,
  selector: string,
  text: string,
  verbose?: boolean,
): Promise<void> {
  const { Runtime } = client;

  await Runtime.evaluate({
    expression: `document.querySelector(${JSON.stringify(selector)})?.focus()`,
  });
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

async function clickElement(client: CDPClient, selector: string): Promise<void> {
  const { Runtime } = client;
  await Runtime.evaluate({
    expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
  });
}

async function captureResponse(
  client: CDPClient,
  timeoutMs: number,
  verbose?: boolean,
): Promise<string> {
  const { Runtime } = client;
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stableCount = 0;
  const STABLE_NEEDED = 6; // 6 × 500ms = 3s stable = done

  if (verbose) console.log('[browser] Polling for response...');

  // Track which selector matched — for debug
  let matchedSelector = '';

  while (Date.now() < deadline) {
    try {
      // ── Strategy 1: specific selectors ──────────────────────────────────
      const result = await Runtime.evaluate({
        expression: `
          (function() {
            // Try known selectors first
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

            // ── Strategy 2: find biggest text block that appeared after send ──
            // Look for any element with significant text that is NOT the input area
            const allDivs = document.querySelectorAll('div, section, main');
            let best = { text: '', sel: '', len: 0 };
            for (const el of allDivs) {
              // Skip input areas
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

      // ── Check loading state ──────────────────────────────────────────────
      const loadResult = await Runtime.evaluate({
        expression: `
          (function() {
            // Check known loading selectors
            const loadSels = ${JSON.stringify(LOADING_SELECTORS)};
            if (loadSels.some(s => { try { return document.querySelector(s) !== null; } catch { return false; } })) {
              return true;
            }
            // Check if submit/send button is disabled (= still generating)
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

      // Progress log
      if (verbose && currentText.length > 0 && currentText.length !== lastText.length) {
        process.stdout.write(`\r[browser] ${currentText.length} chars received...`);
      }

      if (currentText.length > 20) {
        if (currentText === lastText && !isLoading) {
          stableCount++;
          if (verbose) process.stdout.write(`\r[browser] Stable ${stableCount}/${STABLE_NEEDED}...`);
          if (stableCount >= STABLE_NEEDED) {
            if (verbose) console.log(`\n[browser] Response complete (${currentText.length} chars)`);
            return currentText;
          }
        } else {
          stableCount = 0;
          lastText = currentText;
        }
      } else if (currentText.length === 0 && lastText.length === 0) {
        // Nothing yet — check for mid-session captcha
        const midChallenge = await detectChallenge(client);
        if (midChallenge !== 'none') {
          console.log(`\n  ⏸  Challenge appeared: ${midChallenge}`);
          await promptUser('  Press Enter after solving: ');
          await sleep(2000);
        }

        // Dump DOM hint every 10s in verbose mode to help debug selector issues
        if (verbose) {
          const elapsed = timeoutMs - (deadline - Date.now());
          if (elapsed > 0 && Math.round(elapsed / 1000) % 10 === 0) {
            const domHint = await Runtime.evaluate({
              expression: `
                (function() {
                  // Return a summary of notable elements to help debug
                  const result = [];
                  const interesting = document.querySelectorAll('[class*="message"],[class*="response"],[class*="chat"],[class*="answer"],[role="article"],[role="main"],article,main');
                  for (const el of interesting) {
                    const text = (el.innerText || '').trim().slice(0, 60);
                    if (text.length > 5) {
                      result.push(el.tagName + '[' + (el.getAttribute('class') || '').slice(0,50) + '] = "' + text + '"');
                    }
                  }
                  return result.slice(0, 8).join('\\n');
                })()
              `,
              returnByValue: true,
            });
            if (domHint.result?.value) {
              console.log('\n[browser] DOM hint:\n' + domHint.result.value);
            }
          }
        }
      }
    } catch (err) {
      if (verbose) console.warn(`\n[browser] Poll error: ${(err as Error).message}`);
    }

    await sleep(500);
  }

  if (lastText) {
    console.warn('\n[browser] Timed out — returning partial response');
    return lastText;
  }

  // Last resort: dump DOM for debugging
  try {
    const dump = await Runtime.evaluate({
      expression: `document.body?.innerText?.slice(0, 2000) ?? ''`,
      returnByValue: true,
    });
    const bodyText = (dump.result?.value as string) ?? '';
    if (bodyText.length > 100) {
      console.warn('[browser] No response captured. Page body preview:');
      console.warn(bodyText.slice(0, 500));
    }
  } catch { /* ignore */ }

  throw new Error(
    `Response capture timed out after ${timeoutMs}ms.\n` +
    `  Tip: run with -v (--verbose) to see DOM hints and matched selectors.\n` +
    `  Or file a bug at https://github.com/Fon-1/grok-cli/issues`
  );
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
    // Runs before any page scripts — removes webdriver/automation fingerprints
    await Page.addScriptToEvaluateOnNewDocument({ source: STEALTH_SCRIPT });
    log('[browser] Stealth patches injected');

    // ── 3. Resolve and set cookies ─────────────────────────────────────────
    const cookies = await resolveCookies(opts, log);
    if (cookies.length > 0) {
      await setCookies(client, cookies, opts.verbose);
    }

    // ── 4. Navigate to grok.com ────────────────────────────────────────────
    const grokUrl = opts.grokUrl || 'https://grok.com';
    log(`[browser] Navigating to ${grokUrl}`);
    await Page.navigate({ url: grokUrl });

    // Use networkIdle instead of just loadEvent for better hydration detection
    try {
      await Promise.race([
        Page.loadEventFired(),
        sleep(15_000),
      ]);
    } catch { /* ignore */ }
    await sleep(2500);

    // ── 5. Handle any initial challenges ──────────────────────────────────
    log('[browser] Checking for challenges...');
    await checkAndHandleChallenges(client, opts, log);
    await sleep(1000);

    // ── 6. Manual login wait ───────────────────────────────────────────────
    if (opts.manualLogin) {
      console.log(
        '\n  ⏸  Manual login mode\n' +
        '     Please sign in to grok.com in the browser window.\n' +
        '     Waiting...\n'
      );
      await waitFor(
        async () => {
          // Check for challenges first, handle them
          const ch = await detectChallenge(client);
          if (ch !== 'none') await handleChallenge(client, ch, opts, log);
          const authed = await verifyGrokAuth(client, opts.verbose);
          return authed ? true : null;
        },
        opts.browserTimeout,
        3000,
      );
      log('[browser] Authenticated ✓');
    } else {
      const authed = await verifyGrokAuth(client, opts.verbose);
      if (!authed) {
        log('[browser] Warning: auth not confirmed — proceeding (may fail if not logged in)');
      } else {
        log('[browser] Authenticated ✓');
      }
    }

    // ── 7. Find textarea ───────────────────────────────────────────────────
    log('[browser] Looking for input area...');
    let textareaSel: string;
    try {
      textareaSel = await waitFor(
        () => findElement(client, TEXTAREA_SELECTORS),
        30_000,
        1000,
      );
    } catch {
      // One more challenge check in case CF appeared after nav
      await checkAndHandleChallenges(client, opts, log);
      textareaSel = await waitFor(
        () => findElement(client, TEXTAREA_SELECTORS),
        15_000,
        1000,
      );
    }
    log(`[browser] Found input: ${textareaSel}`);

    // ── 8. Paste bundle ────────────────────────────────────────────────────
    log(`[browser] Pasting bundle (${bundleText.length.toLocaleString()} chars)...`);
    await pasteText(client, textareaSel, bundleText, opts.verbose);

    // ── 9. Submit ──────────────────────────────────────────────────────────
    log('[browser] Submitting...');
    let submitted = false;

    // Wait for an enabled submit button
    try {
      const submitSel = await waitFor(
        async () => {
          for (const sel of SUBMIT_SELECTORS) {
            const result = await Runtime.evaluate({
              expression: `
                (function() {
                  const btn = document.querySelector(${JSON.stringify(sel)});
                  return btn && !btn.disabled && !btn.getAttribute('aria-disabled') ? true : null;
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
      submitted = true;
    } catch {
      log('[browser] Submit button not found — trying Enter key');
    }

    if (!submitted) {
      // Fallback: Shift+Enter to submit (some UIs use this)
      const { Input } = client;
      await Runtime.evaluate({
        expression: `document.querySelector(${JSON.stringify(textareaSel)})?.focus()`,
      });
      await sleep(100);
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(80);
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }

    await sleep(1500);

    // ── 10. Capture response ───────────────────────────────────────────────
    log('[browser] Waiting for Grok response...');
    const answer = await captureResponse(client, opts.responseTimeout, opts.verbose);

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
  // Priority: explicit inline > inline file > auto ~/.grok/cookies.json > Chrome profile
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

  // Auto-load ~/.grok/cookies.json
  const grokHome = path.join(os.homedir(), '.grok');
  const { autoLoadCookies } = await import('./cookies.js');
  const autoCookies = autoLoadCookies(grokHome);
  if (autoCookies && autoCookies.length > 0) {
    log(`[browser] Auto-loaded ${autoCookies.length} cookies from ~/.grok/cookies.json`);
    return autoCookies;
  }

  // Try to read from Chrome profile (skip in manual-login / remote mode)
  if (!opts.manualLogin && !opts.remoteChrome) {
    const { getDefaultChromeCookiePaths, readChromeCookies } = await import('./cookies.js');
    const cookieDbPaths = opts.cookiePath
      ? [opts.cookiePath]
      : getDefaultChromeCookiePaths();

    for (const dbPath of cookieDbPaths) {
      if (!fs.existsSync(dbPath)) continue;
      try {
        // Read cookies for both grok.com and x.com (auth lives on x.com)
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
      break; // Only try the first existing path
    }
  }

  log('[browser] No cookies found — relying on browser session');
  return [];
}
