$ErrorActionPreference = "Stop"

$input = [Console]::In.ReadToEnd()
$data = $input | ConvertFrom-Json
$sessionId = $data.session_id

if (-not $sessionId) {
  exit 0
}

$envFile = $env:CLAUDE_ENV_FILE
if (-not $envFile) {
  exit 0
}

Add-Content -Path $envFile -Value "FOCUSD_SESSION_ID=$sessionId" -Encoding UTF8
exit 0
