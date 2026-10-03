import type { ScanHookName } from "./command.js";

const LEFTHOOK_RUN_COMMAND =
  /(?:^|[\n;&|])\s*(?:[^#\n;&|]*\/)?lefthook(?:\s+[^\n;&|]*)?\s+run\s+["']?pre-commit["']?(?:\s|$)/u;
const GENERATED_RUN_CALL =
  /(?:^|\n)\s*call_lefthook\s+run\s+["']?pre-commit["']?(?:\s|$)/u;
const GENERATED_DISPATCH =
  /(?:^|\n)\s*(?:elif\s+)?lefthook(?:\.bat)?(?:\s|$)[^\n]*["']?\$@["']?/u;

export function hasLefthookRunCommand(
  source: string,
  hookName: ScanHookName = "pre-commit",
): boolean {
  const runCommand = new RegExp(
    LEFTHOOK_RUN_COMMAND.source.replace("pre-commit", hookName),
    "u",
  );
  const generatedCall = new RegExp(
    GENERATED_RUN_CALL.source.replace("pre-commit", hookName),
    "u",
  );
  return (
    runCommand.test(source) ||
    (generatedCall.test(source) &&
      source.includes("LEFTHOOK_BIN") &&
      GENERATED_DISPATCH.test(source))
  );
}
