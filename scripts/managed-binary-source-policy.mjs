const PLATFORM_ASSETS = Object.freeze({
  gitleaks: Object.freeze({
    "darwin:arm64": ["darwin_arm64.tar.gz", "tar.gz", "vendor/gitleaks"],
    "darwin:x64": ["darwin_x64.tar.gz", "tar.gz", "vendor/gitleaks"],
    "linux:arm64": ["linux_arm64.tar.gz", "tar.gz", "vendor/gitleaks"],
    "linux:x64": ["linux_x64.tar.gz", "tar.gz", "vendor/gitleaks"],
    "win32:x64": ["windows_x64.zip", "zip", "vendor/gitleaks.exe"],
  }),
  "osv-scanner": Object.freeze({
    "darwin:arm64": ["darwin_arm64", "binary", "vendor/osv-scanner"],
    "darwin:x64": ["darwin_amd64", "binary", "vendor/osv-scanner"],
    "linux:arm64": ["linux_arm64", "binary", "vendor/osv-scanner"],
    "linux:x64": ["linux_amd64", "binary", "vendor/osv-scanner"],
    "win32:x64": ["windows_amd64.exe", "binary", "vendor/osv-scanner.exe"],
  }),
});

const RELEASES = Object.freeze({
  gitleaks: Object.freeze({
    version: "8.28.0",
    repository: "gitleaks/gitleaks",
    assetPrefix: "gitleaks_8.28.0_",
    checksumAsset: "gitleaks_8.28.0_checksums.txt",
    configUrl:
      "https://raw.githubusercontent.com/gitleaks/gitleaks/v8.28.0/config/gitleaks.toml",
    configPath: "vendor/gitleaks.toml",
  }),
  "osv-scanner": Object.freeze({
    version: "2.4.0",
    repository: "google/osv-scanner",
    assetPrefix: "osv-scanner_",
    checksumAsset: "osv-scanner_SHA256SUMS",
  }),
});

function rejected(message) {
  throw new TypeError(`Untrusted managed binary source: ${message}`);
}

export function assertOfficialManagedBinaryEntry(entry) {
  if (typeof entry !== "object" || entry === null) rejected("invalid entry");
  const release = RELEASES[entry.engine];
  const platformAsset =
    PLATFORM_ASSETS[entry.engine]?.[`${entry.platform}:${entry.arch}`];
  if (release === undefined || platformAsset === undefined) {
    rejected("unsupported engine or platform");
  }
  const [assetSuffix, assetFormat, executablePath] = platformAsset;
  const base = `https://github.com/${release.repository}/releases/download/v${release.version}`;
  const expectedAsset = `${base}/${release.assetPrefix}${assetSuffix}`;
  const expectedChecksum = `${base}/${release.checksumAsset}`;
  const expectedPackage = `@zedbee/${entry.engine}-${entry.platform}-${entry.arch}`;

  if (
    entry.version !== release.version ||
    entry.packageName !== expectedPackage ||
    entry.assetUrl !== expectedAsset ||
    entry.checksumUrl !== expectedChecksum ||
    entry.assetFormat !== assetFormat ||
    entry.executablePath !== executablePath ||
    entry.licensePath !== "LICENSE" ||
    entry.noticePath !== "THIRD_PARTY_NOTICES.md"
  ) {
    rejected(`${entry.engine ?? "unknown"} metadata does not match policy`);
  }
  if (entry.engine === "gitleaks") {
    if (
      entry.configUrl !== release.configUrl ||
      entry.configPath !== release.configPath
    ) {
      rejected("Gitleaks config does not match policy");
    }
  } else if (
    entry.configUrl !== undefined ||
    entry.configPath !== undefined ||
    entry.configSha256 !== undefined
  ) {
    rejected("OSV-Scanner must not declare a managed config");
  }
  return entry;
}
