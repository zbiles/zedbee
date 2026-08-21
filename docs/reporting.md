# Reporting and enterprise export

## Automatic terminal output

An automatic scan (`zedbee scan` or `zedbee scan --format auto`) always writes a complete versioned JSON report to operating-system temporary storage. A pass with zero findings still receives a report. Its complete report path appears before the final output and after the final result; the path is printed only after a complete report exists. A wide ordinary TTY uses branded Ink. A narrow terminal, redirected output, CI, `TERM=dumb`, or screen-reader output uses a linear ANSI-free result.

Automatic output shows up to 25 findings by default, with blockers first; that limit applies only to findings. Counts, disclosures, incomplete checks, report warnings, guidance, and report paths remain complete. Explicit `--format ink` is a bounded preview using the same limit, but writes a temporary report only when its finding preview overflows. Fixing only the visible preview is insufficient; read the complete report and address every applicable finding.

Configure the limit and maximum report age without making any lockfile changes:

```jsonc
{
  "schemaVersion": 1,
  "reporting": {
    "sourceExcerpts": "interactive",
    "terminalFindingLimit": 25,
    "temporaryReportMaxAge": "24h",
    "agentGuidance": {
      "opening": "Use the complete report as the source of truth.",
      "nextStep": "Fix every blocking finding, then run Zedbee again.",
    },
  },
}
```

`terminalFindingLimit` defaults to 25; set it to any positive integer or `"all"` to show every finding. `temporaryReportMaxAge` defaults to `"24h"` and accepts positive whole-number durations such as `"30m"`, `"24h"`, and `"7d"`. Temporary reports are OS handoff data, retained for at most the configured age but possibly removed earlier by the operating system; they are not archival storage. This configuration example is illustrative; `zedbee init` writes editable recommended guidance. `opening` and `nextStep` can be blanked independently with `""` to hide that heading/message. Complete-report lines remain when a configured message is blank.

The temporary JSON report follows the disk source-excerpt policy, not the interactive preview policy. The default `"interactive"` policy can show source excerpts live in Ink but omits ordinary excerpts from disk. Set `sourceExcerpts` to `"always"` or pass `--include-source` to persist them; `"never"` or `--no-source` omits them. Secret content is always redacted.

Cleanup and write warnings are non-blocking report-maintenance diagnostics and do not replace the scan's normal outcome. A cleanup warning identifies a safely validated path when possible. A report failure prints no path or configured guidance, restores every finding, preserves the canonical scan outcome, and shows the fixed `REPORT UNAVAILABLE` alert twice—above and below the result. `REPORT DELIVERY WARNING` is a detail panel for report-maintenance information, not the fixed failure alert.

## Explicit complete exports

Explicit text (`--format text`), JSON (`--format json`), and SARIF (`--format sarif`) output remains complete and never uses the terminal finding limit. This complete-export guarantee does not include forced Ink:

```bash
npx zedbee scan --format text > zedbee-report.txt
npx zedbee scan --format json > zedbee-report.json
npx zedbee scan --format sarif > zedbee.sarif
```

These explicit formats create no sidecar or automatic temporary report. Text is stable human-readable output, JSON is Zedbee's versioned machine contract, and SARIF is the enterprise interchange format. Redirect explicit JSON or SARIF when durable output is required. Coding tools that receive a complete-report path must process it and respect exit code 2 as incomplete required analysis; they must not treat a preview or an incomplete scan as clean.

## SARIF 2.1.0

For enterprise ingestion, redirect the SARIF format your workflow consumes:

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

Explicit output is complete even when automatic terminal presentation is constrained: terminal finding limits never abbreviate explicitly requested text, JSON, or SARIF. Future terminal presentation changes do not alter this export contract.

SARIF follows the configured source-excerpt policy. Redirected SARIF omits ordinary source excerpts by default; use `--include-source` to opt in, `--no-source` to suppress them, or configure `reporting.sourceExcerpts`. Secret findings remain redacted in every format. Like all scan output, SARIF is based on the exact staged Git-index snapshot, not later working-tree edits.
