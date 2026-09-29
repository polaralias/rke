const EXCLUDED_SEGMENTS = new Set([".git", ".engineering-workflow", "node_modules", ".venv", "venv", "dist", "build", "coverage", ".pytest_cache", ".ruff_cache", "__pycache__"]);
const SENSITIVE_SEGMENTS = new Set([".ssh", ".aws", ".azure", ".gnupg", ".terraform"]);
const SENSITIVE_NAMES = new Set([".env", ".git-credentials", ".netrc", ".npmrc", ".pypirc", "application_default_credentials.json", "credentials.json", "id_dsa", "id_ed25519", "id_rsa", "id_ecdsa"]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret)(\s*[:=]\s*)["']?[^\s"']{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

export function isExcludedPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part) || SENSITIVE_SEGMENTS.has(part))) return true;
  if (SENSITIVE_NAMES.has(name) || name.startsWith(".env.") || /^(?:credentials|secrets?)(?:\.[^/]*)?$/.test(name) || /\.(?:key|p12|pem|pfx|tfstate)$/.test(name)) return true;
  const joined = parts.join("/");
  return joined.endsWith(".docker/config.json") || joined.endsWith(".kube/config") || joined.includes(".config/gcloud/");
}

export function containsSecret(text: string): boolean { return SECRET_PATTERNS.some((pattern) => { pattern.lastIndex = 0; return pattern.test(text); }); }

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((result, pattern, index) => result.replace(pattern, index === 1 ? "$1$2[REDACTED]" : "[REDACTED]"), text);
}
