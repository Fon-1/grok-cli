export interface GrokOptions {
  prompt: string;
  files: string[];
  model: string;
  /** Copy assembled bundle to clipboard instead of sending */
  copy: boolean;
  /** Print assembled bundle to stdout */
  render: boolean;
  /** Dry-run: print bundle but don't open browser */
  dryRun: boolean;
  /** Keep browser open after run */
  keepBrowser: boolean;
  /** Run browser in headless mode */
  headless: boolean;
  /** Path to Chrome binary */
  chromePath?: string;
  /** Chrome user-data-dir to use (for cookie/session reuse) */
  chromeProfile?: string;
  /** Explicit path to Chrome Cookies SQLite DB */
  cookiePath?: string;
  /** Inline cookies JSON (array of CookieParam) or base64 */
  inlineCookies?: string;
  /** Path to JSON file with CookieParam[] */
  inlineCookiesFile?: string;
  /** Target grok.com URL (default: https://grok.com) */
  grokUrl: string;
  /** Timeout in ms for the overall browser session */
  browserTimeout: number;
  /** Timeout in ms waiting for response to complete */
  responseTimeout: number;
  /** Whether to use manual login mode (persistent profile) */
  manualLogin: boolean;
  /** Remote Chrome CDP address host:port */
  remoteChrome?: string;
  /** Write output to file */
  writeOutput?: string;
  /** Verbose logging */
  verbose: boolean;

  // ── Grok-specific modes ──────────────────────────────────────────────────
  /** Enable Think mode (deep reasoning) */
  think: boolean;
  /** Enable DeepSearch mode (web search before answering) */
  deepSearch: boolean;
  /** Generate image from prompt — saves to this file path (PNG/JPG) */
  imagine?: string;
  /** Trigger Read Aloud and save audio URL or MP3 to this path */
  readAloud?: string;
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  files: string[];
  model: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  mode: 'browser';
  answer?: string;
  errorMessage?: string;
  durationMs?: number;
  bundlePath?: string;
  options: Partial<GrokOptions>;
}

export interface BundleResult {
  text: string;
  fileCount: number;
  charCount: number;
  skippedFiles: string[];
}

export interface CookieParam {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
  url?: string;
}
