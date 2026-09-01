import { describe, expect, it } from "vitest";
import {
  consumeGitBatchBlobOutput,
  type GitBlobStream,
} from "../../src/git/batch-object-stream.js";

const OID_A = "0123456789012345678901234567890123456789";
const OID_B = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const OID_C = "f".repeat(64);

async function* splitAtEveryBoundary(bytes: Buffer): AsyncIterable<Buffer> {
  const widths = [1, 2, 7, 3, 16, 5, 4, 11];
  let offset = 0;
  let width = 0;
  while (offset < bytes.length) {
    const end = Math.min(offset + widths[width % widths.length]!, bytes.length);
    yield bytes.subarray(offset, end);
    offset = end;
    width += 1;
  }
}

function frame(objectId: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${objectId} blob ${bytes.length}\n`, "ascii"),
    bytes,
    Buffer.from("\n", "ascii"),
  ]);
}

async function collect(blob: GitBlobStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of blob.chunks) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("consumeGitBatchBlobOutput", () => {
  it("preserves exact binary framing across blobs, hash formats, and chunk boundaries", async () => {
    const payloads = [
      Buffer.from([0x00, 0xff, 0x0a, 0x31, 0x32]),
      Buffer.from("header-looking blob 7\ncontent\n", "utf8"),
      Buffer.alloc(70_003, 0x5a),
    ];
    const output = Buffer.concat([
      frame(OID_A, payloads[0]!),
      frame(OID_B, payloads[1]!),
      frame(OID_C, payloads[2]!),
    ]);
    const actual: Array<{ objectId: string; size: number; bytes: Buffer }> = [];

    await consumeGitBatchBlobOutput(
      splitAtEveryBoundary(output),
      [OID_A, OID_B, OID_C],
      async (blob) => {
        actual.push({
          objectId: blob.objectId,
          size: blob.size,
          bytes: await collect(blob),
        });
      },
    );

    expect(actual).toEqual([
      { objectId: OID_A, size: payloads[0]!.length, bytes: payloads[0] },
      { objectId: OID_B, size: payloads[1]!.length, bytes: payloads[1] },
      { objectId: OID_C, size: payloads[2]!.length, bytes: payloads[2] },
    ]);
  });

  it.each([
    ["wrong object type", Buffer.from(`${OID_A} tree 3\nabc\n`, "ascii")],
    ["wrong object id", frame(OID_B, Buffer.from("abc", "ascii"))],
    [
      "non-ASCII header bytes",
      Buffer.concat([
        Buffer.from([0xb0]),
        Buffer.from(`${OID_A.slice(1)} blob 0\n\n`, "ascii"),
      ]),
    ],
    ["truncated body", Buffer.from(`${OID_A} blob 4\nabc`, "ascii")],
    ["missing delimiter", Buffer.from(`${OID_A} blob 3\nabc!`, "ascii")],
    [
      "trailing output",
      Buffer.concat([frame(OID_A, Buffer.alloc(0)), Buffer.from("x")]),
    ],
  ])("rejects %s as a sanitized protocol failure", async (_case, output) => {
    const failure = await consumeGitBatchBlobOutput(
      splitAtEveryBoundary(output),
      [OID_A],
      async (blob) => {
        await collect(blob);
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "GitCommandError",
      code: "GIT_COMMAND_FAILED",
    });
    expect(String(failure)).not.toContain(OID_A);
    expect(String(failure)).not.toContain(OID_B);
  });
});
