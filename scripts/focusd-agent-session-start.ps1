$ErrorActionPreference = "Stop"

try {
  $stdin = [System.IO.StreamReader]::new([System.Console]::OpenStandardInput())
  $rawJson = $stdin.ReadToEnd()
  $stdin.Close()

  if (-not $rawJson) { exit 0 }

  $data = $rawJson | ConvertFrom-Json
  $sessionId = $data.session_id
  if (-not $sessionId) { exit 0 }

  # Write session_id to fixed file so subsequent hooks can read it
  # (CLAUDE_ENV_FILE env var propagation is unreliable)
  $statusDir = if ($env:FOCUSD_AGENT_STATUS_DIR) { $env:FOCUSD_AGENT_STATUS_DIR }
               elseif ($env:APPDATA) { Join-Path $env:APPDATA "com.focusd.island" }
               else { Join-Path $env:LOCALAPPDATA "com.focusd.island" }
  New-Item -ItemType Directory -Force -Path $statusDir | Out-Null
  $sessionFile = Join-Path $statusDir "session-claudeCode.txt"
  [System.IO.File]::WriteAllText($sessionFile, $sessionId, [System.Text.UTF8Encoding]::new($false))

  $envFile = $env:CLAUDE_ENV_FILE
  if ($envFile) {
    Add-Content -Path $envFile -Value "FOCUSD_SESSION_ID=$sessionId" -Encoding UTF8
  }
} catch { }

exit 0
