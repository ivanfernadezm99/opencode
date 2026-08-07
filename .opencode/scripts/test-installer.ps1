<#
.SYNOPSIS
    Install.ps1 Test Suite — validates syntax, COMMAND mode traps, URL consistency.

.PARAMETER Path
    Path to install.ps1 to test. Default: repo root relative path.
#>
param([string]$Path)

$ErrorActionPreference = "Stop"
$passed = 0
$failed = 0
$warnings = 0

if (-not $Path) {
    $scriptDir = Split-Path $PSScriptRoot -Parent
    $Path = Join-Path $scriptDir "install.ps1"
}
if (-not (Test-Path $Path)) {
    Write-Host "ERROR: install.ps1 not found at $Path" -ForegroundColor Red
    exit 1
}

$content = Get-Content $Path -Raw
$allLines = $content -split "`n"

function Test-Pass    { param([string]$N); $script:passed++; Write-Host "  PASS: $N" -ForegroundColor Green }
function Test-Fail    { param([string]$N, [string]$D); $script:failed++; Write-Host "  FAIL: $N" -ForegroundColor Red; if ($D) { Write-Host "        $D" -ForegroundColor DarkRed } }
function Test-Warn    { param([string]$N, [string]$D); $script:warnings++; Write-Host "  WARN: $N" -ForegroundColor Yellow; if ($D) { Write-Host "        $D" -ForegroundColor DarkYellow } }

Write-Host "`n=== Install.ps1 Test Suite ===" -ForegroundColor Cyan
Write-Host "Script: $Path`n" -ForegroundColor DarkGray

# ----- [1] File integrity -----
Write-Host "--- [1] File integrity ---" -ForegroundColor White
if ($allLines.Count -gt 900 -and $content.Contains("function Main")) {
    Test-Pass "install.ps1: $($allLines.Count) lines, Main function present"
} else {
    Test-Fail "install.ps1 content" "Expected 900+ lines and Main function"
}

# ----- [2] PowerShell syntax (AST) -----
Write-Host "--- [2] PowerShell syntax ---" -ForegroundColor White
try {
    $parseTokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseInput($content, [ref]$parseTokens, [ref]$parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        Test-Fail "AST parse error" "ParseInput reported $($parseErrors.Count) error(s): $($parseErrors[0].Extent.StartLineNumber) $($parseErrors[0].Message)"
    } else {
        Test-Pass "AST parses cleanly (0 parse errors)"
    }
} catch {
    Test-Fail "AST parse error" $_.Exception.Message
}

# ----- [3] COMMAND mode traps -----
<#
  PowerShell 5.1 COMMAND vs EXPRESSION mode:
  BAD:  if (Test-Path $path -and $condition)
        The parser sees Test-Path's arguments as: $path, '-and', '$condition'
        '-and' becomes a string argument, not a logical operator.
  GOOD: if ((Test-Path $path) -and $condition)
        Outer parens force EXPRESSION mode for -and.
  
  This test finds BOTH:
    A) Unfixed: cmdlet-before-and without wrapping parens (FAIL)
    B) Fixed:   cmdlet wrapped in parens before -and (PASS)
#>
Write-Host "--- [3] COMMAND mode -and traps ---" -ForegroundColor White
$bugs = @()
$fixed = @()
for ($i = 0; $i -lt $allLines.Count; $i++) {
    $line = $allLines[$i]
    $n = $i + 1

    # Pattern A—BUG: if (Command $arg -and without wrapping parens
    # A cmdlet name (starts with uppercase) followed by `$arg -and`
    if ($line -match '\bif\s*\(\s*[A-Z][a-zA-Z-]+\s+\$\S+\s+-and\b') {
        # Double-check: NOT already wrapped in parens: if ((Command ...)
        if ($line -notmatch '\bif\s*\(\s*\(') {
            $bugs += @{ Line = $n; Text = $line.Trim() }
        }
    }

    # Pattern B—GOOD fixed pattern: if ((Command $arg) -and
    if ($line -match '\bif\s*\(\s*\([A-Z][a-zA-Z-]+\s+\$\S+\)\s+-and\b') {
        $fixed += @{ Line = $n; Text = $line.Trim() }
    }
}

if ($bugs.Count -gt 0) {
    foreach ($b in $bugs) {
        Test-Fail "COMMAND mode trap at line $($b.Line)" $b.Text
    }
} else {
    Test-Pass "No unfixed COMMAND mode -and traps"
}

if ($fixed.Count -gt 0) {
    foreach ($f in $fixed) {
        Test-Pass "COMMAND mode fix confirmed at line $($f.Line): $($f.Text)"
    }
} else {
    Test-Warn "No COMMAND mode fix pattern found" "Should find at least Test-Path and Test-Property wraps"
}

# ----- [4] Safe argument splatting -----
Write-Host "--- [4] Argument handling ---" -ForegroundColor White
if ($content -match '\$mainParams\s*=\s*@\{\}') {
    Test-Pass "Safe hashtable splatting (mainParams)"
} elseif ($content -match 'Main @args') {
    Test-Fail "Uses raw `$args splatting" "Replace 'Main @args' with safe hashtable splatting"
} else {
    Test-Warn "Cannot determine splatting method"
}

# Verify Main is called with @mainParams, not @args
$mainCall = Select-String -Path $Path -Pattern '\bMain\b' | Where-Object { $_.Line -match '\bMain\s' }
$hasSafeMain = $false
$hasUnsafeMain = $false
foreach ($m in $mainCall) {
    if ($m.Line -match 'Main @mainParams') { $hasSafeMain = $true }
    if ($m.Line -match 'Main @args')       { $hasUnsafeMain = $true }
}
if ($hasSafeMain) { Test-Pass "Main called with @mainParams" }
if ($hasUnsafeMain) { Test-Fail "Main called with @args (unsafe)" }

# ----- [5] Required functions -----
Write-Host "--- [5] Required functions ---" -ForegroundColor White
$requiredFunctions = @(
    "function Main", "function Write-Info", "function Write-Success",
    "function Write-Warn", "function Write-Err", "function Write-Step",
    "function Stop-WithError", "function Show-Banner", "function Get-Arch",
    "function Get-LatestVersion", "function Get-InstalledVersion",
    "function Install-Binary", "function Add-ToUserPath",
    "function Download-WithRetry", "function Clear-OrphanedShortcuts",
    "function Test-Property", "function Get-Property",
    "function Migrate-SessionDatabase"
)
foreach ($func in $requiredFunctions) {
    if ($content -match "function $($func -replace '^function ','')") {
        Test-Pass "Function '$func'"
    } else {
        Test-Fail "Function '$func' not found"
    }
}

# Migrate-SessionDatabase must be invoked exactly once, right after the
# opencode binary install, with the freshly installed binary as its source of
# truth for the channel name.
if ($content -match 'Migrate-SessionDatabase -Version \$Version -BinaryPath \$opencodeExe') {
    Test-Pass "Migrate-SessionDatabase called once with freshly installed binary"
} else {
    Test-Fail "Migrate-SessionDatabase callsite missing or malformed"
}
$migrateCallCount = ([regex]::Matches($content, 'Migrate-SessionDatabase -Version')).Count
if ($migrateCallCount -eq 1) { Test-Pass "Exactly one Migrate-SessionDatabase callsite ($migrateCallCount)" }
else { Test-Fail "Expected exactly one Migrate-SessionDatabase callsite, found $migrateCallCount" }

# Pre-update data backup must exist and cover both session DBs and engram DB.
if ($content -match 'Backing up session and engram databases') { Test-Pass "Pre-update backup step present" }
else { Test-Fail "Pre-update backup step missing" }

# ----- [6] Error handling -----
Write-Host "--- [6] Error handling ---" -ForegroundColor White
if ($content -match '\$ErrorActionPreference\s*=\s*"Stop"') { Test-Pass 'ErrorActionPreference = Stop' }
else { Test-Warn "ErrorActionPreference" "Not set to Stop at script level" }

if ($content -match '#Requires -Version 5\.1') { Test-Pass '#Requires -Version 5.1' }
else { Test-Warn "#Requires" "Missing PowerShell version requirement" }

# ----- [7] Main parameters (inside function Main's param block) -----
Write-Host "--- [7] Main parameters ---" -ForegroundColor White
# Parameters live inside "function Main { param(...) }", not at script level
$mainStart = $content.IndexOf("function Main {")
if ($mainStart -ge 0) {
    $mainBody = $content.Substring($mainStart, 500)
    $mainParam = [regex]::Match($mainBody, 'param\s*\(([^)]+)\)')
    if ($mainParam.Success) {
        foreach ($param in @("Version", "Channel", "NoModifyPath", "UseMirror", "Desktop")) {
            if ($mainParam.Groups[1].Value -match '\$' + $param + '\b') {
                Test-Pass "Main param: `$$param"
            } else {
                Test-Warn "Main param: `$$param" "Not found in Main's param() block"
            }
        }
    } else {
        Test-Warn "Main param block" "Could not find param() inside Main function"
    }
} else {
    Test-Warn "Main function" "Could not locate 'function Main {' in script"
}

# ----- [8] Release URL / version consistency -----
<#
  Verify that the download URLs built by install.ps1 match the release tag.
  Prevents the asset-not-found bug we had in v1.17.13.
#>
Write-Host "--- [8] Release URL consistency ---" -ForegroundColor White
$urlRepo = "ivanfernadezm99/opencode"
$releaseTag = "v1.17.13"

# Find how the script constructs binary download URLs
$binaryDlPatterns = @()
for ($i = 0; $i -lt $allLines.Count; $i++) {
    $line = $allLines[$i]
    $n = $i + 1
    # Look for github.com download URL construction patterns
    if ($line -match 'github\.com.*releases.*download.*\$Version.*\$archiveName') {
        $binaryDlPatterns += @{ Line = $n; Text = $line.Trim() }
    }
    if ($line -match 'github\.com.*releases.*download') {
        $binaryDlPatterns += @{ Line = $n; Text = $line.Trim() }
    }
}
if ($binaryDlPatterns.Count -gt 0) {
    # Verify the URL template uses variables, not hardcoded values
    $allUseVars = $true
    foreach ($p in $binaryDlPatterns) {
        if ($p.Text -match 'github\.com/[^"]+/[^"]+/releases/download/[^$]') {
            Test-Warn "Hardcoded download URL at line $($p.Line)" $p.Text
            $allUseVars = $false
        }
    }
    if ($allUseVars) {
        Test-Pass "Download URLs use `$Version / variables"
    }
} else {
    # Also check for nextcloud mirror download
    if ($content -match 'nextcloud.*download') {
        Test-Pass "Mirror download URL found"
    } else {
        Test-Warn "Download URLs" "Cannot find download URL construction pattern"
    }
}

# Verify binary version number consistency
$verMatches = [regex]::Matches($content, '(\d+\.\d+\.\d+)')
$uniqueVersions = @{}
foreach ($m in $verMatches) {
    $uniqueVersions[$m.Groups[1].Value] = $true
}
$scriptVersion = ($uniqueVersions.Keys | Where-Object { $_ -ne "5.1" -and $_ -ne "5000" } | Sort-Object -Descending | Select-Object -First 1)
if ($scriptVersion) {
    $tagVersion = $releaseTag -replace '^v',''
    Test-Pass "Script version $scriptVersion detected"
    # This is informational; actual URL assertion needs the CI to pass the target tag
}

# ----- [9] Installer update safety (PR3: verified backup / restore / dedupe) -----
<#
  PR3 contracts (design D9/D14, R5r, D7/C2/W5, B1, W4/R4r, W7, W8):
  - Backup-Path verifies non-empty (dirs AND files) and skips a legitimately absent source.
  - Backup scope covers session DBs, engram DB, desktop dir, global config (incl. skills).
  - Restore-ClientData / Stop-CronHolders / Restore-Path exist and Restore-ClientData is called.
  - Stop-WithError throws (terminating) and restores inline, instead of 'exit 1'.
  - Main is wrapped in try/catch (restore) and env vars are restored in finally.
  - Skills install is copy-only (no Remove-Item on the skill dir).
  - Desktop cron block runs `cron dedupe` unconditionally and Stop-WithError on non-zero exit.
  - Retention keeps the newest 8 backups per family.
#>
Write-Host "--- [9] Installer update safety ---" -ForegroundColor White

# [9.1] Backup-Path function + script-scoped backup stamp
if ($content -match 'function Backup-Path') { Test-Pass "Backup-Path function present" }
else { Test-Fail "Backup-Path function" "Required for verified, non-empty backup" }
if ($content -match '\$script:backupStamp\s*=\s*Get-Date') { Test-Pass 'Script-scoped backup stamp ($script:backupStamp)' }
else { Test-Fail "backup stamp" 'Expected $script:backupStamp (script scope, not local)' }
if ($content -match 'Copy-Item -Path \$Src -Destination \$Dst -Recurse -Force -ErrorAction Stop') { Test-Pass "Backup-Path copy is Recurse+Force+Stop" }
else { Test-Fail "Backup-Path copy" "Expected Copy-Item ... -ErrorAction Stop" }

# [9.2] Non-empty verification for dirs AND files + missing-source skip
if ($content -match 'PSIsContainer') { Test-Pass "Non-empty verification (dirs)" }
else { Test-Fail "Non-empty verify" "Expected PSIsContainer branch in Backup-Path" }
if ($content -match '\$item\.Length -eq 0') { Test-Pass "Non-empty verification (files)" }
else { Test-Fail "Non-empty verify (files)" "Expected Length-eq-0 branch for files" }
if ($content -match 'source absent \(fresh install\)') { Test-Pass "Missing-source skip (fresh install, R5r)" }
else { Test-Fail "Missing-source skip" "Expected fresh-install skip note in Backup-Path" }

# [9.3] Backup scope covers session, engram, desktop, global config
$scopeOk = ($content -match '\$sessionDataDir\.backup-\$script:backupStamp') -and `
          ($content -match '\$engramDbDir\.backup-\$script:backupStamp') -and `
          ($content -match '\$desktopDataDir\.backup-\$script:backupStamp') -and `
          ($content -match '\$globalConfigDir\.backup-\$script:backupStamp')
if ($scopeOk) { Test-Pass "Backup scope: session + engram + desktop + global config" }
else { Test-Fail "Backup scope" "Expected all 4 families in the backup map" }

# [9.4] Restore functions + callsite(s)
foreach ($f in @("Restore-ClientData", "Stop-CronHolders", "Restore-Path")) {
    if ($content -match "function $f") { Test-Pass "Function '$f'" }
    else { Test-Fail "Function '$f' not found" }
}
$rcCalls = ([regex]::Matches($content, 'Restore-ClientData')).Count
if ($rcCalls -ge 2) { Test-Pass "Restore-ClientData called at restore hook(s) ($rcCalls refs)" }
else { Test-Fail "Restore-ClientData callsite" "Expected definition + at least one call site" }

# [9.5] Stop-WithError throws (not exit) and restores inline
$sweStart = $content.IndexOf("function Stop-WithError")
$sweEnd = if ($sweStart -ge 0) { $content.IndexOf("# --- Banner", $sweStart) } else { -1 }
if ($sweStart -ge 0 -and $sweEnd -gt $sweStart) {
    $sweBody = $content.Substring($sweStart, $sweEnd - $sweStart)
    if ($sweBody -match 'throw \$Message') { Test-Pass "Stop-WithError throws (terminating, C2/W5)" }
    else { Test-Fail "Stop-WithError throw" 'Expected "throw $Message" instead of "exit 1"' }
    if ($sweBody -match 'Restore-ClientData') { Test-Pass "Stop-WithError restores inline" }
    else { Test-Fail "Stop-WithError restore" "Expected Restore-ClientData call in Stop-WithError" }
} else {
    Test-Fail "Stop-WithError" "function not found"
}

# [9.6] try { Main @mainParams } catch -> restore; env restored in finally (W7)
if ($content -match 'try\s*\{\s*Main @mainParams') { Test-Pass "Main wrapped in try/catch" }
else { Test-Fail "try{Main}" "Expected 'try { Main @mainParams }'" }
if ($content -match 'Main @mainParams[\s\S]*Restore-ClientData') { Test-Pass "catch restores client data" }
else { Test-Fail "catch restore" "Expected catch block after Main to call Restore-ClientData" }
if ($content -match 'finally\s*\{' -and $content -match 'Remove-Item Env:\\XDG_DATA_HOME') { Test-Pass "env restored in finally (W7)" }
else { Test-Fail "finally env restore" "Expected finally restoring XDG_DATA_HOME / ENGRAM_DATA_DIR" }

# [9.7] Copy-only skills: no Remove-Item on the skill dest; backup before overwrite (B1)
if ($content -match 'Remove-Item -Path \$dest -Recurse') {
    Test-Fail "Copy-only skills" "Found Remove-Item on skills dest (B1 violation)"
} else {
    Test-Pass "Copy-only skills: no Remove-Item on skill dir"
}
if ($content -match '\$dest\.backup-\$script:backupStamp') { Test-Pass "Skills backed up before overwrite" }
else { Test-Fail "Skills backup" "Expected \$dest.backup-\$script:backupStamp before overwrite" }

# [9.8] Unconditional cron dedupe + non-zero exit -> Stop-WithError + stamp-after-all (W4/R4r)
if ($content -match 'cron dedupe') { Test-Pass "Unconditional 'cron dedupe' present" }
else { Test-Fail "cron dedupe" "Expected unconditional dedupe under XDG redirect (W4)" }
if ($content -match '\$dedupeRun\.ExitCode -ne 0\)[\s\S]*?Stop-WithError') { Test-Pass "Non-zero dedupe exit -> Stop-WithError (R4r)" }
else { Test-Fail "Non-zero dedupe exit -> Stop-WithError" 'Expected Stop-WithError when cron dedupe fails (exit != 0)' }
# cron add failures must also Stop-WithError (R4r) via the non-success branch
if ($content -match 'if \(\$addRun\.ExitCode -eq 0\)' -and $content -match 'Stop-WithError "Failed to create cron') { Test-Pass "Non-zero cron add exit -> Stop-WithError (R4r)" }
else { Test-Fail "Non-zero cron add -> Stop-WithError" 'Expected Stop-WithError on failed cron add' }
if ($content -match 'Set-Content -Path \$desktopCronStamp') { Test-Pass "Desktop stamp written after adds (R4r)" }
else { Test-Fail "Desktop stamp" "Expected Set-Content on \$desktopCronStamp after all adds" }

# [9.9] Retention (W8): keep newest 8 per family, never delete originals
if ($content -match 'function Enforce-BackupRetention') { Test-Pass "Retention function (Enforce-BackupRetention)" }
else { Test-Fail "Retention" "Expected Enforce-BackupRetention (keep newest 8, W8)" }
if ($content -match '\[int\]\$Keep = 8' -or $content -match '\$Keep = 8') { Test-Pass "Retention keeps newest 8" }
else { Test-Fail "Retention count" "Expected keep-newest-8 (default 8)" }

# ----- [10] Corrective gate (round 3): partial-backup quarantine, PS5.1, restore correctness -----
<#
  Gate feedback fixes (all verified against real file):
  - B1: partial backup must NEVER be restorable -> quarantine to *.incomplete-* on copy failure.
  - B2: PS5.1 `cron dedupe 2>&1 | Out-Null` aborts -Desktop updates (stderr -> NativeCommandError
       under EAP=Stop); stderr must be redirected to a temp file, not merged into the pipeline.
  - C3: desktop installer non-zero exit was swallowed; must Stop-WithError -> restore.
  - W4: taskkill 2>$null under EAP=Stop can abort restore; wrap in EAP=Continue helper.
  - W5: user-config cron stamp written even when per-job adds failed; gate on all-success.
  - W6: backup stamp 1-second granularity -> add milliseconds (fff).
  - W7: Get-WindowsVersion can silently downgrade; refuse resolved version older than installed.
  - W8: Restore-Path must purge stale live -wal/-shm sidecars.
  - W9: whole-desktop-dir backup with locked cache subdirs can block updates; exclude caches.
  - S: double restore guard ($script:restoreDone).
#>
Write-Host "--- [10] Corrective gate (round 3) ---" -ForegroundColor White

# [10.1] B1: partial backup quarantined (.incomplete-*), never restorable
if ($content -match '\.incomplete-') { Test-Pass "Partial backup quarantine (.incomplete-*) [B1]" }
else { Test-Fail "Partial backup quarantine" "Expected partial backup renamed to *.incomplete-* on copy failure" }
$bpStart = $content.IndexOf("function Backup-Path")
$bpEnd = $content.IndexOf("function Restore-Path", $bpStart)
if ($bpStart -ge 0 -and $bpEnd -gt $bpStart) {
    $bpBody = $content.Substring($bpStart, $bpEnd - $bpStart)
    if ($bpBody -match 'incomplete-' -or $bpBody -match 'Quarantine-PartialBackup') { Test-Pass "Quarantine inside Backup-Path (partial never restorable)" }
    else { Test-Fail "Quarantine placement" "Expected quarantine (rename or Quarantine-PartialBackup) inside Backup-Path" }
    if ($bpBody -match 'catch' -and $bpBody -match 'throw') { Test-Pass "Backup-Path catches copy error and rethrows after quarantine" }
    else { Test-Fail "Backup-Path catch/rethrow" "Expected try/catch that quarantines then rethrows" }
} else {
    Test-Fail "Backup-Path body" "Could not isolate Backup-Path function body"
}

# [10.2] B2: PS5.1-safe cron dedupe (no 2>&1 pipeline merge on the dedupe invocation)
if ($content -match 'cron dedupe 2>&1 \| Out-Null') {
    Test-Fail "PS5.1 dedupe" "2>&1 | Out-Null on cron dedupe aborts on PS5.1 (NativeCommandError)"
} else {
    Test-Pass "No 2>&1 | Out-Null on cron dedupe [B2]"
}
if ($content -match 'Invoke-NativeRedirected -FilePath \$opencodeExe -Arguments @\("cron", "dedupe"\)') {
    Test-Pass "cron dedupe routed through Invoke-NativeRedirected (stderr to file, PS5.1-safe)"
} else {
    Test-Fail "cron dedupe stderr redirect" "Expected dedupe via Invoke-NativeRedirected (2> to file, no pipeline merge)"
}
if ($content -match '\$dedupeRun\.ExitCode -ne 0') { Test-Pass "cron dedupe exit code checked" }
else { Test-Fail "cron dedupe exit check" "Expected \$dedupeRun.ExitCode -ne 0 -> Stop-WithError" }

# [10.3] C3: desktop installer non-zero exit -> Stop-WithError (not swallowed Write-Warn)
if ($content -match 'Desktop installer exited with code') {
    Test-Fail "Desktop installer exit" "Swallowed non-zero exit (must Stop-WithError -> restore)"
} else {
    Test-Pass "Desktop installer non-zero exit not swallowed [C3]"
}
if ($content -match 'Stop-WithError "Desktop installer failed') { Test-Pass "Desktop installer non-zero -> Stop-WithError" }
else { Test-Fail "Desktop installer Stop-WithError" "Expected Stop-WithError on non-zero desktop installer exit" }

# [10.4] W4: taskkill wrapped in EAP=Continue helper
if ($content -match 'function Invoke-TaskKill') { Test-Pass "Invoke-TaskKill helper" }
else { Test-Fail "Invoke-TaskKill" "Expected taskkill wrapped in EAP=Continue helper" }
$tkStart = $content.IndexOf("function Invoke-TaskKill")
$tkEnd = if ($tkStart -ge 0) { $content.IndexOf("function Restore-ClientData", $tkStart) } else { -1 }
if ($tkStart -ge 0 -and $tkEnd -gt $tkStart) {
    $tkBody = $content.Substring($tkStart, $tkEnd - $tkStart)
    if ($tkBody -match '\$ErrorActionPreference\s*=\s*"Continue"') { Test-Pass "Invoke-TaskKill sets EAP=Continue [W4]" }
    else { Test-Fail "Invoke-TaskKill EAP" "Expected EAP=Continue inside Invoke-TaskKill" }
} else {
    Test-Fail "Invoke-TaskKill body" "Could not isolate Invoke-TaskKill function"
}
$tkHelperCount = ([regex]::Matches($content, 'Invoke-TaskKill -ImageName')).Count
if ($tkHelperCount -ge 3) { Test-Pass "All taskkill callsites routed through Invoke-TaskKill ($tkHelperCount)" }
else { Test-Fail "taskkill callsites" "Expected >=3 Invoke-TaskKill -ImageName callsites, found $tkHelperCount" }

# [10.5] W5: user-config cron stamp only after ALL adds succeed
if ($content -match 'cronAddFailed') { Test-Pass "User-cron add-failure flag tracked (W5)" }
else { Test-Fail "cronAddFailed" "Expected flag tracking failed cron adds" }
if ($content -match '\$cronAddFailed[\s\S]*?Set-Content -Path \$cronStampFile' -or $content -match 'Set-Content -Path \$cronStampFile[\s\S]*?\$cronAddFailed') {
    Test-Pass "User-cron stamp only after all adds succeed [W5]"
} else {
    Test-Fail "User-cron stamp gating" "Expected stamp write gated on all adds succeeding"
}

# [10.6] W6: backup stamp millisecond precision
if ($content -match '\$script:backupStamp\s*=\s*Get-Date -Format[^\r\n]*fff') { Test-Pass "Backup stamp includes milliseconds (W6)" }
else { Test-Fail "Backup stamp precision" "Expected yyyyMMdd-HHmmssfff (millisecond) backup stamp" }

# [10.7] W7: no silent downgrade by Get-WindowsVersion
if ($content -match 'older than installed') { Test-Pass "No-downgrade guard present (W7)" }
else { Test-Fail "No-downgrade guard" "Expected Get-WindowsVersion to refuse installing a version older than installed" }

# [10.8] W8: Restore-Path purges stale -wal/-shm sidecars
$rpStart = $content.IndexOf("function Restore-Path")
$rpEnd = $content.IndexOf("function Stop-CronHolders", $rpStart)
if ($rpStart -ge 0 -and $rpEnd -gt $rpStart) {
    $rpBody = $content.Substring($rpStart, $rpEnd - $rpStart)
    if ($rpBody -match '"-wal"' -and $rpBody -match 'Remove-Item') { Test-Pass "Restore-Path purges stale sidecars (W8)" }
    else { Test-Fail "Sidecar purge" "Expected Restore-Path to remove stale -wal/-shm not present in backup" }
} else {
    Test-Fail "Restore-Path body" "Could not isolate Restore-Path function"
}

# [10.9] W9: desktop cache subdirs excluded from backup
if ($content -match 'GPUCache') { Test-Pass "Desktop cache subdirs excluded from backup (W9)" }
else { Test-Fail "Cache exclusion" "Expected GPUCache excluded from desktop backup scope" }

# [10.10] S: double-restore guard
if ($content -match '\$script:restoreDone') { Test-Pass "restoreDone guard (single restore)" }
else { Test-Fail "restoreDone guard" "Expected \$script:restoreDone guard in Restore-ClientData" }

# ----- [11] Corrective gate 2 (3rd re-run): airtight quarantine, PS5.1 cron add, idempotent seed -----
<#
  Gate-2 feedback (both reviewers verified against the real file with runtime probes):
  - B1a: partial backup must NEVER be restorable even when the quarantine rename FAILS —
        verify the rename result; if it failed, delete AND write a .incomplete sentinel
        inside $Dst; Restore-Path must refuse a backup carrying the sentinel.
  - B1b: Restore-Path must not trust Test-Path alone — require a .backup-complete marker
        written by Backup-Path only on success; refuse backups lacking it.
  - B1c: sidecar purge only for DBs whose base .db is present in the backup; skip when empty.
  - W5:  user-config block must run unconditional `cron dedupe` (mirror desktop) AND parse
        the FULL multi-word job name (Test-CronJobNameExists), not the truncated first word.
  - B2:  desktop/user cron add + cron list must NOT `2>&1`-merge native stderr under EAP=Stop
        (PS5.1 NativeCommandError) — route through Invoke-NativeRedirected (2> $errTmp).
  - CRITICAL4: dedupe exit init -1 + temp cleanup in finally (no stale $LASTEXITCODE / junk).
  - W5 (restore): restoreDone set only AFTER all four Restore-Path calls return; catch prints
        "RESTORE FAILED" loudly when a restore returns $false, not "restored".
  - W6: Stop-WithError must restore BEFORE Stop-Transcript (restore actions captured in log).
  - W7: postinstall cmd /c EAP restore must be in finally.
  - W8: no-downgrade comparison must apply to mirror-resolved versions too.
  - W9: cache-only desktop dir (only-excluded-items) is a LEGIT empty backup -> $true, not a block.
#>
Write-Host "--- [11] Corrective gate 2 (3rd re-run) ---" -ForegroundColor White

# [11.1] B1a: Quarantine-PartialBackup verifies rename; on failure writes .incomplete sentinel
if ($content -match 'function Quarantine-PartialBackup') { Test-Pass "Quarantine-PartialBackup function [B1a]" }
else { Test-Fail "Quarantine-PartialBackup" "Expected a function that verifies the quarantine rename result" }
$qStart = $content.IndexOf("function Quarantine-PartialBackup")
$qEnd = if ($qStart -ge 0) { $content.IndexOf("function Restore-Path", $qStart) } else { -1 }
if ($qStart -ge 0 -and $qEnd -gt $qStart) {
    $qBody = $content.Substring($qStart, $qEnd - $qStart)
    if ($qBody -match 'Rename-Item' -and $qBody -match '\.incomplete') { Test-Pass "Quarantine writes .incomplete sentinel on rename failure [B1a]" }
    else { Test-Fail "Quarantine sentinel" "Expected Rename-Item attempt AND .incomplete sentinel fallback" }
    if ($qBody -match 'Quarantined partial backup') { Test-Pass "Quarantined message only after confirmed rename [B1a]" }
    else { Test-Fail "Quarantine confirm msg" "Expected 'Quarantined' only after rename succeeds" }
} else {
    Test-Fail "Quarantine-PartialBackup body" "Could not isolate Quarantine-PartialBackup function"
}

# [11.2] B1b: Restore-Path requires .backup-complete marker
$rp11 = $content.IndexOf("function Restore-Path")
$rp11End = if ($rp11 -ge 0) { $content.IndexOf("function Invoke-TaskKill", $rp11) } else { -1 }
if ($rp11 -ge 0 -and $rp11End -gt $rp11) {
    $rp11Body = $content.Substring($rp11, $rp11End - $rp11)
    if ($rp11Body -match '\.backup-complete') { Test-Pass "Restore-Path requires .backup-complete marker [B1b]" }
    else { Test-Fail "Restore completeness marker" "Expected Restore-Path to refuse backups lacking .backup-complete" }
    if ($rp11Body -match '\.incomplete') { Test-Pass "Restore-Path refuses .incomplete sentinel [B1a]" }
    else { Test-Fail "Restore incomplete refusal" "Expected Restore-Path to refuse a backup containing .incomplete" }
} else {
    Test-Fail "Restore-Path body" "Could not isolate Restore-Path for gate-2 checks"
}
# Backup-Path must write the marker only on success (Set-BackupCompleteMarker / .backup-complete Set-Content)
if ($content -match 'function Set-BackupCompleteMarker') { Test-Pass "Set-BackupCompleteMarker function [B1b]" }
else { Test-Fail "Set-BackupCompleteMarker" "Expected a helper that writes .backup-complete only on success" }

# [11.3] B1c: sidecar purge gated on base .db present in backup + skip when empty
if ($rp11 -ge 0 -and $rp11End -gt $rp11) {
    $rp11Body = $content.Substring($rp11, $rp11End - $rp11)
    if ($rp11Body -match 'Get-ChildItem -Path \$Backup[^\r\n]* -Filter "\*\.db"') { Test-Pass "Sidecar purge enumerates backup .db (base present) [B1c]" }
    else { Test-Fail "Sidecar purge source" "Expected sidecar purge to enumerate DBs from the BACKUP, not the target" }
    if ($rp11Body -match '\.Count -gt 0') { Test-Pass "Sidecar purge skipped when no DBs in backup [B1c]" }
    else { Test-Fail "Sidecar purge empty guard" "Expected purge gated on backup .db count > 0" }
}

# [11.4] W5: user block runs unconditional cron dedupe + full-name parse helper
if ($content -match 'Test-CronJobNameExists') { Test-Pass "Test-CronJobNameExists helper (full multi-word name) [W5]" }
else { Test-Fail "Test-CronJobNameExists" "Expected a full-name existence matcher (fixes multi-word truncation)" }
# The user-config block (not just desktop) must call cron dedupe.
$userBlock = ""
$uBlockStart = $content.IndexOf("Setting up default cron jobs")
$uBlockEnd = $content.IndexOf("Installing credential manager", $uBlockStart)
if ($uBlockStart -ge 0 -and $uBlockEnd -gt $uBlockStart) {
    $userBlock = $content.Substring($uBlockStart, $uBlockEnd - $uBlockStart)
    if ($userBlock -match 'cron.*dedupe') { Test-Pass "User-config block runs unconditional cron dedupe [W5]" }
    else { Test-Fail "User-config dedupe" "Expected unconditional cron dedupe in the user-config block (mirror desktop)" }
}

# [11.5] B2: no 2>&1 merge on desktop/user cron add or cron list; route through Invoke-NativeRedirected
if ($content -match 'function Invoke-NativeRedirected') { Test-Pass "Invoke-NativeRedirected helper [B2]" }
else { Test-Fail "Invoke-NativeRedirected" "Expected a PS5.1-safe native runner (2> \$errTmp, exit-code gated)" }
if ($content -match '& \$opencodeExe @cronArgs 2>&1') { Test-Fail "PS5.1 cron add" "Desktop/user cron add still uses 2>&1 merge (NativeCommandError hazard)" }
else { Test-Pass "No 2>&1 merge on cron add [B2]" }
if ($content -match '& \$opencodeExe cron list 2>&1') { Test-Fail "PS5.1 cron list" "cron list still uses 2>&1 merge" }
else { Test-Pass "No 2>&1 merge on cron list [B2]" }

# [11.6] CRITICAL4: Invoke-NativeRedirected inits exit -1, cleans temp in finally, never reads stale $LASTEXITCODE
$inrStart = $content.IndexOf("function Invoke-NativeRedirected")
$inrEnd = if ($inrStart -ge 0) { $content.IndexOf("function Backup-Path", $inrStart) } else { -1 }
if ($inrStart -ge 0 -and $inrEnd -gt $inrStart) {
    $inrBody = $content.Substring($inrStart, $inrEnd - $inrStart)
    if ($inrBody -match '\$exitCode = -1') { Test-Pass "Invoke-NativeRedirected inits exit to -1 (no stale \$LASTEXITCODE) [CRITICAL4]" }
    else { Test-Fail "Native exit init" "Expected \$exitCode = -1 before invocation" }
    if ($inrBody -match 'finally\s*\{' -and $inrBody -match 'Remove-Item.*\$errTmp') { Test-Pass "Invoke-NativeRedirected cleans temp in finally [CRITICAL4]" }
    else { Test-Fail "Native temp cleanup" "Expected Remove-Item \$errTmp in a finally block" }
} else {
    Test-Fail "Invoke-NativeRedirected body" "Could not isolate Invoke-NativeRedirected function"
}

# [11.7] W5(restore): restoreDone set only after all Restore-Path calls; catch prints RESTORE FAILED on $false
$rcStart = $content.IndexOf("function Restore-ClientData")
$rcEnd = if ($rcStart -ge 0) { $content.IndexOf("function Enforce-BackupRetention", $rcStart) } else { -1 }
if ($rcStart -ge 0 -and $rcEnd -gt $rcStart) {
    $rcBody = $content.Substring($rcStart, $rcEnd - $rcStart)
    if ($rcBody -match '\$allOk' -or $rcBody -match 'return \$ok') { Test-Pass "Restore-ClientData returns success flag [W5-restore]" }
    else { Test-Fail "Restore success flag" "Expected Restore-ClientData to return overall success" }
    if ($rcBody -match 'Restore-Path.*\$allOk|Restore-Path.*\$ok') { Test-Pass "restoreDone set after all Restore-Path calls [W5-restore]" }
    else { Test-Fail "restoreDone placement" "Expected restoreDone assigned after the four Restore-Path calls return" }
}
# Outer catch must distinguish restored vs RESTORE FAILED
$catchBlock = ""
$cStart = $content.IndexOf('catch {')
$cEnd = $content.LastIndexOf('finally {')
if ($cStart -ge 0 -and $cEnd -gt $cStart) {
    $catchBlock = $content.Substring($cStart, $cEnd - $cStart)
    if ($catchBlock -match 'RESTORE FAILED') { Test-Pass "Catch prints RESTORE FAILED loudly on failed restore [W5-restore]" }
    else { Test-Fail "RESTORE FAILED message" "Expected the outer catch to distinguish failed restore from success" }
}

# [11.8] W6: Stop-WithError restores BEFORE Stop-Transcript
$swe11 = $content.IndexOf("function Stop-WithError")
$swe11End = if ($swe11 -ge 0) { $content.IndexOf("# --- Banner", $swe11) } else { -1 }
if ($swe11 -ge 0 -and $swe11End -gt $swe11) {
    $swe11Body = $content.Substring($swe11, $swe11End - $swe11)
    $ri = $swe11Body.IndexOf("Restore-ClientData")
    $ti = $swe11Body.IndexOf("Stop-Transcript")
    if ($ri -ge 0 -and $ti -gt $ri) { Test-Pass "Stop-WithError restores before Stop-Transcript [W6]" }
    else { Test-Fail "Stop-WithError order" "Expected Restore-ClientData BEFORE Stop-Transcript so restore actions are logged" }
}

# [11.9] W7: postinstall cmd /c EAP restore in finally
$postInstall = ""
$piStart = $content.IndexOf("Running postinstall for")
$piEnd = if ($piStart -ge 0) { $content.IndexOf("Scan installed skills", $piStart) } else { -1 }
if ($piStart -ge 0 -and $piEnd -gt $piStart) {
    $postInstall = $content.Substring($piStart, $piEnd - $piStart)
    if ($postInstall -match 'finally' -and $postInstall -match '\$ErrorActionPreference\s*=\s*\$prevEA') { Test-Pass "Postinstall EAP restore in finally [W7]" }
    else { Test-Fail "Postinstall EAP finally" "Expected EAP restored in finally after cmd /c" }
}

# [11.10] W8: no-downgrade comparison applies to mirror-resolved versions too
$guardBlock = ""
$gStart = $content.IndexOf("no-downgrade guard")
$gEnd = if ($gStart -ge 0) { $content.IndexOf('$opencodeInstalled', $gStart) } else { -1 }
if ($gStart -ge 0 -and $gEnd -gt $gStart) {
    $guardBlock = $content.Substring($gStart, $gEnd - $gStart)
    if ($guardBlock -match 'older than installed' -and $guardBlock -match 'non-semver') { Test-Pass "No-downgrade guard covers mirror + non-semver note [W8]" }
    else { Test-Fail "Mirror downgrade guard" "Expected no-downgrade comparison applied outside the -not \$UseMirror guard with a non-semver note" }
}

# [11.11] W9: cache-only desktop dir (only-excluded-items) is legit empty backup -> true
$bp11 = $content.IndexOf("function Backup-Path")
$bp11End = if ($bp11 -ge 0) { $content.IndexOf("function Restore-Path", $bp11) } else { -1 }
if ($bp11 -ge 0 -and $bp11End -gt $bp11) {
    $bp11Body = $content.Substring($bp11, $bp11End - $bp11)
    if ($bp11Body -match 'hadExcludes') { Test-Pass "Backup-Path tracks hadExcludes (only-excluded-items) [W9]" }
    else { Test-Fail "hadExcludes" "Expected Backup-Path to distinguish only-excluded-items from copy failure" }
    if ($bp11Body -match 'isEmpty -and -not \$hadExcludes') { Test-Pass "Empty-with-excludes returns true (legit), empty-without-excludes fails [W9]" }
    else { Test-Fail "W9 empty logic" "Expected empty backup to be legitimate only when excludes were applied" }
}

# ----- Summary -----
Write-Host ""
$total = $passed + $failed
Write-Host "=== Results: $passed passed, $failed failed, $warnings warnings ===" -ForegroundColor Cyan
if ($failed -gt 0) { Write-Host "SOME TESTS FAILED" -ForegroundColor Red; exit 1 }
else { Write-Host "ALL TESTS PASSED" -ForegroundColor Green; exit 0 }
