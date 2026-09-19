from __future__ import annotations

import importlib.metadata
import runpy
from pathlib import Path

import rke
from rke.repo_context_mcp import SERVER_INFO


ROOT = Path(__file__).resolve().parents[1]


def test_version_has_one_runtime_identity() -> None:
    assert rke.__version__ == "0.4.0"
    assert importlib.metadata.version("polaralias-rke") == rke.__version__
    assert SERVER_INFO["version"] == rke.__version__


def test_project_uses_dynamic_hatch_version() -> None:
    project = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'dynamic = ["version"]' in project
    assert '[tool.hatch.version]\npath = "src/rke/__init__.py"' in project
    assert "\nversion = " not in project
    assert not (ROOT / "VERSION").exists()


def test_release_validator_is_importable() -> None:
    namespace = runpy.run_path(str(ROOT / "scripts" / "validate_release.py"), run_name="release_validator")
    assert callable(namespace["artifact_versions"])
