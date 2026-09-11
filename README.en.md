# MATCHi Slot Sniper for Windows

This project combines MATCHi schedule monitoring, release-time polling, candidate-court selection, and confirmation-page parsing into one Windows desktop tool. It includes a guided GUI and a command-line interface. Start with a non-paying mode to validate the account, venue, date, and price before considering any payment flow.

> The public desktop build currently includes the verified `ATL Victoriastadion · Badminton` profile. The CLI wizard can discover basic information for other MATCHi venues, but venue rules and page structures can differ. Test another venue with `dry-run` or `confirm` first.

## Safety modes

| Mode | Behavior | Payment |
| --- | --- | --- |
| `dry-run` | Logs in and reads the schedule once | No confirmation page and no payment |
| `confirm` | Reads the confirmation page, price, and payment methods | Does not enter payment |
| `checkout` | Creates an online checkout URL and prints it | The tool does not pay |
| `value-card` | Submits a real booking only after strict Value Card and amount checks | Real booking and charge; explicit opt-in required |

The default GUI mode is `confirm`. The project does not bypass CAPTCHA and never treats a checkout URL as proof that a booking succeeded.

## One-click Windows installation

### Download ZIP

1. On the GitHub page, choose **Code → Download ZIP**.
2. Extract it to a normal folder such as `C:\Tools\matchi-slot-sniper-windows`.
3. Open the extracted folder and double-click `install.bat`.
4. The installer checks Node.js, Python, the virtual environment, and `pywebview`. If `winget` is available, it can install missing Node.js LTS and Python 3.12 packages.
5. When it finishes, use the **MATCHi 场地抢订** desktop shortcut.

### Git

```powershell
git clone https://github.com/S117-steven/matchi-slot-sniper-windows.git
cd matchi-slot-sniper-windows
.\install.bat
```

The installer is safe to rerun. Existing `config.json`, `.env`, and GUI preferences are kept.

## Requirements

- Windows 10 or Windows 11.
- Node.js 20 or newer.
- Python 3.11 or newer.
- Internet access to MATCHi and PyPI during installation.
- A modern WebView2 runtime. If the GUI does not open, install the [Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

If `winget` is not available, install the official [Node.js LTS](https://nodejs.org/) and [Python for Windows](https://www.python.org/downloads/windows/) packages, enable PATH integration, and rerun `install.bat`.

## First run

1. Double-click the desktop shortcut.
2. Enter your own MATCHi email and password.
3. Choose a venue, local target date, whole-hour start time, duration, and court quantity.
4. Keep **确认预览 / Confirm preview** selected and start the run.
5. Review the login, schedule, candidate, and confirmation-price messages in the log.

The password is kept in memory for the current run and passed to the child process through its environment. It is not written to `config.json`, GUI settings, or logs. The email and non-sensitive GUI preferences may be saved in the ignored `gui/settings.json` file.

Closing the GUI stops the current wait or polling task. The **open logs** action opens the local `logs` directory.

## GUI behavior

- The GUI currently supports 60, 120, and 180-minute bookings starting on a whole hour.
- It prefers consecutive court numbers and can optionally accept scattered courts.
- `dry-run` is suitable for checking login and schedule access.
- `confirm` parses the confirmation page without entering payment.
- Value Card mode reads the current account cards, requires sufficient balance, and refuses a bank-funded remainder.
- Candidate conflicts are handled with finite retries. Uncertain payment outcomes stop further charging and are marked for manual review.

## CLI

The root-level `run-cli.bat` avoids manual virtual-environment activation:

```powershell
.\run-cli.bat check --config config.json
.\run-cli.bat run --config config.json
.\run-cli.bat wizard --config config.json
npm test
```

Direct Node.js usage is also supported:

```powershell
node src\cli.mjs check --config config.json
node src\cli.mjs run --config config.json --mode confirm
```

Interactive CLI login asks for the password without echoing it. Automation can temporarily set `MATCHI_EMAIL` and `MATCHI_PASSWORD`, but do not commit them or paste them into issues.

## Configuration

The installer copies `config.example.json` to the ignored local `config.json`. The CLI wizard is recommended because it discovers the venue and sport IDs.

Important fields include:

| Field | Meaning |
| --- | --- |
| `facilitySlug` / `facilityId` | MATCHi venue slug and numeric ID |
| `timeZone` | Venue timezone, for example `Europe/Stockholm` |
| `sportId` | MATCHi sport ID |
| `targetDate` / `startTime` | Local target date and `HH:00` start time |
| `durationMinutes` | `60`, `120`, or `180` |
| `courtPreferences` | Preferred court names; an empty list means no preference |
| `quantity` | Number of simultaneous courts, from 1 to 6 |
| `advanceDays` | Used to calculate the release date when `releaseAt` is empty |
| `releaseAt` | Optional explicit release instant; takes precedence over `advanceDays` |
| `pollIntervalMs` | Normal polling interval; never lower than 1000 ms |
| `mode` | `dry-run`, `confirm`, `checkout`, or `value-card` |

For another venue:

```powershell
Copy-Item config.example.json config.json
notepad config.json
.\run-cli.bat check --config config.json
```

MATCHi venues may use different release windows and booking limits. Follow the values shown by the site.

## `.env` and payment keys

`.env` is created from `.env.example` and ignored by Git:

```dotenv
MATCHI_EMAIL=
MATCHI_CHECKOUT_API_KEY=
```

The GUI can collect the email itself. Avoid putting the password in `.env`.

`MATCHI_CHECKOUT_API_KEY` is required only when Value Card checkout preparation is used. It is not a public project key and is intentionally not bundled. Without your own legitimate key, use `dry-run` or `confirm`.

## Troubleshooting

### No window after double-clicking

Confirm `.venv\Scripts\pythonw.exe` exists and rerun `install.bat`. Then inspect `logs\gui-startup.log` for WebView2, Python dependency, or Node.js path errors.

### Node.js or Python not found

Install the official version manually with PATH integration, open a new PowerShell, and rerun the installer. It checks `node`, `py -3`, and common Windows installation directories.

### Login failure or an empty schedule

Verify that the account can log in in a normal browser. Check the venue, sport, date, ID values, and release window. Do not post credentials. For a page change, submit a redacted error and a minimal HTML fixture.

### No slot found

The target may not be released, may violate venue limits, or may not have enough consecutive/free courts. Review the schedule, free-count, and target-free log fields.

### Confirmation price cannot be parsed

The tool deliberately refuses payment rather than guessing. Save a redacted log and update the parser with a small test fixture if MATCHi changed its HTML.

### Value Card key or balance error

This is an intentional guard. Use only your own valid key, restart the GUI after changing `.env`, and ensure the selected card covers the configured maximum. When uncertain, use `confirm`.

### HTTP 429, 503, or transient network errors

Check connectivity and the MATCHi service. The client uses finite backoff and stops after repeated failures; do not lower `pollIntervalMs` below 1000 ms.

## Logs, privacy, and publishing

The following runtime data is ignored by Git:

```text
logs/ state/ gui-runs/ .env config.json gui/settings.json .venv/
```

Before publishing a fork:

```powershell
git status --short
git diff --check
```

If a password, cookie, Value Card detail, or checkout key was exposed, rotate it immediately. Deleting the local file is not enough to remove a secret from Git history.

## Development

```powershell
npm test
node --check src\cli.mjs
node --check src\matchi-client.mjs
.venv\Scripts\python.exe gui\smoke_test.py
```

The Node.js tests are offline and do not require a MATCHi account. Keep parser changes backed by redacted, minimal fixtures and keep the default mode non-paying.

## Disclaimer

This software is provided as-is. It cannot guarantee a successful booking and may need updates when MATCHi changes its pages or rules. Users are responsible for complying with MATCHi, venue, and payment-service terms, their request rate, account, bookings, and charges. The tool does not solve CAPTCHA or bypass access controls, rate limits, or venue rules.

See [SECURITY.md](SECURITY.md) for private vulnerability reports and [CONTRIBUTING.md](CONTRIBUTING.md) for development contributions.
