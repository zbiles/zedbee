# Zedbee benchmark baselines

Recorded phase timings for development regression checks. Actual scan times depend on the project, enabled checks, and execution environment.

This document is the single source of benchmark baselines. Automated comparisons read the full-precision timings directly from the tables below.

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
| Snapshot cache-key hashing <!-- snapshot --> | 0.752 | 0.6801 |
| Inspection <!-- inspection --> | 0.5698 | 0.4869 |
| Structural security (collection) <!-- adapter.structuralSecurity.collect --> | 2.641 | 3.2858 |
| Attribution <!-- attribution --> | 0.0607 | 0.0099 |
| Rendering <!-- rendering --> | 0.008 | 0.0061 |
| Formatting <!-- adapter.formatting.execute --> | 2.496 | 1.7967 |
| Lint <!-- adapter.lint.execute --> | 544.959 | 514.8498 |
| Types <!-- adapter.types.execute --> | 524.0171 | 496.3678 |
| Cyclomatic complexity <!-- adapter.cyclomaticComplexity.execute --> | 11.7068 | 2.6155 |
| Readability complexity <!-- adapter.readabilityComplexity.execute --> | 2.3962 | 2.0878 |
| Structural security <!-- adapter.structuralSecurity.execute --> | 2.5558 | 2.7932 |
| Secrets <!-- adapter.secrets.execute --> | 1.5106 | 1.3629 |
| Duplication <!-- adapter.duplication.execute --> | 65.4085 | 63.2641 |
| Dependency architecture <!-- adapter.dependencyArchitecture.execute --> | 9.4142 | 8.1687 |
| Dead code <!-- adapter.deadCode.execute --> | 254.12 | 251.3045 |
| React correctness <!-- adapter.reactCorrectness.execute --> | 6.4753 | 2.4984 |
| React accessibility <!-- adapter.reactAccessibility.execute --> | 1.7105 | 1.3366 |
| Vulnerabilities <!-- adapter.vulnerabilities.execute --> | 0.0108 | 0.0094 |

### monorepo fixture

| Phase | First batch (ms) | Subsequent batch (ms) |
| --- | ---: | ---: |
| Snapshot cache-key hashing <!-- snapshot --> | 5.1678 | 5.3009 |
| Inspection <!-- inspection --> | 5.0435 | 4.8167 |
| Structural security (collection) <!-- adapter.structuralSecurity.collect --> | 5.6025 | 5.6527 |
| Attribution <!-- attribution --> | 0.0382 | 0.018 |
| Rendering <!-- rendering --> | 0.0063 | 0.004 |

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

That command updates `bench/README.md` with the measured timings and environment. Review and commit this file. Keep the machine otherwise idle and record whether a VM was used in the review. GitHub Actions runs also record the job, runner image, and run link when available.

Each phase label contains an HTML comment with its stable identifier. These comments are hidden in the rendered table; retain them when editing so the benchmark runner can match measurements to rows. Invalid or duplicate rows cause an error instead of silently changing the comparison.
