# Reporting and enterprise export

Zedbee writes reports to standard output. It does not create a report file automatically, so redirect the format your workflow consumes:

```bash
npx zedbee scan --format sarif > zedbee.sarif
```

`--format sarif` emits one complete report in SARIF 2.1.0. It is non-interactive, ANSI-free, deterministically ordered, and suitable for enterprise ingestion. The report includes the Zedbee tool and rule metadata, every canonical finding, stable finding fingerprints, repository-relative locations, attribution evidence, network disclosures, and incomplete-check notifications.

SARIF is a structured representation of the same scan, not a different policy decision. It retains Zedbee's normal exit status:

| Code | Meaning                                                  |
| ---: | -------------------------------------------------------- |
|  `0` | Scan completed with no blocking findings.                |
|  `1` | Scan completed and repository policy blocked the commit. |
|  `2` | Zedbee or an enabled check could not complete.           |

For incomplete scans, the SARIF invocation has `executionSuccessful: false`, and each incomplete check is recorded in `toolExecutionNotifications`. A warning disposition can permit a commit under the configured policy, but it remains visible in the report; consumers must not treat incomplete analysis as a clean scan.

Explicit structured output is complete even when terminal presentation is constrained: terminal finding limits never abbreviate an explicitly requested JSON or SARIF export. Future terminal presentation changes do not alter this export contract.

SARIF follows the configured source-excerpt policy. Redirected SARIF omits ordinary source excerpts by default; use `--include-source` to opt in, `--no-source` to suppress them, or configure `reporting.sourceExcerpts`. Secret findings remain redacted in every format. Like all scan output, SARIF is based on the exact staged Git-index snapshot, not later working-tree edits.
