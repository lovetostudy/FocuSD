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

if ($env:FOCUSD_AGENT_STATUS_DIR) {
  $statusDir = $env:FOCUSD_AGENT_STATUS_DIR
} elseif ($env:APPDATA) {
  $statusDir = Join-Path $env:APPDATA "com.focusd.island"
} else {
  $statusDir = Join-Path $env:LOCALAPPDATA "com.focusd.island"
}

New-Item -ItemType Directory -Force -Path $statusDir | Out-Null

# Try FOCUSD_SESSION_ID env var first
$sessionId = $env:FOCUSD_SESSION_ID

# Fallback: trace up process tree to find Claude Code process PID
if (-not $sessionId) {
  try {
    $currentPid = $pid
    $maxDepth = 5
    for ($i = 0; $i -lt $maxDepth; $i++) {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $proc) { break }
      # Claude Code runs as a Node.js process
      if (($proc.Name -eq "claude.exe" -or $proc.Name -eq "node.exe")) {
        $sessionId = "cc-$($proc.ProcessId)"
        break
      }
      $currentPid = $proc.ParentProcessId
    }
  } catch {
    # Silently ignore errors
  }
}

if ($sessionId) {
  $markerName = "${prefix}-${sessionId}-running.flag"
} else {
  $markerName = "${prefix}-running.flag"
}

$markerPath = Join-Path $statusDir $markerName
[System.IO.File]::WriteAllText($markerPath, "", [System.Text.UTF8Encoding]::new($false))
exit 0
