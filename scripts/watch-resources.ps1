<#
.SYNOPSIS
  Samples Hue's per-process resource use over time so a slow degradation shows up
  as a trend instead of a feeling.

.DESCRIPTION
  "The PC lags after Hue has been open a while" has several possible shapes, and
  they are told apart by *which* number grows and in *which* process:

    - renderer Private_MB climbing        -> JS/heap leak in the UI or pipeline
    - GPU process Private_MB climbing     -> GPU/VRAM leak (transparent window,
                                             WebGPU model buffers)
    - main Handles / Threads climbing     -> leaked OS handles, timers, sockets
    - CPU_pct high while idle             -> a hook, VAD, or capture loop that
                                             never stops
    - system CommitMB near CommitLimit    -> the machine is paging, which is what
                                             makes *everything else* lag

  Run this, leave it running as long as it takes to reproduce, then look at the
  CSV. A leak is a line that only goes up across many samples; noise wobbles.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\watch-resources.ps1
  powershell -ExecutionPolicy Bypass -File scripts\watch-resources.ps1 -IntervalSeconds 15 -OutFile C:\temp\hue.csv
#>
[CmdletBinding()]
param(
  # How often to sample. 30s is plenty for a leak that takes an hour to bite.
  [int]$IntervalSeconds = 30,
  # Where the samples land. Open in Excel and chart a column against Sample.
  [string]$OutFile = "$PSScriptRoot\..\hue-resource-log.csv",
  # Stop on its own so an overnight run doesn't grow forever. 0 = until Ctrl+C.
  [int]$MaxSamples = 0,
  # Process name filter. Hue's packaged exe is hue.exe; `npm run dev` is electron.exe.
  [string]$Match = 'hue|electron'
)

$ErrorActionPreference = 'Stop'

# CPU is only meaningful as a delta: Process.CPU is cumulative seconds since the
# process started, so a long-lived process always looks busy. Remember the last
# reading per PID and report the percentage actually burned in the interval.
$lastCpu = @{}

# Electron does not label its own processes, so a bare PID list cannot tell the
# renderer (where a JS leak would live) from the GPU process (where a VRAM leak
# would). The command line carries --type=, which is the only reliable label.
function Get-ElectronRole {
  param([int]$ProcessId)
  try {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop).CommandLine
  } catch {
    return 'unknown'
  }
  if (-not $cmd) { return 'unknown' }
  if ($cmd -match '--type=([\w-]+)') { return $Matches[1] }
  # No --type= at all means this is the process that spawned the others.
  return 'main'
}

Write-Host "Sampling '$Match' every $IntervalSeconds s -> $OutFile"
Write-Host "Reproduce the lag while this runs, then stop with Ctrl+C.`n"

$sample = 0
while ($true) {
  $sample++
  $now = Get-Date

  $procs = @(Get-Process | Where-Object { $_.ProcessName -match $Match })

  if ($procs.Count -eq 0) {
    Write-Host ("[{0:HH:mm:ss}] no matching process -- is Hue running?" -f $now)
  }

  # System-wide commit. This is the number that explains why the *whole PC* lags
  # rather than just Hue: once commit approaches the limit, Windows pages and
  # every application stutters, however well-behaved it is.
  $os = Get-CimInstance Win32_OperatingSystem
  $committedMB = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1KB, 0)
  $totalMB = [math]::Round($os.TotalVisibleMemorySize / 1KB, 0)

  $rows = foreach ($p in $procs) {
    # A process that exited between the enumeration and here throws on access.
    try {
      $cpuNow = $p.CPU
      $prev = $lastCpu[$p.Id]
      $lastCpu[$p.Id] = $cpuNow
      # First sighting has no baseline, so no rate can be computed yet.
      $cpuPct = if ($null -ne $prev) {
        [math]::Round((($cpuNow - $prev) / $IntervalSeconds) * 100 / [Environment]::ProcessorCount, 1)
      } else { $null }

      [pscustomobject]@{
        Sample     = $sample
        Time       = $now.ToString('HH:mm:ss')
        UptimeMin  = [math]::Round(((Get-Date) - $p.StartTime).TotalMinutes, 1)
        PID        = $p.Id
        Role       = Get-ElectronRole -ProcessId $p.Id
        WS_MB      = [math]::Round($p.WorkingSet64 / 1MB, 1)
        Private_MB = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
        CPU_pct    = $cpuPct
        Handles    = $p.HandleCount
        Threads    = $p.Threads.Count
        SysUsedMB  = $committedMB
        SysTotalMB = $totalMB
      }
    } catch {
      # Process vanished mid-sample; nothing to record for it.
    }
  }

  if ($rows) {
    $rows | Export-Csv -Path $OutFile -NoTypeInformation -Append -Encoding utf8

    # Console view: one line per role so a trend is visible without opening the CSV.
    foreach ($r in ($rows | Sort-Object Private_MB -Descending)) {
      Write-Host ("[{0}] {1,-10} pid {2,-6} priv {3,8} MB  cpu {4,5}%  hnd {5,6}  thr {6,4}" -f `
        $r.Time, $r.Role, $r.PID, $r.Private_MB, $r.CPU_pct, $r.Handles, $r.Threads)
    }
    $totalPriv = [math]::Round((($rows | Measure-Object Private_MB -Sum).Sum), 1)
    Write-Host ("           TOTAL Hue {0} MB   |   system {1}/{2} MB used`n" -f $totalPriv, $committedMB, $totalMB)
  }

  if ($MaxSamples -gt 0 -and $sample -ge $MaxSamples) { break }
  Start-Sleep -Seconds $IntervalSeconds
}
