import type { CheckId } from "../../config/schema.js";
import type { CheckAdapter } from "../adapter.js";

/** Fixed trusted entries only. No request may supply an import or command. */
export async function loadAnalyzerAdapter(
  checkId: CheckId,
): Promise<CheckAdapter> {
  switch (checkId) {
    case "formatting":
      return (await import("../prettier/adapter.js")).prettierAdapter;
    case "lint":
      return (await import("../eslint/lint-adapter.js")).lintAdapter;
    case "types":
      return (await import("../typescript/adapter.js")).typescriptAdapter;
    case "cyclomaticComplexity":
      return (await import("../complexity/adapter.js"))
        .cyclomaticComplexityAdapter;
    case "readabilityComplexity":
      return (await import("../complexity/adapter.js"))
        .readabilityComplexityAdapter;
    case "structuralSecurity":
      return (await import("../structural-security/adapter.js"))
        .structuralSecurityAdapter;
    case "secrets":
      return (await import("../secrets/adapter.js")).secretsAdapter;
    case "duplication":
      return (await import("../duplication/adapter.js")).duplicationAdapter;
    case "dependencyArchitecture":
      return (await import("../dependency-architecture/adapter.js"))
        .dependencyArchitectureAdapter;
    case "deadCode":
      return (await import("../dead-code/adapter.js")).deadCodeAdapter;
    case "reactCorrectness":
      return (await import("../react/correctness-adapter.js"))
        .reactCorrectnessAdapter;
    case "reactAccessibility":
      return (await import("../react/accessibility-adapter.js"))
        .reactAccessibilityAdapter;
    case "vulnerabilities":
      return (await import("../vulnerabilities/adapter.js"))
        .vulnerabilitiesAdapter;
  }
}
