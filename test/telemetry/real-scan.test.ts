import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { executeScanCommand } from "../../src/commands/scan.js";
import { CHECK_IDS } from "../../src/config/schema.js";
import { startTelemetry } from "../../src/telemetry/client.js";
import {
  telemetryBatchSchema,
  type TelemetryEvent,
} from "../../src/telemetry/schema.js";
import { TelemetryStore } from "../../src/telemetry/state.js";
import {
  sendTelemetry,
  TELEMETRY_ENDPOINT,
} from "../../src/telemetry/transport.js";
import { createGitRepository } from "../helpers/git-repository.js";

const cases = (["json", "sarif"] as const).flatMap((format) =>
  [false, true].flatMap((blocked) =>
    [false, true].map((disabled) => ({ format, blocked, disabled })),
  ),
);

describe("real scan telemetry delivery", () => {
  it.each(cases)(
    "$format scan blocked=$blocked disabled=$disabled preserves output and telemetry",
    async ({ format, blocked, disabled }) => {
      const repo = await createGitRepository("zedbee-telemetry-real-scan-");
      await repo.write(
        "package.json",
        '{"name":"telemetry-fixture","private":true}\n',
      );
      await repo.write(
        ".zedbeerc.jsonc",
        JSON.stringify({
          schemaVersion: 1,
          profile: "recommended",
          checks: Object.fromEntries(
            CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
          ),
        }),
      );
      const config = (strict: boolean) =>
        JSON.stringify({
          compilerOptions: { strict, noEmit: true, types: [] },
          files: ["private-customer.ts"],
        });
      await repo.write("tsconfig.json", config(false));
      await repo.write(
        "private-customer.ts",
        blocked
          ? "export function privateTelemetryValue(value) { return value; }\n"
          : "export function privateTelemetryValue(value: number) { return value; }\n",
      );
      await repo.commitAll("fixture baseline");
      await repo.write("tsconfig.json", config(true));
      expect((await repo.git(["add", "tsconfig.json"])).exitCode).toBe(0);

      const sent: TelemetryEvent[] = [];
      let output = "";
      const code = await runCli(
        [
          "node",
          "zedbee",
          "scan",
          "--hook-invocation",
          "--format",
          format,
          "--no-service",
          "--no-color",
        ],
        {
          startTelemetry: (options) =>
            startTelemetry({
              ...options,
              env: {
                CI: "1",
                ...(disabled ? { ZEDBEE_TELEMETRY_DISABLED: "1" } : {}),
              },
              store: new TelemetryStore(join(repo.root, "telemetry-state")),
              send: (events, signal) =>
                sendTelemetry(events, signal, async (url, init) => {
                  expect(url).toBe(TELEMETRY_ENDPOINT);
                  expect(init?.method).toBe("POST");
                  expect(init?.redirect).toBe("error");
                  const batch = telemetryBatchSchema.parse(
                    JSON.parse(String(init?.body)),
                  );
                  sent.push(...batch.events);
                  return new Response(null, { status: 204 });
                }),
            }),
          executeScanCommand: (options, io) =>
            executeScanCommand(
              { ...options, cwd: repo.root },
              {
                ...io,
                writeStdout: (value) => {
                  output += value;
                },
              },
            ),
        },
      );
      const outcome = blocked ? "blocked" : "pass";
      expect(code).toBe(blocked ? 1 : 0);
      const report: unknown = JSON.parse(output);
      expect(report).toMatchObject(
        format === "json"
          ? {
              outcome,
              exitCode: code,
              checks: [{ checkId: "types", status: "completed" }],
            }
          : {
              version: "2.1.0",
              runs: [
                { invocations: [{ properties: { outcome, exitCode: code } }] },
              ],
            },
      );
      if (disabled) {
        expect(sent).toEqual([]);
        return;
      }
      expect(sent.map((event) => event.event)).toEqual([
        "scan_started",
        "scan_finished",
      ]);
      expect(sent[0]?.run_id).toBe(sent[1]?.run_id);
      expect(sent[1]).toMatchObject({
        outcome,
        output_format: format,
        invocation_source: "git_hook",
        check_ids: ["types"],
        finding_count: blocked ? 1 : 0,
        empty_input: false,
      });
      const wire = JSON.stringify(sent);
      for (const privateValue of [
        repo.root,
        "private-customer",
        "privateTelemetryValue",
        "TS7006",
      ])
        expect(wire).not.toContain(privateValue);
    },
  );
});
