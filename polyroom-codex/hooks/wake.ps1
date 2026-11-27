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

$appUrl = "$env:POLYROOM_WAKE_URL"
$appToken = "$env:POLYROOM_WAKE_TOKEN"
$appMode = [bool]($appUrl -or $appToken)
if ($appMode) {
  if ($Action -eq 'claim') {
    [Console]::Error.WriteLine('This session was opened by the polyroom app, which already connected it, so it takes no connection code.')
    exit 1
  }
  if (-not $env:POLYROOM_WAKE_DIR) { exit 0 }
  if ($appUrl -cnotmatch '^(?:https://[^/]|http://127\.0\.0\.1(?:[:/]|\z))' -or $appUrl -match '[\s\x00-\x1f\x7f?#@]') { exit 0 }
  if ($appToken -cnotmatch '^saw_[A-Za-z0-9_-]+\z') { exit 0 }
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
$appCodeText = 'This conversation was opened by the polyroom app, which already connected it, so the connection code was not used. Tell the person in one sentence that it is already connected, then end the turn.'
$appRefusedText = 'The chat refused the polyroom wake token, so this session stopped waiting for notices: the connection was removed or expired, or the agent or its workspace was deleted. Tell the person in one sentence, and say they can connect this agent again in the polyroom app.'

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
  $appMode -or (Read-Settings)['POLYROOM_WAKE_TOKEN'] -eq $script:token
}

function Remove-Files([string[]]$Paths) {
  foreach ($path in $Paths) { try { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue } catch { } }
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
    Remove-Files $temporary
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
  if ($parts.Count -eq 1 -and $parts[0] -match '^\d+$') { if ($appMode) { return @{ State = 'foreign' } }; return @{ State = 'mine'; Number = $parts[0] } }
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
if ($appMode) {
  $url = $appUrl.TrimEnd('/')
  $token = $appToken
  $code = ''
} else {
  $url = "$($settings['POLYROOM_WAKE_URL'])".TrimEnd('/')
  $token = "$($settings['POLYROOM_WAKE_TOKEN'])"
  $code = "$($settings['POLYROOM_WAKE_CODE'])"
}
$budget = Number-Setting $settings 'POLYROOM_WAKE_BUDGET_SECONDS' 1740
$waitSeconds = Number-Setting $settings 'POLYROOM_WAKE_WAIT_SECONDS' 20
$margin = Number-Setting $settings 'POLYROOM_WAKE_MARGIN_SECONDS' 15
$retryMin = Number-Setting $settings 'POLYROOM_WAKE_RETRY_MIN_SECONDS' 2
$retryMax = Number-Setting $settings 'POLYROOM_WAKE_RETRY_MAX_SECONDS' 60
$startToleranceMs = Number-Setting $settings 'POLYROOM_WAKE_START_TOLERANCE_MS' 100
$icaclsTimeoutMs = [Math]::Max((Number-Setting $settings 'POLYROOM_WAKE_ICACLS_TIMEOUT_MS' 10000), 1000)
$unknownCursor = '999999999999999'
$userAgent = 'polyroom-wake/1'

foreach ($leftover in @(Get-ChildItem -LiteralPath $dir -Filter 'wake.env.*.tmp' -File -ErrorAction SilentlyContinue)) {
  if ($leftover.Name -match '^wake\.env\.(\d{1,9})\.tmp$' -and ([int]$Matches[1] -eq $PID -or -not (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue))) {
    Remove-Files $leftover.FullName
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
    Remove-Files (Join-Path $dir 'stopped'), (Join-Path $dir 'pending')
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
    [Console]::Out.WriteLine(([ordered]@{ decision = 'block'; reason = $Text } | ConvertTo-Json -Compress))
    exit 0
  }
  [Console]::Error.WriteLine($Text)
  exit 2
}

$ownerOnlyMark = Join-Path $dir '.owner-only'
$hookFiles = @('wake.env', 'cursor', 'pending', 'pending-session', 'stopped', 'wake.lock')
$folderProblem = "polyroom could not keep its wake folder $dir to this Windows account alone"
$folderCheck = 'check that the folder holds only the files of polyroom and that this Windows account owns it and can change its permissions'
$folderStop = "folder`n"

function Test-HookEntry([string]$Name) {
  ($hookFiles + @('.owner-only', 'declined')) -ccontains $Name -or $Name -cmatch '^wake\.env\.\d+\.tmp$' -or $Name -cmatch '^\.(?:auth|headers|body|status)\.\d+$'
}

function Test-OnlyHookEntries {
  try {
    foreach ($entry in @(Get-ChildItem -LiteralPath $dir -Force -Name -ErrorAction Stop)) { if (-not (Test-HookEntry $entry)) { return $false } }
    return $true
  } catch {
    return $false
  }
}

function Format-Argument([string]$Value) {
  if ($Value -and $Value -notmatch '[\s"]') { return $Value }
  '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-WindowsTool([string]$Name, [string[]]$Arguments) {
  $root = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path (Join-Path $root 'System32') $Name
  $start.Arguments = (@($Arguments | ForEach-Object { Format-Argument $_ })) -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($start)
  try {
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEndAsync()
    $null = $process.StandardError.ReadToEndAsync()
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $process.HasExited) {
      if ($clock.ElapsedMilliseconds -ge $icaclsTimeoutMs) { throw "$Name passed its time limit" }
      Start-Sleep -Milliseconds 25
    }
    if ($process.ExitCode -ne 0) { throw "$Name ended with $($process.ExitCode)" }
    $output.Result
  } finally {
    if (-not $process.HasExited) { try { $process.Kill() } catch {} }
    $process.Dispose()
  }
}

function Get-OwnerSid {
  $found = @([regex]::Matches((Invoke-WindowsTool 'whoami.exe' @('/user', '/fo', 'csv', '/nh')), 'S-1-\d+(?:-\d+)+'))
  if ($found.Count -ne 1) { throw 'whoami did not name one account' }
  $found[0].Value
}

function Test-OnlyOwnerFull([string]$Path, [string]$Sid) {
  $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $Sid) { return $false }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) { return $false }
  $rule = $rules[0]
  $inheritance = if (Test-Path -LiteralPath $Path -PathType Container) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
  $applies = $rule.IdentityReference.Value -ceq $Sid -and
    $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $rule.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
    $rule.InheritanceFlags -eq $inheritance -and
    $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None
  if ($Path -ceq $dir) { return $applies -and $acl.AreAccessRulesProtected -and -not $rule.IsInherited }
  $applies
}

function Keep-FolderToOwner([bool]$BeforeToken) {
  if (-not (Test-OnlyHookEntries)) {
    Remove-Item -LiteralPath $ownerOnlyMark -Force -ErrorAction SilentlyContinue
    return $false
  }
  if (-not $BeforeToken -and (Test-Path -LiteralPath $ownerOnlyMark)) { return $true }
  Remove-Item -LiteralPath $ownerOnlyMark -Force -ErrorAction SilentlyContinue
  try {
    $sid = Get-OwnerSid
    $files = @($hookFiles | ForEach-Object { Join-Path $dir $_ } | Where-Object { Test-Path -LiteralPath $_ })
    Invoke-WindowsTool 'icacls.exe' @($dir, '/setowner', "*$sid") | Out-Null
    Invoke-WindowsTool 'icacls.exe' @($dir, '/reset') | Out-Null
    Invoke-WindowsTool 'icacls.exe' @($dir, '/inheritance:r', '/grant:r', "*${sid}:(OI)(CI)F") | Out-Null
    foreach ($file in $files) {
      Invoke-WindowsTool 'icacls.exe' @($file, '/setowner', "*$sid") | Out-Null
      Invoke-WindowsTool 'icacls.exe' @($file, '/reset') | Out-Null
    }
    foreach ($path in @($dir) + $files) {
      if (-not (Test-OnlyOwnerFull $path $sid)) { return $false }
    }
    [System.IO.File]::WriteAllText($ownerOnlyMark, '', $utf8)
    return $true
  } catch {
    return $false
  }
}

function Test-Text($Value, [string]$Expected) {
  ($Value -is [string]) -and [string]::Equals($Value, $Expected, [System.StringComparison]::Ordinal)
}

function Test-WakeCodeCall([string]$Line, [string]$Offered) {
  try { $record = $Line | ConvertFrom-Json } catch { return $false }
  if ($record -isnot [System.Management.Automation.PSCustomObject]) { return $false }
  $item = $record.payload.item
  (Test-Text $record.type 'event_msg') -and (Test-Text $record.payload.type 'item_completed') -and (Test-Text $item.type 'McpToolCall') -and (Test-Text $item.server $serverName) -and
    (Test-Text $item.tool 'chat_wake_code') -and (Test-Text $item.status 'completed') -and -not (($item.result.isError -is [bool]) -and $item.result.isError) -and (Test-Text $item.result.structuredContent.code $Offered)
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
          if ($line.Contains($Offered) -and (Test-WakeCodeCall $line $Offered)) { return $true }
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

if ($Product -eq 'codex' -and $Action -eq 'wait' -and $stopText -and $appMode) {
  $appCodePattern = $(if ($serverName) { [regex]::Escape($serverName) + ' wake code: `?swc_[A-Za-z0-9_-]{43}`?(\\n)?"' } else { ' wake code: `?swc_[A-Za-z0-9_-]{43}' })
  if ([regex]::IsMatch($stopText, $appCodePattern)) { Deliver-Text $appCodeText }
}

if ($Product -eq 'codex' -and $Action -eq 'wait' -and $stopText -and -not $appMode) {
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
    if (-not (Keep-FolderToOwner $true)) { Deliver-Text "$folderProblem, so this conversation is not connected and the code was not used. Tell the person to $folderCheck, and run the polyroom connect skill again only if they ask." }
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
$stoppedFile = Join-Path $dir 'stopped'
if (-not (Keep-FolderToOwner ($Action -eq 'claim' -or (-not $token -and $code -ne '')))) {
  if ($Action -eq 'claim') {
    [Console]::Error.WriteLine("$folderProblem, so the code was not used: $folderCheck, then run the connect skill again.")
    exit 1
  }
  if ($Action -eq 'session-start' -or -not ($token -or $code) -or (Test-Path -LiteralPath $stoppedFile)) { exit 0 }
  try { [System.IO.File]::WriteAllText($stoppedFile, $folderStop, $utf8) } catch { exit 0 }
  Deliver-Text "$folderProblem, so this session stopped waiting for notices and did not use its token. Tell the person in one sentence to $folderCheck; the session waits again by itself once that is fixed."
}
if ((Test-Path -LiteralPath $stoppedFile -PathType Leaf) -and [System.IO.File]::ReadAllText($stoppedFile, $utf8) -ceq $folderStop) { Remove-Item -LiteralPath $stoppedFile -Force -ErrorAction SilentlyContinue }
if (-not $url) { exit 0 }

if ($Action -eq 'claim') {
  if (-not (Invoke-Claim)) { exit 1 }
  [Console]::Out.WriteLine('Connected: this session now wakes on polyroom notices.')
  exit 0
}

$stoppedFile = Join-Path $dir 'stopped'
if ($(if ($appMode) { (Read-Marked $stoppedFile).State -eq 'mine' } else { Test-Path -LiteralPath $stoppedFile })) { exit 0 }
if (-not $token) {
  if (-not $code) { exit 0 }
  if (-not (Invoke-Claim)) { exit 0 }
}
$authorization = @{ Authorization = "Bearer $token" }
$cursorFile = Join-Path $dir 'cursor'
$pendingFile = Join-Path $dir 'pending'
function Read-Cursor {
  $savedCursor = Read-Marked $cursorFile
  if ($savedCursor.State -eq 'mine') { $savedCursor.Number } elseif ($savedCursor.State -eq 'foreign' -or $appMode) { $unknownCursor } else { '0' }
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
    Connection = if ($Name -and $lines.Count -gt 4) { "$($lines[4])".Trim() } else { '' }
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
      if (-not (Get-LiveProcess ([int]$Matches[1]))) { Remove-Files $path }
    } elseif ($name -match '^\d+$' -and [long]$name -lt [long]$script:record) {
      $old = Read-Holder $name
      if (-not (Test-Holding $old)) { Remove-Files $path }
    }
  }
  $legacy = Read-Holder ''
  if (-not (Test-Holding $legacy)) {
    Remove-Files (Join-Path $lock 'pid'), (Join-Path $lock 'owner')
  }
}

try {
  New-Item -ItemType Directory -Path $lock -Force | Out-Null
  $top = Get-TopRecord
  $holder = Read-Holder $top
  if (-not $holder) { Exit-Busy }
  $holderReplaced = -not $appMode -and $holder.Connection -and $holder.Connection -ne (Get-TokenMark) -and (Test-ConnectedAsBefore)
  if ((Test-Holding $holder) -and -not $holderReplaced -and (-not $session -or $holder.Session -ne $session -or $holder.Turn -eq $ownTurn)) { Exit-Busy }
  $topNumber = if ($top) { [long]$top } else { [long]0 }
  Wait-LockTest "$topNumber"
  $next = "$($topNumber + 1)"
  try {
    $ownStart = Get-StartTicks (Get-Process -Id $PID)
    $ownMark = if ($null -ne $ownStart) { "start:$ownStart" } else { '' }
    [System.IO.File]::WriteAllText($staged, "$PID`n$session`n$ownTurn`n$ownMark`n$(Get-TokenMark)`n", $utf8)
    [System.IO.File]::Move($staged, (Join-Path $lock $next))
  } catch {
    Remove-Files $staged
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
  Remove-Files $pendingFile

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
      if ($appMode) {
        Write-Marked $stoppedFile '0'
        Deliver-Text $appRefusedText
      }
      [System.IO.File]::WriteAllText($stoppedFile, '', $utf8)
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
  Remove-Files $staged
  if ($record) {
    if (Test-HoldsLock) {
      try { [System.IO.File]::WriteAllText((Join-Path $lock $record), "released`n", $utf8) } catch {}
    } else {
      Remove-Files (Join-Path $lock $record)
    }
  }
}
