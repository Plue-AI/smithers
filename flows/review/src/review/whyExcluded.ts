import { extname } from "node:path";
import { globMatch } from "./globMatch.ts";
import { effectivePath } from "../git/effectivePath.ts";
import type { DiffRecord } from "../git/diffRecord.ts";
import type { FileFilter } from "./fileFilter.ts";

const supportedExtensions = new Set([
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".groovy",
  ".py",
  ".pyi",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hxx",
  ".cs",
  ".vb",
  ".fs",
  ".go",
  ".rs",
  ".rb",
  ".rake",
  ".gemspec",
  ".php",
  ".swift",
  ".m",
  ".mm",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".sql",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".vue",
  ".svelte",
  ".xml",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".ini",
  ".env",
  ".gradle",
  ".cmake",
  ".r",
  ".lua",
  ".pl",
  ".pm",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".ets",
  ".json5",
  ".dart",
  ".tf",
]);

const defaultExcludePatterns = [
  "**/*_test.go",
  "**/src/test/java/**/*.java",
  "**/src/test/**/*.kt",
  "**/*.test.{js,jsx,ts,tsx}",
  "**/*.spec.{js,jsx,ts,tsx}",
  "**/__tests__/**",
  "**/test/**/*_test.py",
  "**/tests/**/*_test.py",
  "**/*_test.py",
  "**/*_spec.rb",
  "**/spec/**/*_spec.rb",
  "**/*Test.java",
  "**/*Tests.java",
  "**/*_test.rs",
  "**/oh_modules/**",
  "**/*.test.ets",
];

// Tool state and vendored or packaged third-party code. Reported as
// `provider_dir`, never hidden, and a rule `include` brings a path back.
const providerDirs = [
  ".idea/",
  ".vscode/",
  ".svn/",
  "vendor/",
  "node_modules/",
  "target/",
  ".happypack/",
  ".cachefile/",
  "_packages/",
  "rpm/",
  "pkgs/",
];

function isProviderDir(path: string) {
  return providerDirs.some((prefix) => path.startsWith(prefix));
}

function isAllowedExt(path: string) {
  const ext = extFromPath(path);
  return ext === "" || supportedExtensions.has(ext);
}

function extFromPath(path: string) {
  const name = path.split("/").pop() ?? path;
  const ext = extname(name);
  return ext.startsWith(".") ? ext.toLowerCase() : "";
}

function isDefaultExcluded(path: string) {
  const lower = path.toLowerCase();
  return defaultExcludePatterns.some((pattern) => globMatch(pattern, lower));
}

function isUserExcluded(filter: FileFilter | null, path: string) {
  if (!filter) return false;
  const lower = path.toLowerCase();
  return filter.exclude.some((pattern) => globMatch(pattern, lower));
}

function isUserIncluded(filter: FileFilter | null, path: string) {
  if (!filter || filter.include.length === 0) return false;
  const lower = path.toLowerCase();
  return filter.include.some((pattern) => globMatch(pattern, lower));
}

/**
 * Why the review filters skip this file, or `""` when it is reviewable.
 */
export function whyExcluded(diff: DiffRecord, filter: FileFilter | null) {
  if (diff.isBinary) return "binary";
  const path = effectivePath(diff);
  if (isUserExcluded(filter, path)) return "user_exclude";
  if (!isAllowedExt(path)) return "unsupported_ext";
  if (filter && filter.include.length > 0 && isUserIncluded(filter, path)) return "";
  if (isProviderDir(path)) return "provider_dir";
  if (isDefaultExcluded(path)) return "default_path";
  return "";
}
