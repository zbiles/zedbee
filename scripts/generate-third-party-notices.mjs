import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateThirdPartyNotices } from "./check-production-licenses.mjs";

const root = process.cwd();
await writeFile(
  resolve(root, "THIRD_PARTY_NOTICES.md"),
  await generateThirdPartyNotices(root),
);
console.log("Generated third-party notices.");
