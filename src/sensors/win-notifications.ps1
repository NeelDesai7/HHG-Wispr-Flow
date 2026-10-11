# Reads this laptop's notifications via Windows' UserNotificationListener and prints one JSON
# object per line (UTF-8) for the Node hub. Text fields are base64 UTF-8, so content stays on
# one line and intact. Nothing is written anywhere; the hub screens, extracts tasks, and forgets.
param([int]$ParentPid = 0, [int]$IntervalMs = 4000, [switch]$EmitExisting)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
function B64([string]$s) {
  if (-not $s) { return '' }
  return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
}

# The async helper lives in System.Runtime.WindowsRuntime, which isn't loaded by default.
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  $script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
} catch {
  Emit @{ type = 'error'; reason = 'winrt-helper-missing'; detail = "$($_.Exception.Message)" }
  exit 1
}

# Await an IAsyncOperation<T> from Windows Runtime synchronously.
function Await($op, $resultType) {
  $task = $script:AsTask.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

try {
  [void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications.Management, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
} catch {
  Emit @{ type = 'error'; reason = 'winrt-unavailable'; detail = "$($_.Exception.Message)" }
  exit 1
}

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
try {
  $access = Await ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
} catch {
  Emit @{ type = 'error'; reason = 'access-failed'; detail = "$($_.Exception.Message)" }
  exit 1
}
Emit @{ type = 'access'; status = "$access" }
if ("$access" -ne 'Allowed') { exit 2 }

$toastKind = [Windows.UI.Notifications.NotificationKinds]::Toast
$listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'
$baselined = $false
Emit @{ type = 'ready'; pid = $PID }

while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  try {
    $notes = Await ($listener.GetNotificationsAsync($toastKind)) $listType
  } catch {
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }
  foreach ($n in $notes) {
    $id = [uint32]$n.Id
    if ($seen.Contains($id)) { continue }
    [void]$seen.Add($id)
    if (-not $baselined -and -not $EmitExisting) { continue } # first pass: baseline existing without sending

    $app = ''
    try { $app = $n.AppInfo.DisplayInfo.DisplayName } catch { }
    $texts = New-Object System.Collections.Generic.List[string]
    try {
      foreach ($b in $n.Notification.Visual.Bindings) {
        foreach ($t in $b.GetTextElements()) { if ($t.Text) { $texts.Add($t.Text) } }
      }
    } catch { }
    if ($texts.Count -eq 0) { continue }
    $title = $texts[0]
    $body = if ($texts.Count -gt 1) { ($texts[1..($texts.Count - 1)] -join ' ') } else { '' }
    $at = (Get-Date).ToUniversalTime().ToString('o')
    try { $at = $n.CreationTime.UtcDateTime.ToString('o') } catch { }
    Emit @{ type = 'notification'; app = (B64 $app); title = (B64 $title); body = (B64 $body); at = $at }
  }
  # Keep the seen set from growing without bound across a long session.
  if ($seen.Count -gt 4000) { $seen.Clear(); $baselined = $false }
  $baselined = $true
  Start-Sleep -Milliseconds $IntervalMs
}
