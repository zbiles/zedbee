declare module "@yarnpkg/lockfile" {
  export interface ParseResult {
    readonly type: "success" | "merge" | "conflict";
    readonly object: Record<string, unknown>;
  }

  export function parse(contents: string, fileLocation?: string): ParseResult;

  const lockfile: {
    parse: typeof parse;
  };
  export default lockfile;
}
