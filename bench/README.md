# Zedbee benchmark history

This is the single record of benchmark results and the environments that produced them. Runs are retained in chronological order; updates append a dated entry instead of replacing earlier measurements.

## Reading changes over time

Each run has its own machine details and timing tables. A change table compares it with the previous entry having matching CPU, memory, OS, architecture, Node version, and hosted-runner details. Positive changes mean slower; negative changes mean faster. Different environments are separate series, so the original GitHub run and the Mac run are not evidence of a code speedup or slowdown.

The original GitHub measurements have an unrecorded date and incomplete environment information. They remain visible as historical results and are not used for automatic regression comparisons.

## Run and record

Run `npm run benchmark` to compare against the latest entry with a matching recorded environment. With no matching entry, the command reports that a comparison is unavailable; it does not silently pass or compare with another machine.

Run `npm run benchmark:update` to measure and append a new entry, then review and commit this file. Existing entries remain unchanged. The comparison fails when a phase is both more than 25% and more than 250 ms slower. Recording a new entry is not proof that a regression has been fixed; review the changes before accepting it as the next reference.

## Measurement method

Each timing is a median: three samples in the first batch, then five in the subsequent batch. Repeated phase samples share one fixture-scoped analysis session; final session cleanup is outside phase timings. These are not complete CLI timings. coldMs/warmMs are historical field names, not fresh/warm process guarantees. Historical Secretlint and OSV substitutions remain; the snapshot phase measures cache-key hashing, not Git materialization.

The small fixture exercises individual analyzers. The monorepo fixture has a root workspace and 12 package workspaces. These synthetic measurements are not a promise of real-project scan speed. Run under similar load and record any relevant VM or machine changes. Source commits are recorded because the harness and analyzers can change too.

## GitHub-hosted runner reference

For public repositories, GitHub lists these standard runners (checked September 30, 2026):

| Runner label | CPU allocation | Memory | Architecture |
| --- | --- | --- | --- |
| `ubuntu-latest` | 4 CPUs | 16 GB | x64 |
| `windows-latest` | 4 CPUs | 16 GB | x64 |
| `macos-latest` | 3 CPUs (Apple M1) | 7 GB | arm64 |

Source: [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories). Private-repository allocations can differ. This is reference information, not a reconstruction of the original run's unknown configuration.

## Run: Historical GitHub Actions — measurement date unrecorded

### Measurement environment

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

### Results

#### small fixture

| Phase | First batch (ms) | Subsequent batch (ms) |
| --- | ---: | ---: |
| Snapshot cache-key hashing | 0.752 | 0.6801 |
| Inspection | 0.5698 | 0.4869 |
| Structural security (collection) | 2.641 | 3.2858 |
| Attribution | 0.0607 | 0.0099 |
| Rendering | 0.008 | 0.0061 |
| Formatting | 2.496 | 1.7967 |
| Lint | 544.959 | 514.8498 |
| Types | 524.0171 | 496.3678 |
| Cyclomatic complexity | 11.7068 | 2.6155 |
| Readability complexity | 2.3962 | 2.0878 |
| Structural security | 2.5558 | 2.7932 |
| Secrets | 1.5106 | 1.3629 |
| Duplication | 65.4085 | 63.2641 |
| Dependency architecture | 9.4142 | 8.1687 |
| Dead code | 254.12 | 251.3045 |
| React correctness | 6.4753 | 2.4984 |
| React accessibility | 1.7105 | 1.3366 |
| Vulnerabilities | 0.0108 | 0.0094 |

#### monorepo fixture

| Phase | First batch (ms) | Subsequent batch (ms) |
| --- | ---: | ---: |
| Snapshot cache-key hashing | 5.1678 | 5.3009 |
| Inspection | 5.0435 | 4.8167 |
| Structural security (collection) | 5.6025 | 5.6527 |
| Attribution | 0.0382 | 0.018 |
| Rendering | 0.0063 | 0.004 |

### Change from previous matching environment

No earlier run has matching recorded environment details. These measurements establish a starting point for this environment.

## Run: 2026-09-30T20:21:15.475Z — MacBook / Apple M5 Max / 128 GiB

### Measurement environment

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

### Results

#### small fixture

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

#### monorepo fixture

| Phase | First batch (ms) | Subsequent batch (ms) |
| --- | ---: | ---: |
| Snapshot cache-key hashing | 9.7006 | 8.6338 |
| Inspection | 5.8399 | 5.7397 |
| Structural security (collection) | 9.306 | 9.2745 |
| Attribution | 0.0365 | 0.0163 |
| Rendering | 0.0079 | 0.004 |

### Change from previous matching environment

No earlier run has matching recorded environment details. These measurements establish a starting point for this environment.
