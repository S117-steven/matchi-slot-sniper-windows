# Contributing

1. Create a fork and a feature branch.
2. Do not commit passwords, cookies, real Value Card IDs, checkout keys, personal logs, or `config.json`.
3. Run `npm test` before opening a pull request.
4. If you change the desktop UI, run `gui\smoke_test.py` with a Python environment that has `pywebview` installed.
5. Describe the affected MATCHi page shape and include a redacted fixture when changing an HTML parser.

Please keep the default execution mode non-paying (`confirm` or `dry-run`) and preserve the explicit safety gates around payment.
