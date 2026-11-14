#Requires -Version 5.1
<#
  把 dsh-stuck-guard 装进当前用户的 DSH profile（Windows PowerShell，无外部依赖）。

  用法：
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop"

  做三件事，全部可回滚（先备份 package.json）：
    1. 在 profile 的 package.json 里加 dependencies["dsh-stuck-guard"] = link:<本目录>
    2. 在 dsh.profile.bundles 里加 dsh-stuck-guard
    3. 在 profile 的 node_modules 里建一个指向本目录的 junction
  装完必须重启 DSH 才生效。
#>
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$SourceDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$Name = 'dsh-stuck-guard'

if (-not (Test-Path (Join-Path $SourceDir 'index.js'))) {
  throw "找不到插件源码：$SourceDir\index.js"
}
if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) {
  $available = Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\profiles') -Directory -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Name
  throw "找不到 profile：$ProfileDir。现有 profile：$($available -join ', ')"
}

$pkgPath = Join-Path $ProfileDir 'package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgPath "$pkgPath.bak-$stamp"
Write-Host "已备份：$pkgPath.bak-$stamp"

$doc = Get-Content $pkgPath -Raw | ConvertFrom-Json
if (-not $doc.PSObject.Properties['dependencies']) {
  $doc | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$linkSpec = 'link:' + ($SourceDir -replace '\\', '/')
$doc.dependencies | Add-Member -NotePropertyName $Name -NotePropertyValue $linkSpec -Force

if (-not $doc.PSObject.Properties['dsh']) {
  $doc | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
}
if (-not $doc.dsh.PSObject.Properties['profile']) {
  $doc.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
$bundles = @()
if ($doc.dsh.profile.PSObject.Properties['bundles']) { $bundles = @($doc.dsh.profile.bundles) }
if ($bundles -notcontains $Name) { $bundles += $Name }
$doc.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force

$json = $doc | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($pkgPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已登记：dependencies[$Name] = $linkSpec"

$linkPath = Join-Path $ProfileDir "node_modules\$Name"
$nodeModules = Split-Path $linkPath -Parent
if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules | Out-Null }
if (Test-Path $linkPath) { (Get-Item $linkPath -Force).Delete() }
New-Item -ItemType Junction -Path $linkPath -Target $SourceDir | Out-Null
Write-Host "已链接：$linkPath -> $SourceDir"

Write-Host ''
Write-Host '完成。现在重启 DSH。'
Write-Host "打包进 bundles 的顺序在：$pkgPath 的 dsh.profile.bundles"
Write-Host "卸载：.\uninstall.ps1 -ProfileDir `"$ProfileDir`""
