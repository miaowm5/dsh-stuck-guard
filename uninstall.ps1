#Requires -Version 5.1
<#
  从 DSH profile 里移除 dsh-stuck-guard：删依赖、删 bundles 行、删 node_modules 链接。
  不会动你的对话、会话或其它插件。备份文件（package.json.bak-*）保留，可手动恢复。
#>
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$Name = 'dsh-stuck-guard'
$pkgPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $pkgPath)) { throw "找不到 profile：$ProfileDir" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgPath "$pkgPath.bak-$stamp"

$doc = Get-Content $pkgPath -Raw | ConvertFrom-Json
if ($doc.PSObject.Properties['dependencies']) {
  $doc.dependencies.PSObject.Properties.Remove($Name)
}
if ($doc.PSObject.Properties['dsh'] -and $doc.dsh.PSObject.Properties['profile'] -and $doc.dsh.profile.PSObject.Properties['bundles']) {
  $kept = @(@($doc.dsh.profile.bundles) | Where-Object { $_ -ne $Name })
  $doc.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $kept -Force
}

$json = $doc | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($pkgPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))

$linkPath = Join-Path $ProfileDir "node_modules\$Name"
if (Test-Path $linkPath) { (Get-Item $linkPath -Force).Delete() }

Write-Host "已移除 $Name（备份：package.json.bak-$stamp）。重启 DSH 生效。"
