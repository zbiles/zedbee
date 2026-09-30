# Zedbee benchmark baselines

Recorded phase timings for development regression checks. Actual scan times depend on the project, enabled checks, and execution environment.

This document is the single source of benchmark baselines. Automated comparisons read the full-precision timings directly from the tables below.

## Measurement environment

| Detail | Recorded value |
| --- | --- |
| Origin | Local run |
| Measured at (UTC) | 2026-09-30T20:21:15.475Z |
| Machine | MacBook |
| Source commit | 3b8af7b7b72827a088ffc61fddcfada7d91a12a1 |
| Uncommitted changes | No |
| Node.js | v24.15.0 |
| Platform / architecture | darwin / arm64 |
| OS version / release | Darwin Kernel Version 25.3.0: Wed Jan 28 20:54:38 PST 2026; root:xnu-12377.91.3~2/RELEASE_ARM64_T6050 / 25.3.0 |
| CPU | Apple M5 Max |
| Logical CPUs | 18 |
| Memory visible to process (GiB) | 128.00 |

CPU and memory describe what the process could see, including virtual hardware on hosted runners. Runner labels such as `ubuntu-latest` can change over time; use the recorded image version and run link when available.

### GitHub-hosted runner specifications

For the standard runner labels used by this project's workflows, GitHub publishes these specifications for public repositories (checked September 30, 2026):

| Runner label | CPU allocation | Memory | Architecture |
| --- | --- | --- | --- |
| `ubuntu-latest` | 4 CPUs | 16 GB | x64 |
| `windows-latest` | 4 CPUs | 16 GB | x64 |
| `macos-latest` | 3 CPUs (Apple M1) | 7 GB | arm64 |

Source: [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories). Private-repository allocations can differ. This table is a reference for hosted runners. The measurement environment above identifies the system used for the results below.

## Results

Each value is a median: the first batch has three samples and the second has five. The column names describe sample order; they do not mean a fresh process followed by a warmed process.

### small fixture

| Phase | First batch (ms) | Subsequent batch (ms) |
| --- | ---: | ---: |
| Snapshot cache-key hashing | 1.1705 | 1.0981 |
| Inspection | 0.6265 | 0.7001 |
| Structural security (collection) | 2.355 | 2.246 |
| Attribution | 0.0166 | 0.0092 |
| Rendering | 0.008 | 0.0055 |
| Formatting | 2.5953 | 1.683 |
| Lint | 461.8162 | 443.141 |
| Types | 439.387 | 444.1414 |
| Cyclomatic complexity | 2.0851 | 1.7417 |
| Readability complexity | 1.6851 | 1.5564 |
| Structural security | 2.4778 | 2.2638 |
| Secrets | 1.1947 | 1.1425 |
| Duplication | 65.7313 | 62.8018 |
| Dependency architecture | 11.3818 | 9.7075 |
| Dead code | 352.4295 | 286.4817 |
| React correctness | 17.192 | 7.2865 |
| React accessibility | 3.3707 | 3.1292 |
| Vulnerabilities | 0.0083 | 0.007 |

### monorepo fixture

| Phase | First batch (ms) | Subsequent batch (ms) |
| --- | ---: | ---: |
| Snapshot cache-key hashing | 9.7006 | 8.6338 |
| Inspection | 5.8399 | 5.7397 |
| Structural security (collection) | 9.306 | 9.2745 |
| Attribution | 0.0365 | 0.0163 |
| Rendering | 0.0079 | 0.004 |

## Current benchmark method and limitations

Repeated phase samples share one fixture-scoped analysis session; final session cleanup is outside phase timings. These are not complete CLI timings. coldMs/warmMs are historical field names, not fresh/warm process guarantees. Historical Secretlint and OSV substitutions remain; the snapshot phase measures cache-key hashing, not Git materialization.

The source revision matters as well as the machine: the harness and analyzer implementations can change between releases. Compare the recorded revision and environment when interpreting results.

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

That command updates `bench/README.md` with the measured timings and environment. Review and commit this file. Keep the machine otherwise idle and record whether a VM was used in the review. GitHub Actions runs also record the job, runner image, and run link when available.

The benchmark runner matches measurements using the phase labels in these tables. Unknown labels, invalid timings, or duplicate rows cause an error instead of silently changing the comparison.
