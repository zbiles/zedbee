import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { managedReactAccessibilityConfig } from "../../../src/checks/react/config.js";

async function rules(attributes: string) {
  const engine = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        ...managedReactAccessibilityConfig(),
        languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      },
    ],
  });
  return (
    await engine.lintText(
      `const view = <div ${attributes} onKeyDown={() => {}} />;`,
      { filePath: "app.jsx" },
    )
  )[0]!.messages.map((m) => m.ruleId);
}
const interaction = "jsx-a11y/no-noninteractive-element-interactions";
const tabindex = "jsx-a11y/no-noninteractive-tabindex";
describe("focusable window splitter", () => {
  it.each(["{0}", '"0"', "{-1}"])(
    "accepts a separator with tabIndex %s and current value",
    async (index) => {
      const found = await rules(
        `role="separator" tabIndex=${index} aria-valuenow={value}`,
      );
      expect(found).not.toContain(interaction);
      expect(found).not.toContain(tabindex);
    },
  );
  it.each(["", "aria-valuenow={null}", "aria-valuenow={undefined}"])(
    "retains checking without a usable current value: %s",
    async (value) => {
      expect(await rules(`role="separator" tabIndex={0} ${value}`)).toContain(
        interaction,
      );
    },
  );
  it("retains checking for an unfocusable separator", async () => {
    expect(await rules('role="separator" aria-valuenow={5}')).toContain(
      interaction,
    );
  });
  it("does not trust a later spread", async () => {
    expect(
      await rules('role="separator" tabIndex={0} aria-valuenow={5} {...props}'),
    ).toContain(interaction);
  });
  it("allows an earlier spread overridden by explicit attributes", async () => {
    expect(
      await rules('{...props} role="separator" tabIndex={0} aria-valuenow={5}'),
    ).not.toContain(interaction);
  });
  it("preserves checking of other roles", async () => {
    expect(
      await rules('role="article" tabIndex={0} aria-valuenow={5}'),
    ).toContain(interaction);
  });
});
