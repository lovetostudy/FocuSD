param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Provider,

  [Parameter(Position = 1)]
  [ValidateSet("running", "confirming")]
  [string]$FlagType = "running"
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
  $baseMarker = "${prefix}-${sessionId}"
} else {
  $baseMarker = $prefix
}

if ($FlagType -eq "confirming") {
  # Create confirming flag, keep running flag intact
  $confirmingPath = Join-Path $statusDir "${baseMarker}-confirming.flag"
  [System.IO.File]::WriteAllText($confirmingPath, "", [System.Text.UTF8Encoding]::new($false))
  # Return PermissionRequest allow decision to avoid blocking the permission dialog
  [Console]::Out.Write('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}')
} else {
  # running mode: clear any stale confirming flag first, then create running flag
  $confirmingPath = Join-Path $statusDir "${baseMarker}-confirming.flag"
  Remove-Item -LiteralPath $confirmingPath -Force -ErrorAction SilentlyContinue
  # Fallback: also clear session-less confirming flag created by confirming.bat
  $legacyConfirmingPath = Join-Path $statusDir "${prefix}-confirming.flag"
  Remove-Item -LiteralPath $legacyConfirmingPath -Force -ErrorAction SilentlyContinue
  $runningPath = Join-Path $statusDir "${baseMarker}-running.flag"
  [System.IO.File]::WriteAllText($runningPath, "", [System.Text.UTF8Encoding]::new($false))
}
exit 0
