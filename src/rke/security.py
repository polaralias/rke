from __future__ import annotations

import re
from pathlib import Path


SECRET_PATTERNS = {
    "private-key": re.compile(
        r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?"
        r"-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        re.DOTALL,
    ),
    "credential-assignment": re.compile(
        r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|"
        r"client[_-]?secret)\s*([:=])\s*([\"']?)([^\s\"']{8,})\3"
    ),
    "github-token": re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    "aws-access-key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "bearer-token": re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}"),
}

SENSITIVE_FILENAMES = {
    ".env",
    ".git-credentials",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "application_default_credentials.json",
    "credentials.json",
    "id_dsa",
    "id_ed25519",
    "id_rsa",
}
SENSITIVE_DIRECTORY_PARTS = {
    ".aws",
    ".azure",
    ".gnupg",
    ".ssh",
}


def is_sensitive_path(relative: Path) -> bool:
    parts = tuple(part.casefold() for part in relative.parts)
    name = relative.name.casefold()
    if (
        name in SENSITIVE_FILENAMES
        or name.startswith(".env.")
        or relative.suffix.casefold() in {".key", ".p12", ".pem", ".pfx"}
        or SENSITIVE_DIRECTORY_PARTS.intersection(parts)
    ):
        return True
    joined = "/".join(parts)
    return (
        joined.endswith(".docker/config.json")
        or joined.endswith(".kube/config")
        or ".config/gcloud/" in f"/{joined}/"
        or name.endswith(".tfstate")
        or ".terraform/" in f"/{joined}/"
    )


def secret_kinds(value: str) -> list[str]:
    return [kind for kind, pattern in SECRET_PATTERNS.items() if pattern.search(value)]


def contains_secret(value: str) -> bool:
    return bool(secret_kinds(value))


def redact_secrets(value: str) -> tuple[str, list[str]]:
    findings: list[str] = []
    redacted = value
    for kind, pattern in SECRET_PATTERNS.items():
        if not pattern.search(redacted):
            continue
        findings.append(kind)
        if kind == "credential-assignment":
            redacted = pattern.sub(r"\1\2[REDACTED]", redacted)
        elif kind == "bearer-token":
            redacted = pattern.sub("Bearer [REDACTED]", redacted)
        else:
            redacted = pattern.sub(f"[REDACTED {kind}]", redacted)
    return redacted, findings
