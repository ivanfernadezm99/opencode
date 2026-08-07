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
if ($content -match '\$dedupeExit -ne 0\)[\s\S]*?Stop-WithError') { Test-Pass "Non-zero dedupe exit -> Stop-WithError (R4r)" }
else { Test-Fail "Non-zero dedupe exit -> Stop-WithError" 'Expected Stop-WithError when cron dedupe fails (exit != 0)' }
# cron add failures must also Stop-WithError (R4r) via the non-success branch
if ($content -match 'if \(\$LASTEXITCODE -eq 0\)' -and $content -match 'Stop-WithError "Failed to create cron') { Test-Pass "Non-zero cron add exit -> Stop-WithError (R4r)" }
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
    if ($bpBody -match 'incomplete-') { Test-Pass "Quarantine inside Backup-Path (partial never restorable)" }
    else { Test-Fail "Quarantine placement" "Expected quarantine rename inside Backup-Path" }
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
if ($content -match 'cron dedupe 2>\s*\$dedupeTmp') { Test-Pass "cron dedupe stderr redirected to temp file (PS5.1-safe)" }
else { Test-Fail "cron dedupe stderr redirect" "Expected 'cron dedupe 2> \$dedupeTmp' (stderr to file, not pipeline)" }
if ($content -match '\$dedupeExit -ne 0') { Test-Pass "cron dedupe exit code checked" }
else { Test-Fail "cron dedupe exit check" "Expected \$dedupeExit -ne 0 -> Stop-WithError" }

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

# ----- Summary -----
Write-Host ""
$total = $passed + $failed
Write-Host "=== Results: $passed passed, $failed failed, $warnings warnings ===" -ForegroundColor Cyan
if ($failed -gt 0) { Write-Host "SOME TESTS FAILED" -ForegroundColor Red; exit 1 }
else { Write-Host "ALL TESTS PASSED" -ForegroundColor Green; exit 0 }
