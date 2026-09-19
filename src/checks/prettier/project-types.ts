import type { FormattingSettings } from "./settings.js";

export interface ImportedFormattingOverride {
  readonly files: readonly string[];
  readonly excludeFiles: readonly string[];
  readonly settings: Partial<FormattingSettings>;
}

export interface ProjectPrettierInstallation {
  readonly projectRoot: string;
  readonly packageRoot: string;
  readonly entryUrl: string;
  readonly version: string;
  readonly declaredRange: string;
  readonly identity: string;
}

export interface FormattingProvenance {
  readonly engine: "managed" | "project";
  readonly version: string;
  readonly projectRoot: string;
  readonly configFiles: readonly string[];
}

export type ProjectPrettierErrorCode =
  | "PROJECT_PRETTIER_TRUST_REQUIRED"
  | "PROJECT_PRETTIER_INSTALL_MISSING"
  | "PROJECT_PRETTIER_VERSION_UNSUPPORTED"
  | "PROJECT_PRETTIER_LAYOUT_UNSUPPORTED"
  | "PROJECT_PRETTIER_CONFIG_INVALID"
  | "PROJECT_PRETTIER_PLUGIN_MISSING"
  | "PROJECT_PRETTIER_WORKER_FAILED"
  | "PROJECT_PRETTIER_PROTOCOL_INVALID"
  | "PROJECT_PRETTIER_OUTPUT_LIMIT"
  | "PROJECT_PRETTIER_PLAN_STALE";

export interface ProjectPrettierFailure {
  readonly code: ProjectPrettierErrorCode;
  readonly message: string;
  readonly projectRoot: string;
  readonly file?: string;
}

export type ProjectFormatIgnored = {
  readonly kind: "ignored";
  readonly reason: "prettierignore" | "gitignore" | "unsupported";
};

export type ProjectFormatSupport =
  | { readonly kind: "supported" }
  | ProjectFormatIgnored;

export type ProjectFormatResult =
  | { readonly kind: "formatted"; readonly text: string }
  | ProjectFormatIgnored;

export interface ImportableNativeConfig {
  readonly settings: Partial<FormattingSettings>;
  readonly overrides: readonly {
    readonly files: string | readonly string[];
    readonly excludeFiles?: string | readonly string[];
    readonly settings: Partial<FormattingSettings>;
  }[];
  readonly limitations: readonly string[];
}

export type ProjectPrettierRequest =
  | {
      readonly id: number;
      readonly operation: "classify";
      readonly file: string;
    }
  | {
      readonly id: number;
      readonly operation: "format";
      readonly file: string;
      readonly source: string;
    }
  | {
      readonly id: number;
      readonly operation: "importConfig";
      readonly configFile: string;
    }
  | {
      readonly id: number;
      readonly operation: "importConfig";
      /** Package-exported shared configuration specifier. */
      readonly configPackage: string;
    };

export type ProjectPrettierReply =
  | {
      readonly id: number;
      readonly operation: "classify";
      readonly result: ProjectFormatSupport;
    }
  | {
      readonly id: number;
      readonly operation: "format";
      readonly result: ProjectFormatResult;
    }
  | {
      readonly id: number;
      readonly operation: "importConfig";
      readonly result: ImportableNativeConfig;
    }
  | {
      readonly id: number;
      readonly operation: "error";
      readonly failure: ProjectPrettierFailure;
    };

export type FormattingFixSelection =
  | { readonly engine: "managed"; readonly settings: FormattingSettings }
  | {
      readonly engine: "project";
      readonly projectRoot: string;
      readonly installationIdentity: string;
      readonly snapshotIdentity: string;
    };
