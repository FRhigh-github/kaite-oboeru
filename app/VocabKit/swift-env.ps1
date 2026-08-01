# Windows で Swift をビルドするための環境設定。
#
# Swift on Windows は MSVC のリンカ (link.exe) と Windows SDK を使うため、
# Visual Studio の vcvars64.bat を読み込む必要がある。
# ただし vcvars64.bat は PATH を組み替えるので、そのあとで Swift の bin を
# 追加し直さないと swift コマンドが消える。
#
# 使い方:
#   . .\swift-env.ps1      ← ドット2つではなく「ドット + 空白」で読み込む
#   swift build
#   swift test

$ErrorActionPreference = "Stop"

# --- Visual Studio を探す ---
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "vswhere が見つかりません。Visual Studio (C++ ワークロード) が必要です。"
}
$vsPath = & $vswhere -products * -latest -property installationPath
if (-not $vsPath) { throw "Visual Studio のインストールが見つかりません。" }

$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) {
    throw "vcvars64.bat が見つかりません: $vcvars`nVisual Studio Installer で「C++ によるデスクトップ開発」を追加してください。"
}

# --- Swift の SDKROOT を控えておく ---
# Windows 版 Swift は標準ライブラリの場所を SDKROOT で解決する。
# インストーラはユーザー環境変数に設定するが、新規プロセスには
# 自動で入らないことがあるため明示的に読み込む。
# 未設定だと "unable to load standard library" で失敗する。
$swiftRoot = "$env:LOCALAPPDATA\Programs\Swift"
$sdkRoot = [System.Environment]::GetEnvironmentVariable("SDKROOT", "User")
if (-not $sdkRoot -or -not (Test-Path $sdkRoot)) {
    $platforms = Join-Path $swiftRoot "Platforms"
    if (Test-Path $platforms) {
        $sdkRoot = Get-ChildItem $platforms -Directory |
            Sort-Object Name -Descending |
            ForEach-Object {
                Join-Path $_.FullName "Windows.platform\Developer\SDKs\Windows.sdk"
            } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
    }
}
if (-not $sdkRoot) {
    throw "Swift の SDKROOT が見つかりません。Swift ツールチェーンを再インストールしてください。"
}

$swiftBins = @()
foreach ($sub in "Toolchains", "Runtimes") {
    $dir = Join-Path $swiftRoot $sub
    if (Test-Path $dir) {
        Get-ChildItem $dir -Directory |
            Sort-Object Name -Descending |
            Select-Object -First 1 |
            ForEach-Object {
                $bin = Join-Path $_.FullName "usr\bin"
                if (Test-Path $bin) { $swiftBins += $bin }
            }
    }
}
if (-not $swiftBins) {
    throw "Swift ツールチェーンが見つかりません。`n  winget install --id Swift.Toolchain"
}

# --- vcvars64.bat の環境変数を取り込む ---
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match "^(.*?)=(.*)$") {
        Set-Item -Path "env:$($matches[1])" -Value $matches[2] -ErrorAction SilentlyContinue
    }
}

# --- Swift を PATH に戻し、SDKROOT を設定する ---
$env:Path = ($swiftBins -join ";") + ";" + $env:Path
$env:SDKROOT = $sdkRoot

Write-Host "Swift 環境を設定しました:"
Write-Host "  VS     : $vsPath"
Write-Host "  SDKROOT: $sdkRoot"
& swift --version
