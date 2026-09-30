# Zedbee benchmark baselines

Recorded phase timings for development regression checks. Actual scan times depend on the project, enabled checks, and execution environment.

This report is generated from [baselines.json](baselines.json). The JSON retains full precision for automated comparisons; tables round milliseconds to two decimal places.

## Measurement environment

| Detail | Recorded value |
| --- | --- |
| Origin | GitHub Actions (maintainer-confirmed). These timings were included in the initial public commit 3b12487. The exact run, runner image, hardware, Node.js version, and measurement date were not recorded. |
| Measured at (UTC) | Not recorded |
| Source commit | Not recorded |
| Uncommitted changes | Not recorded |
| Node.js | Not recorded |
| Platform / architecture | Not recorded |
| OS version / release | Not recorded |
| CPU | Not recorded |
| Logical CPUs | Not recorded |
| Memory visible to process (GiB) | Not recorded |

CPU and memory describe what the process could see, including virtual hardware on hosted runners. Runner labels such as `ubuntu-latest` can change over time; use the recorded image version and run link when available.

## Results

Each value is a median: the first batch has three samples and the second has five. The column names describe sample order; they do not mean a fresh process followed by a warmed process.

### small fixture

| Phase | First batch (ms) | Subsequent batch (ms) |
| --- | ---: | ---: |
| Snapshot cache-key hashing | 0.75 | 0.68 |
| Inspection | 0.57 | 0.49 |
| Structural security (collection) | 2.64 | 3.29 |
| Attribution | 0.06 | 0.01 |
| Rendering | 0.01 | 0.01 |
| Formatting | 2.50 | 1.80 |
| Lint | 544.96 | 514.85 |
| Types | 524.02 | 496.37 |
| Cyclomatic complexity | 11.71 | 2.62 |
| Readability complexity | 2.40 | 2.09 |
| Structural security | 2.56 | 2.79 |
| Secrets | 1.51 | 1.36 |
| Duplication | 65.41 | 63.26 |
| Dependency architecture | 9.41 | 8.17 |
| Dead code | 254.12 | 251.30 |
| React correctness | 6.48 | 2.50 |
| React accessibility | 1.71 | 1.34 |
| Vulnerabilities | 0.01 | 0.01 |

### monorepo fixture

| Phase | First batch (ms) | Subsequent batch (ms) |
| --- | ---: | ---: |
| Snapshot cache-key hashing | 5.17 | 5.30 |
| Inspection | 5.04 | 4.82 |
| Structural security (collection) | 5.60 | 5.65 |
| Attribution | 0.04 | 0.02 |
| Rendering | 0.01 | 0.00 |

## Current benchmark method and limitations

Repeated phase samples share one fixture-scoped analysis session; final session cleanup is outside phase timings. These are not complete CLI timings. coldMs/warmMs are historical field names, not fresh/warm process guarantees. Historical Secretlint and OSV substitutions remain; the snapshot phase measures cache-key hashing, not Git materialization.

The source revision matters as well as the machine: the harness and analyzer implementations can change between releases. The historical baseline predates environment capture; its presence in an old commit does not identify the exact revision used to measure it.

The small fixture exercises individual analyzers. The monorepo fixture contains a root workspace and 12 package workspaces, and measures the supporting phases listed above.

The existing comparison fails only when a phase is both more than 25% slower and more than 250 ms slower than its baseline. A failure across different machines or runtimes does not, by itself, establish a code regression. Compare revisions under the same conditions when investigating one.

## Reproduce or update

From a repository checkout with its supported Node.js version:

```sh
npm ci --ignore-scripts
npm run benchmark
```

To deliberately replace the baseline with new measurements and their environment:

```sh
npm run benchmark:update
```

That command updates both `bench/baselines.json` and this report. Review and commit them together. Keep the machine otherwise idle and record whether a VM was used in the review. GitHub Actions runs also record the job, runner image, and run link when available.

To regenerate only this readable report without measuring or changing the baseline:

```sh
npm run benchmark:report
```
