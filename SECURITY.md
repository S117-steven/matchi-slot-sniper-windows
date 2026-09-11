# Security policy

## Reporting a vulnerability

Do not publish passwords, session cookies, Value Card identifiers, checkout API keys, or private logs in a public issue.

For a security report, contact the repository owner privately through GitHub. Include the affected version, a concise reproduction, and a redacted log or stack trace when useful.

## Local data

The application keeps the MATCHi password in memory for the current run. Local configuration, logs, run state, and `.env` files are ignored by Git. Check `git status` before publishing a fork and rotate any credential that was accidentally exposed.
