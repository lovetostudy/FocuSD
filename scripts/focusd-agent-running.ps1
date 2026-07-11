param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Provider
)

$ErrorActionPreference = "Stop"

if ($Provider -eq "codex") {
  $prefix = "agent-codex"
} elseif ($Provider -eq "claudeCode") {
  $prefix = "agent-claudeCode"
} else {
  exit 2
}

$sessionId = $env:FOCUSD_SESSION_ID

if ($env:FOCUSD_AGENT_STATUS_DIR) {
  $statusDir = $env:FOCUSD_AGENT_STATUS_DIR
} elseif ($env:APPDATA) {
  $statusDir = Join-Path $env:APPDATA "com.focusd.island"
} else {
  $statusDir = Join-Path $env:LOCALAPPDATA "com.focusd.island"
}

New-Item -ItemType Directory -Force -Path $statusDir | Out-Null

if ($sessionId) {
  $markerName = "${prefix}-${sessionId}-running.flag"
} else {
  $markerName = "${prefix}-running.flag"
}

$markerPath = Join-Path $statusDir $markerName
[System.IO.File]::WriteAllText($markerPath, "", [System.Text.UTF8Encoding]::new($false))
exit 0
