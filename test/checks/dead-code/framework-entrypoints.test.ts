import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createManagedKnipConfig } from "../../../src/checks/dead-code/managed-config.js";

it("selects captured default Next conventions without rooting helpers or shadowed src routes", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "next-app",
    dependencies: { next: "16" },
  });
  for (const path of [
    "app/(group)/[id]/page.tsx",
    "app/@slot/default.tsx",
    "app/_private/page.tsx",
    "app/helper.ts",
    "app/page.test.tsx",
    "app/page.mjs",
    "app/page.d.ts",
    "app/Page.tsx",
    "app/global-error.tsx",
    "app/sub/global-error.tsx",
    "app/(group)/robots.ts",
    "app/sub/robots.ts",
    "app/sub/sitemap.ts",
    "app/sub/icon.tsx",
    "src/app/page.tsx",
    "src/pages/api/hello.ts",
    "instrumentation.ts",
    "next.config.mts",
    "next-env.d.ts",
  ])
    await f.write(path, "export default {};");
  const inspection = await inspectRepository(f.root);
  const config = await createManagedKnipConfig(
    inspection.snapshotRoot,
    inspection,
  );
  expect(config.workspaces["."]?.entry).toEqual([
    "app/(group)/[id]/page.tsx",
    "app/(group)/robots.ts",
    "app/@slot/default.tsx",
    "app/global-error.tsx",
    "app/sub/icon.tsx",
    "app/sub/sitemap.ts",
    "instrumentation.ts",
    "next-env.d.ts",
    "next.config.mts",
    "src/pages/api/hello.ts",
  ]);
});

it("an empty root router shadows src independently and non-Next siblings stay ordinary", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "root",
    workspaces: ["web", "plain"],
  });
  await f.writeJson("web/package.json", {
    name: "web",
    dependencies: { next: "16" },
  });
  await f.writeJson("plain/package.json", { name: "plain" });
  await mkdir(join(f.root, "web/app"), { recursive: true });
  await f.write("web/src/app/page.tsx", "export default {};");
  await f.write("web/src/pages/index.tsx", "export default {};");
  await f.write("plain/app/page.tsx", "export default {};");
  const inspection = await inspectRepository(f.root);
  const config = await createManagedKnipConfig(
    inspection.snapshotRoot,
    inspection,
  );
  expect(config.workspaces.web?.entry).toEqual(["src/pages/index.tsx"]);
  expect(config.workspaces.plain?.entry).toEqual([]);
});

it.each([false, true])(
  "does not suppress next for manifest-only or next-env-only projects (%s)",
  async (declaration) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "next-app",
      dependencies: { next: "16" },
    });
    if (declaration)
      await f.write("next-env.d.ts", '/// <reference types="next" />');
    const inspection = await inspectRepository(f.root);
    const config = await createManagedKnipConfig(
      inspection.snapshotRoot,
      inspection,
    );
    expect(config.workspaces["."]?.ignoreDependencies).toEqual([]);
  },
);

it.each([
  "page",
  "layout",
  "route",
  "template",
  "default",
  "error",
  "loading",
  "not-found",
  "forbidden",
  "unauthorized",
])(
  "recognizes App Router %s across supported default extensions",
  async (name) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "next-app",
      dependencies: { next: "16" },
    });
    for (const ext of ["js", "jsx", "ts", "tsx"])
      await f.write(
        `src/app/(group)/@slot/[...slug]/${name}.${ext}`,
        "export default {};",
      );
    const inspection = await inspectRepository(f.root);
    const config = await createManagedKnipConfig(
      inspection.snapshotRoot,
      inspection,
    );
    expect(config.workspaces["."]?.entry).toEqual([
      `src/app/(group)/@slot/[...slug]/${name}.js`,
      `src/app/(group)/@slot/[...slug]/${name}.jsx`,
      `src/app/(group)/@slot/[...slug]/${name}.ts`,
      `src/app/(group)/@slot/[...slug]/${name}.tsx`,
    ]);
  },
);
