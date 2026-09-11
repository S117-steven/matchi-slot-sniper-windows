# MATCHi 场地抢订（Windows）

这是一个把 MATCHi 场地监测、放票时刻轮询、候选场地选择和确认页解析整合在一起的 Windows 桌面工具。项目同时提供图形界面和命令行入口，适合先用“只检测/确认预览”检查配置，再由用户自行决定是否进入付款流程。

> 当前公开版本的桌面界面内置了已经验证过的 `ATL Victoriastadion · Badminton` 配置。命令行向导可以读取其他 MATCHi 场馆的公开资料并生成配置，但不同场馆可能有不同的预约规则，第一次使用其他场馆时请先用 `dry-run` 或 `confirm` 验证。

## 先看安全边界

| 模式 | 会做什么 | 会不会付款 |
| --- | --- | --- |
| `dry-run` | 登录并读取日历，检查是否存在符合条件的空位 | 不会打开确认页，不会付款 |
| `confirm` | 找到空位后读取确认页、价格和支付方式 | 不会进入付款入口 |
| `checkout` | 创建 MATCHi 在线支付入口并打印 URL | 工具本身不会付款 |
| `value-card` | 在全部金额和场地数量保护通过后，用指定 Value Card 提交预订 | 会产生真实预订和扣款，必须由用户显式开启 |

首次使用建议保持默认的 `confirm`，确认日志、日期、场地、价格都正确后再考虑更高风险的流程。项目不会绕过 CAPTCHA，也不会伪造登录或支付结果。

## 最简单的安装方式

### 方式 A：下载 ZIP

1. 在 GitHub 项目页点击 **Code → Download ZIP**。
2. 将 ZIP 解压到一个普通目录，例如 `C:\Tools\matchi-slot-sniper-windows`。不要直接在 ZIP 压缩包内部运行，也不要把项目放进需要管理员权限的系统目录。
3. 打开解压后的文件夹，双击 `install.bat`。
4. 安装器会检查 Node.js、Python 和 Python 虚拟环境；如果系统有 `winget`，缺少 Node.js 或 Python 时会自动尝试安装。
5. 安装结束后，桌面会出现 **MATCHi 场地抢订** 快捷方式。以后直接双击这个快捷方式即可。

### 方式 B：使用 Git

```powershell
git clone https://github.com/S117-steven/matchi-slot-sniper-windows.git
cd matchi-slot-sniper-windows
.\install.bat
```

安装器可以重复运行。它会保留已有的 `config.json`、`.env` 和 GUI 设置，不会覆盖用户配置。

### 安装器需要什么

- Windows 10 或 Windows 11。
- Node.js 20 或更新版本。安装器优先使用 Node.js LTS。
- Python 3.11 或更新版本。安装器默认通过 Python 3.12 创建 `.venv`。
- 可访问 MATCHi 的网络连接。
- 支持 WebView2 的现代 Windows。若 GUI 打不开，请安装 [Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
- 安装 Python 依赖时需要访问 PyPI。公司网络若拦截 PyPI，请先配置代理或换到允许下载的网络。

没有 `winget` 的电脑也可以手动安装 [Node.js LTS](https://nodejs.org/) 和 [Python for Windows](https://www.python.org/downloads/windows/)，安装时勾选加入 PATH，然后重新双击 `install.bat`。

## 第一次运行

1. 双击桌面快捷方式。
2. 填入自己的 MATCHi 邮箱和密码。
3. 选择场馆、日期、整点开始时间、时长和场地数量。
4. 保持执行模式为 **确认预览**，点击开始。
5. 在任务日志中确认登录、日历请求、目标时段、候选场地和确认页价格。

密码只在本次运行期间存在于内存和子进程环境变量中，不会写入 `config.json`、GUI 设置或日志。邮箱和上一次的非敏感设置可能会保存在被 Git 忽略的 `gui/settings.json` 中；不希望保留邮箱时可以删除该文件。

GUI 关闭窗口会停止当前等待或轮询任务。运行结束后可以点击“打开日志”查看 `logs` 文件夹。

## GUI 功能说明

- **目标日期**：按 MATCHi 场馆的本地日期填写。
- **开始小时**：当前 GUI 只允许整点，例如 `18:00`。
- **时长**：支持 60、120、180 分钟。
- **场地数量**：支持 1 到 6 块。工具优先寻找连续编号的场地；打开“没有连号时接受分散场地”后，找不到连续编号时才考虑分散场地。
- **预计放票时间**：按配置中的 `advanceDays` 计算，仅用于提示；最终以 MATCHi 返回的日历窗口为准。
- **只检测**：适合先检查登录和日历是否可读。
- **确认预览**：适合首次实际测试。它会读取确认页并解析价格，但不会点击付款。
- **读取余额/自动预订**：只有在确实使用 Value Card 时才需要。必须从当前账号实时读取卡片，且金额必须完全由指定卡覆盖。

当前 GUI 的自动预订保护包括：

- 默认不进入支付流程；
- Value Card 余额不足时拒绝启动；
- 每个场地分别读取确认页，避免把不同场地的价格混在一起；
- 只接受确认页中能明确解析出 SEK 价格的订单；
- 场地冲突后尝试安全补位，但不会无限重试；
- 付款后复核 MATCHi 订单和余额；
- 结果不确定时停止继续扣款，并在界面和日志中标记为需要人工核对。

## 命令行用法

安装后可以使用项目根目录的 `run-cli.bat`，不需要手动激活虚拟环境：

```powershell
# 只检查一次日历，不打开确认页
.\run-cli.bat check --config config.json

# 按 config.json 等待放票并运行
.\run-cli.bat run --config config.json

# 交互式读取场馆资料并生成配置
.\run-cli.bat wizard --config config.json

# 运行 Node.js 单元测试
npm test
```

命令行也支持直接执行：

```powershell
node src\cli.mjs check --config config.json
node src\cli.mjs run --config config.json --mode confirm
```

命令行登录时会交互式询问密码，不会把密码回显到屏幕。自动化环境可以临时设置 `MATCHI_EMAIL` 和 `MATCHI_PASSWORD` 环境变量，但不要把它们写入脚本、Issue、截图或 Git。

## 配置文件

安装器会把 `config.example.json` 复制为本地的 `config.json`。`config.json` 已被 `.gitignore` 忽略，应该只保存自己的本地设置。

常用字段：

| 字段 | 说明 |
| --- | --- |
| `facilitySlug` | MATCHi 场馆 URL 中的 slug，例如 `atl` |
| `facilityId` | MATCHi 场馆数字 ID |
| `facilityName` | 日志显示名称 |
| `timeZone` | 场馆所在时区，瑞典通常是 `Europe/Stockholm` |
| `sportId` | MATCHi 运动项目 ID |
| `targetDate` | 目标日期，格式 `YYYY-MM-DD` |
| `startTime` | 目标开始时间，格式 `HH:00` |
| `durationMinutes` | `60`、`120` 或 `180` |
| `courtPreferences` | 优先场地名称数组；空数组表示不限制场地 |
| `allowAnyCourt` | 没有偏好场地时是否接受任意场地 |
| `quantity` | 同一时间需要的场地数量，1 到 6 |
| `advanceDays` | 当没有填写 `releaseAt` 时，用于计算放票日的天数 |
| `releaseAt` | 可选的明确放票时刻；填写后优先于 `advanceDays` |
| `pollIntervalMs` | 普通轮询间隔，不能低于 1000 毫秒 |
| `pollTimeoutSeconds` | 放票后的最长轮询时间 |
| `mode` | `dry-run`、`confirm`、`checkout` 或 `value-card` |

最稳妥的配置流程是运行 `wizard`：它会先读取场馆资料和运动项目，再写入数字 ID，减少手工抄错的机会。其他场馆第一次使用时，先运行：

```powershell
Copy-Item config.example.json config.json
notepad config.json
```

把场馆、日期和时间改好后执行 `run-cli.bat check --config config.json`。如果场馆的预约窗口不是 14 天，按网站显示修改 `advanceDays`。

## `.env` 和付款密钥

`.env` 是安装器从 `.env.example` 创建的本地文件，也被 Git 忽略。它可以包含：

```dotenv
MATCHI_EMAIL=
MATCHI_CHECKOUT_API_KEY=
```

邮箱也可以只在 GUI 中输入。密码不建议写入 `.env`；GUI 不会读取或保存密码。

`MATCHI_CHECKOUT_API_KEY` 只在 `value-card` 模式准备结账时需要。它不是本项目提供的公共密钥，也不会包含在仓库中；没有合法密钥时请使用 `dry-run` 或 `confirm`。不要向任何人索要、复制或公开他人的密钥。

## 常见问题

### 双击快捷方式没有窗口

先打开项目目录，确认 `.venv\Scripts\pythonw.exe` 存在。若不存在，重新双击 `install.bat`。如果仍然没有窗口，查看 `logs\gui-startup.log`，重点检查 WebView2、Python 依赖和 Node.js 路径。

### 安装器提示找不到 Node.js 或 Python

手动安装对应的官方版本并勾选加入 PATH，然后重新打开一个 PowerShell，再运行 `install.bat`。安装器会优先寻找 `node`、`py -3` 和常见安装目录。

### GUI 显示“找不到 Node.js”

Node.js 可能刚刚安装但旧进程没有刷新 PATH。关闭旧的终端和 GUI，重新运行安装器；也可以在新的 PowerShell 中执行 `node --version` 检查。

### 登录失败或日历为空

确认邮箱和密码能在浏览器直接登录 MATCHi；检查目标日期、运动项目、场馆 ID 和场馆的预约提前天数。不要把账号密码贴到 Issue。若网站 HTML 或登录流程发生变化，请附上脱敏后的错误信息和最小 HTML fixture 提交问题。

### 找不到空位

这不一定是脚本故障。确认目标时间已经开放、时长和场地数量符合场馆规则，并查看日志中的 `日历时段`、`空闲` 和 `目标空闲` 数字。脚本不会把不可用或不连续的场地当成成功。

### 确认页价格无法解析

工具会拒绝进入付款入口，而不是猜价格。请保存脱敏日志，确认没有把场地名称中的数字误识别成价格；如果页面结构确实变化，应先在测试 fixture 中修复解析器。

### Value Card 模式提示缺少密钥或余额不足

这是保护措施。确认 `.env` 中的密钥属于你自己的合法配置，并重启 GUI 让环境变量重新加载；余额、币种和最大扣款必须满足整次预订的上限。没有把握时使用 `confirm`。

### 出现 429、503 或网络临时错误

检查网络和 MATCHi 服务状态。工具会做有限退避并在连续失败时停止，避免无限请求或把短暂故障扩大成限流。不要把 `pollIntervalMs` 降到 1000 毫秒以下。

## 日志和隐私

运行时生成的以下内容默认不会被 Git 提交：

- `logs/`
- `state/`
- `gui-runs/`
- `.env`
- `config.json`
- `gui/settings.json`
- `.venv/`

发布自己的分支前执行：

```powershell
git status --short
git diff --check
```

如果误把密码、Cookie、Value Card 信息或结账密钥写进日志或提交，立即撤销/更换对应凭据；仅删除本地文件不足以清除已经推送到 Git 历史中的秘密。

## 开发和测试

Node.js 测试不需要 MATCHi 账号或网络：

```powershell
npm test
node --check src\cli.mjs
node --check src\matchi-client.mjs
```

GUI 的本地 smoke test 不会打开窗口，也不会访问网络。安装依赖后运行：

```powershell
.venv\Scripts\python.exe gui\smoke_test.py
```

项目主要目录：

```text
src/                  MATCHi 客户端、解析器、轮询与 CLI
gui/                  pywebview 桌面界面
scripts/              安装器、Value Card 读取辅助脚本
test/                 Node.js 离线测试 fixture
.github/workflows/    GitHub Actions 测试
```

提交解析器变更时，请使用脱敏、最小化的 HTML fixture，并保持默认模式不付款。

## 责任与使用规则

本工具按“原样”提供，不保证一定抢到场地，也不保证 MATCHi 页面未来不会变化。用户需要自行确认 MATCHi、场馆和支付服务的条款，控制请求频率，并对自己的账号、预订和扣款负责。工具不会自动解决 CAPTCHA，也不应被用于绕过访问控制、限流或场馆规则。

英文说明见 [README.en.md](README.en.md)。安全问题请先阅读 [SECURITY.md](SECURITY.md)。
