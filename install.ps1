# WinDrop installer - AirDrop-style file sharing between iPhone and Windows.
#
# One line (PowerShell):
#   irm https://raw.githubusercontent.com/sumitkumarraju/WinDrop/main/install.ps1 | iex
# Or from a downloaded / cloned copy:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# What it does:
#   1. Checks for Node.js 18+ (offers to install the LTS with winget)
#   2. Puts WinDrop in %LOCALAPPDATA%\WinDrop (or uses this folder when run from a clone)
#   3. Downloads cloudflared for Internet mode and checks Cloudflare's signature
#   4. Starts WinDrop with Windows and adds Desktop + Start menu shortcuts
#
# Options (environment variables):
#   $env:WINDROP_DIR = 'D:\Apps\WinDrop'   install somewhere else
#   $env:WINDROP_NO_TUNNEL = '1'          skip the cloudflared download (no Internet mode)

function Install-WinDrop {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $repo = 'sumitkumarraju/WinDrop'
    $branch = 'main'
    $port = 8765
    $check = [char]0x2713

    function Say([string]$msg) { Write-Host "  $msg" }
    function Step([string]$msg) { Write-Host "  > $msg" -ForegroundColor Cyan }
    function Done([string]$msg) { Write-Host "  $check $msg" -ForegroundColor Green }
    function Warn([string]$msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
    function Fail([string]$msg) { Write-Host "  x $msg" -ForegroundColor Red }

    Write-Host ''
    Write-Host '  WinDrop' -ForegroundColor White -NoNewline
    Write-Host '  -  AirDrop-style sharing for iPhone and Windows' -ForegroundColor DarkGray
    Write-Host ''

    if ([Environment]::OSVersion.Version.Major -lt 10) { Fail 'WinDrop needs Windows 10 or 11.'; return }

    # ---- 1. Node.js 18+ ----
    function Get-NodeMajor {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { return 0 }
        try { return [int]((& node -v).TrimStart('v').Split('.')[0]) } catch { return 0 }
    }
    Step 'Checking Node.js'
    if ((Get-NodeMajor) -lt 18) {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            $answer = Read-Host '    Node.js 18+ is required. Install Node.js LTS now with winget? [Y/n]'
            if ($answer -and $answer -notmatch '^(y|yes)$') { Fail 'Install Node.js from https://nodejs.org and run this again.'; return }
            winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        }
        if ((Get-NodeMajor) -lt 18) { Fail 'Node.js 18+ was not found. Install it from https://nodejs.org and run this again.'; return }
    }
    Done "Node.js $(& node -v) found"

    # ---- 2. Get WinDrop ----
    $local = $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'server.js'))
    $dir = if ($local) { $PSScriptRoot } elseif ($env:WINDROP_DIR) { $env:WINDROP_DIR } else { Join-Path $env:LOCALAPPDATA 'WinDrop' }

    # Stop a running copy so its files can be replaced.
    try { Invoke-RestMethod -Method Post -Uri "http://localhost:$port/api/quit" -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 2 } catch {}

    if ($local) {
        Done "Using this folder: $dir"
    } else {
        Step "Downloading WinDrop from github.com/$repo"
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("windrop-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force $tmp | Out-Null
        $zip = Join-Path $tmp 'windrop.zip'
        Invoke-WebRequest -Uri "https://github.com/$repo/archive/refs/heads/$branch.zip" -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
        New-Item -ItemType Directory -Force $dir | Out-Null
        # Copy everything except the demo video; keep this PC's settings and paired devices.
        Get-ChildItem $src.FullName -Force | Where-Object { $_.Name -ne 'docs' } | ForEach-Object {
            Copy-Item $_.FullName -Destination $dir -Recurse -Force
        }
        Remove-Item $tmp -Recurse -Force
        Done "Installed to $dir"
    }

    # ---- 3. cloudflared for Internet mode ----
    $cf = Join-Path $dir 'bin\cloudflared.exe'
    if ($env:WINDROP_NO_TUNNEL) {
        Say 'Skipping cloudflared (Internet mode will be unavailable).'
    } elseif (Test-Path $cf) {
        Done 'cloudflared already present (Internet mode)'
    } else {
        Step 'Downloading cloudflared for Internet mode (~55 MB, from Cloudflare)'
        New-Item -ItemType Directory -Force (Split-Path $cf) | Out-Null
        try {
            Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf -UseBasicParsing
            $sig = Get-AuthenticodeSignature $cf
            if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Cloudflare') {
                Remove-Item $cf -Force
                Warn 'cloudflared signature check failed; removed it. Internet mode will be unavailable.'
            } else {
                Done 'cloudflared downloaded and signature verified'
            }
        } catch {
            Warn "Could not download cloudflared ($($_.Exception.Message)). Everything else works; Internet mode needs it."
        }
    }

    # ---- 4. Start with Windows + shortcuts + launch ----
    Step 'Setting up start with Windows and shortcuts'
    Push-Location $dir
    try { & node server.js --install } finally { Pop-Location }

    Write-Host ''
    Done 'WinDrop is ready!'
    Say 'The WinDrop window opens in a few seconds.'
    Say 'If Windows Firewall asks about Node.js, tick "Private networks" and click Allow.'
    Say 'On your iPhone: scan the QR code, type the pairing code, then Share > Add to Home Screen.'
    Write-Host ''
}

Install-WinDrop
