import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { compareCodeUnits } from "../../core/compare.js";
import { isGeneratedLockfile } from "./supported-path.js";

export const PROJECT_FORMATTING_INVENTORY_MAX_FILES = 20_000;

export interface ProjectFormattingInventory {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

/**
 * Builds one deterministic, repository-wide regular-file inventory. The
 * limit is shared by every directory; reaching it never masquerades as a
 * complete inventory.
 */
export async function collectProjectFormattingInventory(
  root: string,
  maxFiles = PROJECT_FORMATTING_INVENTORY_MAX_FILES,
): Promise<ProjectFormattingInventory> {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new TypeError("Expected a positive safe inventory limit");
  }
  const files: string[] = [];
  let truncated = false;

  const visit = async (directory: string): Promise<void> => {
    if (truncated) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const repositoryPath = relative(root, fullPath).split(sep).join("/");
        if (!isGeneratedLockfile(repositoryPath)) {
          if (files.length === maxFiles) {
            truncated = true;
            return;
          }
          files.push(repositoryPath);
        }
      }
      if (truncated) return;
    }
  };

  await visit(root);
  return Object.freeze({ files: Object.freeze(files), truncated });
}
