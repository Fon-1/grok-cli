# start-chrome-debug.ps1
# Khởi động Chrome với remote debugging port 9222
# Dùng profile riêng để không ảnh hưởng Chrome đang dùng

$Port = 9222
$ProfileDir = "$env:USERPROFILE\.grok\browser-profile"

# Tạo profile dir nếu chưa có
if (-not (Test-Path $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
    Write-Host "Tạo profile dir: $ProfileDir"
}

# Tìm Chrome
$ChromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome Beta\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome Beta\Application\chrome.exe"
)

$ChromeExe = $null
foreach ($path in $ChromePaths) {
    if (Test-Path $path) {
        $ChromeExe = $path
        break
    }
}

if (-not $ChromeExe) {
    Write-Error "Không tìm thấy Chrome. Cài Chrome tại: https://www.google.com/chrome/"
    exit 1
}

Write-Host "Chrome: $ChromeExe"

# Kill Chrome cũ đang dùng profile này (nếu có)
$existingProcs = Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*$ProfileDir*"
}
if ($existingProcs) {
    Write-Host "Đang đóng Chrome cũ trên profile này..."
    $existingProcs | Stop-Process -Force
    Start-Sleep -Seconds 1
}

# Kiểm tra port 9222 có đang dùng không
$portInUse = netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING"
if ($portInUse) {
    Write-Host "Port $Port đã có LISTENING — Chrome debug đã chạy."
    Write-Host ""
    Write-Host "Chạy ngay:"
    Write-Host "  .\grok.ps1 -p `"câu hỏi`" --remote-chrome 127.0.0.1:$Port"
    exit 0
}

# Khởi động Chrome với debug port
$args = @(
    "--remote-debugging-port=$Port",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=`"$ProfileDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,800",
    "https://grok.com"
)

Write-Host ""
Write-Host "Khởi động Chrome debug trên port $Port..."
Write-Host "Profile: $ProfileDir"
Write-Host ""

Start-Process -FilePath $ChromeExe -ArgumentList $args

# Đợi Chrome mở port
Write-Host "Đợi Chrome mở port $Port" -NoNewline
$timeout = 20
$elapsed = 0
$ready = $false

while ($elapsed -lt $timeout) {
    Start-Sleep -Seconds 1
    $elapsed++
    Write-Host "." -NoNewline

    $check = netstat -ano 2>$null | Select-String ":$Port\s" | Select-String "LISTENING"
    if ($check) {
        $ready = $true
        break
    }
}

Write-Host ""

if ($ready) {
    Write-Host ""
    Write-Host "Chrome debug sẵn sàng trên port $Port ✓" -ForegroundColor Green
    Write-Host ""
    Write-Host "Bước tiếp theo:" -ForegroundColor Yellow
    Write-Host "  1. Vào cửa sổ Chrome vừa mở"
    Write-Host "  2. Đăng nhập vào grok.com (nếu chưa đăng nhập)"
    Write-Host "  3. Sau khi đăng nhập xong, chạy lệnh:"
    Write-Host ""
    Write-Host "  .\grok.ps1 -p `"câu hỏi của bạn`" --remote-chrome 127.0.0.1:$Port" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Ví dụ:"
    Write-Host "  .\grok.ps1 -p `"Explain bubble sort`" --remote-chrome 127.0.0.1:$Port" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Warning "Chrome chưa mở port $Port sau ${timeout}s."
    Write-Host ""
    Write-Host "Thử kiểm tra thủ công:"
    Write-Host "  netstat -ano | findstr :$Port"
    Write-Host ""
    Write-Host "Nếu vẫn không có LISTENING, thử chạy Chrome thủ công:"
    Write-Host "  & `"$ChromeExe`" --remote-debugging-port=$Port --user-data-dir=`"$ProfileDir`" https://grok.com"
}
