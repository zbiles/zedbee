import { lintSource } from "@secretlint/core";
import { SECRET_LINT_CONFIG } from "./secrets/config.js";

export async function detectDiagnosticSecrets(
  content: string,
  filePath: string,
): Promise<readonly (readonly [number, number] | undefined)[]> {
  const { messages } = await lintSource({
    source: { content, filePath, contentType: "text" },
    options: {
      config: SECRET_LINT_CONFIG,
      maskSecrets: true,
      noPhysicFilePath: true,
    },
  });
  return messages.map(({ range }) => range);
}

export function diagnosticCredentialValues(source: string): string[] {
  return Array.from(
    source.matchAll(
      /(?:secret|password|token|credential|api[_-]?key|access[_-]?key)[\w-]*["']?\s*[:=]\s*["']([^"'\r\n]+)["']/giu,
    ),
    (match) => match[1]!,
  ).filter(Boolean);
}
