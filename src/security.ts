const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "coverage", ".pytest_cache", ".ruff_cache", "__pycache__"]);
const SENSITIVE_NAMES = /(^|\/)(\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?(?:\.[^/]*)?)$/i;
const SECRET_TEXT = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,})/i;

export function isExcludedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment)) || SENSITIVE_NAMES.test(normalized);
}

export function containsSecret(text: string): boolean { return SECRET_TEXT.test(text); }

export function redactSecrets(text: string): string {
  return text.replace(/(api[_-]?key|access[_-]?token|client[_-]?secret|password)(\s*[:=]\s*)["']?[^\s"']+/gi, "$1$2[REDACTED]");
}
