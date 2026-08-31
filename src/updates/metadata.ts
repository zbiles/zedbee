import { gt, prerelease, satisfies, valid, validRange } from "semver";

export interface ReleaseMetadata {
  readonly name: "zedbee";
  readonly version: string;
  readonly engines?: { readonly node: string };
}

export interface UpdateNotice {
  readonly current: string;
  readonly latest: string;
}

export function releaseMetadata(value: unknown): ReleaseMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (
    entry.name !== "zedbee" ||
    typeof entry.version !== "string" ||
    entry.version.length > 128 ||
    valid(entry.version) !== entry.version ||
    prerelease(entry.version) !== null
  )
    return undefined;
  let node: string | undefined;
  if (entry.engines !== undefined) {
    if (typeof entry.engines !== "object" || entry.engines === null)
      return undefined;
    const engines = entry.engines as Record<string, unknown>;
    if (engines.node !== undefined) {
      if (
        typeof engines.node !== "string" ||
        engines.node.length > 256 ||
        validRange(engines.node) === null
      )
        return undefined;
      node = engines.node;
    }
  }
  // Keep only validated release metadata, never registry descriptions or scripts.
  return {
    name: "zedbee",
    version: entry.version,
    ...(node === undefined ? {} : { engines: { node } }),
  };
}

export function updateFromMetadata(
  value: unknown,
  current: string,
  node: string,
): UpdateNotice | undefined {
  const release = releaseMetadata(value);
  if (
    release === undefined ||
    valid(current) === null ||
    valid(node) === null ||
    !gt(release.version, current) ||
    (release.engines !== undefined && !satisfies(node, release.engines.node))
  )
    return undefined;
  return { current, latest: release.version };
}

export async function fetchLatestMetadata(
  fetcher: typeof fetch = fetch,
): Promise<ReleaseMetadata | undefined> {
  try {
    const response = await fetcher("https://registry.npmjs.org/zedbee/latest", {
      signal: AbortSignal.timeout(2500),
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      return undefined;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return releaseMetadata(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    return undefined;
  }
}
