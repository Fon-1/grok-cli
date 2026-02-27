# grok-cli 🤖

Ask Grok when you're stuck. Bundle your prompt + files and send to [grok.com](https://grok.com) via Chrome browser automation — **no API key required**.

Inspired by [oracle](https://github.com/steipete/oracle) (for ChatGPT), this is the Grok equivalent.

---

## How it works

1. Resolves file globs → reads content → builds a markdown bundle
2. Launches Chrome (or attaches to an existing instance)
3. Sets cookies from your Chrome profile / `~/.grok/cookies.json`
4. Navigates to `grok.com`, pastes the bundle, submits
5. Waits for the response and captures it
6. Saves session to `~/.grok/sessions/`

---

## Quick Start

```bash
# Install
npm install -g grok-cli
# or
npx grok-cli -p "explain this code" --file src/app.ts

# Check your setup
grok init

# Ask with files
grok -p "review this PR for bugs" --file "src/**/*.ts" --file "!src/**/*.test.ts"

# Dry-run: build bundle and copy to clipboard (paste into grok.com manually)
grok -p "refactor this" --file src/utils.ts --dry-run --copy

# Manual login (opens browser, wait for login, then sends)
grok -p "explain the auth flow" --file src/auth.ts --manual-login

# Headless (no visible window)
grok -p "fix the types" --file src/types.ts --headless
```

Requires **Node 20+** and **Google Chrome**.

---

## Authentication Options

### Option 1 — Auto (Chrome profile, recommended)

If you're already logged in to `grok.com` in Chrome, grok-cli reads your cookies automatically:

```bash
grok -p "your question" --file src/app.ts
```

Check if this works:
```bash
grok cookies
```

### Option 2 — `~/.grok/cookies.json`

Export your `grok.com` cookies as a `CookieParam[]` JSON array and save to `~/.grok/cookies.json`:

```json
[
  { "name": "auth_token", "value": "YOUR_TOKEN", "domain": "grok.com", "path": "/", "secure": true, "httpOnly": true },
  { "name": "ct0", "value": "YOUR_CT0", "domain": "grok.com", "path": "/" }
]
```

Then just run:
```bash
grok -p "explain this"
```

Or specify inline:
```bash
grok -p "explain this" --inline-cookies-file ~/my-cookies.json
```

### Option 3 — Manual login

Opens a persistent browser profile. Log in once, reuse forever:

```bash
grok -p "explain this" --manual-login --keep-browser
# First run: log in to grok.com
# Subsequent runs: reuses the profile at ~/.grok/browser-profile
```

### Option 4 — Remote Chrome

Attach to an already-running Chrome with remote debugging:

```bash
# Start Chrome with CDP
google-chrome --remote-debugging-port=9222

# Use it
grok -p "explain this" --remote-chrome localhost:9222
```

---

## Commands

### `grok` (default — ask a question)

```
Options:
  -p, --prompt <text>              Prompt / question (required, or pipe via stdin)
  -f, --file <patterns...>         Files/globs (prefix ! to exclude)
  -m, --model <name>               Grok model [default: grok-3]
  --copy                           Copy bundle to clipboard without browser
  --render                         Print bundle to stdout
  --dry-run                        Preview bundle, don't open browser
  --keep-browser                   Keep Chrome open after run
  --headless                       Run Chrome headless
  --chrome-path <path>             Path to Chrome binary
  --chrome-profile <dir>           Chrome user-data-dir
  --cookie-path <path>             Explicit Cookies SQLite DB path
  --inline-cookies <json>          Inline CookieParam[] JSON or base64
  --inline-cookies-file <path>     Load cookies from JSON file
  --grok-url <url>                 Target URL [default: https://grok.com]
  --browser-timeout <ms>           Overall timeout [default: 120000]
  --response-timeout <ms>          Response capture timeout [default: 300000]
  --manual-login                   Wait for manual login in browser
  --remote-chrome <host:port>      Attach to existing Chrome CDP
  --write-output <path>            Write response to file
  -v, --verbose                    Verbose logging
```

### `grok status`

```bash
grok status              # list last 72h of sessions
grok status --hours 24   # last 24h
grok status --clear      # delete old sessions
```

### `grok session <id>`

```bash
grok session abc123def      # show session details + response
grok session abc123def --render-bundle  # also print the bundle used
```

### `grok cookies`

```bash
grok cookies                  # check grok.com cookies in default Chrome profile
grok cookies --domain x.com   # different domain
```

### `grok init`

```bash
grok init   # setup check + quick start guide
```

---

## Examples

```bash
# Review TypeScript files
grok -p "Find potential bugs and type safety issues" \
  --file "src/**/*.ts" --file "!src/**/*.test.ts"

# Explain a specific file
grok -p "Walk me through what this component does" --file src/components/Auth.tsx

# Fix a bug (pipe error message)
echo "TypeError: Cannot read properties of undefined (reading 'map')" | \
  grok -p "Fix this error" --file src/pages/index.tsx

# Multi-file architecture question
grok -p "How does the auth flow work end to end?" \
  --file src/middleware/auth.ts \
  --file src/pages/api/login.ts \
  --file src/hooks/useAuth.ts

# Write output to file
grok -p "Generate unit tests for this" --file src/utils.ts --write-output tests/utils.test.ts
```

---

## Sessions

Sessions are stored in `~/.grok/sessions/` as JSON files.

```bash
ls ~/.grok/sessions/
grok status           # list recent sessions
grok session <id>     # view a session's response
```

Override the home dir:
```bash
GROK_HOME_DIR=/tmp/grok-test grok -p "test"
```

---

## Captcha & Bot Detection Handling

grok.com runs on X.com infrastructure which has multiple layers of bot protection:

| Challenge | What happens |
|-----------|-------------|
| **Cloudflare JS challenge** ("Just a moment...") | Tool waits up to 30s for auto-pass. With stealth patches + non-headless Chrome, this usually passes automatically. |
| **Cloudflare Turnstile** | Same — usually auto-passes in a real Chrome window. |
| **Arkose FunCaptcha** (X.com login) | Tool pauses, prints instructions, waits for you to solve it in the browser window, then continues. |
| **reCAPTCHA / hCaptcha** | Same pause-and-wait approach. |
| **Login wall** (redirected to x.com/login) | Tool exits with clear error — cookies are missing or expired. |

**Key insight: don't automate login.** X.com's login flow uses Arkose FunCaptcha + aggressive TLS/behavioral fingerprinting that's extremely hard to bypass programmatically. The right approach is to use an **already-authenticated session** (cookies from an existing Chrome session).

### Tips to avoid challenges

1. **Use non-headless mode** (default) — headless Chrome is much easier for Cloudflare to detect
2. **Keep cookies fresh** — expired `auth_token` / `ct0` triggers login redirect
3. **Use your real Chrome profile** (`--chrome-profile`) — Cloudflare trusts browsers with history
4. **Don't run too frequently** — rate limiting triggers more challenges

### If you keep hitting Cloudflare

```bash
# Use your actual Chrome profile (already has CF clearance cookies)
grok -p "your question" --chrome-profile ~/.config/google-chrome/Default

# Or: manual login mode — log in once, reuse forever
grok -p "your question" --manual-login --keep-browser
```

## Notes

- The UI automation uses DOM selectors that may need updating if grok.com changes its layout. File an issue if things break.
- **Avoid `--headless`** — Cloudflare detects headless browsers and will show challenges more often.
- On macOS, encrypted Chrome cookies are decrypted automatically via Keychain (`Chrome Safe Storage`).
- On Linux, cookies may be stored unencrypted or with GNOME Keyring / KWallet — if decryption fails, use `--inline-cookies-file` or `--manual-login`.
- On Windows, Chrome uses DPAPI app-bound encryption — use `--manual-login` or `--inline-cookies-file`.

---

## License

MIT
