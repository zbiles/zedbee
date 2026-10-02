import { format } from "prettier";
import { applyEdits, modify, parse } from "jsonc-parser";
import { configFileSchema } from "../config/schema.js";
import { resolveConfig } from "../config/profiles.js";
import { createFilePolicyResolver } from "../config/file-policy.js";
import { prettierOptions } from "../checks/prettier/settings.js";
import { initFileChange } from "./recommend.js";
import type { InitProposal } from "./types.js";

/** Format inert setup data before binding the review, hashes, and writes. */
export async function formatInitProposal(
  proposal: InitProposal,
): Promise<InitProposal> {
  const files = await Promise.all(
    proposal.files.map(async (file) => {
      if (file.relativePath !== ".zedbeerc.jsonc") return file;
      const config = resolveConfig(configFileSchema.parse(parse(file.after)));
      const policy = createFilePolicyResolver(config, {
        files: new Map(),
        isEmpty: true,
        containsAddedLine: () => false,
      })("formatting", file.relativePath, "target");
      // Never load project configuration or plugins while preparing setup data.
      let source = file.after;
      if (policy.engine === "project" && policy.severity !== "off") {
        // Setup data always uses the formatter that wrote it. Project source
        // keeps native formatting, without executing project code in a preview.
        const parsed = parse(source);
        const index = Array.isArray(parsed.overrides)
          ? parsed.overrides.length
          : 0;
        source = applyEdits(
          source,
          modify(
            source,
            ["overrides", index],
            {
              files: [".zedbeerc.jsonc"],
              checks: {
                formatting: { engine: "managed", severity: policy.severity },
              },
              generated: "prettier-engine",
            },
            {
              formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
            },
          ),
        );
      }
      const after = await format(source, {
        ...prettierOptions(policy.settings),
        parser: "json",
      });
      return after === file.after
        ? file
        : initFileChange(
            file.relativePath,
            file.before,
            after,
            file.mode,
            file.absolutePath,
          );
    }),
  );
  return Object.freeze({ ...proposal, files: Object.freeze(files) });
}
