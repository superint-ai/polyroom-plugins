param(
  [Parameter(Position = 0)][string]$Product = '',
  [Parameter(Position = 1)][string]$Action = ''
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Desktop' -and [int][Net.ServicePointManager]::SecurityProtocol -ne 0) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

if (@('codex:wait', 'codex:session-start', 'codex:claim', 'claude:wait', 'claude:session-start', 'claude:claim') -notcontains "${Product}:${Action}") {
  [Console]::Error.WriteLine('usage: wake.ps1 codex|claude wait|session-start|claim')
  exit 64
}

if ($env:POLYROOM_WAKE_DIR) {
  $dir = $env:POLYROOM_WAKE_DIR
} elseif ($Product -eq 'codex') {
  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
  $dir = Join-Path $codexHome 'polyroom'
} else {
  $claudeHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
  $dir = Join-Path $claudeHome 'polyroom'
}
$config = Join-Path $dir 'wake.env'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$serverName = ''
try {
  $servers = (Get-Content -LiteralPath (Join-Path $pluginRoot '.mcp.json') -Raw -Encoding UTF8 | ConvertFrom-Json).mcpServers
  $serverNames = @($servers.PSObject.Properties.Name)
  if ($serverNames.Count -eq 1 -and $serverNames[0] -match '^[A-Za-z0-9_-]+$' -and $servers.($serverNames[0]).url -is [string] -and $servers.($serverNames[0]).url) { $serverName = $serverNames[0] }
} catch {
  $serverName = ''
}
$idleText = 'No new polyroom notices. Call the polyroom tool chat_identity once so this session keeps waiting, then end the turn with one word.'
$refusedText = 'The chat refused the polyroom wake token, so this session stopped waiting for notices: the connection was removed or expired, or the agent or its workspace was deleted. Tell the person in one sentence, and say they can type Connect polyroom to connect again.'
$connectedText = 'polyroom connected this conversation, and it now waits for notices. Tell the person in one short sentence that it is connected, then end the turn.'
$codeRefusedText = 'The chat refused the polyroom connection code, so this conversation is not connected. Tell the person, and run the polyroom connect skill again only if they ask.'
$addressMissingText = 'The polyroom plugin has no chat address in its .mcp.json, so this conversation is not connected. Tell the person to reinstall the polyroom plugin.'
$unreachableText = 'polyroom could not reach the chat to connect this conversation. Tell the person to check the network, and run the polyroom connect skill again only if they ask.'
$foreignCodeText = 'The polyroom connection code was not used, because this conversation did not get it from the chat_wake_code tool of polyroom. Tell the person, and run the polyroom connect skill again only if they ask.'
$busyText = 'Another polyroom session on this computer already waits for notices for this agent, so this session does not wait. Close the other session, then send any message here so this one waits.'
$alreadyConnectedText = 'This conversation is already connected to polyroom, so the new connection code was not used. To connect another agent, the person removes this connection on the Agents page of polyroom (open the agent, Edit in Connections, Revoke next to the connection under Connections and tokens, then Save), and then runs the polyroom connect skill again.'

function Read-Settings {
  $values = @{}
  if (Test-Path -LiteralPath $config) {
    foreach ($line in [System.IO.File]::ReadAllLines($config, $utf8)) {
      $index = $line.IndexOf('=')
      if ($index -gt 0) { $values[$line.Substring(0, $index)] = $line.Substring($index + 1).Trim() }
    }
  }
  $values
}

function Test-ConnectedAsBefore {
  (Read-Settings)['POLYROOM_WAKE_TOKEN'] -eq $script:token
}

function Save-Setting([string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath $config) { $lines = @([System.IO.File]::ReadAllLines($config, $utf8) | Where-Object { -not $_.StartsWith("$Key=") }) }
  if ($Value) { $lines += "$Key=$Value" }
  $temporary = "$config.$PID.tmp"
  try {
    [System.IO.File]::WriteAllLines($temporary, [string[]]$lines, $utf8)
    Move-Item -LiteralPath $temporary -Destination $config -Force
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Number-Setting([hashtable]$Values, [string]$Key, [int]$Default) {
  $value = $Values[$Key]
  if ($value -match '^\d+$') { [int]$value } else { $Default }
}

function Read-Number([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    $value = ([System.IO.File]::ReadAllText($Path, $utf8)).Trim()
    if ($value -match '^\d+$') { return $value }
  }
  $null
}

function Get-TokenMark {
  $digest = [System.Security.Cryptography.SHA256]::Create().ComputeHash($utf8.GetBytes("$script:token"))
  -join ($digest[0..5] | ForEach-Object { $_.ToString('x2') })
}

function Read-Marked([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @{ State = 'missing' } }
  $parts = @(([System.IO.File]::ReadAllText($Path, $utf8)).Trim() -split '\s+')
  if ($parts.Count -eq 1 -and $parts[0] -match '^\d+$') { return @{ State = 'mine'; Number = $parts[0] } }
  if (($parts.Count -eq 2 -or $parts.Count -eq 3) -and $parts[1] -match '^\d+$') {
    if ($parts[0] -eq (Get-TokenMark)) { return @{ State = 'mine'; Number = $parts[1]; Turn = $(if ($parts.Count -eq 3) { $parts[2] } else { '' }) } }
    return @{ State = 'foreign' }
  }
  @{ State = 'missing' }
}

function Write-Number([string]$Path, [string]$Value) {
  [System.IO.File]::WriteAllText($Path, "$Value`n", $utf8)
}

$settings = Read-Settings
$url = "$($settings['POLYROOM_WAKE_URL'])".TrimEnd('/')
$token = "$($settings['POLYROOM_WAKE_TOKEN'])"
$code = "$($settings['POLYROOM_WAKE_CODE'])"
$budget = Number-Setting $settings 'POLYROOM_WAKE_BUDGET_SECONDS' 1740
$waitSeconds = Number-Setting $settings 'POLYROOM_WAKE_WAIT_SECONDS' 20
$margin = Number-Setting $settings 'POLYROOM_WAKE_MARGIN_SECONDS' 15
$retryMin = Number-Setting $settings 'POLYROOM_WAKE_RETRY_MIN_SECONDS' 2
$retryMax = Number-Setting $settings 'POLYROOM_WAKE_RETRY_MAX_SECONDS' 60
$startToleranceMs = Number-Setting $settings 'POLYROOM_WAKE_START_TOLERANCE_MS' 100
$unknownCursor = '999999999999999'
$userAgent = 'polyroom-wake/1'

foreach ($leftover in @(Get-ChildItem -LiteralPath $dir -Filter 'wake.env.*.tmp' -File -ErrorAction SilentlyContinue)) {
  if ($leftover.Name -match '^wake\.env\.(\d{1,9})\.tmp$' -and ([int]$Matches[1] -eq $PID -or -not (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue))) {
    Remove-Item -LiteralPath $leftover.FullName -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Wake([string]$Method, [string]$Address, [hashtable]$Headers, [string]$Body, [int]$TimeoutSeconds) {
  $arguments = @{ Uri = $Address; Method = $Method; Headers = $Headers; UserAgent = $userAgent; TimeoutSec = $TimeoutSeconds; UseBasicParsing = $true }
  if ($Body) { $arguments['Body'] = $utf8.GetBytes($Body); $arguments['ContentType'] = 'application/json' }
  try {
    $response = Invoke-WebRequest @arguments
    $reader = New-Object System.IO.StreamReader($response.RawContentStream, $utf8)
    $cursor = $response.Headers['x-polyroom-cursor']
    if ($cursor -is [array]) { $cursor = $cursor[-1] }
    return @{ Status = [int]$response.StatusCode; Body = $reader.ReadToEnd(); Cursor = "$cursor" }
  } catch [System.Net.WebException] {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    return @{ Status = $status; Body = ''; Cursor = '' }
  } catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    return @{ Status = $status; Body = ''; Cursor = '' }
  }
}

function Invoke-Claim {
  if ($script:code -notmatch '^[A-Za-z0-9_-]+$') {
    [Console]::Error.WriteLine('No valid POLYROOM_WAKE_CODE in wake.env.')
    return $false
  }
  $answer = Invoke-Wake 'POST' "$url/wake/claim" @{} "{`"code`":`"$($script:code)`"}" ($waitSeconds + $margin)
  $script:claimStatus = $answer.Status
  $received = $answer.Body.Trim()
  if ($answer.Status -eq 200 -and $received -match '^saw_[A-Za-z0-9_-]+$') {
    Save-Setting 'POLYROOM_WAKE_TOKEN' $received
    Save-Setting 'POLYROOM_WAKE_CODE' ''
    $script:token = $received
    Write-Marked (Join-Path $dir 'cursor') $unknownCursor
    Remove-Item -LiteralPath (Join-Path $dir 'stopped'), (Join-Path $dir 'pending') -Force -ErrorAction SilentlyContinue
    return $true
  }
  [Console]::Error.WriteLine("The chat refused the connection code (HTTP $($answer.Status)). Run the connect skill again for a new code.")
  $false
}

function Write-Marked([string]$Path, [string]$Value, [string]$Turn = '') {
  $line = "$(Get-TokenMark) $Value"
  if ($Turn) { $line = "$line $Turn" }
  Write-Number $Path $line
}

function Deliver-Body([string]$Body) {
  if ($Product -eq 'codex') {
    [Console]::Out.Write($Body)
    exit 0
  }
  [Console]::Error.Write($Body)
  exit 2
}

function Deliver-Text([string]$Text) {
  if ($Product -eq 'codex') {
    [Console]::Out.WriteLine((@{ decision = 'block'; reason = $Text } | ConvertTo-Json -Compress))
    exit 0
  }
  [Console]::Error.WriteLine($Text)
  exit 2
}

function Test-IssuedHere([string]$Transcript, [string]$Offered) {
  if (-not $Transcript) { return $false }
  for ($try = 0; $try -lt 5; $try++) {
    if (Test-Path -LiteralPath $Transcript -PathType Leaf) {
      $stream = $null
      try {
        $stream = New-Object System.IO.FileStream($Transcript, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $reader = New-Object System.IO.StreamReader($stream, $utf8)
        while ($null -ne ($line = $reader.ReadLine())) {
          if ($line.Contains("`"server`":`"$serverName`",`"tool`":`"chat_wake_code`"") -and $line.Contains("`"structuredContent`":{`"code`":`"$Offered`"")) { return $true }
        }
      } catch {
      } finally {
        if ($stream) { $stream.Dispose() }
      }
    }
    if ($try -lt 4) { Start-Sleep -Seconds 1 }
  }
  $false
}

$stopText = ''
if ($Action -eq 'wait' -and [Console]::IsInputRedirected) { $stopText = [Console]::In.ReadToEnd() }
function Get-StopField([string]$Name) {
  try {
    $value = ($stopText | ConvertFrom-Json).$Name
    if ($value -is [string] -and $value -match '^[A-Za-z0-9_.:-]+$') { return $value }
  } catch {
  }
  ''
}
$session = Get-StopField 'session_id'
$turn = Get-StopField 'turn_id'
$ownTurn = if ($turn) { $turn } else { Get-StopField 'prompt_id' }

function Get-Parent {
  try {
    $parentId = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop).ParentProcessId
    $parentProcess = Get-Process -Id $parentId -ErrorAction Stop
    if ($parentProcess.StartTime -le (Get-Process -Id $PID).StartTime) { return @{ Id = $parentId; Started = $parentProcess.StartTime } }
  } catch {
  }
  $null
}
$parent = Get-Parent

function Test-Orphaned {
  if (-not $parent) { return $false }
  try {
    $parentProcess = Get-Process -Id $parent.Id -ErrorAction Stop
    return $parentProcess.StartTime -ne $parent.Started
  } catch {
    return $true
  }
}

if ($Product -eq 'codex' -and $Action -eq 'wait' -and $stopText) {
  if (-not $serverName -and $stopText -match ' wake code: `?swc_[A-Za-z0-9_-]{43}') { Deliver-Text $addressMissingText }
  $offers = @()
  if ($serverName) { $offers = [regex]::Matches($stopText, [regex]::Escape($serverName) + ' wake code: `?(swc_[A-Za-z0-9_-]{43})`?(\\n)?"') }
  if ($offers.Count -gt 0) {
    if ($token -and -not (Test-Path -LiteralPath (Join-Path $dir 'stopped'))) { Deliver-Text $alreadyConnectedText }
    $offered = $offers[$offers.Count - 1].Groups[1].Value
    $transcript = ''
    try { $transcript = "$(($stopText | ConvertFrom-Json).transcript_path)" } catch { $transcript = '' }
    if (-not (Test-IssuedHere $transcript $offered)) { Deliver-Text $foreignCodeText }
    $pluginUrl = ''
    try {
      $servers = (Get-Content -LiteralPath (Join-Path $pluginRoot '.mcp.json') -Raw -Encoding UTF8 | ConvertFrom-Json).mcpServers
      $pluginUrl = "$($servers.$serverName.url)".TrimEnd('/')
    } catch {
      $pluginUrl = ''
    }
    if ($pluginUrl.EndsWith('/mcp')) { $pluginUrl = $pluginUrl.Substring(0, $pluginUrl.Length - 4) }
    if (-not $pluginUrl) { Deliver-Text $addressMissingText }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $url = $pluginUrl
    $code = $offered
    Save-Setting 'POLYROOM_WAKE_URL' $url
    Save-Setting 'POLYROOM_WAKE_TOKEN' ''
    Save-Setting 'POLYROOM_WAKE_CODE' $code
    $script:claimStatus = $null
    if (Invoke-Claim) { Deliver-Text $connectedText }
    Save-Setting 'POLYROOM_WAKE_CODE' ''
    if ($script:claimStatus -eq 0) { Deliver-Text $unreachableText }
    Deliver-Text $codeRefusedText
  }
}

if (-not (Test-Path -LiteralPath $dir -PathType Container)) { exit 0 }
if (-not $url) { exit 0 }

if ($Action -eq 'claim') {
  if (-not (Invoke-Claim)) { exit 1 }
  [Console]::Out.WriteLine('Connected: this session now wakes on polyroom notices.')
  exit 0
}

if (Test-Path -LiteralPath (Join-Path $dir 'stopped')) { exit 0 }
if (-not $token) {
  if (-not $code) { exit 0 }
  if (-not (Invoke-Claim)) { exit 0 }
}
$authorization = @{ Authorization = "Bearer $token" }
$cursorFile = Join-Path $dir 'cursor'
$pendingFile = Join-Path $dir 'pending'
function Read-Cursor {
  $savedCursor = Read-Marked $cursorFile
  if ($savedCursor.State -eq 'mine') { $savedCursor.Number } elseif ($savedCursor.State -eq 'foreign') { $unknownCursor } else { '0' }
}
$cursor = Read-Cursor

if ($Action -eq 'session-start') {
  if ((Read-Marked $pendingFile).State -ne 'mine') { exit 0 }
  $answer = Invoke-Wake 'GET' "$url/wake?after=$cursor&wait=0&format=session-start&redelivery=1" $authorization '' $margin
  if ($answer.Status -eq 200) { [Console]::Out.Write($answer.Body) }
  exit 0
}

$lock = Join-Path $dir 'wake.lock'
$staged = Join-Path $lock ".new.$PID"
$record = ''

function Exit-Busy {
  if ($Product -eq 'codex') { [Console]::Out.WriteLine((@{ systemMessage = $busyText } | ConvertTo-Json -Compress)) }
  exit 0
}

function Get-TopRecord {
  "$(@(Get-ChildItem -LiteralPath $lock -Name -File -Force -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Sort-Object { [long]$_ }) | Select-Object -Last 1)"
}

function Test-HoldsLock {
  $script:record -and (Get-TopRecord) -eq $script:record
}

function Read-Holder([string]$Name) {
  if ($Name) {
    $path = Join-Path $lock $Name
    try { $lines = @([System.IO.File]::ReadAllText($path, $utf8) -split "`n") } catch { return $null }
  } else {
    $path = Join-Path $lock 'pid'
    $lines = @("$(Read-Number (Join-Path $lock 'pid'))") + @("$(if (Test-Path -LiteralPath (Join-Path $lock 'owner')) { [System.IO.File]::ReadAllText((Join-Path $lock 'owner'), $utf8).Trim() })" -split ' ')
  }
  $holderPid = "$($lines[0])".Trim()
  @{
    Id = if ($holderPid -match '^\d+$') { [int]$holderPid } else { 0 }
    Session = if ($lines.Count -gt 1) { "$($lines[1])".Trim() } else { '' }
    Turn = if ($lines.Count -gt 2) { "$($lines[2])".Trim() } else { '' }
    Start = if ($lines.Count -gt 3) { "$($lines[3])".Trim() } else { '' }
    Path = $path
  }
}

function Get-LiveProcess([int]$Id) {
  if ($Id -gt 0 -and $Id -ne $PID) { Get-Process -Id $Id -ErrorAction SilentlyContinue } else { $null }
}

function Get-StartTicks($Process) {
  try { $started = $Process.StartTime } catch { $started = $null }
  if ($null -eq $started) { return $null }
  $started.ToUniversalTime().Ticks
}

function Test-Holding($Holder) {
  if (-not $Holder) { return $false }
  $process = Get-LiveProcess $Holder.Id
  if (-not $process) { return $false }
  if ($Holder.Start -like 'start:?*') {
    $current = Get-StartTicks $process
    $held = 0L
    return $null -ne $current -and [long]::TryParse($Holder.Start.Substring(6), [ref]$held) -and [Math]::Abs($held - $current) -le $startToleranceMs * 10000L
  }
  try { $written = [System.IO.File]::GetLastWriteTimeUtc($Holder.Path) } catch { return $false }
  ([DateTime]::UtcNow - $written).TotalSeconds -le ($budget + $margin)
}

function Wait-LockTest([string]$Seen) {
  $gate = $env:POLYROOM_WAKE_LOCK_TEST_GATE
  if (-not $gate) { return }
  [System.IO.File]::WriteAllText((Join-Path $gate "$PID"), "$Seen`n", $utf8)
  for ($tries = 0; $tries -lt 400 -and -not (Test-Path -LiteralPath (Join-Path $gate "$PID.go")); $tries++) { Start-Sleep -Milliseconds 50 }
}

function Get-EarlierHolders {
  $ids = @()
  foreach ($name in @(Get-ChildItem -LiteralPath $lock -Name -File -Force -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' -and [long]$_ -lt [long]$script:record })) {
    $old = Read-Holder $name
    if (Test-Holding $old) { $ids += $old.Id }
  }
  $legacy = Read-Holder ''
  if (Test-Holding $legacy) { $ids += $legacy.Id }
  , $ids
}

function Stop-EarlierHolders {
  foreach ($id in (Get-EarlierHolders)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  for ($tries = 0; $tries -lt 60 -and (Get-EarlierHolders).Count -gt 0; $tries++) { Start-Sleep -Milliseconds 100 }
  (Get-EarlierHolders).Count -eq 0
}

function Clear-OldRecords {
  foreach ($name in @(Get-ChildItem -LiteralPath $lock -Name -File -Force -ErrorAction SilentlyContinue)) {
    $path = Join-Path $lock $name
    if ($name -match '^\.new\.(\d+)$') {
      if (-not (Get-LiveProcess ([int]$Matches[1]))) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    } elseif ($name -match '^\d+$' -and [long]$name -lt [long]$script:record) {
      $old = Read-Holder $name
      if (-not (Test-Holding $old)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }
  $legacy = Read-Holder ''
  if (-not (Test-Holding $legacy)) {
    Remove-Item -LiteralPath (Join-Path $lock 'pid'), (Join-Path $lock 'owner') -Force -ErrorAction SilentlyContinue
  }
}

try {
  New-Item -ItemType Directory -Path $lock -Force | Out-Null
  $top = Get-TopRecord
  $holder = Read-Holder $top
  if (-not $holder) { Exit-Busy }
  if ((Test-Holding $holder) -and (-not $session -or $holder.Session -ne $session -or $holder.Turn -eq $ownTurn)) { Exit-Busy }
  $topNumber = if ($top) { [long]$top } else { [long]0 }
  Wait-LockTest "$topNumber"
  $next = "$($topNumber + 1)"
  try {
    $ownStart = Get-StartTicks (Get-Process -Id $PID)
    $ownMark = if ($null -ne $ownStart) { "start:$ownStart" } else { '' }
    [System.IO.File]::WriteAllText($staged, "$PID`n$session`n$ownTurn`n$ownMark`n", $utf8)
    [System.IO.File]::Move($staged, (Join-Path $lock $next))
  } catch {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    Exit-Busy
  }
  $record = $next
  if (-not (Stop-EarlierHolders) -or -not (Test-HoldsLock)) { exit 0 }
  Clear-OldRecords
  $cursor = Read-Cursor

  $savedPending = Read-Marked $pendingFile
  if ($savedPending.State -eq 'mine' -and (-not $savedPending.Turn -or $savedPending.Turn -eq $turn)) {
    $cursor = $savedPending.Number
    Write-Marked $cursorFile $cursor
  }
  Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue

  $format = if ($Product -eq 'codex') { 'stop' } else { 'text' }
  $deadline = [DateTime]::UtcNow.AddSeconds($budget)
  $backoff = $retryMin
  while ($true) {
    $left = [int][Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
    $waitNow = $waitSeconds
    if ($waitNow + $margin -gt $left) { $waitNow = $left - $margin }
    if ($waitNow -lt 1) { break }
    if (-not (Test-ConnectedAsBefore) -or (Test-Orphaned) -or -not (Test-HoldsLock)) { exit 0 }
    $answer = Invoke-Wake 'GET' "$url/wake?after=$cursor&wait=$waitNow&format=$format" $authorization '' ($waitNow + $margin)
    if (-not (Test-ConnectedAsBefore)) {
      if ($answer.Status -eq 200 -and $answer.Cursor -match '^\d+$') { Deliver-Body $answer.Body }
      exit 0
    }
    if ($answer.Status -eq 200 -and $answer.Cursor -match '^\d+$') {
      if ((Test-Orphaned) -or -not (Test-HoldsLock)) { exit 0 }
      Write-Marked $pendingFile $answer.Cursor $turn
      Deliver-Body $answer.Body
    }
    if (-not (Test-HoldsLock)) { exit 0 }
    if ($answer.Status -eq 204) {
      if ($cursor -eq $unknownCursor -and $answer.Cursor -eq $unknownCursor) {
        $cursor = '0'
        Write-Marked $cursorFile $cursor
      } elseif ($answer.Cursor -match '^\d+$' -and $answer.Cursor -ne $cursor) {
        $cursor = $answer.Cursor
        Write-Marked $cursorFile $cursor
      }
      $backoff = $retryMin
      continue
    }
    if ($answer.Status -eq 401 -or $answer.Status -eq 403) {
      [System.IO.File]::WriteAllText((Join-Path $dir 'stopped'), '', $utf8)
      Deliver-Text $refusedText
    }
    $left = [int][Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds) - $margin
    if ($left -lt 1) { break }
    Start-Sleep -Seconds ([Math]::Min($backoff, $left))
    $backoff = [Math]::Min($backoff * 2, $retryMax)
  }
  if (-not (Test-HoldsLock)) { exit 0 }
  Deliver-Text $idleText
} finally {
  Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
  if ($record) {
    if (Test-HoldsLock) {
      try { [System.IO.File]::WriteAllText((Join-Path $lock $record), "released`n", $utf8) } catch {}
    } else {
      Remove-Item -LiteralPath (Join-Path $lock $record) -Force -ErrorAction SilentlyContinue
    }
  }
}
