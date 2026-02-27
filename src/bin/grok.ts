#!/usr/bin/env node
/**
 * grok — Ask Grok when you're stuck.
 *
 * Bundles your prompt + files and sends them to grok.com
 * via Chrome browser automation (no API key needed).
 *
 * Usage:
 *   grok -p "explain this code" --file "src/**\/*.ts"
 *   grok -p "fix the bug" --file src/app.ts --keep-browser
 *   grok status
 *   grok session <id>
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { buildBundle } from '../lib/bundler.js';
import { runGrokBrowser } from '../lib/browser.js';
import {
  generateSessionId,
  saveSession,
  saveBundleText,
  updateSession,
  loadSession,
  loadBundle,
  listSessions,
  clearSessions,
} from '../lib/sessions.js';
import {
  printBanner,
  printBundleInfo,
  printAnswer,
  printSessionList,
  printSessionDetail,
  copyToClipboard,
  writeOutputFile,
} from '../lib/output.js';
import type { GrokOptions } from '../lib/types.js';

const VERSION = '0.1.0';

// ─── Program ─────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('grok')
  .description('Ask Grok when you\'re stuck. Bundle your prompt + files → send to grok.com via browser automation.')
  .version(VERSION);

// ─── Main command (default: ask grok) ────────────────────────────────────────

program
  .option('-p, --prompt <text>', 'Prompt / question to ask Grok')
  .option('-f, --file <patterns...>', 'Files or glob patterns to include (prefix ! to exclude)')
  .option('-m, --model <name>', 'Grok model to use (e.g. grok-3, grok-3-mini)', 'grok-3')
  .option('--copy', 'Copy the assembled bundle to clipboard without opening browser')
  .option('--render', 'Print the assembled bundle to stdout')
  .option('--dry-run', 'Preview bundle without opening browser')
  .option('--keep-browser', 'Keep the browser window open after run')
  .option('--headless', 'Run Chrome in headless mode')
  .option('--chrome-path <path>', 'Path to Chrome binary')
  .option('--chrome-profile <dir>', 'Chrome user-data-dir to use for cookies/session')
  .option('--cookie-path <path>', 'Explicit path to Chrome Cookies SQLite DB')
  .option('--inline-cookies <json>', 'Inline cookies JSON array (CookieParam[]) or base64')
  .option('--inline-cookies-file <path>', 'Path to JSON file with CookieParam[]')
  .option('--grok-url <url>', 'Target URL (default: https://grok.com)', 'https://grok.com')
  .option('--browser-timeout <ms>', 'Overall browser session timeout in ms', '120000')
  .option('--response-timeout <ms>', 'Response capture timeout in ms', '300000')
  .option('--manual-login', 'Manual login mode: open browser, wait for you to sign in, then proceed')
  .option('--remote-chrome <host:port>', 'Attach to existing remote Chrome via CDP (e.g. localhost:9222)')
  .option('--write-output <path>', 'Write response to file')
  .option('-v, --verbose', 'Verbose logging')
  // ── Grok-specific modes ──────────────────────────────────────────────────
  .option('--think', 'Enable Think mode (deep reasoning before answering)')
  .option('--deep-search', 'Enable DeepSearch mode (Grok searches the web first)')
  .option('--imagine <output-file>', 'Generate image from prompt, save to file (e.g. output.png)')
  .option('--read-aloud <output-file>', 'Trigger Read Aloud, save audio URL or MP3 to file')
  .action(async (opts) => {
    // Allow prompt from stdin if not provided as argument
    let prompt: string = opts.prompt ?? '';

    if (!prompt) {
      // Check if there's piped input
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        prompt = Buffer.concat(chunks).toString('utf-8').trim();
      }
    }

    if (!prompt) {
      console.error(chalk.red('Error: --prompt (-p) is required or pipe text via stdin.'));
      console.error(chalk.dim('  Example: grok -p "explain this code" --file src/app.ts'));
      process.exit(1);
    }

    printBanner();

    const grokOpts: GrokOptions = {
      prompt,
      files: opts.file ?? [],
      model: opts.model ?? 'grok-3',
      copy: opts.copy ?? false,
      render: opts.render ?? false,
      dryRun: opts.dryRun ?? false,
      keepBrowser: opts.keepBrowser ?? false,
      headless: opts.headless ?? false,
      chromePath: opts.chromePath,
      chromeProfile: opts.chromeProfile,
      cookiePath: opts.cookiePath,
      inlineCookies: opts.inlineCookies,
      inlineCookiesFile: opts.inlineCookiesFile,
      grokUrl: opts.grokUrl ?? 'https://grok.com',
      browserTimeout: parseInt(opts.browserTimeout ?? '120000', 10),
      responseTimeout: parseInt(opts.responseTimeout ?? '300000', 10),
      manualLogin: opts.manualLogin ?? false,
      remoteChrome: opts.remoteChrome,
      writeOutput: opts.writeOutput,
      verbose: opts.verbose ?? false,
      // Grok-specific modes
      think: opts.think ?? false,
      deepSearch: opts.deepSearch ?? false,
      imagine: opts.imagine,
      readAloud: opts.readAloud,
    };

    // ── Build bundle ──────────────────────────────────────────────────────
    console.log(chalk.dim('  Building bundle...'));
    const bundle = await buildBundle(prompt, grokOpts.files, grokOpts.verbose);

    printBundleInfo(bundle.fileCount, bundle.charCount, bundle.skippedFiles);

    // ── Print active modes ────────────────────────────────────────────────
    const activeModes: string[] = [];
    if (grokOpts.think) activeModes.push('Think');
    if (grokOpts.deepSearch) activeModes.push('DeepSearch');
    if (grokOpts.imagine) activeModes.push(`Imagine → ${grokOpts.imagine}`);
    if (grokOpts.readAloud) activeModes.push(`ReadAloud → ${grokOpts.readAloud}`);
    if (activeModes.length > 0) {
      console.log(chalk.cyan(`  Modes: ${activeModes.join(', ')}`));
    }

    // ── Dry run / render / copy ───────────────────────────────────────────
    if (grokOpts.render || grokOpts.dryRun) {
      console.log('\n' + chalk.bold('─── Bundle ──────────────────────────────────────\n'));
      console.log(bundle.text);
      console.log('\n' + chalk.bold('─────────────────────────────────────────────────\n'));
    }

    if (grokOpts.copy || grokOpts.dryRun) {
      const ok = await copyToClipboard(bundle.text);
      if (ok) {
        console.log(chalk.green('  ✓ Bundle copied to clipboard — paste into grok.com'));
      } else {
        console.log(chalk.yellow('  Could not access clipboard'));
      }
    }

    if (grokOpts.dryRun) {
      console.log(chalk.dim('\n  Dry-run: skipping browser launch.'));
      return;
    }

    // ── Create session ────────────────────────────────────────────────────
    const sessionId = generateSessionId();
    const bundleFp = saveBundleText(sessionId, bundle.text);

    saveSession({
      id: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prompt,
      files: grokOpts.files,
      model: grokOpts.model,
      status: 'running',
      mode: 'browser',
      bundlePath: bundleFp,
      options: {
        grokUrl: grokOpts.grokUrl,
        model: grokOpts.model,
        keepBrowser: grokOpts.keepBrowser,
        headless: grokOpts.headless,
        manualLogin: grokOpts.manualLogin,
      },
    });

    console.log(chalk.dim(`  Session: ${sessionId}`));
    console.log();

    // ── Run browser ───────────────────────────────────────────────────────
    try {
      const result = await runGrokBrowser(bundle.text, grokOpts, (msg) => {
        if (grokOpts.verbose) return; // already printed by browser.ts
        // Show short progress lines
        if (msg.includes('Navigating') || msg.includes('Waiting') || msg.includes('Pasting') || msg.includes('Done') || msg.startsWith('Read Aloud:')) {
          console.log(chalk.dim(`  ${msg.replace(/^\[browser\] /, '').trim()}`));
        }
      });

      updateSession(sessionId, {
        status: 'completed',
        answer: result.answer,
        durationMs: result.durationMs,
      });

      printAnswer(result.answer);

      if (grokOpts.writeOutput) {
        writeOutputFile(grokOpts.writeOutput, result.answer);
      }

      if (grokOpts.copy) {
        const ok = await copyToClipboard(result.answer);
        if (ok) console.log(chalk.dim('  Answer copied to clipboard'));
      }
    } catch (err) {
      const message = (err as Error).message;
      updateSession(sessionId, {
        status: 'failed',
        errorMessage: message,
      });
      console.error(chalk.red(`\n  Error: ${message}`));
      console.error(chalk.dim(`  Session ${sessionId} saved — use 'grok session ${sessionId}' to review`));
      process.exit(1);
    }
  });

// ─── status command ───────────────────────────────────────────────────────────

program
  .command('status')
  .description('List recent sessions')
  .option('--hours <n>', 'Look back N hours', '72')
  .option('--clear', 'Clear sessions older than --hours')
  .action((opts) => {
    const hours = parseInt(opts.hours, 10);
    if (opts.clear) {
      const n = clearSessions(hours);
      console.log(chalk.dim(`  Cleared ${n} session file(s) older than ${hours}h`));
      return;
    }
    const sessions = listSessions(hours);
    printSessionList(sessions);
  });

// ─── session command ──────────────────────────────────────────────────────────

program
  .command('session <id>')
  .description('Show details and response for a session')
  .option('--render-bundle', 'Print the full bundle used for this session')
  .action((id, opts) => {
    const session = loadSession(id);
    if (!session) {
      console.error(chalk.red(`  Session not found: ${id}`));
      process.exit(1);
    }
    printSessionDetail(session);
    if (opts.renderBundle) {
      const text = loadBundle(id);
      if (text) {
        console.log(chalk.bold('\n─── Bundle ──────────────────────────────────────\n'));
        console.log(text);
      } else {
        console.log(chalk.dim('  Bundle file not found.'));
      }
    }
  });

// ─── cookies command ──────────────────────────────────────────────────────────

program
  .command('cookies')
  .description('Test cookie reading from your Chrome profile')
  .option('--domain <domain>', 'Domain to check', 'grok.com')
  .option('--cookie-path <path>', 'Explicit path to Chrome Cookies SQLite DB')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (opts) => {
    const { getDefaultChromeCookiePaths, readChromeCookies } = await import('../lib/cookies.js');

    const cookiePaths: string[] = opts.cookiePath
      ? [opts.cookiePath]
      : getDefaultChromeCookiePaths();

    console.log(chalk.dim(`\n  Looking for cookies for domain: ${opts.domain}`));
    console.log(chalk.dim(`  Checking ${cookiePaths.length} profile location(s)...\n`));

    let found = false;
    for (const p of cookiePaths) {
      const { default: fs2 } = await import('fs');
      if (!fs2.existsSync(p)) {
        console.log(chalk.dim(`  ✗ ${p}`));
        continue;
      }
      console.log(chalk.dim(`  ✓ Found: ${p}`));
      const cookies = await readChromeCookies(p, opts.domain, opts.verbose);
      if (cookies && cookies.length > 0) {
        found = true;
        console.log(chalk.green(`    → ${cookies.length} cookies for ${opts.domain}:`));
        for (const c of cookies) {
          console.log(chalk.dim(`      ${c.name} (${c.domain})`));
        }
      } else {
        console.log(chalk.yellow(`    → No cookies found (may be encrypted or not logged in)`));
      }
    }

    if (!found) {
      console.log(chalk.yellow('\n  No cookies found. Options:'));
      console.log(chalk.dim('    1. Log in to grok.com in Chrome first'));
      console.log(chalk.dim('    2. Export cookies to ~/.grok/cookies.json (CookieParam[] format)'));
      console.log(chalk.dim('    3. Use --manual-login to log in via the automation browser'));
    }
  });

// ─── init command (setup wizard) ─────────────────────────────────────────────

program
  .command('init')
  .description('Quick setup: check Chrome, cookies, and create ~/.grok config')
  .action(async () => {
    printBanner();
    console.log(chalk.bold('  Setup Check\n'));

    // Check Chrome
    const { getDefaultChromeCookiePaths } = await import('../lib/cookies.js');
    const { default: fs2 } = await import('fs');
    const paths = getDefaultChromeCookiePaths();
    const foundProfiles = paths.filter(p => fs2.existsSync(p));

    if (foundProfiles.length > 0) {
      console.log(chalk.green(`  ✓ Chrome profile found: ${foundProfiles[0]}`));
    } else {
      console.log(chalk.yellow('  ✗ No Chrome profile found'));
      console.log(chalk.dim('    Install Chrome and log in to grok.com'));
    }

    // Check ~/.grok dir
    const { getGrokHomeDir } = await import('../lib/sessions.js');
    const homeDir = getGrokHomeDir();
    if (!fs2.existsSync(homeDir)) {
      fs2.mkdirSync(homeDir, { recursive: true });
      console.log(chalk.green(`  ✓ Created ${homeDir}`));
    } else {
      console.log(chalk.green(`  ✓ ${homeDir} exists`));
    }

    // Check cookies.json
    const cookiesPath = path.join(homeDir, 'cookies.json');
    if (fs2.existsSync(cookiesPath)) {
      console.log(chalk.green(`  ✓ ${cookiesPath} exists`));
    } else {
      console.log(chalk.dim(`  ℹ  No ${cookiesPath} — optional: export cookies here for inline mode`));
    }

    console.log(chalk.bold('\n  Quick Start\n'));
    console.log(chalk.dim('  Option 1 — Use existing Chrome session (auto-copy cookies):'));
    console.log('    grok -p "explain this function" --file src/app.ts\n');
    console.log(chalk.dim('  Option 2 — Manual login (persistent browser profile):'));
    console.log('    grok -p "explain this function" --manual-login --file src/app.ts\n');
    console.log(chalk.dim('  Option 3 — Export cookies to ~/.grok/cookies.json then:'));
    console.log('    grok -p "explain this function" --file src/app.ts\n');
    console.log(chalk.dim('  Option 4 — Dry run (copy bundle to paste manually):'));
    console.log('    grok -p "explain this function" --file src/app.ts --dry-run --copy\n');
  });

program.parse(process.argv);
