# grok-cli 🤖

Ask Grok when you're stuck. Bundle your prompt + files and send to [grok.com](https://grok.com) via Chrome browser automation — **no API key required**.

Inspired by [oracle](https://github.com/steipete/oracle) (for ChatGPT), this is the Grok equivalent.

---

## Mục lục

- [Cách hoạt động](#cách-hoạt-động)
- [Cài đặt](#cài-đặt)
- [Bước 1 — Mở Chrome debug](#bước-1--mở-chrome-debug)
- [Bước 2 — Đăng nhập Grok](#bước-2--đăng-nhập-grok)
- [Bước 3 — Chạy lệnh](#bước-3--chạy-lệnh)
- [Hỏi câu đơn giản](#hỏi-câu-đơn-giản)
- [Đính kèm file](#đính-kèm-file)
- [Các mode đặc biệt](#các-mode-đặc-biệt)
- [Lưu kết quả](#lưu-kết-quả)
- [Dry-run và Copy](#dry-run-và-copy)
- [Quản lý session](#quản-lý-session)
- [Xác thực (Authentication)](#xác-thực-authentication)
- [Captcha & Bot Detection](#captcha--bot-detection)
- [Tất cả flags](#tất-cả-flags)
- [Troubleshooting](#troubleshooting)

---

## Cách hoạt động

```
Prompt + Files
     │
     ▼
Bundle builder        ← Đọc files, build markdown context
     │
     ▼
Chrome (CDP)          ← Attach vào Chrome đang chạy (hoặc launch mới)
     │
     ▼
grok.com              ← Paste bundle vào textarea, submit
     │
     ▼
Response capture      ← Poll DOM cho đến khi response ổn định
     │
     ▼
Session saved         ← Lưu vào ~/.grok/sessions/
```

---

## Cài đặt

**Yêu cầu:** Node.js 20+, Google Chrome

```bash
git clone https://github.com/Fon-1/grok-cli.git
cd grok-cli
npm install
npm run build
```

> **Windows:** Dùng `.\grok.ps1` thay vì `grok` để tránh conflict với tool khác.  
> **macOS/Linux:** Chạy `npm link` để dùng lệnh `grok` toàn cục.

---

## Bước 1 — Mở Chrome debug

Trước khi chạy bất kỳ lệnh nào cần browser, phải mở Chrome với remote debugging:

### Windows

```powershell
.\start-chrome-debug.ps1
```

Script sẽ:
1. Tìm Chrome trên máy
2. Mở Chrome với `--remote-debugging-port=9222`
3. Đợi đến khi port LISTENING
4. Báo "Chrome debug sẵn sàng ✓"

### macOS / Linux

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.grok/browser-profile" \
  https://grok.com

# Linux
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.grok/browser-profile" \
  https://grok.com
```

### Kiểm tra port đã mở chưa

```powershell
# Windows
netstat -ano | findstr :9222
# Phải thấy dòng LISTENING

# macOS/Linux
lsof -i :9222
```

---

## Bước 2 — Đăng nhập Grok

Sau khi Chrome mở, vào cửa sổ Chrome và đăng nhập vào [grok.com](https://grok.com) bằng tài khoản X (Twitter) của bạn. Chỉ cần đăng nhập **1 lần** — các lần sau Chrome nhớ session.

---

## Bước 3 — Chạy lệnh

---

## Hỏi câu đơn giản

Câu hỏi không cần file đính kèm:

```powershell
# Windows
.\grok.ps1 -p "Explain what is a closure in JavaScript" --remote-chrome 127.0.0.1:9222

# macOS/Linux
grok -p "Explain what is a closure in JavaScript" --remote-chrome 127.0.0.1:9222
```

**Kết quả:**
```
  grok 🤖  — Ask Grok when you're stuck

  Building bundle...
  Bundle: 0 file(s), 245 chars (~61 tokens)
  Session: a1b2c3d4e5f6g7h8

  Navigating to https://grok.com
  Pasting bundle (245 chars)...
  Waiting for Grok response...

─── Grok Response ───────────────────────────────

A closure in JavaScript is a function that retains access to variables
from its outer scope even after the outer function has returned...

─────────────────────────────────────────────────
```

---

## Đính kèm file

### 1 file cụ thể

```powershell
.\grok.ps1 -p "Explain what this function does" --file src/utils.ts --remote-chrome 127.0.0.1:9222
```

### Nhiều file

```powershell
.\grok.ps1 -p "How does authentication work in this project?" `
  --file src/middleware/auth.ts `
  --file src/pages/api/login.ts `
  --file src/hooks/useAuth.ts `
  --remote-chrome 127.0.0.1:9222
```

### Glob pattern — tất cả TypeScript files

```powershell
.\grok.ps1 -p "Review this codebase for potential bugs" `
  --file "src/**/*.ts" `
  --remote-chrome 127.0.0.1:9222
```

### Glob + Exclude

```powershell
# Bỏ qua test files
.\grok.ps1 -p "Audit the code quality" `
  --file "src/**/*.ts" `
  --file "!src/**/*.test.ts" `
  --file "!src/**/*.spec.ts" `
  --remote-chrome 127.0.0.1:9222
```

### Cả thư mục

```powershell
.\grok.ps1 -p "What does the components folder do?" `
  --file src/components `
  --remote-chrome 127.0.0.1:9222
```

### Pipe từ stdin

```powershell
# Windows
Get-Content error.log | .\grok.ps1 -p "What caused this error?" --remote-chrome 127.0.0.1:9222

# macOS/Linux
cat error.log | grok -p "What caused this error?" --remote-chrome 127.0.0.1:9222
```

---

## Các mode đặc biệt

### Think mode — Suy luận sâu

Grok sẽ suy nghĩ kỹ hơn trước khi trả lời. Phù hợp với câu hỏi phức tạp, thuật toán, kiến trúc.

```powershell
.\grok.ps1 -p "What is the most efficient way to find the longest common subsequence?" `
  --think `
  --remote-chrome 127.0.0.1:9222
```

```powershell
# Think + file code
.\grok.ps1 -p "Find all potential race conditions in this code" `
  --file src/store/actions.ts `
  --think `
  --remote-chrome 127.0.0.1:9222
```

### DeepSearch — Tìm kiếm web

Grok tìm kiếm thông tin mới nhất trên internet trước khi trả lời. Phù hợp với câu hỏi về tin tức, thư viện mới, so sánh công nghệ.

```powershell
.\grok.ps1 -p "What are the latest features in React 19?" `
  --deep-search `
  --remote-chrome 127.0.0.1:9222
```

```powershell
# DeepSearch để check security vulnerabilities
.\grok.ps1 -p "Are there any known CVEs for express 4.18.2?" `
  --deep-search `
  --remote-chrome 127.0.0.1:9222
```

### Think + DeepSearch kết hợp

```powershell
.\grok.ps1 -p "Compare the performance benchmarks of Bun vs Node.js vs Deno in 2025" `
  --think `
  --deep-search `
  --remote-chrome 127.0.0.1:9222
```

### Imagine — Tạo ảnh

Grok tạo ảnh từ text prompt, tự động tải về máy.

```powershell
# Tạo ảnh lưu PNG
.\grok.ps1 -p "A futuristic city on Mars at sunset, cinematic lighting, 4K" `
  --imagine "C:\Users\darky\Pictures\mars-city.png" `
  --remote-chrome 127.0.0.1:9222
```

```powershell
# Logo cho project
.\grok.ps1 -p "Minimalist logo for a CLI tool named 'grok', dark theme, tech aesthetic" `
  --imagine "C:\Users\darky\Pictures\grok-logo.png" `
  --remote-chrome 127.0.0.1:9222
```

**Kết quả:**
```
  Modes: Imagine → C:\Users\darky\Pictures\mars-city.png

  [imagine] Waiting for generated image...
  [imagine] Image found: https://...
  [imagine] Image saved to: C:\Users\darky\Pictures\mars-city.png

─── Grok Response ───────────────────────────────
Image saved to: C:\Users\darky\Pictures\mars-city.png
─────────────────────────────────────────────────
```

### Read Aloud — Đọc to

> **Lưu ý thực tế:** grok.com web hiện **chưa có** nút Read Aloud (`enable_text_to_speech: false` trong config). Tính năng này mới chỉ có trên **Android app** (ra mắt 22/2/2026).
>
> grok-cli giải quyết bằng cách inject **Web Speech API** (`speechSynthesis`) trực tiếp vào Chrome để đọc response — không cần button, không cần premium.

```powershell
# Đọc to response + lưu text vào file
.\grok.ps1 -p "Tell me a short story about a robot" `
  --read-aloud "C:\Users\darky\story.txt" `
  --remote-chrome 127.0.0.1:9222
```

```powershell
# Đọc giải thích + lưu markdown
.\grok.ps1 -p "Summarize the SOLID principles in simple terms" `
  --read-aloud "C:\Users\darky\solid.md" `
  --remote-chrome 127.0.0.1:9222
```

**Điều sẽ xảy ra:**
1. Grok trả lời → tool lấy text của response
2. Inject `speechSynthesis.speak()` vào Chrome → **Chrome đọc to trong cửa sổ browser**
3. Lưu nội dung text vào file output (`.txt` hoặc `.md`)

**Để dừng đọc:** Mở DevTools trong Chrome → Console → gõ:
```javascript
window.speechSynthesis.cancel()
```

```powershell
# Kết hợp: hỏi + đọc to
.\grok.ps1 -p "Summarize the SOLID principles in simple terms" `
  --read-aloud "C:\Users\darky\solid.txt" `
  --remote-chrome 127.0.0.1:9222
```

---

## Lưu kết quả

### Lưu response ra file

```powershell
# Tạo unit tests và lưu
.\grok.ps1 -p "Write comprehensive unit tests for all exported functions" `
  --file src/utils.ts `
  --write-output tests/utils.test.ts `
  --remote-chrome 127.0.0.1:9222
```

```powershell
# Tạo documentation
.\grok.ps1 -p "Write JSDoc documentation for all functions in this file" `
  --file src/api/users.ts `
  --write-output docs/users-api.md `
  --remote-chrome 127.0.0.1:9222
```

```powershell
# Refactor code và lưu kết quả
.\grok.ps1 -p "Refactor this to use async/await instead of callbacks" `
  --file src/legacy/handler.js `
  --write-output src/handler.js `
  --remote-chrome 127.0.0.1:9222
```

### Kết hợp nhiều options

```powershell
# Think + DeepSearch + lưu file + verbose
.\grok.ps1 -p "Analyze security vulnerabilities in this authentication code" `
  --file src/auth/login.ts `
  --file src/auth/middleware.ts `
  --think `
  --deep-search `
  --write-output reports/security-audit.md `
  --remote-chrome 127.0.0.1:9222 `
  -v
```

---

## Dry-run và Copy

### Xem bundle trước khi gửi

```powershell
# Chỉ xem — không mở browser
.\grok.ps1 -p "explain this" --file src/app.ts --dry-run
```

**Output:**
```
  Building bundle...
  Bundle: 1 file(s), 4,925 chars (~1,231 tokens)

─── Bundle ──────────────────────────────────────
<system>
You are Grok...
</system>

<files>
### src/app.ts
```typescript
...
```
</files>

<question>
explain this
</question>
─────────────────────────────────────────────────
  Dry-run: skipping browser launch.
```

### Copy bundle để paste thủ công

```powershell
# Build bundle và copy vào clipboard
.\grok.ps1 -p "Review this code" --file src/app.ts --copy

# Sau đó mở grok.com và Ctrl+V
```

### Render + Copy (xem và copy)

```powershell
.\grok.ps1 -p "explain this" --file src/utils.ts --render --copy --dry-run
```

---

## Quản lý session

Mỗi lần chạy, grok-cli tự động lưu session vào `~/.grok/sessions/` (Windows: `C:\Users\<tên>\\.grok\sessions\`).

### Xem danh sách session

```powershell
# 72h gần nhất (mặc định)
.\grok.ps1 status

# 24h gần nhất
.\grok.ps1 status --hours 24
```

**Output:**
```
  Recent Sessions

  ✓ a1b2c3d4e5f6g7h8  2/27/2026, 10:30:15 AM  8.4s  [2 file(s)]
    Review this codebase for potential bugs

  ✓ x9y8z7w6v5u4t3s2  2/27/2026, 9:15:02 AM   12.1s [0 file(s)]
    Explain what is a closure in JavaScript
```

### Xem chi tiết session

```powershell
# Xem response của session
.\grok.ps1 session a1b2c3d4e5f6g7h8

# Xem cả bundle đã gửi
.\grok.ps1 session a1b2c3d4e5f6g7h8 --render-bundle
```

### Xóa session cũ

```powershell
# Xóa session cũ hơn 7 ngày (168h)
.\grok.ps1 status --clear --hours 168

# Xóa tất cả session cũ hơn 24h
.\grok.ps1 status --clear --hours 24
```

---

## Xác thực (Authentication)

### Option 1 — Remote Chrome (khuyến nghị cho Windows)

Mở Chrome với debug port, đăng nhập thủ công, sau đó attach:

```powershell
# Bước 1: Mở Chrome debug
.\start-chrome-debug.ps1

# Bước 2: Đăng nhập grok.com trong Chrome

# Bước 3: Chạy lệnh
.\grok.ps1 -p "your question" --remote-chrome 127.0.0.1:9222
```

### Option 2 — Manual login (tự động mở Chrome)

grok-cli tự mở Chrome, bạn đăng nhập, tool tiếp tục tự động:

```powershell
# Lần đầu: đăng nhập
.\grok.ps1 -p "your question" --manual-login --keep-browser

# Lần sau: profile đã lưu, không cần đăng nhập lại
.\grok.ps1 -p "your question" --manual-login
```

### Option 3 — Cookies file

Export cookies từ Chrome và lưu vào file:

1. Cài extension [EditThisCookie](https://chrome.google.com/webstore/detail/editthiscookie) hoặc [Cookie-Editor](https://cookie-editor.com/)
2. Vào grok.com → export cookies → lưu thành `cookies.json`
3. Copy file vào `~/.grok/cookies.json` (Windows: `C:\Users\<tên>\.grok\cookies.json`)

Format file:
```json
[
  {
    "name": "auth_token",
    "value": "YOUR_AUTH_TOKEN",
    "domain": ".x.com",
    "path": "/",
    "secure": true,
    "httpOnly": true
  },
  {
    "name": "ct0",
    "value": "YOUR_CT0_TOKEN",
    "domain": ".x.com",
    "path": "/",
    "secure": true
  }
]
```

Sau đó chạy bình thường (không cần `--remote-chrome`):
```powershell
.\grok.ps1 -p "your question"
```

Hoặc chỉ định file:
```powershell
.\grok.ps1 -p "your question" --inline-cookies-file C:\Users\darky\my-cookies.json
```

### Kiểm tra cookies

```powershell
# Kiểm tra Chrome có cookies grok.com không
.\grok.ps1 cookies

# Kiểm tra domain khác
.\grok.ps1 cookies --domain x.com
```

### Setup wizard

```powershell
.\grok.ps1 init
```

**Output:**
```
  Setup Check

  ✓ Chrome profile found: C:\Users\darky\AppData\Local\Google\Chrome\...
  ✓ C:\Users\darky\.grok exists
  ℹ  No cookies.json — optional: export cookies here for inline mode

  Quick Start

  Option 1 — Use existing Chrome session:
    .\grok.ps1 -p "your question" --remote-chrome 127.0.0.1:9222

  Option 2 — Manual login:
    .\grok.ps1 -p "your question" --manual-login
```

---

## Captcha & Bot Detection

grok.com chạy trên X.com infrastructure với nhiều lớp bảo vệ:

| Challenge | Cách xử lý |
|-----------|------------|
| **Cloudflare JS** ("Just a moment...") | Tự động đợi 30s. Nếu không qua → tool dừng, bạn solve trong browser, Enter để tiếp tục |
| **Cloudflare Turnstile** | Tương tự — thường tự qua với Chrome thật |
| **Arkose FunCaptcha** (login X.com) | Tool dừng, hướng dẫn bạn solve puzzle trong browser, Enter để tiếp |
| **reCAPTCHA / hCaptcha** | Dừng + chờ bạn solve |
| **Login wall** (redirect đến x.com/login) | Báo lỗi rõ ràng — cookies hết hạn |

### Tips tránh bị chặn

```powershell
# Dùng Chrome profile thật (có lịch sử duyệt web)
.\grok.ps1 -p "question" --chrome-profile "C:\Users\darky\AppData\Local\Google\Chrome\User Data\Default"

# Không dùng --headless (Cloudflare detect headless rất dễ)
# ❌ Sai:  .\grok.ps1 -p "question" --headless
# ✅ Đúng: .\grok.ps1 -p "question"  (không có --headless)

# Nếu hay bị Cloudflare: dùng remote Chrome đã có cookies CF
.\start-chrome-debug.ps1
.\grok.ps1 -p "question" --remote-chrome 127.0.0.1:9222
```

---

## Tất cả flags

### Flags chính

| Flag | Viết tắt | Mặc định | Mô tả |
|------|----------|----------|-------|
| `--prompt <text>` | `-p` | — | Câu hỏi gửi Grok (bắt buộc) |
| `--file <patterns...>` | `-f` | — | File hoặc glob pattern (dùng `!` để exclude) |
| `--model <name>` | `-m` | `grok-3` | Model Grok |
| `--remote-chrome <host:port>` | — | — | Attach Chrome đang chạy qua CDP |
| `--write-output <path>` | — | — | Lưu response ra file |
| `--verbose` | `-v` | false | Log chi tiết |

### Mode flags

| Flag | Mô tả |
|------|-------|
| `--think` | Bật Think mode — suy luận sâu hơn |
| `--deep-search` | Bật DeepSearch — tìm web trước khi trả lời |
| `--imagine <file>` | Tạo ảnh từ prompt, lưu PNG/JPG |
| `--read-aloud <file>` | Click Read Aloud, lưu audio URL/MP3 |

### Browser flags

| Flag | Mặc định | Mô tả |
|------|----------|-------|
| `--manual-login` | false | Mở browser, chờ đăng nhập thủ công |
| `--keep-browser` | false | Giữ Chrome mở sau khi xong |
| `--headless` | false | Chạy Chrome ẩn (không nên dùng) |
| `--chrome-path <path>` | auto | Đường dẫn Chrome binary |
| `--chrome-profile <dir>` | — | Chrome user-data-dir |
| `--browser-timeout <ms>` | `120000` | Timeout tổng (2 phút) |
| `--response-timeout <ms>` | `300000` | Timeout đợi response (5 phút) |

### Cookie flags

| Flag | Mô tả |
|------|-------|
| `--cookie-path <path>` | Đường dẫn trực tiếp đến Chrome Cookies SQLite |
| `--inline-cookies <json>` | JSON array CookieParam[] hoặc base64 |
| `--inline-cookies-file <path>` | Load cookies từ file JSON |

### Preview flags

| Flag | Mô tả |
|------|-------|
| `--dry-run` | Xem bundle, không mở browser |
| `--render` | In bundle ra stdout |
| `--copy` | Copy bundle vào clipboard |

---

## Troubleshooting

### `error: unknown option '--remote-chrome'`

Đang dùng nhầm lệnh `grok`. Dùng wrapper script:
```powershell
# Windows
.\grok.ps1 -p "question" --remote-chrome 127.0.0.1:9222

# macOS/Linux (sau npm link)
grok -p "question" --remote-chrome 127.0.0.1:9222
```

### `Error: connect ECONNREFUSED 127.0.0.1:9222`

Chrome chưa mở debug port:
```powershell
# Kiểm tra
netstat -ano | findstr :9222
# Phải thấy LISTENING

# Nếu không có → chạy lại
.\start-chrome-debug.ps1
```

### Waiting for Grok response... mãi không xong

Tool đang poll DOM nhưng không tìm thấy response. Chạy với `-v` để xem DOM hints:
```powershell
.\grok.ps1 -p "Say hello" --remote-chrome 127.0.0.1:9222 -v
```

Sau 10s sẽ thấy:
```
[browser] DOM hint:
DIV[class="response-content..."] = "Hello! How can I help..."
```

Copy class name đó và [mở issue](https://github.com/Fon-1/grok-cli/issues) để update selector.

### Redirected to login page

Cookies hết hạn hoặc không tìm thấy:
```powershell
# Kiểm tra cookies
.\grok.ps1 cookies

# Fix: dùng remote Chrome đã đăng nhập
.\start-chrome-debug.ps1   # mở Chrome
# Đăng nhập grok.com trong Chrome
.\grok.ps1 -p "question" --remote-chrome 127.0.0.1:9222
```

### Cloudflare challenge không tự qua

```powershell
# Không dùng --headless
# Dùng Chrome profile thật
.\grok.ps1 -p "question" `
  --chrome-profile "$env:LOCALAPPDATA\Google\Chrome\User Data\Default" `
  --remote-chrome 127.0.0.1:9222
```

### Build lỗi

```powershell
# Xóa dist và build lại
Remove-Item -Recurse -Force dist
npm run build
```

---

## Sessions

Tất cả session lưu tại `~/.grok/sessions/` (Windows: `C:\Users\<tên>\.grok\sessions\`).

```powershell
# Xem sessions gần đây
.\grok.ps1 status

# Xem 1 session cụ thể
.\grok.ps1 session <id>

# Xem bundle đã gửi trong session đó
.\grok.ps1 session <id> --render-bundle

# Xóa sessions cũ
.\grok.ps1 status --clear --hours 168
```

Override thư mục lưu:
```powershell
$env:GROK_HOME_DIR = "D:\grok-data"
.\grok.ps1 -p "question"
```

---

## License

MIT
