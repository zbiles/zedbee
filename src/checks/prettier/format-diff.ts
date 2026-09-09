import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { diffLines, type Change } from "diff";
import { mergeLineRanges, type LineRange } from "../../git/change-set.js";
import { CheckIncompleteError } from "../incomplete-error.js";

const comparisonTimeoutMs = 2_000;
const diffModule = createRequire(import.meta.url).resolve("diff");

// Fixed code only. File contents are passed as data, never evaluated as code.
// Resolving the dependency here works in both source tests and the npm package.
const comparisonWorker = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { diffLines } = require(workerData.diffModule);
  parentPort.postMessage(diffLines(workerData.source, workerData.formatted, {
    timeout: workerData.timeoutMs,
  }));
`;

interface ComparisonOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function timeoutError(): CheckIncompleteError {
  return new CheckIncompleteError({
    code: "FORMATTING_DIFF_TIMEOUT",
    message: "The formatting comparison exceeded its time limit.",
    remediation:
      "Format the affected file with Prettier directly or edit its formatting manually, then review and stage the changes and scan again.",
  });
}

function checkBudget(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Formatting comparison aborted", "AbortError");
  }
  if (Date.now() >= deadline) throw timeoutError();
}

/** Only skip diffing when every possible common line is in the matching suffix. */
function replacementRanges(
  source: string,
  formatted: string,
): LineRange[] | undefined {
  const before = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const after = formatted.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    before[oldEnd - 1] === after[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const oldMiddle = new Set(before.slice(start, oldEnd));
  // A repeated suffix line in either middle can change jsdiff's chosen anchors.
  // Include the suffix in this intersection test instead of trimming it blindly.
  for (let index = start; index < after.length; index++) {
    if (oldMiddle.has(after[index]!)) return undefined;
  }
  const suffix = new Set(before.slice(oldEnd));
  for (let index = start; index < newEnd; index++) {
    if (suffix.has(after[index]!)) return undefined;
  }
  if (oldEnd > start) return [{ start: start + 1, end: oldEnd }];
  const anchor = Math.min(start + 1, Math.max(1, before.length));
  return [{ start: anchor, end: anchor }];
}

function compareInWorker(
  source: string,
  formatted: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<Change[]> {
  checkBudget(deadline, signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(comparisonWorker, {
      eval: true,
      execArgv: [],
      workerData: {
        source,
        formatted,
        diffModule,
        timeoutMs: Math.max(1, deadline - Date.now()),
      },
    });
    let settled = false;
    const finish = (error: unknown, changes?: Change[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Wait for termination so cancelled or timed-out work cannot keep running.
      void worker.terminate().then(() => {
        if (error !== undefined) reject(error);
        else resolve(changes!);
      }, reject);
    };
    const abort = () =>
      finish(new DOMException("Formatting comparison aborted", "AbortError"));
    const timer = setTimeout(
      () => finish(timeoutError()),
      Math.max(0, deadline - Date.now()),
    );
    worker.once("message", (changes: Change[] | undefined) => {
      if (changes === undefined || Date.now() >= deadline)
        finish(timeoutError());
      else finish(undefined, changes);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", () =>
      finish(
        new Error(
          "Formatting comparison worker exited before returning a result",
        ),
      ),
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function lineCount(value: string, reportedCount: number | undefined): number {
  if (reportedCount !== undefined) {
    return reportedCount;
  }
  if (value === "") {
    return 0;
  }
  const breaks = value.match(/\n/g)?.length ?? 0;
  return breaks + (value.endsWith("\n") ? 0 : 1);
}

export async function formattingTransformationRanges(
  source: string,
  formatted: string,
  options: ComparisonOptions = {},
): Promise<LineRange[]> {
  const timeoutMs = options.timeoutMs ?? comparisonTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new TypeError("Invalid formatting comparison time limit");
  const deadline = Date.now() + timeoutMs;
  checkBudget(deadline, options.signal);
  if (source === formatted) {
    return [];
  }

  const replacement = replacementRanges(source, formatted);
  checkBudget(deadline, options.signal);
  if (replacement !== undefined) return replacement;

  const sourceLineCount = Math.max(1, lineCount(source, undefined));
  // Small edits finish without starting a worker. Bound both time and edit
  // distance here so large ambiguous rewrites cannot monopolize the main thread.
  const immediate = diffLines(source, formatted, {
    maxEditLength: 32,
    timeout: Math.min(10, Math.max(1, deadline - Date.now())),
  });
  checkBudget(deadline, options.signal);
  const changes =
    immediate ??
    (await compareInWorker(source, formatted, deadline, options.signal));
  const ranges: LineRange[] = [];
  let sourceLine = 1;
  let previousWasRemoval = false;

  for (const change of changes) {
    const count = lineCount(change.value, change.count);
    if (change.removed === true) {
      if (count > 0) {
        ranges.push({ start: sourceLine, end: sourceLine + count - 1 });
        sourceLine += count;
      }
      previousWasRemoval = true;
    } else if (change.added === true) {
      if (!previousWasRemoval) {
        const anchor = Math.min(Math.max(sourceLine, 1), sourceLineCount);
        ranges.push({ start: anchor, end: anchor });
      }
      previousWasRemoval = false;
    } else {
      sourceLine += count;
      previousWasRemoval = false;
    }
  }

  return mergeLineRanges(ranges);
}

export function intersectRanges(
  transformations: readonly LineRange[],
  staged: readonly LineRange[],
): LineRange[] {
  const intersections: LineRange[] = [];
  for (const transformation of transformations) {
    for (const changed of staged) {
      const start = Math.max(transformation.start, changed.start);
      const end = Math.min(transformation.end, changed.end);
      if (start <= end) {
        intersections.push({ start, end });
      }
    }
  }
  return mergeLineRanges(intersections);
}
