param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("codex", "claudeCode")]
  [string]$Provider,

  [Parameter(Mandatory = $true, Position = 1)]
  [ValidateSet("idle", "running", "completed", "failed")]
  [string]$Phase,

  [Parameter(Position = 2)]
  [string]$TaskId = "",

  [string]$StatusPath = "",

  [int]$MinimumRunningVisibleMs = 800,

  [switch]$HookResponse
)

$ErrorActionPreference = "Stop"

function New-AgentTaskStatus {
  param(
    [string]$Phase = "idle",
    [string]$TaskId = "",
    [long]$UpdatedAt = 0
  )

  $status = [ordered]@{
    phase = $Phase
    updatedAt = $UpdatedAt
  }

  if ($TaskId) {
    $status.taskId = $TaskId
  }

  return $status
}

function Copy-AgentTaskStatus {
  param(
    [object]$Source
  )

  if ($null -eq $Source) {
    return New-AgentTaskStatus
  }

  $phase = "idle"
  if ($Source.PSObject.Properties.Name -contains "phase") {
    $candidatePhase = [string]$Source.phase
    if (@("idle", "running", "completed", "failed") -contains $candidatePhase) {
      $phase = $candidatePhase
    }
  }

  $updatedAt = 0
  if ($Source.PSObject.Properties.Name -contains "updatedAt") {
    $updatedAt = [long]$Source.updatedAt
  }

  $taskId = ""
  if ($Source.PSObject.Properties.Name -contains "taskId") {
    $taskId = [string]$Source.taskId
  }

  return New-AgentTaskStatus -Phase $phase -TaskId $taskId -UpdatedAt $updatedAt
}

function Get-DefaultStatusPath {
  if ($env:FOCUSD_AGENT_STATUS_PATH) {
    return $env:FOCUSD_AGENT_STATUS_PATH
  }

  if ($env:APPDATA) {
    return Join-Path $env:APPDATA "com.focusd.island\agent-status.json"
  }

  return Join-Path $env:LOCALAPPDATA "com.focusd.island\agent-status.json"
}

function Get-AgentMarkerNames {
  param(
    [string]$Provider
  )

  $sessionId = $env:FOCUSD_SESSION_ID
  if (-not $sessionId) {
    try {
      $currentPid = $pid
      $maxDepth = 5
      for ($i = 0; $i -lt $maxDepth; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $proc) { break }
        if (($proc.Name -eq "claude.exe" -or $proc.Name -eq "node.exe")) {
          $sessionId = "cc-$($proc.ProcessId)"
          break
        }
        $currentPid = $proc.ParentProcessId
      }
    } catch { }
  }

  if ($Provider -eq "codex") {
    $base = "agent-codex"
  } else {
    $base = "agent-claudeCode"
  }

  if ($sessionId) {
    $runningName = "${base}-${sessionId}-running.flag"
  } else {
    $runningName = "${base}-running.flag"
  }

  return @{
    Running = $runningName
  }
}

function Update-AgentRunningMarkers {
  param(
    [string]$Provider,
    [string]$Phase,
    [string]$StatusDirectory
  )

  $markerNames = Get-AgentMarkerNames -Provider $Provider
  $runningPath = Join-Path $StatusDirectory $markerNames.Running

  if ($Phase -eq "running") {
    [System.IO.File]::WriteAllText($runningPath, "", [System.Text.UTF8Encoding]::new($false))
    return
  }

  Remove-Item -LiteralPath $runningPath -Force -ErrorAction SilentlyContinue
}

if (-not $StatusPath) {
  $StatusPath = Get-DefaultStatusPath
}

$mutex = New-Object System.Threading.Mutex($false, "FocuSD.AgentStatus")
$hasLock = $false

try {
  $hasLock = $mutex.WaitOne([TimeSpan]::FromSeconds(5))
  if (-not $hasLock) {
    throw "Timed out waiting for the FocuSD agent status file lock."
  }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $state = [ordered]@{
    codex = New-AgentTaskStatus
    claudeCode = New-AgentTaskStatus
    updatedAt = $now
  }

  if (Test-Path -LiteralPath $StatusPath) {
    try {
      $existing = Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
      $state.codex = Copy-AgentTaskStatus -Source $existing.codex
      $state.claudeCode = Copy-AgentTaskStatus -Source $existing.claudeCode
    } catch {
      $state.codex = New-AgentTaskStatus
      $state.claudeCode = New-AgentTaskStatus
    }
  }

  $nextTask = New-AgentTaskStatus -Phase $Phase -TaskId $TaskId -UpdatedAt $now
  if ($Provider -eq "codex") {
    $state.codex = $nextTask
  } else {
    $state.claudeCode = $nextTask
  }
  $state.updatedAt = $now

  $statusDirectory = Split-Path -Parent $StatusPath
  New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
  Update-AgentRunningMarkers -Provider $Provider -Phase $Phase -StatusDirectory $statusDirectory

  $json = $state | ConvertTo-Json -Depth 5
  $temporaryPath = "$StatusPath.tmp"
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($temporaryPath, $json, $utf8NoBom)
  Move-Item -LiteralPath $temporaryPath -Destination $StatusPath -Force
} finally {
  if ($hasLock) {
    $mutex.ReleaseMutex() | Out-Null
  }
  $mutex.Dispose()
}

if ($HookResponse) {
  [Console]::Out.Write('{"continue":true,"suppressOutput":true}')
}
