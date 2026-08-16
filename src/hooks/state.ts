const LEFTHOOK_RUN_COMMAND =
  /(?:^|[\n;&|])\s*(?:[^#\n;&|]*\/)?lefthook(?:\s+[^\n;&|]*)?\s+run\s+["']?pre-commit["']?(?:\s|$)/u;
const GENERATED_RUN_CALL =
  /(?:^|\n)\s*call_lefthook\s+run\s+["']?pre-commit["']?(?:\s|$)/u;
const GENERATED_DISPATCH =
  /(?:^|\n)\s*(?:elif\s+)?lefthook(?:\.bat)?(?:\s|$)[^\n]*["']?\$@["']?/u;

export function hasLefthookRunCommand(source: string): boolean {
  return (
    LEFTHOOK_RUN_COMMAND.test(source) ||
    (GENERATED_RUN_CALL.test(source) &&
      source.includes("LEFTHOOK_BIN") &&
      GENERATED_DISPATCH.test(source))
  );
}
