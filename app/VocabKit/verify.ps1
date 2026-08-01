# Swift 実装が Python 参照実装と一致することを検証する。
#
#   .\verify.ps1
#
# Swift 側の Normalizer を変更したら必ず通すこと。
# ずれると「合っているのにバツ」が発生し、離脱に直結する。

Set-Location $PSScriptRoot

. "$PSScriptRoot\swift-env.ps1" | Out-Null

Write-Host "`nビルド中..."
# swift build は Windows でシンボリックリンクの警告を stderr に出す（無害）。
# PowerShell 5.1 は native command の stderr を 2>&1 するとエラー扱いに
# してしまうので、リダイレクトせず終了コードだけで判定する。
& swift build

if ($LASTEXITCODE -ne 0) {
    Write-Host "`nビルドに失敗しました。" -ForegroundColor Red
    exit 1
}

$binDir = ".build\x86_64-unknown-windows-msvc\debug"
$failed = 0

foreach ($name in "VerifyNormalizer", "VerifyScheduler") {
    $exe = Join-Path $binDir "$name.exe"
    if (-not (Test-Path $exe)) {
        Write-Host "`n実行ファイルが見つかりません: $exe" -ForegroundColor Red
        $failed++
        continue
    }
    Write-Host "`n--------------------------------------------------"
    & $exe
    if ($LASTEXITCODE -ne 0) { $failed++ }
}

Write-Host "`n=================================================="
if ($failed -eq 0) {
    Write-Host "すべての検証に合格しました。" -ForegroundColor Green
    exit 0
}
Write-Host "$failed 件の検証が失敗しました。" -ForegroundColor Red
exit 1
