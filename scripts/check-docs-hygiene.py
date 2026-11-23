#!/usr/bin/env python3
"""Check that public documentation and the offline fixture recipe are self-contained."""

import argparse
from pathlib import Path


ROOT_MARKDOWN = {"README.md", "AGENTS.md"}
FIXTURES = "docker/storage-fixtures"
MINIO_RECIPE = f"{FIXTURES}/minio-ce.Dockerfile"
REQUIRED_FILES = ROOT_MARKDOWN | {
    "docs/architecture.md",
    "docs/development.md",
    "docs/core-contracts.md",
    "docs/syntax.md",
    "docs/storage.md",
    ".github/workflows/ci.yml",
    "Makefile",
    "compose.storage-tests.yaml",
    f"{FIXTURES}/with-storage-fixtures.sh",
    f"{FIXTURES}/uds-bridge.Dockerfile",
    f"{FIXTURES}/uds_tcp_bridge.rs",
    MINIO_RECIPE,
}


def check(root):
    for name in sorted(REQUIRED_FILES):
        if not (root / name).is_file():
            raise ValueError(f"required public file missing: {name}")

    for entry in sorted(root.iterdir()):
        if entry.name.endswith(".md") and entry.name not in ROOT_MARKDOWN:
            raise ValueError(f"unexpected root Markdown configuration file: {entry.name}")

    # Keep these checks aligned with l9_public_repository_hygiene_docs_and_pinned_fixture_provenance.
    required_text = {
        f"{FIXTURES}/uds_tcp_bridge.rs": ("#![forbid(unsafe_code)]",),
        "compose.storage-tests.yaml": (
            "postgres:16-bookworm@sha256:",
            "network_mode: none",
            'network_mode: "service:minio"',
        ),
    }
    minio_pin = ("9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a", "RELEASE.2025-10-15T17-29-55Z")
    required_text.update({MINIO_RECIPE: minio_pin, "docs/storage.md": minio_pin})
    for name, snippets in required_text.items():
        content = (root / name).read_text(encoding="utf-8")
        for snippet in snippets:
            if snippet not in content:
                raise ValueError(f"{name} is missing required fixture provenance {snippet!r}")

    markdown = sorted(root / name for name in ROOT_MARKDOWN)
    markdown.extend(sorted((root / "docs").rglob("*.md")))
    for path in markdown:
        if not path.resolve().is_relative_to(root):
            raise ValueError(f"public Markdown resolves outside the repository: {path}")
        content = path.read_text(encoding="utf-8")
        if "[[" in content:
            raise ValueError(f"non-portable wiki-link syntax in {path.relative_to(root)}")
        for segment in content.split("](")[1:]:
            raw_target, closing, _ = segment.partition(")")
            if not closing:
                continue
            target = raw_target.split("#", 1)[0].strip()
            if not target or target.startswith(("https://", "http://")):
                continue
            resolved = (path.parent / target).resolve()
            if not resolved.is_relative_to(root) or not resolved.exists():
                raise ValueError(f"invalid relative link {target!r} in {path.relative_to(root)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        check(args.root.resolve())
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"docs hygiene: {error}\n")


if __name__ == "__main__":
    main()
