# Daemon

## Features
- [x] `run` with a single-owner data-directory lock    → docs/install#running-in-the-foreground
- [x] Exit codes 0-4 and SIGTERM drain    → docs/install#running-in-the-foreground
- [x] Redacting logger and PI_LOG_LEVEL    → docs/configuration
- [x] Private directories (0700) and files (0600)    → docs/security
- [?] CLI --help, --version and --env-file=<path> forms    → (needs docs)
      ⚠️ Code exists but no doc section found

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Direct tests: example/{cli-args,lock,runtime}; e2e/daemon via test/fixtures/daemon-child.ts.
- No test: cli/main.ts; no direct test: runtime/{fatal,private-dir,proc-start,signals,version}.ts.
- docs/install.md exit-code claim is partly stale: some configuration errors exit 1, not 2.
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
