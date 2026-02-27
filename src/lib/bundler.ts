import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import type { BundleResult } from './types.js';

const MAX_FILE_BYTES = 1_000_000; // 1MB per file
const MAX_TOTAL_CHARS = 200_000;  // ~50k tokens rough limit

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    md: 'markdown',
    json: 'json', json5: 'json5',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml',
    xml: 'xml', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    sql: 'sql',
    graphql: 'graphql', gql: 'graphql',
    dockerfile: 'dockerfile',
    env: 'bash',
    txt: 'text',
  };
  // Check filename directly (e.g. Dockerfile)
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  return langMap[ext] || ext || 'text';
}

export async function resolveFiles(patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];

  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];

  for (const p of patterns) {
    if (p.startsWith('!')) {
      excludePatterns.push(p.slice(1));
    } else {
      // If it's a directory, add **/* glob
      try {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          includePatterns.push(`${p}/**/*`);
        } else {
          includePatterns.push(p);
        }
      } catch {
        // Treat as glob pattern
        includePatterns.push(p);
      }
    }
  }

  if (includePatterns.length === 0) return [];

  const files = await fg(includePatterns, {
    ignore: excludePatterns,
    dot: false,
    onlyFiles: true,
    absolute: false,
    followSymbolicLinks: false,
  });

  return files.sort();
}

export async function buildBundle(
  prompt: string,
  filePaths: string[],
  verbose = false,
): Promise<BundleResult> {
  const resolvedFiles = await resolveFiles(filePaths);
  const skippedFiles: string[] = [];
  const sections: string[] = [];
  let totalChars = 0;

  // Add system preamble
  const preamble = [
    'You are Grok, a highly capable AI assistant by xAI.',
    'Below is context from the user\'s files followed by their question.',
    'Use all provided context to give a thorough, accurate answer.',
  ].join(' ');

  sections.push(`<system>\n${preamble}\n</system>`);

  // Add files
  if (resolvedFiles.length > 0) {
    const fileSections: string[] = [];

    for (const filePath of resolvedFiles) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_BYTES) {
          skippedFiles.push(`${filePath} (too large: ${formatFileSize(stat.size)})`);
          if (verbose) console.warn(`[bundler] Skipping ${filePath}: ${formatFileSize(stat.size)} exceeds limit`);
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        if (totalChars + content.length > MAX_TOTAL_CHARS) {
          skippedFiles.push(`${filePath} (total char limit reached)`);
          if (verbose) console.warn(`[bundler] Skipping ${filePath}: total char limit reached`);
          continue;
        }

        const lang = detectLanguage(filePath);
        const section = `### ${filePath}\n\`\`\`${lang}\n${content}\n\`\`\``;
        fileSections.push(section);
        totalChars += content.length;

        if (verbose) console.log(`[bundler] Added ${filePath} (${formatFileSize(stat.size)})`);
      } catch (err) {
        skippedFiles.push(`${filePath} (read error: ${(err as Error).message})`);
      }
    }

    if (fileSections.length > 0) {
      sections.push(`<files>\n${fileSections.join('\n\n')}\n</files>`);
    }
  }

  // Add user prompt
  sections.push(`<question>\n${prompt}\n</question>`);

  const text = sections.join('\n\n');

  return {
    text,
    fileCount: resolvedFiles.length - skippedFiles.length,
    charCount: text.length,
    skippedFiles,
  };
}
