# Installs or updates Hangar on Windows: irm https://hangar.odahcam.com/install.ps1 | iex
# Downloads the installer from a pinned GitHub release, checks its SHA-256 and runs it silently, for the current user
# (no admin prompt). The version and digest live here, not on GitHub: a release asset swapped there fails the check,
# so each release updates both lines and redeploys the Worker.
# Everything runs inside the function, called on the last line, so a download cut short runs nothing.
function Install-Hangar {
    $version = '0.5.0'
    $sha256 = '0c61e80eecc1c722cca2e467e59153a8e0dee2f2b01a122061133f0189a5c6e1'
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Hangar needs 64-bit Windows' }

    $name = "Hangar_${version}_x64-setup.exe"
    $setup = Join-Path ([IO.Path]::GetTempPath()) $name
    Write-Host "Downloading Hangar $version..."
    Invoke-WebRequest "https://github.com/odahcam/hangar/releases/download/v$version/$name" -OutFile $setup -UseBasicParsing
    try {
        if ((Get-FileHash $setup -Algorithm SHA256).Hash -ne $sha256) {
            throw "$name doesn't match the expected SHA-256; nothing was installed"
        }
        # An update: the running app is closed before its files are replaced.
        Get-Process Hangar -ErrorAction SilentlyContinue | Stop-Process -Force
        Write-Host 'Installing...'
        $p = Start-Process $setup -ArgumentList '/S' -Wait -PassThru
        if ($p.ExitCode -ne 0) { throw "the installer exited with $($p.ExitCode)" }
    } finally {
        Remove-Item $setup -ErrorAction SilentlyContinue
    }

    $exe = Join-Path $env:LOCALAPPDATA 'Hangar\Hangar.exe'
    if (Test-Path $exe) {
        Write-Host "Hangar $version is installed. Opening it..."
        Start-Process $exe
    } else {
        Write-Host "Hangar $version is installed; open it from the Start menu."
    }
}

Install-Hangar
