# Zedbee scan Action

Run a committed pull-request scan using a pinned Zedbee GitHub release. The calling workflow supplies checkout with full history, Node 24, and project dependency installation. This Action can be kept alongside Zedbee's source; no separate Action repository is needed.

`zedbee init --workflow github` previews a starter workflow; add `--yes` to apply it. Existing `zedbee.yml` and `zedbee.yaml` workflows are preserved. Review and commit the generated file to enable PR checks.

```yaml
- name: Scan committed pull-request changes
  uses: zbiles/zedbee/.github/actions/scan@f8f33d26372cbc806cd89692c664554b1c516fb7
  with:
    version: 0.1.0-beta.12
    base-ref: ${{ github.event.pull_request.base.sha }}
    report-format: sarif
```

Keep `version` pinned to the intended GitHub CLI release. The release must provide its tested `zedbee-<version>.tgz` artifact and `SHA256SUMS`; the Action verifies the checksum before installation. The Action is pinned separately to its immutable implementation commit.

| Input                    | Meaning                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `version`                | Required exact GitHub release version of Zedbee.                                                             |
| `base-ref`               | Base SHA or Git ref available locally. Defaults to the PR event base SHA.                                    |
| `report-format`          | `sarif` (default) or `json`.                                                                                 |
| `trust-project-prettier` | `false` by default. Explicit `true` permits project formatter/config/plugin execution in a trusted workflow. |

The Action installs its tool separately, scans from the repository root, disables source excerpts, and preserves complete report artifacts for passing, blocked, and incomplete scans. The final status preserves CLI exit 0/1/2 even after upload. A startup failure without valid structured output is marked incomplete; any captured output is retained as diagnostic text rather than labeled JSON/SARIF. Step summaries include outcome and counts without source or finding messages.

Outputs are `report-path` (runner-local report file), `exit-code`, and `outcome`. Normal telemetry preferences and environment opt-outs apply. The calling workflow should use a read-only token and avoid persisted checkout credentials. Configure a required status check separately in repository branch protection or rulesets if desired.
