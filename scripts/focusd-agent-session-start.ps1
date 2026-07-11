$ErrorActionPreference = "Stop"

try {
  $stdin = [System.IO.StreamReader]::new([System.Console]::OpenStandardInput())
  $rawJson = $stdin.ReadToEnd()
  $stdin.Close()

  if (-not $rawJson) { exit 0 }

  $data = $rawJson | ConvertFrom-Json
  $sessionId = $data.session_id
  if (-not $sessionId) { exit 0 }

  $envFile = $env:CLAUDE_ENV_FILE
  if (-not $envFile) { exit 0 }

  Add-Content -Path $envFile -Value "FOCUSD_SESSION_ID=$sessionId" -Encoding UTF8
} catch { }

exit 0
