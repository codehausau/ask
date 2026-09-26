// Skip rules shared by context collection and reference resolution.
//
// Kept in its own module so searching the tree for `@needle` considers exactly
// the same files that would be attached — no "matched it but refused to send
// it" surprises.

export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".gradle",
  ".idea",
  ".venv",
  "__pycache__",
  ".terraform",
  // Caches and scratch dirs. These are frequently untracked-but-not-ignored,
  // so git enumeration alone does not exclude them, and a single one can hold
  // tens of thousands of entries.
  ".tmp",
  ".cache",
  ".pre-commit-cache",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".parcel-cache",
  ".vite",
  ".svelte-kit",
  ".astro",
  ".dart_tool",
  // ask's own scratch space, so a session file can never be attached.
  ".ask",
]);

/** Extensions treated as non-text and skipped during directory walks. */
export const SKIP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svgz",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".mp3", ".mp4", ".mov", ".avi", ".wav", ".ogg", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".class", ".jar", ".apk", ".aab",
  ".pyc", ".wasm", ".db", ".sqlite", ".keystore",
]);

/** Lockfiles: large, near-zero review value. */
export const LOCKFILES: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
]);

/** Files that usually hold credentials. Skipped unless explicitly allowed. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|[/\\])\.env(\.|$)/i,
  /(^|[/\\])(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/,
  /\.(pem|key|p12|pfx|jks|ppk)$/i,
  /(^|[/\\])(credentials|secrets?)\.(json|ya?ml|toml|ini)$/i,
];

export function isSecretPath(relPath: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(relPath));
}

export function isProbablyBinary(buffer: Buffer): boolean {
  // A NUL byte in the first chunk is the classic, cheap heuristic.
  return buffer.subarray(0, 8000).includes(0);
}
