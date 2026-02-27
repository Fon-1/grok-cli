import fs from 'fs';
import chalk from 'chalk';

export function printBanner() {
  console.log(chalk.cyan.bold('\n  grok 🤖  — Ask Grok when you\'re stuck\n'));
}

export function printBundleInfo(fileCount: number, charCount: number, skipped: string[]) {
  console.log(
    chalk.dim(`  Bundle: ${fileCount} file(s), ${charCount.toLocaleString()} chars (~${Math.round(charCount / 4).toLocaleString()} tokens)`)
  );
  if (skipped.length > 0) {
    console.log(chalk.yellow(`  Skipped ${skipped.length} file(s):`));
    for (const s of skipped) {
      console.log(chalk.yellow(`    - ${s}`));
    }
  }
}

export function printAnswer(answer: string) {
  console.log('\n' + chalk.green.bold('─── Grok Response ───────────────────────────────\n'));
  console.log(answer);
  console.log('\n' + chalk.green.bold('─────────────────────────────────────────────────\n'));
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const { default: clipboardy } = await import('clipboardy');
    await clipboardy.write(text);
    return true;
  } catch {
    return false;
  }
}

export function writeOutputFile(filePath: string, text: string) {
  fs.writeFileSync(filePath, text, 'utf-8');
  console.log(chalk.dim(`  Output written to: ${filePath}`));
}

export function printSessionList(sessions: import('./types.js').SessionMeta[]) {
  if (sessions.length === 0) {
    console.log(chalk.dim('  No recent sessions.'));
    return;
  }

  console.log(chalk.bold('\n  Recent Sessions\n'));
  for (const s of sessions) {
    const status = {
      completed: chalk.green('✓'),
      running:   chalk.yellow('⟳'),
      failed:    chalk.red('✗'),
      timeout:   chalk.red('⏱'),
    }[s.status] ?? '?';

    const date = new Date(s.createdAt).toLocaleString();
    const dur = s.durationMs ? ` ${(s.durationMs / 1000).toFixed(1)}s` : '';
    const files = s.files.length > 0 ? ` [${s.files.length} file(s)]` : '';

    console.log(`  ${status} ${chalk.cyan(s.id)}  ${chalk.dim(date)}${chalk.dim(dur)}${chalk.dim(files)}`);
    console.log(`    ${chalk.white(s.prompt.slice(0, 80))}${s.prompt.length > 80 ? chalk.dim('…') : ''}`);
    if (s.status === 'failed' && s.errorMessage) {
      console.log(`    ${chalk.red(s.errorMessage)}`);
    }
    console.log();
  }
}

export function printSessionDetail(session: import('./types.js').SessionMeta) {
  console.log(chalk.bold(`\n  Session: ${session.id}`));
  console.log(chalk.dim(`  Created: ${new Date(session.createdAt).toLocaleString()}`));
  console.log(chalk.dim(`  Status:  ${session.status}`));
  if (session.durationMs) console.log(chalk.dim(`  Duration: ${(session.durationMs / 1000).toFixed(1)}s`));
  console.log(chalk.dim(`  Files: ${session.files.join(', ') || 'none'}`));
  console.log();
  console.log(chalk.bold('  Prompt:'));
  console.log('  ' + session.prompt.split('\n').join('\n  '));
  if (session.answer) {
    console.log();
    printAnswer(session.answer);
  }
}
