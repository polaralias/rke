from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_architecture_frontmatter_uses_durable_evidence_paths() -> None:
    architecture = read("docs/knowledge/rke-architecture.md")
    frontmatter = architecture.split("---", 2)[1]
    assert "tests passed" not in frontmatter
    assert "wheel built" not in frontmatter
    assert "src/rke/operations.py" in frontmatter
    assert ".github/workflows/publish-release.yml" in frontmatter


def test_documentation_matches_installed_host_and_scope_contracts() -> None:
    host = read("skills/engineering-workflow/references/host-integration.md")
    structure = read("skills/engineering-workflow/references/structural-context.md")
    repository = read("skills/engineering-workflow/references/repo-context-contract.md")
    assert ".githooks/pre-push" in host
    assert "core.hooksPath=.githooks" in host
    assert "graph shards" in structure
    assert "arbitrary file count" in structure
    assert "modification time and size alone are never accepted" in repository
    assert "every operation in the authoritative registry" in repository


def test_readme_exposes_the_normal_close_journey_and_release_identity() -> None:
    readme = read("README.md")
    assert (
        "activate → retrieve/trace → change → documentation assess → explain → apply → close"
        in readme
    )
    assert "`rke.__version__` is the only version source" in readme
    assert "repeatable `--scope <relative-path>`" in readme
