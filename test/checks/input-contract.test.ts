import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import {
  cannotAnalyzeArtifact,
  inputContractFor,
  type ArtifactKind,
} from "../../src/checks/input-contract.js";

const JAVASCRIPT_SOURCE_CHECKS = [
  "lint",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "reactCorrectness",
  "reactAccessibility",
] as const;

const REPOSITORY_WIDE_CHECKS = [
  "duplication",
  "dependencyArchitecture",
  "deadCode",
] as const;

describe("check input contracts", () => {
  it("prevents callers from changing accepted artifacts", () => {
    for (const checkId of CHECK_IDS) {
      const contract = inputContractFor(checkId);
      const artifacts = contract.acceptedArtifacts as unknown as {
        add(value: ArtifactKind): void;
        delete(value: ArtifactKind): void;
        clear(): void;
      };

      expect(contract.checkId).toBe(checkId);
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.acceptedArtifacts)).toBe(true);
      expect(() => artifacts.add("binary")).toThrow(TypeError);
      expect(() => artifacts.delete("text")).toThrow(TypeError);
      expect(() => artifacts.clear()).toThrow(TypeError);
      expect([...contract.acceptedArtifacts]).toEqual(
        checkId === "secrets" ? ["text", "binary"] : ["text"],
      );
    }
  });

  it("accepts JavaScript and TypeScript source only for source analyzers", () => {
    for (const checkId of JAVASCRIPT_SOURCE_CHECKS) {
      expect(inputContractFor(checkId).supportsPath("src/app.ts")).toBe(true);
      expect(inputContractFor(checkId).supportsPath("package.json")).toBe(false);
    }

    expect(inputContractFor("types").supportsPath("src/app.ts")).toBe(true);
    expect(inputContractFor("types").supportsPath("src/app.js")).toBe(false);
  });

  it("uses Prettier's path support for formatting", () => {
    expect(inputContractFor("formatting").supportsPath("package.json")).toBe(
      true,
    );
    expect(inputContractFor("formatting").supportsPath("assets/photo.png")).toBe(
      false,
    );
  });

  it("limits vulnerability analysis to known lockfiles", () => {
    expect(
      inputContractFor("vulnerabilities").supportsPath("package-lock.json"),
    ).toBe(true);
    expect(
      inputContractFor("vulnerabilities").supportsPath("packages/web/yarn.lock"),
    ).toBe(true);
    expect(
      inputContractFor("vulnerabilities").supportsPath("package.json"),
    ).toBe(false);
  });

  it("lets secrets safely skip binary content while rejecting pointers", () => {
    const contract = inputContractFor("secrets");

    expect(contract.supportsPath("assets/photo.png")).toBe(true);
    expect([...contract.acceptedArtifacts]).toEqual(["text", "binary"]);
    expect(cannotAnalyzeArtifact("secrets", "assets/photo.png", "binary")).toBe(
      false,
    );
  });

  it("does not associate repository-wide checks with individual paths", () => {
    for (const checkId of REPOSITORY_WIDE_CHECKS) {
      expect(inputContractFor(checkId).supportsPath("src/app.ts")).toBe(false);
      expect(cannotAnalyzeArtifact(checkId, "src/app.ts", "binary")).toBe(
        false,
      );
    }
  });

  it("rejects unsupported artifacts only when the check consumes their path", () => {
    expect(cannotAnalyzeArtifact("lint", "src/app.ts", "binary")).toBe(true);
    expect(
      cannotAnalyzeArtifact("formatting", "package.json", "binary"),
    ).toBe(true);
    expect(
      cannotAnalyzeArtifact("vulnerabilities", "package-lock.json", "binary"),
    ).toBe(true);
    expect(
      cannotAnalyzeArtifact("formatting", "package.json", "git-lfs-pointer"),
    ).toBe(true);
    expect(cannotAnalyzeArtifact("secrets", "vendor", "submodule")).toBe(
      true,
    );
    expect(cannotAnalyzeArtifact("lint", "assets/photo.png", "binary")).toBe(
      false,
    );
  });
});
