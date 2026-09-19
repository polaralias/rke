from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_workflow(name: str) -> str:
    return (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")


def test_ci_covers_supported_interpreters_and_distribution_smoke() -> None:
    workflow = read_workflow("ci.yml")
    for version in ("3.11", "3.12", "3.13", "3.14"):
        assert f'python: "{version}"' in workflow
    assert workflow.count("os: windows-latest") == 2
    assert "python -m ruff check ." in workflow
    assert "python -m pyright" in workflow
    assert "python -m build" in workflow
    assert "scripts/smoke_distribution.py dist/*.whl" in workflow
    assert "scripts/smoke_distribution.py dist/*.tar.gz" in workflow


def test_release_draft_has_one_serialized_main_branch_trigger() -> None:
    workflow = read_workflow("release-drafter.yml")
    assert "pull_request:" not in workflow
    assert "release-drafter-${{ github.repository }}" in workflow
    assert "import rke; print(rke.__version__)" in workflow
    assert "cat VERSION" not in workflow


def test_tag_release_validates_and_publishes_the_built_artifacts() -> None:
    workflow = read_workflow("publish-release.yml")
    assert '"v*.*.*"' in workflow
    assert "scripts/validate_release.py --tag" in workflow
    assert "scripts/smoke_distribution.py dist/*.whl" in workflow
    assert "scripts/smoke_distribution.py dist/*.tar.gz" in workflow
    assert "actions/attest-build-provenance@v3" in workflow
    assert "pypa/gh-action-pypi-publish@release/v1" in workflow
    assert 'gh release view "$tag"' in workflow
    assert 'gh release edit "$tag" --draft=false' in workflow
    assert "needs: publish-pypi" in workflow
    assert workflow.index("publish-pypi:") < workflow.index("publish-github:")
