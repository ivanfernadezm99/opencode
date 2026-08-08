<#
.SYNOPSIS
    Runtime harness for install.ps1 PR3 update-safety. Unlike the static suite
    (test-installer.ps1), this harness ACTUALLY EXECUTES the real functions
    AST-extracted from install.ps1 and asserts their runtime behavior.

.DESCRIPTION
    The static suite only greps for string presence. Reviewers repeatedly caught
    real runtime bugs (null-deref on empty stderr temp file, a cron-name matcher
    that never matches, quarantine windows) that presence-greps cannot see. This
    harness institutionalizes the reviewer's "manual probe" approach: parse
    install.ps1, slice each needed function's verbatim source by AST extent,
    redefine them in an isolated runspace with stub writers, then run behavioral
    probes against the same code paths a Windows update exercises.

    Probes:
      1. Invoke-NativeRedirected with EMPTY stderr   -> must NOT throw (round-3 BLOCKER)
      2. stderr content + non-zero exit              -> exit code captured, temp cleaned
      3. exe missing                                 -> ExitCode -1, never false success
      4. Test-CronJobNameExists vs REAL formatJobRow -> exact full-name only (CRITICAL)
      5. B1 quarantine airtightness                  -> no restorable partial survives
      6. Sidecar purge only when backup holds the DB ; empty backup never deletes live -wal
      7. Empty-backup (cache-only / only-excluded)   -> legit $true vs copy failure -> not-success
      8. Four Restore-Path returns all complete      -> every marked-complete backup restores
      9. User-block seed retry idempotence           -> exact matcher prevents re-add
     10. PS5.1 hazard scan                           -> no residual 2>&1 merge of native stderr

.PARAMETER Path
    Path to install.ps1 to harness. Default: repo root relative.
.PARAMETER KeepInner
    Keep the generated inner probe script on disk for inspection.

.EXAMPLE
    pwsh .opencode/scripts/install-runtime-harness.ps1
#>
param(
    [string]$Path,
    [switch]$KeepInner,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

# --------------------------------------------------------------------------
# Resolve install.ps1
# --------------------------------------------------------------------------
if (-not $Path) {
    $harnessDir = Split-Path $PSScriptRoot -Parent
    $Path = Join-Path $harnessDir "install.ps1"
}
if (-not (Test-Path $Path)) {
    Write-Host "ERROR: install.ps1 not found at $Path" -ForegroundColor Red
    exit 1
}
$Path = (Resolve-Path $Path).Path
$sourceText = Get-Content -Path $Path -Raw

$script:passed = 0; $script:failed = 0; $script:skipped = 0
function T { param([string]$N, [switch]$Pass, [string]$Detail = "")
    if ($Pass) { $script:passed++; if (-not $Quiet) { Write-Host "  PASS  $N  $Detail" -ForegroundColor Green } }
    else       { $script:failed++; Write-Host "  FAIL  $N  $Detail" -ForegroundColor Red }
}

Write-Host "`n=== install.ps1 Runtime Harness ===" -ForegroundColor Cyan
Write-Host "Script: $Path`n" -ForegroundColor DarkGray

# ----------------------------------------------------------------------------
# 1) AST-EXTRACT verbatim function bodies
# ----------------------------------------------------------------------------
function Get-InstallFunctionBodies {
    param([string]$Source, [string[]]$Names)
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Source, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        throw "install.ps1 did not parse cleanly"
    }
    $found = @{}
    $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) |
        ForEach-Object {
            $fn = [System.Management.Automation.Language.FunctionDefinitionAst]$_
            if ($Names -contains $fn.Name) {
                $found[$fn.Name] = $Source.Substring($fn.Extent.StartOffset, $fn.Extent.EndOffset - $fn.Extent.StartOffset)
            }
        }
    return $found
}

$required = @(
    "Write-Info", "Write-Success", "Write-Warn", "Write-Err",
    "Invoke-NativeRedirected", "Test-CronJobNameExists",
    "Set-BackupCompleteMarker", "Quarantine-PartialBackup",
    "Backup-Path", "Restore-Path", "Enforce-BackupRetention"
)
$realFns = Get-InstallFunctionBodies -Source $sourceText -Names $required
$missing = @($required | Where-Object { -not $realFns.ContainsKey($_) })
if ($missing.Count -gt 0) {
    Write-Host "ERROR: functions missing from install.ps1: $($missing -join ', ')" -ForegroundColor Red
    exit 1
}

# ----------------------------------------------------------------------------
# 2) Stub block (insulate the real functions from machine side-effects)
#    Children return a SIMPLE TEXT result protocol (id|1|detail) - never JSON,
#    because the prior draft's ConvertTo-Json bool round-trip flipped PASS/FAIL.
# ----------------------------------------------------------------------------
$stubs = @'
function Write-Info    { param([string]$Message)  }
function Write-Success { param([string]$Message)  }
function Write-Warn    { param([string]$Message)  }
function Write-Err     { param([string]$Message)  }
function Write-Step    { param([string]$Message)  }
function Stop-Transcript { param([switch]$ErrorAction) }
function Stop-WithError  { param([string]$Message) throw $Message }
function Stop-CronHolders {}
function Invoke-TaskKill { param([string]$ImageName) }
$script:backupStamp = ""
$ErrorActionPreference = "Continue"
$env:TEMP = $env:PROBE_TEMP
'@

# ----------------------------------------------------------------------------
# 3) The probe body (same runspace as the real functions) ----------------------
# ----------------------------------------------------------------------------
$probes = @'
$out = [System.Collections.Generic.List[string]]::new()
function Record { param([string]$Id,[int]$Ok,[string]$Detail="")
  # Plain text: "id  ok(0|1)  detail". ok is an INT, immune to JSON bool coercion.
  $script:out.Add("$Id`t$Ok`t$Detail") }
function Reset-Dir { param([string]$p) if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }; New-Item -ItemType Directory -Path $p -Force | Out-Null }
function Set-MarkerComplete { param([string]$dir) Add-Content -Path (Join-Path $dir ".backup-complete") -Value "complete" }

$scratch = Join-Path $env:PROBE_TEMP "scratch-$PID"
Reset-Dir $scratch
$sh = if (Get-Command '/bin/sh' -ErrorAction SilentlyContinue) { '/bin/sh' } else { 'cmd' }

# --- P1: EMPTY stderr (round-3 BLOCKER) --------------------------------------
try {
    if ($sh -eq '/bin/sh') { $r1 = Invoke-NativeRedirected -FilePath '/bin/sh' -Arguments @('-c','echo stdout-only') -Label 'empty1' }
    else                   { $r1 = Invoke-NativeRedirected -FilePath 'cmd' -Arguments @('/d','/c','echo stdout-only') -Label 'empty1' }
    $ok1 = ($null -ne $r1) -and ($r1.ExitCode -eq 0) -and ([string]::IsNullOrEmpty([string]$r1.Stderr))
    Record 'P1-empty-stderr' $(if ($ok1) {1} else {0}) ("ExitCode=$($r1.ExitCode) Stderr='[$($r1.Stderr)]'")
} catch { Record 'P1-empty-stderr' 0 ("THREW: " + $_.Exception.Message) }

# --- P2: stderr content + non-zero exit; temp cleaned ------------------------
$before2 = @(Get-ChildItem $env:PROBE_TEMP -Filter 'opencode-empty2-*.log' -ErrorAction SilentlyContinue).Count
try {
    if ($sh -eq '/bin/sh') { $r2 = Invoke-NativeRedirected -FilePath '/bin/sh' -Arguments @('-c','echo boom >&2; exit 3') -Label 'empty2' }
    else                   { $r2 = Invoke-NativeRedirected -FilePath 'cmd' -Arguments @('/d','/c','cmd /c echo boom 1>&2 & exit /b 3') -Label 'empty2' }
    $after2 = @(Get-ChildItem $env:PROBE_TEMP -Filter 'opencode-empty2-*.log' -ErrorAction SilentlyContinue).Count
    $ok2 = ($r2.ExitCode -eq 3) -and ($r2.Stderr -imatch 'boom') -and ($after2 -le $before2)
    Record 'P2-stderr-nonzero' $(if ($ok2) {1} else {0}) ("Exit=$($r2.ExitCode) Stderr='[$($r2.Stderr)]' leftover=$after2")
} catch { Record 'P2-stderr-nonzero' 0 ("THREW: " + $_.Exception.Message) }

# --- P3: exe missing -> ExitCode -1, no false success ------------------------
try {
    $r3 = Invoke-NativeRedirected -FilePath '/no/such/opencode.exe' -Arguments @('cron','list') -Label 'missing'
    $ok3 = ($r3.ExitCode -eq -1) -and (($null -eq $r3.Output) -or (@($r3.Output).Count -eq 0))
    Record 'P3-exe-missing' $(if ($ok3) {1} else {0}) "ExitCode=$($r3.ExitCode) outputCount=$(@($r3.Output).Count)"
} catch { Record 'P3-exe-missing' 0 ("THREW(reported not-success): " + $_.Exception.Message) }

# --- P4: Test-CronJobNameExists against the REAL formatJobRow -----------------
# cron.ts formatJob: `ID${shortId.padEnd(40)} NAME...` - ID is 40 wide (cols 0-39),
# then ONE literal space separator at col 40, then NAME cell starts col 41,
# name is written name.padEnd(18) so wider names overflow verbatim. Exact-match
# per cell: an 18-char padded cell, or the whole name when longer than 18.
function Format-Row { param($Id,$Name,$Sched,$Next,$State)
    '{0} {1} {2} {3} {4}' -f $Id.PadRight(40), $Name.PadRight(18), $Sched.PadRight(18), $Next.PadRight(26), $State
}
$rows4 = @(
    (Format-Row 'abc12345' 'Recordatorio cargar horas Redmine' '30 17 * * 1-5' '2026-08-30 17:30' 'active'),
    (Format-Row 'def67890' 'daily-jobs'                        'every 60s'       '2026-08-30 17:30' 'active'),
    (Format-Row 'ghi11223' 'daily-jobs-backup'                 '0 0 * * *'       '2026-08-30 00:00' 'active')
)
try {
    $mFull = Test-CronJobNameExists -ListLines $rows4 -Name 'Recordatorio cargar horas Redmine'
    $mWord = Test-CronJobNameExists -ListLines $rows4 -Name 'daily-jobs'
    $mPref = Test-CronJobNameExists -ListLines $rows4 -Name 'Recordatorio'       # prefix => false
    $mMiss = Test-CronJobNameExists -ListLines $rows4 -Name 'missing-name'      # absent => false
    $ok4 = ($mFull -eq $true) -and ($mWord -eq $true) -and ($mPref -eq $false) -and ($mMiss -eq $false)
    Record 'P4-matcher-real-layout' $(if ($ok4) {1} else {0}) "full=$([bool]$mFull) single=$([bool]$mWord) prefix=$([bool]$mPref) absent=$([bool]$mMiss)"
} catch { Record 'P4-matcher-real-layout' 0 ("THREW: " + $_.Exception.Message) }

# --- P5: B1 quarantine airtightness -------------------------------------------
$script:backupStamp = 'probe5stamp'
$srcGood = Join-Path $scratch 'goodSrc'; Reset-Dir $srcGood
'db' | Set-Content (Join-Path $srcGood 'sessions.db')
$dstGood = Join-Path $scratch 'goodDst'
$bpOk = Backup-Path -Src $srcGood -Dst $dstGood
$rstGood = Restore-Path -Backup $dstGood -Target (Join-Path $scratch 'livesrc1')
$ok5a = ($bpOk -eq $true) -and (Test-Path (Join-Path $dstGood '.backup-complete')) -and ($rstGood -eq $true) -and (Test-Path (Join-Path $scratch 'livesrc1' 'sessions.db'))
Record 'P5a-good-restorable' $(if ($ok5a) {1} else {0}) "bp=$bpOk marker=$([bool](Test-Path (Join-Path $dstGood '.backup-complete'))) restore=$rstGood"

# copy failure: backup dst under a FILE parent -> Copy-Item throws & no marker
$bf = Join-Path $scratch 'blocker'; 'not-a-dir' | Set-Content $bf
$badDst = Join-Path (Join-Path $bf 'nested') 'sub'
$threw5b = $false
try { $bp5b = Backup-Path -Src $srcGood -Dst $badDst } catch { $threw5b = $true }
$ok5b = $threw5b -and (-not (Test-Path (Join-Path $badDst '.backup-complete')))
Record 'P5b-copy-fail' $(if ($ok5b) {1} else {0}) "threw=$threw5b markerAbsent=$(-not (Test-Path (Join-Path $badDst '.backup-complete')))"

# rename-FAIL quarantine (B1a failure path): force BOTH the rename to fail AND
# the delete fallback to fail, so Quarantine-PartialBackup's catch must write the
# `.incomplete` sentinel and Restore-Path must refuse. (Post-gate hardening —
# the prior probe let Rename-Item succeed, so the sentinel branch never ran.)
#   - Make the rename fail: pre-create the quarantine destination
#     "$partial.incomplete-$stamp" as an existing FILE. Rename-Item cannot move a
#     directory onto an existing file of a different type (fails on Win + Unix).
#   - Make the delete fail: hold an exclusive lock / read-only nested subdir so
#     Remove-Item -Recurse cannot clear it, forcing the sentinel-write branch.
$partial = Join-Path $scratch 'partialDir'; Reset-Dir $partial
'x' | Set-Content (Join-Path $partial 'x.db')
# Block the rename: pre-create the exact quarantine destination as an ordinary file.
$quakeDst = "$partial.incomplete-$script:backupStamp"
'collision' | Set-Content $quakeDst
# Block the delete fallback: a nested subdir the removal cannot empty.
$frozen = Join-Path $partial 'frozen'; New-Item -ItemType Directory -Path $frozen -Force | Out-Null
'lockfile' | Set-Content (Join-Path $frozen 'lock.db')
$lockStream = $null
if ($sh -eq '/bin/sh') {
    # POSIX: an unwritable nested dir makes Remove-Item -Recurse fail on contents.
    & chmod 555 $frozen | Out-Null
} else {
    # Windows: hold an exclusive open handle on the nested file so delete fails.
    $lockStream = [System.IO.File]::Open((Join-Path $frozen 'lock.db'), 'Open', 'ReadWrite', [System.IO.FileShare]::None)
}
$qRes = Quarantine-PartialBackup -Dst $partial
if ($null -ne $lockStream) { $lockStream.Dispose(); $lockStream = $null }
if ($sh -eq '/bin/sh') { & chmod 755 $frozen 2>$null }
$partialRemains = Test-Path $partial
$sentinel = if ($partialRemains) { Test-Path (Join-Path $partial '.incomplete') } else { $false }
$refuse = Restore-Path -Backup $partial -Target (Join-Path $scratch 'qtarget')
# The failure path must write the sentinel AND Restore must refuse (never restore
# a partial that physically survived quarantine).
$ok5c = ($qRes -eq $true) -and $partialRemains -and $sentinel -and ($refuse -eq $false)
Record 'P5c-rename-fail' $(if ($ok5c) {1} else {0}) "quarantine=$qRes partialExists=$partialRemains sentinel=$sentinel refuse=$refuse"

# --- P6: sidecar purge safety --------------------------------------------------
# Purge case: backup holds opencode.db base but NO -wal; a live stale -wal in
# target must be REMOVED on restore (so an old stray WAL never replays).
$srcDB = Join-Path $scratch 'dbSrc'; Reset-Dir $srcDB
'db' | Set-Content (Join-Path $srcDB 'opencode.db')
$dstDB = Join-Path $scratch 'dbDst'
Backup-Path -Src $srcDB -Dst $dstDB | Out-Null
$tgtDB = Join-Path $scratch 'dbTgt'; Reset-Dir $tgtDB
'live-db' | Set-Content (Join-Path $tgtDB 'opencode.db')
'stale-live-wal' | Set-Content (Join-Path $tgtDB 'opencode.db-wal')
Restore-Path -Backup $dstDB -Target $tgtDB | Out-Null
$walPurged = -not (Test-Path (Join-Path $tgtDB 'opencode.db-wal'))
# Empty-backup case: a backup dir with .backup-complete but NO .db must never
# delete a LIVE -wal in the target.
$emptyBk = Join-Path $scratch 'emptyBk'; Reset-Dir $emptyBk
Set-MarkerComplete $emptyBk
$tgtE = Join-Path $scratch 'tgtE'; Reset-Dir $tgtE
'keep' | Set-Content (Join-Path $tgtE 'other.db-wal')
Restore-Path -Backup $emptyBk -Target $tgtE | Out-Null
$walKept = Test-Path (Join-Path $tgtE 'other.db-wal')
Record 'P6-sidecar-purge' $(if ($walPurged -and $walKept) {1} else {0}) "purgeWithDb=$walPurged emptyBkKeepsWal=$walKept"

# --- P7: empty-backup legality ---------------------------------------------------
$srcCache = Join-Path $scratch 'cacheSrc'; Reset-Dir $srcCache
New-Item -ItemType Directory -Path (Join-Path $srcCache 'GPUCache') -Force | Out-Null
$dstCache = Join-Path $scratch 'cacheDst'
$ok7 = (Backup-Path -Src $srcCache -Dst $dstCache -Exclude @('GPUCache')) -eq $true
$srcEmpty = Join-Path $scratch 'emptyNoCache'; Reset-Dir $srcEmpty
$dstEmpty = Join-Path $scratch 'emptyNoCacheDst'
$ok7b = $false
try { $bp7 = Backup-Path -Src $srcEmpty -Dst $dstEmpty; if ($bp7 -eq $false) { $ok7b = $true } }
catch { $ok7b = $true }
Record 'P7-empty-backup-legality' $(if ($ok7 -and $ok7b) {1} else {0}) "cacheOnlyTrue=$ok7 emptyNoCacheIsNotSuccess=$ok7b"

# --- P8: four COMPLETE backups restore --------------------------------------------
$fs8 = @('s','desktop','cfg','engram')
$allOk8 = $true
foreach ($c in $fs8) {
    $bkP = Join-Path $scratch ("bk-$c"); Reset-Dir $bkP
    Set-MarkerComplete $bkP
    if (-not (Restore-Path -Backup $bkP -Target (Join-Path $scratch "tg-$c"))) { $allOk8 = $false }
}
$ok8 = $allOk8
Record 'P8-four-restore-paths' $(if ($ok8) {1} else {0}) "four-complete-restores=$ok8"

# --- P9: user-block seed retry idempotence --------------------------------------
$rows9 = @(
    (Format-Row 'aaaa1111' 'Run Every Day' '0 12 * * *' '2026-08-30 12:00' 'active'),
    (Format-Row 'bbbb2222' 'Run Every Day' '0 12 * * *' '2026-08-30 12:00' 'active')
)
$manifestName = 'Run Every Day'
$seen = Test-CronJobNameExists -ListLines $rows9 -Name $manifestName
$addIfMissing = -not $seen
$ok9 = ($seen -eq $true) -and (-not $addIfMissing)
Record 'P9-retry-idempotent' $(if ($ok9) {1} else {0}) "manifestSeen=$seen retryNoAdd=$(-not $addIfMissing)"

# write results as text: "id`tok`tdetail" per line
Set-Content -Path $env:PROBE_OUT -Value $script:out -Encoding UTF8
'@

# ----------------------------------------------------------------------------
# 4) Compose the full inner child script & run it in a detached pwsh ---------
# ----------------------------------------------------------------------------
$parts = [System.Collections.Generic.List[string]]::new()
$parts.Add($stubs)
foreach ($name in $required) { $parts.Add($realFns[$name]); $parts.Add("") }
$parts.Add($probes)
$fullInner = $parts -join "`n"

$tmpRoot = if ($env:TMPDIR) { $env:TMPDIR } else { [System.IO.Path]::GetTempPath() }
$outTxt = Join-Path $tmpRoot "install-runtime-out-$(Get-Random).txt"
$innerFile = Join-Path $tmpRoot "install-runtime-body-$(Get-Random).ps1"
$env:PROBE_TEMP = Join-Path $tmpRoot ("install-runtime-scratch-" + $PID)
New-Item -ItemType Directory -Path $env:PROBE_TEMP -Force | Out-Null
$env:PROBE_OUT = $outTxt
Set-Content -Path $innerFile -Value $fullInner -Encoding UTF8

$pwshPath = (Get-Command pwsh).Source
& $pwshPath -NoProfile -ExecutionPolicy Bypass -File $innerFile | Out-Null

if (Test-Path $outTxt) {
    foreach ($ln in (Get-Content $outTxt)) {
        if ([string]::IsNullOrWhiteSpace($ln)) { continue }
        $p = $ln -split "`t"
        if ($p.Count -lt 2) { continue }
        $isOk = ($p[1].Trim() -eq "1")
        $detail = if ($p.Count -gt 2) { $p[2] } else { "" }
        # IMPORTANT: `-Pass:$isOk`, NOT `-Pass $isOk`. For a [switch] parameter,
        # `-Pass <bool>` is treated as "switch present" (always ON) regardless of
        # value; `-Pass:$isOk` is the only form that honours the boolean. The prior
        # draft used `-Pass ([bool]...)`, which is exactly why P1/P4 showed PASS
        # for results that were FAIL.
        T -N $p[0] -Pass:$isOk -Detail $detail
    }
} else {
    Write-Host "ERROR: probe run produced no results file" -ForegroundColor Red
    $script:failed++
}

# ----------------------------------------------------------------------------
# P10: native-stderr hazard scan (static, whole source). Must flag ANY
# remaining `2>&1` merge of a NATIVE command under EAP=Stop for the cron/exe/
# BinaryPath/gentleExe/bun/npm paths. Widen the pattern list to the same class
# the PR kills, and EXCLUDE blocks that force EAP=Continue around the invocation
# (the `cmd /c` postinstall is EAP=Continue-wrapped, so it is exempt).
# ----------------------------------------------------------------------------
$haz = @()
$lines = $sourceText -split "`n"
$inEAPContinue = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
    $ln = $lines[$i]
    # Track EAP state so EAP=Continue-wrapped natives are exempt. The script sets
    # EAP=Continue for the postinstall cmd /c and restores $prevEA in finally.
    if ($ln -match '\$ErrorActionPreference\s*=\s*"Continue"') { $inEAPContinue = $true }
    elseif ($ln -match '\$ErrorActionPreference\s*=\s*\$prev[EA]|\$ErrorActionPreference\s*=\s*"Stop"') { $inEAPContinue = $false }
    if ($ln -match '^\s*#') { continue }          # comments document, never execute
    if ($ln -match '2>&1' -and $ln -notmatch '\$\.Exception') {
        # Native invocations that merge stderr under EAP=Stop -> PS5.1
        # NativeCommandError. Only flag them when NOT inside an EAP=Continue block.
        if (-not $inEAPContinue) {
            if ($ln -match '\$opencodeExe|@cronArgs|taskkill|\bcron\b|\bdedupe\b|\$BinaryPath|\$gentleExe|\bbun install\b|\bnpm install\b|\bcmd /c\b') {
                $haz += "line $($i+1): $($ln.Trim())"
            }
        }
    }
}
if ($haz.Count -eq 0) { T -N 'P10-native-hazard' -Pass:$true "no residual non-EAPContinued 2>&1 merge of native stderr" }
else { T -N 'P10-native-hazard' -Pass:$false ($haz -join ' | ') }

# Clean up the scratch dirs the probe leaves under the probe TEMP dir (reviewer
# suggestion). Also the results/body scripts live there; remove the scratch tree.
if (Test-Path $env:PROBE_TEMP) {
    Remove-Item $env:PROBE_TEMP -Recurse -Force -ErrorAction SilentlyContinue
}

if ($KeepInner) { Write-Host "inner probe kept at: $innerFile" -ForegroundColor DarkGray }
# P10 lives in the parent; the child only runs P1-P9. Report child timestamps too.
Write-Host ""
Write-Host "=== Runtime harness: $passed passed, $failed failed, $skipped skipped ==="
if ($failed -gt 0) { exit 1 } else { exit 0 }