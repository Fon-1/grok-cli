# grok.ps1 — wrapper cho grok-cli trên Windows
# Dùng khi 'grok' command bị conflict với tool khác

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$GrokJs = Join-Path $ScriptDir "dist\bin\grok.js"

if (-not (Test-Path $GrokJs)) {
    Write-Error "dist\bin\grok.js không tìm thấy. Chạy: npm run build"
    exit 1
}

node $GrokJs @args
