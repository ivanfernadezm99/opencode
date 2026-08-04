#Requires -Version 5.1
<#
.SYNOPSIS
    one info code -- Installer for Windows
    Installs one info code + gentle-ai in one step.

.DESCRIPTION
    Downloads the latest opencode-fork and gentle-ai binaries from GitHub,
    installs them, adds them to PATH, and runs gentle-ai's agent setup.

.EXAMPLE
    irm https://github.com/YOUR_USER/opencode-fork/releases/latest/download/install.ps1 | iex

.PARAMETER Version
    Specific opencode version to install (e.g., "1.0.180")

.PARAMETER NoModifyPath
    Skip adding directories to the User PATH

.PARAMETER Channel
    gentle-ai channel: stable (default), beta, nightly

.PARAMETER UseMirror
    Download opencode from Nextcloud mirror instead of GitHub
#>

$ErrorActionPreference = "Stop"

$null = & chcp 65001 2>$null
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# --- Configuration ---------------------------------------------------------

$OPENCODE_REPO = "ivanfernadezm99/opencode"
$GENTLE_REPO = "Gentleman-Programming/gentle-ai"
$ENGRAM_REPO = "Gentleman-Programming/engram"
$BINARY_NAME = "opencode"
$GENTLE_NAME = "gentle-ai"

$NEXTCLOUD_MIRROR = "https://enlaceschacocloud.duckdns.org/public.php/webdav"
$NEXTCLOUD_TOKEN = "ojAcbHDQBTX97oD"
$FALLBACK_VERSION = "v1.17.15"

$OPENCODE_DIR = Join-Path $env:LOCALAPPDATA "opencode\bin"
$GENTLE_DIR = Join-Path $env:LOCALAPPDATA "gentle-ai\bin"

# --- Logging ----------------------------------------------------------------

$INSTALL_LOG_DIR = Join-Path $env:LOCALAPPDATA "opencode\logs"
$null = New-Item -ItemType Directory -Path $INSTALL_LOG_DIR -Force
$INSTALL_LOG_FILE = Join-Path $INSTALL_LOG_DIR "install-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
Start-Transcript -Path $INSTALL_LOG_FILE -Append | Out-Null

# --- Colors / Console ------------------------------------------------------

function Write-Info    { param([string]$Message) Write-Host "  $Message" -ForegroundColor Blue }
function Write-Success { param([string]$Message) Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn    { param([string]$Message) Write-Host "  $Message" -ForegroundColor Yellow }
function Write-Err     { param([string]$Message) Write-Host "  $Message" -ForegroundColor Red }
function Write-Step    { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }

function Stop-WithError {
    param([string]$Message)
    Write-Err $Message
    Write-Info "Log saved to: $INSTALL_LOG_FILE"
    Stop-Transcript | Out-Null
    exit 1
}

# --- Banner -----------------------------------------------------------------

function Show-Banner {
    Write-Host ""
    Write-Host "   ___              ___ _        ___                _   " -ForegroundColor Cyan
    Write-Host "  / _ \ _ __   ___ |_ _|_ __   / __\ __  ___    __| | ___ " -ForegroundColor Cyan
    Write-Host " | | | | '_ \ / _ \ | || '_ \ / / | '__/ _ \  / _' |/ _ \'" -ForegroundColor Cyan
    Write-Host " | |_| | | | |  __/ | || | | / /__| | | (_) || (_| |  __/" -ForegroundColor Cyan
    Write-Host "  \___/|_| |_|\___||___|_| |_\____/|_|  \___/  \__,_|\___|" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  one info code - Windows Installer" -ForegroundColor DarkGray
    Write-Host ""
}

# --- Platform ---------------------------------------------------------------

function Get-Arch {
    if (-not [Environment]::Is64BitOperatingSystem) {
        Stop-WithError "32-bit Windows is not supported."
    }
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { return "arm64" }
    return "amd64"
}

# --- Version Detection ------------------------------------------------------

function Get-LatestVersion {
    param([string]$Repo)

    Write-Info "Checking $Repo..."

    # Method 1: HTTP redirect (no rate limit)
    $url = "https://github.com/$Repo/releases/latest"
    try {
        $response = Invoke-WebRequest -Uri $url -MaximumRedirection 0 -ErrorAction Stop `
            -UseBasicParsing -Headers @{ "User-Agent" = "gentle-opencode-installer" }
    } catch {
        $response = $_.Exception.Response
    }

    if ($response -and $response.StatusCode -eq 302 -and $response.Headers["Location"]) {
        $location = $response.Headers["Location"]
        if ($location -match '/tag/(v[\d.]+)') {
            $version = $matches[1]
            Write-Success "Latest: $version"
            return $version
        }
    }

    # Method 2: API fallback
    Write-Warn "Redirect failed, trying API..."
    $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
    try {
        $apiResponse = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "gentle-opencode-installer" }
        $version = $apiResponse.tag_name
        if ($version) {
            Write-Success "Latest: $version"
            return $version
        }
    } catch {
        Write-Warn "GitHub API also failed."
    }

    return $null
}

function Get-WindowsVersion {
    param([string]$Repo, [string]$BinaryName, [string]$LatestVersion)
    <#
    .SYNOPSIS
        Returns the latest version tag that has a Windows binary asset.
        Starts from $LatestVersion and walks backward if needed.
    #>
    $arch = Get-Arch
    $zipName = "${BinaryName}_$($LatestVersion -replace '^v','')_windows_${arch}.zip"

    # Quick check: does the latest release have a Windows asset?
    $assetUrl = "https://github.com/$Repo/releases/download/$LatestVersion/$zipName"
    try {
        $check = Invoke-WebRequest -Uri $assetUrl -Method Head -UseBasicParsing -TimeoutSec 10
        if ($check.StatusCode -eq 200 -or $check.StatusCode -eq 302) {
            Write-Info "Windows build confirmed for $LatestVersion"
            return $LatestVersion
        }
    } catch {}

    # If HEAD check failed, query the release API for assets
    Write-Warn "$LatestVersion has no Windows build. Searching older releases..."
    try {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=10" `
            -Headers @{ "User-Agent" = "gentle-opencode-installer" }
        foreach ($rel in $releases) {
            $tag = $rel.tag_name
            foreach ($asset in $rel.assets) {
                if ($asset.name -match "${BinaryName}_.*_windows_${arch}\.(zip|tar\.gz)") {
                    Write-Success "Found Windows build in $tag"
                    return $tag
                }
            }
        }
    } catch {
        Write-Warn "Could not query releases API."
    }

    return $null
}

function Get-LatestFromNextcloud {
    Write-Info "Checking Nextcloud for latest version..."

    try {
        $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${NEXTCLOUD_TOKEN}:"))
        $response = Invoke-WebRequest -Uri $NEXTCLOUD_MIRROR -Method PROPFIND `
            -UseBasicParsing -TimeoutSec 10 `
            -Headers @{ "Authorization" = "Basic $auth" }
    } catch {
        Write-Warn "Cannot reach Nextcloud mirror."
        return $null
    }

    # Extract versions from opencode_X.Y.Z_windows_amd64.zip filenames
    $highest = $null
    $highestVer = [version]"0.0.0"
    $matches = [regex]::Matches($response.Content, 'opencode_([\d.]+)_windows_amd64\.zip')
    foreach ($m in $matches) {
        $v = $m.Groups[1].Value
        try {
            $parsed = [version]$v
            if ($parsed -gt $highestVer) {
                $highestVer = $parsed
                $highest = "v$v"
            }
        } catch {}
    }

    if ($highest) {
        Write-Success "Nextcloud mirror has: $highest"
        return $highest
    }
    Write-Warn "No opencode versions found on mirror."
    return $null
}

# --- Property Helpers ------------------------------------------------------

function Test-Property {
    param([object]$Object, [string]$Name)
    # Safe property check that works with PSCustomObject (JSON) and OrderedDictionary
    if (-not $Object) { return $false }
    try {
        $val = $Object.$Name
        return $null -ne $val
    } catch {
        # Check via PSObject properties as fallback
        try {
            return ($Object.PSObject.Properties.Name -contains $Name)
        } catch {
            return $false
        }
    }
}

function Get-Property {
    param([object]$Object, [string]$Name)
    if (Test-Property $Object $Name) { return $Object.$Name }
    return $null
}

# --- Version Checks --------------------------------------------------------

function Get-InstalledVersion {
    param([string]$BinaryPath)

    if (-not (Test-Path $BinaryPath)) { return $null }

    try {
        $ver = & $BinaryPath --version 2>&1
        if ($ver -match '([\d.]+)') {
            $versionStr = $matches[1]
            Write-Info "Currently installed: v$versionStr"
            return "v$versionStr"
        }
    } catch {
        # Could not determine version
    }
    return $null
}

function Get-McpManifestVersion {
    $mcpStampFile = Join-Path $env:USERPROFILE ".config\opencode\.mcp-manifest-version"
    if (Test-Path $mcpStampFile) {
        return (Get-Content $mcpStampFile -Raw).Trim()
    }
    return $null
}

function Set-McpManifestVersion {
    param([string]$Version)
    $mcpStampFile = Join-Path $env:USERPROFILE ".config\opencode\.mcp-manifest-version"
    $null = New-Item -ItemType Directory -Path (Split-Path $mcpStampFile -Parent) -Force
    Set-Content -Path $mcpStampFile -Value $Version -NoNewline
}

# --- Download Binary -------------------------------------------------------

function Download-WithRetry {
    param([string]$Url, [string]$OutFile, [int]$MaxRetries = 3, [hashtable]$Headers = @{})

    for ($i = 1; $i -le $MaxRetries; $i++) {
        try {
            if ($i -gt 1) {
                $wait = [math]::Pow(2, $i)
                Write-Warn "Retry $i/$MaxRetries in ${wait}s..."
                Start-Sleep -Seconds $wait
            }
            $iwrParams = @{
                Uri = $Url
                OutFile = $OutFile
                UseBasicParsing = $true
                TimeoutSec = 300
            }
            if ($Headers.Count -gt 0) {
                $iwrParams.Headers = $Headers
            }
            Invoke-WebRequest @iwrParams
            return $true
        } catch {
            Write-Warn "Download attempt $i failed: $_"
        }
    }
    return $false
}

function Install-Binary {
    param(
        [string]$Repo,
        [string]$OutputDir,
        [string]$AssetName,
        [string]$BinaryName,
        [bool]$NeedsExtract = $true,
        [string]$MirrorUrl = "",
        [string]$Version = "",
        [switch]$ContinueOnError
    )

    $arch = Get-Arch

    # Build primary URL
    $mirrorHeaders = @{}
    if ($MirrorUrl) {
        $versionNumber = $Version -replace '^v',''
        $archiveName = "${BinaryName}_${versionNumber}_windows_${arch}.zip"
        $downloadUrl = "$MirrorUrl/$archiveName"
        $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${NEXTCLOUD_TOKEN}:"))
        $mirrorHeaders = @{ "Authorization" = "Basic $auth" }
        Write-Info "Using mirror: Nextcloud"
    } else {
        $versionNumber = $Version -replace '^v',''
        $archiveName = "${BinaryName}_${versionNumber}_windows_${arch}.zip"
        $downloadUrl = "https://github.com/$Repo/releases/download/$Version/$archiveName"
    }

    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

    $tmpDir = Join-Path $env:TEMP "gentle-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    try {
        Write-Info "Downloading $archiveName..."
        $archivePath = Join-Path $tmpDir $archiveName

        # Try primary download
        $ok = Download-WithRetry -Url $downloadUrl -OutFile $archivePath -Headers $mirrorHeaders

        # If primary fails and we're not already on mirror, try Nextcloud
        if (-not $ok -and -not $MirrorUrl -and $BinaryName -eq "opencode" -and $Version) {
            Write-Warn "GitHub download failed. Trying Nextcloud mirror..."
            $mirrorDownloadUrl = "$NEXTCLOUD_MIRROR/$archiveName"
            $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${NEXTCLOUD_TOKEN}:"))
            $ok = Download-WithRetry -Url $mirrorDownloadUrl -OutFile $archivePath -Headers @{ "Authorization" = "Basic $auth" }
        }

        if (-not $ok) {
            if ($ContinueOnError) { throw "Failed to download $archiveName after all attempts." }
            Stop-WithError "Failed to download $archiveName after all attempts."
        }

        $fileSize = (Get-Item $archivePath).Length
        if ($fileSize -lt 1000) {
            if ($ContinueOnError) { throw "Downloaded file is suspiciously small (${fileSize} bytes)." }
            Stop-WithError "Downloaded file is suspiciously small (${fileSize} bytes)."
        }
        Write-Success "Downloaded ($([math]::Round($fileSize / 1MB, 1)) MB)"

        if ($NeedsExtract) {
            Write-Info "Extracting..."
            Expand-Archive -Path $archivePath -DestinationPath $tmpDir -Force
            $binaryPath = Join-Path $tmpDir "$BinaryName.exe"
        } else {
            $binaryPath = $archivePath
        }

        if (-not (Test-Path $binaryPath)) {
            $binaryPath = Join-Path $tmpDir "$BinaryName.exe"
            if (-not (Test-Path $binaryPath)) {
                if ($ContinueOnError) { throw "Binary '$BinaryName.exe' not found in archive" }
                Stop-WithError "Binary '$BinaryName.exe' not found in archive"
            }
        }

        $destPath = Join-Path $OutputDir "$BinaryName.exe"
        Write-Info "Installing to $destPath..."
        Copy-Item -Path $binaryPath -Destination $destPath -Force
        # Unblock if Windows marked it as from the internet (ZoneIdentifier)
        try { Unblock-File -Path $destPath -ErrorAction SilentlyContinue } catch {}
        Write-Success "Installed $BinaryName $Version"

        return $destPath
    }
    finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- PATH Management -------------------------------------------------------

function Add-ToUserPath {
    param([string]$Dir)

    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $pathEntries = if ($userPath) { $userPath -split ';' | Where-Object { $_ -ne '' } } else { @() }
    $alreadyPresent = $pathEntries | Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }

    if (-not $alreadyPresent) {
        $newUserPath = if ($userPath) { "$userPath;$Dir" } else { $Dir }
        [Environment]::SetEnvironmentVariable("PATH", $newUserPath, "User")
        Write-Success "Added $Dir to PATH (takes effect in new shells)"
    }

    # Also set for current session
    $sessionEntries = $env:PATH -split ';' | Where-Object { $_ -ne '' }
    $sessionPresent = $sessionEntries | Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }
    if (-not $sessionPresent) {
        $env:PATH = "$env:PATH;$Dir"
    }
}

# --- Orphaned Shortcut Cleanup ---------------------------------------------

function Clear-OrphanedShortcuts {
    <#
    .SYNOPSIS
        Remove orphaned OpenCode and oneinfo shortcuts whose target no longer exists.
    #>
    $WScriptShell = $null
    try {
        $WScriptShell = New-Object -ComObject WScript.Shell
    } catch {
        Write-Warn "Cannot create WScript.Shell COM object -- skipping shortcut cleanup"
        return
    }

    $locations = @(
        @{ Path = "$env:USERPROFILE\Desktop";                                                    Label = "User Desktop" }
        @{ Path = "$env:PUBLIC\Desktop";                                                          Label = "Public Desktop" }
        @{ Path = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs";                            Label = "Start Menu" }
        @{ Path = "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar";    Label = "Taskbar" }
    )

    $cleaned = 0
    foreach ($loc in $locations) {
        if (-not (Test-Path $loc.Path)) { continue }

        $shortcuts = Get-ChildItem -Path $loc.Path -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*OpenCode*" -or $_.Name -like "*oneinfo*" -or $_.Name -like "*one info*" }

        foreach ($sc in $shortcuts) {
            try {
                $shellLink = $WScriptShell.CreateShortcut($sc.FullName)
                $target = $shellLink.TargetPath
            } catch {
                continue
            }

            $isOrphan = [string]::IsNullOrWhiteSpace($target) -or (-not (Test-Path $target))
            if (-not $isOrphan) { continue }

            Remove-Item -Path $sc.FullName -Force -ErrorAction SilentlyContinue
            Write-Info "Cleaned orphaned shortcut: $($sc.Name)"
            $cleaned++
        }
    }

    if ($cleaned -gt 0) {
        Write-Success "Removed $cleaned orphaned shortcut(s)"
    } else {
        Write-Info "No orphaned shortcuts found"
    }
}

# --- Main -------------------------------------------------------------------

# --- Session DB migration ----------------------------------------------------
# opencode names its session database after the installation channel that was
# baked into the binary at build time (packages/core/src/database/database.ts):
#   stable channels (latest/beta/prod) -> <data>/opencode.db
#   preview channels                 -> <data>/opencode-<channel>.db
# The fork builds from feature branches, so a client updating from one fork
# build to another can switch channels (e.g. dev -> dev-fork-snapshot). The new
# channel starts with an empty DB and all previous sessions appear "lost" even
# though they are intact in the previous channel's DB. Before relaunching, copy
# the newest existing session DB over the DB this build is about to use.
function Migrate-SessionDatabase {
    param(
        [string]$Version,
        [string]$BinaryPath = ""
    )

    # This runs during install with $ErrorActionPreference = Stop at script
    # level; any failure here must never abort the whole installer.
    $destPath = ""
    $destName = ""
    $swapStarted = $false
    try {
        $dataDir = Join-Path $env:USERPROFILE ".local\share\opencode"
        if (-not (Test-Path $dataDir)) {
            Write-Info "No session data directory yet ($dataDir) -- nothing to migrate."
            return
        }

        # Derive the channel this build will use. The channel is baked into the
        # binary at build time and is the most reliable source: `opencode
        # --version` prints 0.0.0-<channel>-<timestamp> for preview builds, or a
        # plain semver for stable builds (which use opencode.db). The release tag
        # is a fallback when the binary cannot be executed. Both patterns anchor
        # the channel capture to the FINAL -<12-14 digits> segment so a channel
        # that itself contains digit groups (e.g. dev-202608041234-foo) is not
        # truncated.
        $channel = ""
        if ($BinaryPath -and (Test-Path $BinaryPath)) {
            # Probe the binary for its baked-in channel, BOUNDED: a first-run
            # AV scan or a hung build must not stall the installer, and a probe
            # that emits nothing must fall through to the version-tag fallback
            # instead of throwing.
            $binVer = ""
            $outFile = Join-Path $env:TEMP "opencode-version-probe-$PID.out"
            $errFile = Join-Path $env:TEMP "opencode-version-probe-$PID.err"
            try {
                $probe = Start-Process -FilePath $BinaryPath -ArgumentList "--version" -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile -ErrorAction SilentlyContinue
                if (-not $probe.WaitForExit(15000)) {
                    $probe.Kill()
                    Write-Warn "opencode --version probe timed out after 15s; falling back to release tag."
                }
                # Ensure the redirected handles are released so the temp files
                # can be removed reliably.
                $null = $probe.WaitForExit()
                $probe.Dispose()
                if (Test-Path $outFile) { $binVer = (Get-Content $outFile -Raw).Trim() }
            } catch {
                $binVer = ""
            } finally {
                Remove-Item -Path $outFile, $errFile -Force -ErrorAction SilentlyContinue
            }
            if ($binVer -match '^0\.0\.0-([A-Za-z0-9._-]+?)-(\d{12,14})$') { $channel = $matches[1] }
        }
        if (-not $channel -and $Version -match '^v?0\.0\.0-([A-Za-z0-9._-]+?)-(\d{12,14})$') { $channel = $matches[1] }
        if ($channel) {
            $destName = if ($channel -notin @("latest", "beta", "prod")) { "opencode-$channel.db" } else { "opencode.db" }
        } elseif ($Version -match '^v?\d+\.\d+\.\d+$') {
            # Stable release: the app always uses opencode.db.
            $destName = "opencode.db"
        } else {
            # No channel derivable (detached-HEAD build, unexecutable binary,
            # unknown version format). Migrating to a guessed name could copy
            # sessions to a DB the app never reads, so warn and skip.
            Write-Warn "Session DB migration skipped: could not determine channel from binary '$BinaryPath' or version '$Version'."
            return
        }
        # The app also honors an env override that forces opencode.db even for
        # preview channels; mirror its exact semantics (only "1" or "true",
        # case-sensitive) so we never write to a DB the app ignores.
        if ($env:OPENCODE_DISABLE_CHANNEL_DB -ceq "1" -or $env:OPENCODE_DISABLE_CHANNEL_DB -ceq "true") {
            $destName = "opencode.db"
        }
        $destPath = Join-Path $dataDir $destName

        # Measure the destination including sidecars: an un-checkpointed WAL can
        # hold sessions the main DB file size alone would miss. We only ever
        # migrate into an EMPTY destination: an existing DB (any size) belongs to
        # the channel the user is already using and must never be overwritten,
        # even when it is small (a few short chats can sit under 512KB).
        $destTotal = 0
        foreach ($suffix in @("", "-wal", "-shm")) {
            $p = "$destPath$suffix"
            if (Test-Path $p) { $destTotal += (Get-Item $p).Length }
        }

        # Find candidate sources BEFORE the guard so skip messages can point at
        # the surviving source. Measure each candidate including sidecars: after
        # the process stop, a heavy session's data can live in a large WAL with
        # a small main file.
        $allCandidates = @(Get-ChildItem -Path $dataDir -Filter "opencode*.db" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notlike "$destName*" -and $_.Name -notmatch '\.backup-' })
        $candidateList = @()
        foreach ($c in $allCandidates) {
            $cSize = $c.Length
            foreach ($suffix in @("-wal", "-shm")) {
                $sp = "$($c.FullName)$suffix"
                if (Test-Path $sp) { $cSize += (Get-Item $sp).Length }
            }
            $candidateList += [pscustomobject]@{ File = $c; SizeWithSidecars = $cSize }
        }
        $candidates = @($candidateList | Where-Object { $_.SizeWithSidecars -gt 300KB } |
            Sort-Object @{ Expression = { $_.File.LastWriteTime }; Descending = $true }, @{ Expression = { $_.File.Name } })
        $source = if ($candidates.Count -gt 0) { $candidates[0].File } else { $null }

        if ($destTotal -gt 0) {
            $hint = if ($source) { "Your previous sessions remain intact in $($source.Name) in $dataDir." } else { "Your previous sessions remain intact in the other channel DB(s) in $dataDir." }
            if ($destTotal -le 512KB) {
                Write-Warn "$destName already exists ($destTotal bytes) -- skipping migration to avoid overwriting it. If it is empty or a partial from an interrupted migration, delete $destName (plus its -wal/-shm files) and re-run to migrate your sessions. $hint"
            } else {
                Write-Info "$destName already holds sessions ($destTotal bytes incl. sidecars) -- skipping migration. If it was left by an interrupted migration, delete $destName (plus its -wal/-shm files) and re-run. $hint"
            }
            return
        }

        if (-not $source) {
            if ($allCandidates) {
                Write-Warn "Found session DB(s) below the migration threshold ($($allCandidates.Name -join ', ')) -- not migrated. If sessions appear missing, check those files."
            } else {
                Write-Info "No previous session DB to migrate."
            }
            return
        }

        # Swap: copy the source DB, then the source sidecars, then remove any
        # destination sidecar the source did not provide (a stale WAL from a
        # previous channel must never replay against the newly copied DB).
        $swapStarted = $true
        Copy-Item -Path $source.FullName -Destination $destPath -Force
        foreach ($suffix in @("-wal", "-shm")) {
            $srcSidecar = "$($source.FullName)$suffix"
            if (Test-Path $srcSidecar) {
                Copy-Item -Path $srcSidecar -Destination "$destPath$suffix" -Force
            } else {
                Remove-Item -Path "$destPath$suffix" -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Success "Migrated sessions from $($source.Name) -> $destName"
    } catch {
        Write-Warn "Session DB migration failed (continuing install): $($_.Exception.Message)"
        # The destination was empty before the swap, so the only thing to undo is
        # a partial copy. Keep this failure-isolated: a rollback error must never
        # abort the installer.
        try {
            if ($swapStarted) {
                foreach ($suffix in @("", "-wal", "-shm")) {
                    Remove-Item -Path "$destPath$suffix" -Force -ErrorAction SilentlyContinue
                }
                Write-Warn "Removed partial $destName after failed migration."
            }
            # If the swap never started, the destination was never touched.
        } catch {
            Write-Warn "Session DB rollback also failed (leaving install as-is): $($_.Exception.Message)"
        }
    }
}

function Main {
    [CmdletBinding()]
    param(
        [string]$Version = "",
        [string]$Channel = $(if ($env:GENTLE_AI_CHANNEL) { $env:GENTLE_AI_CHANNEL } else { "stable" }),
        [switch]$NoModifyPath,
        [switch]$UseMirror,
        [switch]$Desktop
    )

    if ($Channel -eq "nightly") { $Channel = "beta" }

    Show-Banner

    # --- Orphaned Shortcut Cleanup ------------------------------------------

    Write-Step "Cleaning orphaned shortcuts"
    Clear-OrphanedShortcuts

    # --- Version detection --------------------------------------------------

    if (-not $Version) {
        $Version = Get-LatestVersion -Repo $OPENCODE_REPO
    }

    if (-not $Version -and -not $UseMirror) {
        Write-Warn "GitHub is unreachable. Trying Nextcloud mirror..."
        $Version = Get-LatestFromNextcloud
        if (-not $Version) {
            $Version = $FALLBACK_VERSION
            Write-Warn "Using fallback version: $Version"
        }
        $UseMirror = $true
        Write-Info "Mirror mode enabled automatically."
    }

    if (-not $Version) {
        Stop-WithError "Could not determine opencode version and no mirror available."
    }

    # --- Prerequisites ------------------------------------------------------

    Write-Step "Checking prerequisites"

    $missing = @()
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        $missing += "git"
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        $missing += "node"
    }
    # npm is bundled with Node.js -- check only if node is present but npm isn't
    if ((Get-Command node -ErrorAction SilentlyContinue) -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
        $missing += "npm"
    }

    if ($missing.Count -gt 0) {
        Write-Warn "Missing: $($missing -join ', ')"
        Write-Info "gentle-ai needs git, node, and npm to install skills and plugins."

        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Info "Attempting auto-install via winget..."
            foreach ($tool in $missing) {
                if ($tool -eq "git") {
                    Write-Info "Installing Git..."
                    winget install --id Git.Git --source winget --accept-package-agreements --accept-source-agreements
                } elseif ($tool -eq "node") {
                    Write-Info "Installing Node.js (LTS)..."
                    winget install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements
                } elseif ($tool -eq "npm") {
                    Write-Info "npm is bundled with Node.js -- will be available after Node install"
                }
            }
            Write-Warn "Prerequisites were just installed. Restart your terminal and re-run this installer."
            Write-Host ""
            Write-Host "  1. Close this window" -ForegroundColor Cyan
            Write-Host "  2. Open a NEW PowerShell as Administrator" -ForegroundColor Cyan
            Write-Host "  3. Re-run: irm https://github.com/ivanfernadezm99/opencode/releases/latest/download/install.ps1 | iex" -ForegroundColor DarkGray
            Write-Host ""
            Write-Info "Log saved to: $INSTALL_LOG_FILE"
            Stop-Transcript | Out-Null
            exit 0
        } else {
            Write-Err "winget not found. Please install manually:"
            Write-Host ""
            Write-Host "  Git:      https://git-scm.com/download/win" -ForegroundColor Cyan
            Write-Host "  Node.js:  https://nodejs.org/ (LTS)" -ForegroundColor Cyan
            Write-Host ""
            Write-Host "  After installing, OPEN A NEW TERMINAL and re-run the installer." -ForegroundColor Yellow
            Write-Host ""
            Write-Info "Log saved to: $INSTALL_LOG_FILE"
            Stop-Transcript | Out-Null
            exit 1
        }
    }
    Write-Success "git, node, npm -- all present"

    # Stop any running opencode processes BEFORE replacing the binary and
    # migrating session data: a running app locks opencode.exe (file-in-use
    # on replace) and keeps writing to its session DB (a live-WAL copy can
    # tear). Also gracefully stop the engram HTTP server (port 7437) so it
    # flushes mid-write state instead of being force-killed.
    Write-Info "Stopping running opencode processes..."
    foreach ($procName in @("one info code.exe", "@opencode-aidesktop.exe", "OpenCode Dev.exe", "opencode.exe")) {
        taskkill /f /fi "IMAGENAME eq $procName" 2>$null | Out-Null
    }
    Start-Sleep -Seconds 2
    Write-Info "Stopping engram server gracefully..."
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:7437/shutdown" -Method Post -TimeoutSec 3 -ErrorAction SilentlyContinue
    } catch {}
    # Give the server a moment to flush, then force-kill if it is still up so
    # the binary can be replaced without a file-in-use failure.
    Start-Sleep -Seconds 2
    if (Get-Process -Name "engram" -ErrorAction SilentlyContinue) {
        taskkill /f /fi "IMAGENAME eq engram.exe" 2>$null | Out-Null
        Start-Sleep -Seconds 1
    }

    # Back up ALL user data BEFORE replacing anything, just in case: every
    # session DB (opencode-*.db across all channels, with -wal/-shm sidecars)
    # and the engram persistent-memory DB. The installer never deletes these
    # files and the migration below only copies into an empty destination, but
    # a pre-update snapshot means a botched update can always be rolled back
    # by hand. Best-effort: a backup failure warns and continues rather than
    # aborting the install.
    Write-Step "Backing up session and engram databases"
    $backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupCount = 0
    try {
        $sessionDataDir = Join-Path $env:USERPROFILE ".local\share\opencode"
        if (Test-Path $sessionDataDir) {
            foreach ($sdb in @(Get-ChildItem -Path $sessionDataDir -Filter "opencode*.db" -File -ErrorAction SilentlyContinue)) {
                foreach ($suffix in @("", "-wal", "-shm")) {
                    $sp = "$($sdb.FullName)$suffix"
                    if (Test-Path $sp) {
                        Copy-Item -Path $sp -Destination "$sp.backup-$backupStamp" -Force -ErrorAction SilentlyContinue
                        if (Test-Path "$sp.backup-$backupStamp") { $backupCount++ }
                    }
                }
            }
        }
        $engramDbDir = Join-Path $env:USERPROFILE ".engram"
        $engramDbPath = Join-Path $engramDbDir "engram.db"
        if (Test-Path $engramDbPath) {
            foreach ($suffix in @("", "-wal", "-shm")) {
                $ep = "$engramDbPath$suffix"
                if (Test-Path $ep) {
                    Copy-Item -Path $ep -Destination "$ep.backup-$backupStamp" -Force -ErrorAction SilentlyContinue
                    if (Test-Path "$ep.backup-$backupStamp") { $backupCount++ }
                }
            }
        }
        if ($backupCount -gt 0) {
            Write-Success "Backed up $backupCount session/engram file(s) -> *.backup-$backupStamp"
        } else {
            Write-Info "No existing session/engram databases to back up (fresh install)."
        }
    } catch {
        Write-Warn "Pre-update data backup failed (continuing install): $($_.Exception.Message)"
    }

    Write-Step "Installing opencode-fork"
    $opencodeInstalled = $Version -and (Get-InstalledVersion -BinaryPath (Join-Path $OPENCODE_DIR "opencode.exe")) -eq $Version
    if ($opencodeInstalled) {
        Write-Success "opencode already at latest version ($Version), skipping."
    } else {
        $installParams = @{
            Repo       = $OPENCODE_REPO
            OutputDir  = $OPENCODE_DIR
            AssetName  = "opencode"
            BinaryName = "opencode"
            Version    = $Version
        }
        if ($UseMirror) {
            Write-Info "Downloading from Nextcloud mirror..."
            $installParams.MirrorUrl = $NEXTCLOUD_MIRROR
        }
        Install-Binary @installParams
    }

    # Migrate session history from a previous channel's DB so an update never
    # looks like it erased the user's conversations. Must run BEFORE the new
    # binary is first invoked (default cron setup below), otherwise the new
    # channel's DB would be created and its fresh cron rows clobbered by the
    # migration. The CLI binary's baked-in channel is authoritative for the DB
    # name; the desktop exe is bundled with a fixed channel (dev), so desktop
    # sessions never switch channels and need no migration here.
    $opencodeExe = Join-Path $OPENCODE_DIR "opencode.exe"
    Migrate-SessionDatabase -Version $Version -BinaryPath $opencodeExe

    Write-Step "Installing gentle-ai"
    $gentleLatest = Get-LatestVersion -Repo $GENTLE_REPO
    if (-not $gentleLatest) {
        Write-Warn "Cannot reach GitHub for gentle-ai. Using known version..."
        $gentleVersion = "v2.1.10"
    } else {
        $gentleVersion = Get-WindowsVersion -Repo $GENTLE_REPO -BinaryName "gentle-ai" -LatestVersion $gentleLatest
        if (-not $gentleVersion) {
            Write-Warn "No Windows build found for gentle-ai. Using last known version..."
            $gentleVersion = "v2.1.10"
        }
    }
    $gentleInstalled = $gentleVersion -and (Get-InstalledVersion -BinaryPath (Join-Path $GENTLE_DIR "gentle-ai.exe")) -eq $gentleVersion
    if ($gentleInstalled) {
        Write-Success "gentle-ai already at latest version ($gentleVersion), skipping."
    } else {
        try {
            Install-Binary -Repo $GENTLE_REPO -OutputDir $GENTLE_DIR -AssetName "gentle-ai" -BinaryName "gentle-ai" -Version $gentleVersion -ContinueOnError
        } catch {
            Write-Warn "gentle-ai install failed (continuing install): $($_.Exception.Message)"
        }
    }

    Write-Step "Installing engram"
    # engram lives in its own repo (Gentleman-Programming/engram) as a separate
    # binary. The MCP manifest ({{GENTLE_BIN}}/engram.exe mcp --tools=agent)
    # depends on it, but it was never installed by this script — on client
    # machines engram.exe did not exist, so the engram MCP server stayed "failed".
    # Install it into GENTLE_DIR so `engram mcp` (a short-lived stdio subprocess
    # launched by opencode) resolves; the engram HTTP server (`engram serve`,
    # port 7437) is only needed by the session-tracking plugin and auto-starts.
    $engramLatest = Get-LatestVersion -Repo $ENGRAM_REPO
    if (-not $engramLatest) {
        Write-Warn "Cannot reach GitHub for engram. Using a known version..."
        $engramVersion = "v1.20.0"
    } else {
        $engramVersion = Get-WindowsVersion -Repo $ENGRAM_REPO -BinaryName "engram" -LatestVersion $engramLatest
        if (-not $engramVersion) {
            Write-Warn "No Windows build found for engram. Using a known version..."
            $engramVersion = "v1.20.0"
        }
    }
    $engramInstalled = $engramVersion -and (Get-InstalledVersion -BinaryPath (Join-Path $GENTLE_DIR "engram.exe")) -eq $engramVersion
    if ($engramInstalled) {
        Write-Success "engram already at latest version ($engramVersion), skipping."
    } else {
        try {
            Install-Binary -Repo $ENGRAM_REPO -OutputDir $GENTLE_DIR -AssetName "engram" -BinaryName "engram" -Version $engramVersion -ContinueOnError
        } catch {
            Write-Warn "engram install failed (continuing install): $($_.Exception.Message)"
        }
    }

    # Verify engram DB integrity after binary swap. A new engram build may run a
    # schema migration on first start; detect a re-created (empty) DB before the
    # backup step below overwrites the only good copy.
    $engramDbDir = Join-Path $env:USERPROFILE ".engram"
    $engramDbPath = Join-Path $engramDbDir "engram.db"
    if (Test-Path $engramDbPath) {
        $dbSizeAfter = (Get-Item $engramDbPath).Length
        if ($dbSizeAfter -lt 1024) {
            Write-Warn "engram.db suspiciously small after update ($dbSizeAfter bytes) — persistent memory may be lost. Check $engramDbDir for *.backup-* files."
        } else {
            Write-Success "engram.db intact after update ($([math]::Round($dbSizeAfter / 1KB)) KB)"
        }
    }

    Write-Step "Setting up PATH"
    if (-not $NoModifyPath) {
        Add-ToUserPath -Dir $OPENCODE_DIR
        Add-ToUserPath -Dir $GENTLE_DIR
    }

    Write-Step "Backing up Engram database (if exists)"
    if (Test-Path $engramDbPath) {
        try {
            $backupName = "engram.db.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            $backupPath = Join-Path $engramDbDir $backupName
            Copy-Item -Path $engramDbPath -Destination $backupPath -Force
            $dbSize = (Get-Item $engramDbPath).Length
            Write-Success "Backed up engram.db ($([math]::Round($dbSize / 1KB)) KB) -> $backupName"
        } catch {
            Write-Warn "engram.db backup failed (continuing install): $($_.Exception.Message)"
        }
    } else {
        Write-Info "No existing engram.db found -- fresh install"
    }

    Write-Step "Configuring gentle-ai for opencode"
    $gentleExe = Join-Path $GENTLE_DIR "gentle-ai.exe"
    if (Test-Path $gentleExe) {
        Write-Info "This may take a minute -- downloading skills, agents, and tools..."
        $envPath = $env:GENTLE_AI_CHANNEL
        if ($Channel -ne "stable") {
            $env:GENTLE_AI_CHANNEL = $Channel
        }
        $prevEA = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $gentleExe
            $psi.Arguments = "install --agent opencode"
            $psi.UseShellExecute = $false
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $proc = [System.Diagnostics.Process]::Start($psi)
            $stdout = $proc.StandardOutput.ReadToEnd()
            $stderr = $proc.StandardError.ReadToEnd()
            $proc.WaitForExit()
            $output = "$stdout`n$stderr"
            if ($proc.ExitCode -ne 0) {
                Write-Warn "gentle-ai install exited with code $($proc.ExitCode)"
                if ($output.Trim()) { Write-Host $output -ForegroundColor DarkGray }
                Write-Warn "You can run 'gentle-ai install --agent opencode' manually later."
            } else {
                Write-Success "gentle-ai configured opencode agent"
                if ($output.Trim()) { Write-Host $output -ForegroundColor DarkGray }
            }
        }
        catch {
            Write-Warn "gentle-ai install error: $_"
            Write-Warn "You can run 'gentle-ai install --agent opencode' manually later."
        }
        finally {
            $ErrorActionPreference = $prevEA
            $env:GENTLE_AI_CHANNEL = $envPath
        }
    }

    Write-Step "Linking config for desktop app"
    $desktopAppId = "ai.opencode.desktop.dev"
    $desktopConfig = Join-Path $env:APPDATA "$desktopAppId\config\opencode"
    $globalConfig = Join-Path $env:USERPROFILE ".config\opencode"
    if (Test-Path $globalConfig) {
        if (-not (Test-Path $desktopConfig)) {
            New-Item -ItemType Directory -Path $desktopConfig -Force | Out-Null
        }
        Copy-Item -Path "$globalConfig\*" -Destination $desktopConfig -Recurse -Force
        Write-Success "Desktop app config linked"
    } else {
        Write-Warn "No global config found -- desktop app may need manual setup"
    }

    Write-Step "Installing project skills"
    $skillsDir = Join-Path $env:USERPROFILE ".config\opencode\skills"
    $skillsStampFile = Join-Path $skillsDir ".installed-version"
    $repoUrl = "https://github.com/ivanfernadezm99/opencode.git"
    $tempDir = Join-Path $env:TEMP "opencode-skills-$(Get-Random)"
    $shouldInstall = $true

    # Always reinstall skills — sparse checkout is fast and clients need the
    # latest skills even when the opencode version hasn't changed.

    if ($shouldInstall) {
        try {
            # Sparse checkout of .opencode/skills/ only — fast, no full clone
            $null = New-Item -ItemType Directory -Path $tempDir -Force
            git init -q $tempDir 2>$null
            git -C $tempDir remote add origin $repoUrl
            git -C $tempDir config core.sparseCheckout true
            New-Item -Path "$tempDir\.git\info" -Name "sparse-checkout" -ItemType File -Force | Out-Null
            Set-Content "$tempDir\.git\info\sparse-checkout" @"
.opencode/skills/*
.opencode/scripts/*
"@
            Write-Info "Downloading skills and tools from repo..."
            git -C $tempDir pull -q --depth 1 origin dev 2>$null
            $downloadedSkills = Join-Path $tempDir ".opencode\skills"
            if (Test-Path $downloadedSkills) {
                if (-not (Test-Path $skillsDir)) {
                    New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null
                }
                # Copy each skill, skip node_modules
                Get-ChildItem -Path $downloadedSkills -Directory | ForEach-Object {
                    $dest = Join-Path $skillsDir $_.Name
                    if (Test-Path $dest) {
                        Remove-Item -Path $dest -Recurse -Force -ErrorAction SilentlyContinue
                    }
                    Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force -Exclude "node_modules"
                    Write-Success "  Skill '$($_.Name)' installed"
                    # Install skill dependencies if package.json exists
                    $pkgJson = Join-Path $dest "package.json"
                    if (Test-Path $pkgJson) {
                        try {
                            Write-Info "     Installing dependencies for '$($_.Name)'..."
                            Push-Location $dest
                            # Prefer bun, fall back to npm
                            if (Get-Command "bun" -ErrorAction SilentlyContinue) {
                                $depResult = bun install --production 2>&1
                                if ($LASTEXITCODE -eq 0) {
                                    Write-Success "     Dependencies installed (bun)"
                                } else {
                                    Write-Warn "     bun install failed, trying npm..."
                                    npm install --production --no-audit --no-fund 2>&1 | Out-Null
                                    if ($LASTEXITCODE -eq 0) { Write-Success "     Dependencies installed (npm)" }
                                    else { Write-Warn "     Could not install dependencies ($($_.Name))" }
                                }
                            } elseif (Get-Command "npm" -ErrorAction SilentlyContinue) {
                                npm install --production --no-audit --no-fund 2>&1 | Out-Null
                                if ($LASTEXITCODE -eq 0) { Write-Success "     Dependencies installed (npm)" }
                                else { Write-Warn "     Could not install dependencies ($($_.Name))" }
                            } else {
                                Write-Warn "     No package manager found (need bun or npm)"
                            }
                            Pop-Location
                        } catch {
                            Write-Warn "     Failed to install dependencies for '$($_.Name)': $_"
                            Pop-Location
                        }
                    }
                }
                # Write version stamp
                if ($Version) {
                    Set-Content -Path $skillsStampFile -Value $Version -NoNewline
                }
            }
        } catch {
            Write-Warn "Could not download skills: $_"
            Write-Warn "Skills can be cloned manually: git clone $repoUrl"
        } finally {
            if (Test-Path $tempDir) { Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    Write-Step "Configuring MCP servers"
    $opencodeConfigDir = Join-Path $env:USERPROFILE ".config\opencode"
    $opencodeConfigFile = Join-Path $opencodeConfigDir "opencode.json"
    # Ensure directory exists
    if (-not (Test-Path $opencodeConfigDir)) {
        New-Item -ItemType Directory -Path $opencodeConfigDir -Force | Out-Null
    }
    # Read existing config or create minimal one
    if (Test-Path $opencodeConfigFile) {
        $config = Get-Content $opencodeConfigFile -Raw | ConvertFrom-Json
    } else {
        $config = [ordered]@{}
    }
    # Read MCP server manifest from repo
    $mcpManifest = $null
    $mcpManifestVersion = $null
    $mcpManifestUrl = "https://raw.githubusercontent.com/ivanfernadezm99/opencode/dev/.opencode/mcp-servers.json"
    try {
        $mcpManifestJson = Invoke-RestMethod -Uri $mcpManifestUrl -UseBasicParsing -TimeoutSec 15 -Headers @{ "User-Agent" = "gentle-opencode-installer" }
        $mcpManifest = $mcpManifestJson.servers
        $mcpManifestVersion = $mcpManifestJson.version
        Write-Info "Loaded MCP manifest from repo v$mcpManifestVersion ($($mcpManifest.PSObject.Properties.Name.Count) servers)"
    } catch {
        Write-Warn "Could not download MCP manifest from repo: $_"
        Write-Warn "Falling back to built-in MCP servers"
    }

    # Check if MCP manifest has already been applied
    $stampedVersion = Get-McpManifestVersion
    if ($mcpManifestVersion -and $stampedVersion -eq $mcpManifestVersion) {
        Write-Info "MCP manifest v$mcpManifestVersion already applied, skipping."
    } else {
        Write-Info "MCP manifest v$mcpManifestVersion is new (was v$($stampedVersion)), processing..."

        # Ensure MCP section exists in config
        if (-not $config.mcp) { $config | Add-Member -NotePropertyName "mcp" -NotePropertyValue ([ordered]@{}) }

        # Install MCP servers from manifest (or fallback to built-in)
        $mcpServers = if ($mcpManifest) { $mcpManifest } else {
            # Built-in fallback if manifest is unreachable
            [ordered]@{
                context7 = [ordered]@{ enabled = $true; type = "remote"; url = "https://mcp.context7.com/mcp" }
                engram = [ordered]@{ enabled = $true; type = "local"; command_template = @("{{GENTLE_BIN}}", "mcp", "--tools=agent") }
                playwright = [ordered]@{ enabled = $true; type = "local"; command = @("npx", "@anthropic-ai/mcp-playwright@latest"); postinstall = "npx @anthropic-ai/mcp-playwright@latest install" }
                codegraph = [ordered]@{ enabled = $true; type = "local"; command = @("codegraph", "serve", "--mcp") }
            }
        }

        foreach ($serverName in $mcpServers.PSObject.Properties.Name) {
            $serverDef = $mcpServers.$serverName

            # Skip if already configured (preserve user overrides)
            if ($config.mcp.$serverName) {
                Write-Info "MCP server '$serverName' already configured, skipping."
                continue
            }

            # Build server config
            $serverConfig = [ordered]@{ type = $serverDef.type }

            if ($serverDef.type -eq "remote") {
                $serverConfig.url = $serverDef.url
                $serverConfig.enabled = if (Test-Property $serverDef "enabled") { $serverDef.enabled } else { $true }
            } else {
                if (Test-Property $serverDef "command_template") {
                    $resolvedCommand = $serverDef.command_template | ForEach-Object {
                        $_ -replace "{{GENTLE_BIN}}", (Join-Path $GENTLE_DIR "engram.exe")
                    }
                    $serverConfig.command = [string[]]$resolvedCommand
                } elseif (Test-Property $serverDef "command") {
                    $serverConfig.command = [string[]]$serverDef.command
                }
                if (Test-Property $serverDef "enabled") { $serverConfig.enabled = $serverDef.enabled }
            }

            $config.mcp | Add-Member -NotePropertyName $serverName -NotePropertyValue $serverConfig
            Write-Success "Added MCP server: $serverName"

            # Run postinstall if defined
            if ((Test-Property $serverDef "postinstall") -and $serverDef.postinstall) {
                Write-Info "Running postinstall for '$serverName'..."
                try {
                    $prevEA = $ErrorActionPreference
                    $ErrorActionPreference = "Continue"
                    cmd /c " $($serverDef.postinstall) " 2>&1 | Out-Null
                    $ErrorActionPreference = $prevEA
                    Write-Success "Postinstall for '$serverName' completed"
                } catch {
                    Write-Warn "Postinstall for '$serverName' failed: $_"
                }
            }
        }

        # ---- Scan installed skills for additional MCP dependencies ----
        $skillsDir = Join-Path $env:USERPROFILE ".config\opencode\skills"
        if (Test-Path $skillsDir) {
            $skillMcpFiles = Get-ChildItem -Path $skillsDir -Recurse -Filter "mcp.json" -Depth 2 -ErrorAction SilentlyContinue
            foreach ($mcpFile in $skillMcpFiles) {
                try {
                    $skillMcp = Get-Content $mcpFile.FullName -Raw | ConvertFrom-Json
                    $skillName = $skillMcp.skill
                    $dependsOn = $skillMcp.depends_on
                    $inlineServers = $skillMcp.mcp_servers

                    if (-not $dependsOn -and -not $inlineServers) { continue }

                    Write-Info "Skill '$skillName' declares MCP dependencies: $($dependsOn -join ', ')"

                    foreach ($dep in $dependsOn) {
                        if ($config.mcp.$dep) {
                            Write-Info "  MCP '$dep' already configured (required by '$skillName')"
                            continue
                        }
                        if ($mcpManifest -and $mcpManifest.$dep) {
                            $depDef = $mcpManifest.$dep
                            $depConfig = [ordered]@{ type = $depDef.type }
                            if ($depDef.type -eq "remote") {
                                $depConfig.url = $depDef.url
                            } elseif (Test-Property $depDef "command_template") {
                                $resolved = $depDef.command_template | ForEach-Object {
                                    $_ -replace "{{GENTLE_BIN}}", (Join-Path $GENTLE_DIR "engram.exe")
                                }
                                $depConfig.command = [string[]]$resolved
                            } elseif (Test-Property $depDef "command") {
                                $depConfig.command = [string[]]$depDef.command
                            }
                            if (Test-Property $depDef "enabled") { $depConfig.enabled = $depDef.enabled }
                            $config.mcp | Add-Member -NotePropertyName $dep -NotePropertyValue $depConfig
                            Write-Success "  Added MCP '$dep' (required by skill '$skillName')"
                        } else {
                            Write-Warn "  Skill '$skillName' requires MCP '$dep' but no definition found in manifest"
                        }
                    }

                    if ($inlineServers) {
                        foreach ($srvName in $inlineServers.PSObject.Properties.Name) {
                            if ($config.mcp.$srvName) { continue }
                            $config.mcp | Add-Member -NotePropertyName $srvName -NotePropertyValue $inlineServers.$srvName
                            Write-Success "  Added inline MCP server '$srvName' from skill '$skillName'"
                        }
                    }
                } catch {
                    Write-Warn "  Could not parse mcp.json from $($mcpFile.FullName): $_"
                }
            }
        }

        # Write back
        $config | ConvertTo-Json -Depth 10 | Set-Content $opencodeConfigFile -Encoding UTF8
        Write-Success "MCP servers configured"

        # Stamp manifest version so we don't re-process next time
        if ($mcpManifestVersion) {
            Set-McpManifestVersion -Version $mcpManifestVersion
            Write-Info "MCP manifest v$mcpManifestVersion stamped."
        }
    }

    Write-Step "Setting up default cron jobs"
    $opencodeExe = Join-Path $OPENCODE_DIR "opencode.exe"
    $cronStampFile = Join-Path $env:USERPROFILE ".config\opencode\.default-crons-version"
    $cronManifestUrl = "https://raw.githubusercontent.com/ivanfernadezm99/opencode/dev/.opencode/default-crons.json"

    try {
        $cronManifest = Invoke-RestMethod -Uri $cronManifestUrl -UseBasicParsing -TimeoutSec 15 `
            -Headers @{ "User-Agent" = "gentle-opencode-installer" }
        $cronManifestVersion = $cronManifest.version
        Write-Info "Loaded default crons v$cronManifestVersion ($($cronManifest.jobs.Count) jobs)"
    } catch {
        Write-Warn "Could not download default crons manifest: $_"
        $cronManifest = $null
    }

    if ($cronManifest) {
        $stampedCronVersion = if (Test-Path $cronStampFile) { (Get-Content $cronStampFile -Raw).Trim() } else { "" }

        if ($cronManifestVersion -and $stampedCronVersion -eq $cronManifestVersion) {
            Write-Info "Default crons v$cronManifestVersion already applied, skipping."
        } else {
            # Get existing cron jobs to avoid duplicates
            $existingJobs = @()
            try {
                $cronList = & $opencodeExe cron list 2>&1
                if ($cronList -ne "No cron jobs found") {
                    # Parse names from cron list output
                    $cronList | ForEach-Object {
                        if ($_ -match '^\S+\s+(\S.*?)\s+\S+\s+\S+') {
                            $existingJobs += $matches[1].Trim()
                        }
                    }
                }
            } catch {
                Write-Warn "Could not list existing cron jobs — will attempt creation anyway"
            }

            foreach ($job in $cronManifest.jobs) {
                if ($job.name -in $existingJobs) {
                    Write-Info "Cron '$($job.name)' already exists, skipping."
                    continue
                }

                $cronArgs = @("cron", "add", $job.schedule, $job.prompt, "--name", $job.name)
                if ($job.model) { $cronArgs += "--model"; $cronArgs += $job.model }
                if ($job.skills) { $cronArgs += "--skills"; $cronArgs += $job.skills }
                if ($job.workdir) { $cronArgs += "--workdir"; $cronArgs += $job.workdir }
                if ($job.notify) { $cronArgs += "--notify" }

                Write-Info "Creating '$($job.name)' ($($job.schedule))..."
                try {
                    $result = & $opencodeExe @cronArgs 2>&1
                    if ($LASTEXITCODE -eq 0) {
                        Write-Success "  Created cron: $($job.name)"
                    } else {
                        Write-Warn "  Failed to create '$($job.name)': $result"
                    }
                } catch {
                    Write-Warn "  Error creating cron '$($job.name)': $_"
                }
            }

            # Stamp version to skip next time
            if ($cronManifestVersion) {
                $null = New-Item -ItemType Directory -Path (Split-Path $cronStampFile -Parent) -Force
                Set-Content -Path $cronStampFile -Value $cronManifestVersion -NoNewline
                Write-Info "Default crons v$cronManifestVersion stamped."
            }
        }
    }

    Write-Step "Installing credential manager (opencode-cred)"
    $credBinDir = Join-Path $env:USERPROFILE ".config\opencode\bin"
    $credScriptPath = Join-Path $credBinDir "opencode-cred.ps1"
    $credUrl = "https://raw.githubusercontent.com/ivanfernadezm99/opencode/dev/.opencode/scripts/opencode-cred"

    if (-not (Test-Path $credBinDir)) {
        New-Item -ItemType Directory -Path $credBinDir -Force | Out-Null
    }

    try {
        Write-Info "Downloading opencode-cred..."
        Invoke-WebRequest -Uri $credUrl -OutFile $credScriptPath -UseBasicParsing -TimeoutSec 15 `
            -Headers @{ "User-Agent" = "gentle-opencode-installer" }
        # Unblock if Windows marked it as from the internet
        try { Unblock-File -Path $credScriptPath -ErrorAction SilentlyContinue } catch {}
        Write-Success "Installed opencode-cred to $credScriptPath"
        Add-ToUserPath -Dir $credBinDir
    } catch {
        Write-Warn "Could not download opencode-cred: $_"
        Write-Warn "Credential manager not installed. Skills can still use their own credential files."
    }

    Write-Step "Creating desktop shortcut"
    try {
        $wsh = New-Object -ComObject WScript.Shell
        $desktopPath = [Environment]::GetFolderPath("Desktop")
        $shortcutPath = Join-Path $desktopPath "one info code.lnk"
        $targetPath = Join-Path $OPENCODE_DIR "opencode.exe"

        if (Test-Path $targetPath) {
            $lnk = $wsh.CreateShortcut($shortcutPath)
            $lnk.TargetPath = $targetPath
            $lnk.WorkingDirectory = $OPENCODE_DIR
            $lnk.Description = "one info code - AI-powered development environment"
            $lnk.Save()
            Write-Success "Shortcut created: $shortcutPath"
        } else {
            Write-Warn "opencode.exe not found -- skipping shortcut"
        }
    } catch {
        Write-Warn "Could not create shortcut: $_"
    }

    Write-Step "Verifying installation"
    $opencodeExe = Join-Path $OPENCODE_DIR "opencode.exe"
    if (Test-Path $opencodeExe) {
        try {
            $ver = & $opencodeExe --version 2>&1
            Write-Success "opencode: $ver"
        } catch {
            Write-Warn "Could not verify opencode version"
        }
    }

    if (Test-Path $gentleExe) {
        try {
            $ver = & $gentleExe version 2>&1
            Write-Success "gentle-ai: $ver"
        } catch {
            Write-Warn "Could not verify gentle-ai version"
        }
    }

    if ($Desktop) {
        Write-Step "Installing desktop app"

        # Clean stale lockfile that prevents app from starting
        $lockfile = Join-Path $env:APPDATA "ai.opencode.desktop.dev\lockfile"
        if (Test-Path $lockfile) {
            Remove-Item -Path $lockfile -Force -ErrorAction SilentlyContinue
            Write-Info "Cleaned stale lockfile"
        }

        $desktopExeName = "opencode-desktop-win-x64.exe"
        $desktopUrl = "https://github.com/$OPENCODE_REPO/releases/download/$Version/$desktopExeName"
        $desktopPath = Join-Path $env:TEMP $desktopExeName

        Write-Info "Downloading desktop app installer..."
        $ok = Download-WithRetry -Url $desktopUrl -OutFile $desktopPath -MaxRetries 2
        if ($ok) {
            Write-Info "Running desktop installer (silent)..."
            try {
                $proc = Start-Process -FilePath $desktopPath -ArgumentList "/S" -Wait -NoNewWindow -PassThru
                if ($proc.ExitCode -eq 0) {
                    Write-Success "Desktop app installed"
                } else {
                    Write-Warn "Desktop installer exited with code $($proc.ExitCode)"
                }
            } catch {
                Write-Warn "Could not run desktop installer: $_"
            }
            Remove-Item -Path $desktopPath -Force -ErrorAction SilentlyContinue

            # Create default cron jobs in the desktop app's database
            $desktopDataDir = Join-Path $env:APPDATA "ai.opencode.desktop.dev"
            if ($cronManifest -and (Test-Path $opencodeExe)) {
                Write-Info "Setting up default crons for desktop app..."
                $oldXdg = $env:XDG_DATA_HOME
                # Lock engram to its real DB location so the XDG redirect
                # cannot cause an empty DB to initialize under the desktop dir.
                $oldEngramDir = $env:ENGRAM_DATA_DIR
                $env:ENGRAM_DATA_DIR = Join-Path $env:USERPROFILE ".engram"
                $env:XDG_DATA_HOME = $desktopDataDir

                $desktopCronStamp = Join-Path $desktopDataDir ".default-crons-version"
                $desktopStamped = if (Test-Path $desktopCronStamp) { (Get-Content $desktopCronStamp -Raw).Trim() } else { "" }

                if ($cronManifestVersion -and $desktopStamped -eq $cronManifestVersion) {
                    Write-Info "Desktop app crons already up to date, skipping."
                } else {
                    foreach ($job in $cronManifest.jobs) {
                        $cronArgs = @("cron", "add", $job.schedule, $job.prompt, "--name", $job.name)
                        if ($job.model) { $cronArgs += "--model"; $cronArgs += $job.model }
                        if ($job.skills) { $cronArgs += "--skills"; $cronArgs += $job.skills }
                        if ($job.workdir) { $cronArgs += "--workdir"; $cronArgs += $job.workdir }
                        if ($job.notify) { $cronArgs += "--notify" }

                        Write-Info "  Creating '$($job.name)' for desktop app..."
                        try {
                            $result = & $opencodeExe @cronArgs 2>&1
                            if ($LASTEXITCODE -eq 0) {
                                Write-Success "    Created cron: $($job.name)"
                            } else {
                                Write-Warn "    Failed: $result"
                            }
                        } catch {
                            Write-Warn "    Error: $_"
                        }
                    }
                    if ($cronManifestVersion) {
                        $null = New-Item -ItemType Directory -Path $desktopDataDir -Force
                        Set-Content -Path $desktopCronStamp -Value $cronManifestVersion -NoNewline
                        Write-Info "Desktop app crons v$cronManifestVersion stamped."
                    }
                }
                $env:XDG_DATA_HOME = $oldXdg
                if ($null -eq $oldEngramDir) { Remove-Item Env:\ENGRAM_DATA_DIR -ErrorAction SilentlyContinue } else { $env:ENGRAM_DATA_DIR = $oldEngramDir }
            }
        } else {
            Write-Warn "Could not download desktop app installer"
            Write-Info "Download it manually from: https://github.com/$OPENCODE_REPO/releases/tag/$Version"
        }

        # Relaunch the desktop app after a successful install so the update
        # feels seamless (the app closed itself to allow file replacement).
        $launched = $false
        $installedExe = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Programs") -Filter "one info code.exe" -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch "Uninstall" } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if (-not $installedExe) {
            $uninstallKey = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match "one info code" } |
                Select-Object -First 1
            if ($uninstallKey.DisplayIcon -and (Test-Path $uninstallKey.DisplayIcon)) {
                $installedExe = Get-Item $uninstallKey.DisplayIcon
            }
        }
        if ($installedExe) {
            try {
                Start-Process -FilePath $installedExe.FullName
                Write-Success "Desktop app relaunched: $($installedExe.FullName)"
                $launched = $true
            } catch {
                Write-Warn "Could not relaunch desktop app: $_"
            }
        }
        if (-not $launched) {
            Write-Info "Desktop app installed. Open it from the Start Menu (one info code)."
        }
    }

    Write-Host ""
    Write-Host "Installation complete!" -ForegroundColor Green
    Write-Host ""
    Write-Info "Install log saved to: $INSTALL_LOG_FILE"
    Write-Host ""
    Write-Host "Next step:" -ForegroundColor White
    Write-Host "  Set your API key:" -ForegroundColor Cyan
    Write-Host '    $env:OPENCODE_API_KEY = "your-api-key"' -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Then open a project:" -ForegroundColor Cyan
    Write-Host "    opencode" -ForegroundColor White
    Write-Host ""
    Write-Host "  Press Tab to switch between agents:" -ForegroundColor Cyan
    Write-Host "    gentle-orchestrator  (SDD workflow)" -ForegroundColor DarkGray
    Write-Host "    Default              (standard chat)" -ForegroundColor DarkGray
    Write-Host ""
    Stop-Transcript | Out-Null
}

$mainParams = @{}
for ($i = 0; $i -lt $args.Count; $i++) {
    switch -Wildcard ($args[$i]) {
        '-Desktop'      { $mainParams['Desktop'] = $true }
        '-NoModifyPath' { $mainParams['NoModifyPath'] = $true }
        '-UseMirror'    { $mainParams['UseMirror'] = $true }
        '-Version'      { if ($i+1 -lt $args.Count) { $mainParams['Version'] = $args[++$i] } }
        '-Channel'      { if ($i+1 -lt $args.Count) { $mainParams['Channel'] = $args[++$i] } }
    }
}
Main @mainParams
