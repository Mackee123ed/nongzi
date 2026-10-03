# Creates the Windows shortcut that carries the app icon.
# ASCII-only: PowerShell reads .ps1 in the ANSI codepage, so Chinese
# literals here would be garbled. Names are derived from files on disk.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bat  = Get-ChildItem -Path $root -Filter *.bat |
        Where-Object { $_.Name -notlike '_*' } | Select-Object -First 1
if (-not $bat) { throw 'launcher .bat not found' }

$ico = Get-ChildItem -Path (Join-Path $root 'src\pic') -Filter *.ico | Select-Object -First 1
if (-not $ico) { throw 'icon .ico not found' }

$lnkPath = [System.IO.Path]::ChangeExtension($bat.FullName, '.lnk')

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath       = $bat.FullName
$lnk.WorkingDirectory = $root
$lnk.IconLocation     = "$($ico.FullName),0"
$lnk.Description      = 'Nongzi Finance System'
$lnk.Save()

Write-Output "shortcut created: $lnkPath"
