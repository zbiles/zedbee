import { register } from "tsx/esm/api";

// Register TypeScript loading inside the source worker on every supported Node.
// The fixed installed entry and disabled tsconfig keep repository code out.
const loader = register({
  namespace: "zedbee-identity-source",
  tsconfig: false,
});
await loader.import(
  new URL("./identity-worker.ts", import.meta.url).href,
  import.meta.url,
);
