# Removes WinDrop: stops it, removes start-with-Windows and the shortcuts, and (if you agree)
# deletes the app folder. Files you received stay in Downloads\WinDrop.
#
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

function Uninstall-WinDrop {
    $ErrorActionPreference = 'Stop'
    $dir = if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'server.js'))) { $PSScriptRoot }
           elseif ($env:WINDROP_DIR) { $env:WINDROP_DIR }
           else { Join-Path $env:LOCALAPPDATA 'WinDrop' }

    if (-not (Test-Path (Join-Path $dir 'server.js'))) {
        Write-Host "  WinDrop was not found in $dir" -ForegroundColor Yellow
        return
    }

    Push-Location $dir
    try { & node server.js --uninstall } finally { Pop-Location }
    Start-Sleep -Seconds 2

    $isClone = Test-Path (Join-Path $dir '.git')
    if (-not $isClone) {
        $answer = Read-Host "  Also delete the WinDrop folder ($dir)? Received files are kept. [y/N]"
        if ($answer -match '^(y|yes)$') {
            Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dir*" } | Stop-Process -Force
            Remove-Item $dir -Recurse -Force
            Write-Host '  Folder deleted.' -ForegroundColor Green
        }
    }
    Write-Host '  WinDrop removed. Your received files are still in Downloads\WinDrop.' -ForegroundColor Green
}

Uninstall-WinDrop
