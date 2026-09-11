$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venvPath = Join-Path $repoRoot ".venv"
$venvPython = Join-Path $venvPath "Scripts\python.exe"
$venvPythonw = Join-Path $venvPath "Scripts\pythonw.exe"

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathParts = @($machinePath, $userPath, $env:Path) |
        Where-Object { $_ } |
        Select-Object -Unique
    $env:Path = $pathParts -join ";"
}

function Find-Node {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $candidates = @()
    if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles "nodejs\node.exe" }
    if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe" }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe" }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Find-Python {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) { return @{ Path = $launcher.Source; Prefix = @("-3") } }

    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) { return @{ Path = $python.Source; Prefix = @() } }

    return $null
}

function Install-With-Winget {
    param(
        [Parameter(Mandatory = $true)][string]$PackageId,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "未找到 winget。请先手动安装 $DisplayName，然后重新运行 install.bat。"
    }

    Write-Host "未检测到 $DisplayName，尝试通过 winget 安装…" -ForegroundColor Yellow
    & $winget.Source install --id $PackageId --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget 安装 $DisplayName 失败（退出码 $LASTEXITCODE）。请手动安装后重新运行 install.bat。"
    }
    Refresh-ProcessPath
}

function Invoke-Python {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $allArguments = @($pythonInfo.Prefix + $Arguments)
    & $pythonInfo.Path @allArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python 命令失败（退出码 $LASTEXITCODE）：$($Arguments -join ' ')"
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "这个安装器只支持 Windows。"
}

Write-Host "MATCHi 场地抢订 Windows 安装器" -ForegroundColor Green
Write-Host "项目目录：$repoRoot"

Write-Step "检查 Node.js"
$nodePath = Find-Node
if (-not $nodePath) {
    Install-With-Winget -PackageId "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS"
    $nodePath = Find-Node
}
if (-not $nodePath) {
    throw "仍然找不到 Node.js。请从 https://nodejs.org/ 安装 Node.js 20 或更新版本，然后重新运行 install.bat。"
}
$nodeVersion = (& $nodePath --version).Trim()
Write-Host "Node.js：$nodeVersion"

Write-Step "检查 Python"
$pythonInfo = Find-Python
if (-not $pythonInfo) {
    Install-With-Winget -PackageId "Python.Python.3.12" -DisplayName "Python 3.12"
    $pythonInfo = Find-Python
}
if (-not $pythonInfo) {
    throw "仍然找不到 Python。请从 https://www.python.org/downloads/windows/ 安装 Python 3.11 或更新版本，然后重新运行 install.bat。"
}
$pythonVersion = if ($pythonInfo.Prefix.Count -gt 0) {
    (& $pythonInfo.Path @($pythonInfo.Prefix + @("--version"))).Trim()
} else {
    (& $pythonInfo.Path --version).Trim()
}
Write-Host "Python：$pythonVersion"

Write-Step "创建或更新项目虚拟环境"
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "正在创建 .venv…"
    Invoke-Python @("-m", "venv", $venvPath)
}
if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "虚拟环境创建失败：$venvPython"
}

Write-Step "安装桌面界面依赖"
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "升级 pip 失败。请检查网络连接后重试。" }
& $venvPython -m pip install -r (Join-Path $repoRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "安装 Python 依赖失败。请检查网络连接后重试。" }

Write-Step "创建本地配置模板"
$configPath = Join-Path $repoRoot "config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "config.example.json") -Destination $configPath
    Write-Host "已创建 config.json（CLI 配置模板）。"
} else {
    Write-Host "已保留现有 config.json。"
}

$envPath = Join-Path $repoRoot ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath (Join-Path $repoRoot ".env.example") -Destination $envPath
    Write-Host "已创建 .env（不会提交到 Git）。"
} else {
    Write-Host "已保留现有 .env。"
}

Write-Step "创建桌面快捷方式"
$desktopPath = [Environment]::GetFolderPath("Desktop")
if (-not $desktopPath) { throw "无法定位 Windows 桌面目录。" }
$shortcutPath = Join-Path $desktopPath "MATCHi 场地抢订.lnk"
$launcherPath = Join-Path $repoRoot "启动 MATCHi.bat"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $repoRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,167"
$shortcut.Description = "MATCHi 场地抢订"
$shortcut.Save()

Write-Host "`n安装成功。" -ForegroundColor Green
Write-Host "桌面快捷方式：$shortcutPath"
Write-Host "项目目录：$repoRoot"
Write-Host "下一步：双击桌面的 MATCHi 场地抢订，然后先使用默认的确认预览模式。"
