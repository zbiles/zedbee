import { createHash } from "node:crypto";

export function formattingFingerprint(file: string, startLine: number, endLine: number): string {
  return createHash("sha256")
    .update(["formatting", "prettier", file, String(startLine), String(endLine)].join("\0"))
    .digest("hex");
}
