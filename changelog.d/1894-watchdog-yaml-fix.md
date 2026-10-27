### Deletion watchdog

- Fixed the YAML syntax error in `.github/workflows/deletion-watchdog.yml` (line 62): the multi-line BODY string is now a single printf line, so the workflow parses and its dispatch works (issue #1894).
