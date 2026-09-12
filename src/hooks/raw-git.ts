import { updateHuskyHook } from "./husky.js";

export function updateRawGitHook(before: string | null | undefined): string {
  const firstLine = before?.split("\n", 1)[0] ?? "";
  if (
    firstLine.startsWith("#!") &&
    !/^#!\s*(?:\/\S*\/)?(?:sh|bash|dash|ksh|zsh)(?:\s|$)|^#!\s*\/usr\/bin\/env\s+(?:sh|bash|dash|ksh|zsh)(?:\s|$)/u.test(
      firstLine,
    )
  ) {
    throw new Error(
      "Zedbee cannot safely edit a non-shell pre-commit hook. Add the Zedbee command through its existing integration.",
    );
  }
  return updateHuskyHook(before);
}
