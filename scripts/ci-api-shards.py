#!/usr/bin/env python3
"""Plan CI and run a shard using the pinned offline Cargo toolchain."""

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[1]
APP = PurePosixPath("/workspace/apps/api")
DEBUG = APP / "target/debug"
ID = re.compile(r"[a-z0-9][a-z0-9-]*")
CARGO_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_-]*")
DOC_PATH = re.compile(r"docs/.+|README\.md|AGENTS\.md|LICENSE")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def require_fields(value, fields, description):
    require(isinstance(value, dict) and set(value) == set(fields),
            f"unexpected fields in {description}: expected {', '.join(fields)}")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"repeated JSON field: {key}")
        result[key] = value
    return result


def read_toml(path):
    with path.open("rb") as source:
        return tomllib.load(source)


def read_members(root):
    api = root / "apps/api"
    paths = read_toml(api / "Cargo.toml")["workspace"]["members"]
    require(isinstance(paths, list) and paths, "no Cargo workspace members")
    members = {}
    for path in paths:
        manifest = (api / path / "Cargo.toml").resolve()
        require(manifest.is_relative_to(api), f"workspace member escapes apps/api: {path}")
        name = read_toml(manifest)["package"]["name"]
        require(matches(CARGO_NAME, name), f"invalid package name: {name!r}")
        require(name not in members, f"duplicate workspace package: {name}")
        members[name] = APP / manifest.relative_to(api).as_posix()
    return members


def validate_manifest(data, members):
    require_fields(data, ("schema_version", "feature_anchor_crates", "shards"), "shard manifest")
    require(type(data["schema_version"]) is int and data["schema_version"] == 1,
            "unsupported shard manifest schema_version")
    anchors = data["feature_anchor_crates"]
    require(isinstance(anchors, list) and anchors and
            all(matches(CARGO_NAME, name) and name in members for name in anchors),
            "feature_anchor_crates must name workspace packages")
    require(len(anchors) == len(set(anchors)), "duplicate feature anchor")
    require("notarium-bin" in anchors, "notarium-bin must be a feature anchor")

    shards = data["shards"]
    require(isinstance(shards, list) and shards, "expected at least one shard")
    ids, assigned = set(), set()
    flags = ("needs_build_api", "saves_fixture_cache", "runs_doc_tests")
    for shard in shards:
        require_fields(shard, ("id", "crates", *flags), "shard")
        shard_id = shard["id"]
        require(matches(ID, shard_id), f"invalid shard id: {shard_id!r}")
        require(shard_id not in ids, f"duplicate shard id: {shard_id}")
        ids.add(shard_id)
        for field in flags:
            require(type(shard[field]) is bool, f"{shard_id}.{field} must be a boolean")
        crates = shard["crates"]
        require(isinstance(crates, list) and crates, f"{shard_id} has no crates")
        for name in crates:
            require(matches(CARGO_NAME, name) and name in members,
                    f"{shard_id} names an unknown workspace package: {name!r}")
            require(name not in assigned, f"package assigned more than once: {name}")
            assigned.add(name)
        if "fitness-gates" in crates:
            require(shard["needs_build_api"], "the fitness-gates shard requires build-api")

    require(assigned == set(members), f"unassigned packages: {sorted(set(members) - assigned)}")
    for field in ("saves_fixture_cache", "runs_doc_tests"):
        require(sum(shard[field] for shard in shards) == 1,
                f"exactly one shard must set {field}")


def git_bytes(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL)


def code_checks(root, event, pr_head):
    if event != "pull_request":
        return True, "Full checks are required outside pull requests."

    try:
        # Read the raw parent list so shallow history cannot hide a third parent.
        headers = git_bytes(root, "cat-file", "commit", "HEAD").partition(b"\n\n")[0]
        parents = [line[7:] for line in headers.splitlines() if line.startswith(b"parent ")]
        if len(parents) != 2 or parents[1].decode("ascii") != pr_head:
            return True, "The checkout is not the expected two-parent PR merge."
        git_bytes(root, "rev-parse", "--verify", "HEAD^2^{commit}")
        diff = git_bytes(root, "diff", "--no-renames", "--ignore-submodules=none",
                         "--no-ext-diff", "--no-textconv",
                         "--name-only", "-z", "HEAD^1", "HEAD", "--")
        if not diff or not diff.endswith(b"\0"):
            return True, "The PR diff is empty or incomplete."
        paths = diff[:-1].decode("utf-8").split("\0")
    except (OSError, subprocess.CalledProcessError, UnicodeError):
        return True, "The PR merge or changed paths could not be verified."

    for path in paths:
        if not DOC_PATH.fullmatch(path) or ".." in path.split("/") or "\r" in path:
            return True, f"Full checks are required for this changed path.\n\n```text\n{json.dumps(path)}\n```"
    return False, "Documentation-only PR. Public documentation checks ran in this job."


def publish_plan(data):
    run_code, reason = code_checks(ROOT, os.environ.get("EVENT_NAME"),
                                   os.environ.get("PR_HEAD_SHA"))
    matrix = [{"id": shard["id"], "saves_fixture_cache": shard["saves_fixture_cache"]}
              for shard in data["shards"]]
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        summary.write(f"{reason}\n")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"run_code={str(run_code).lower()}\n")
        output.write(f"shards_matrix={json.dumps(matrix, separators=(',', ':'))}\n")


def package_flags(packages):
    return [f"--package={name}" for name in dict.fromkeys(packages)]


def select_binaries(events, selected):
    tests = {}
    linked_dirs = set()
    seen = set()
    finished = []
    for line in events.splitlines():
        event = json.loads(line)
        reason = event["reason"]
        if reason == "build-finished":
            finished.append(event["success"])
        elif reason == "build-script-executed":
            for search_path in event["linked_paths"]:
                path = PurePosixPath(search_path.split("=", 1)[-1])
                if path.is_relative_to(DEBUG) and ".." not in path.parts:
                    linked_dirs.add(str(path))
        elif (reason == "compiler-artifact" and event["package_id"] in selected
              and event["profile"]["test"] is True and event["executable"] is not None):
            package_id = event["package_id"]
            manifest = selected[package_id]
            exe = PurePosixPath(event["executable"])
            require(str(manifest) == event["manifest_path"],
                    f"unexpected manifest for test executable {exe}")
            require(exe.is_relative_to(DEBUG) and exe != DEBUG and ".." not in exe.parts,
                    f"test executable is outside {DEBUG}: {exe}")
            test = (str(manifest.parent), str(exe))
            tests[test] = None
            seen.add(package_id)
    require(len(finished) == 1 and finished[0] is True, "Cargo did not finish the test build")
    missing = [str(manifest) for package_id, manifest in selected.items() if package_id not in seen]
    require(not missing, f"no test executables reported for: {', '.join(missing)}")
    return tests, sorted(linked_dirs)


RUN_TESTS = r"""
run_doc_tests=$1
linked_paths=$2
shift 2
sysroot_libdir=$(rustc --print target-libdir)
(
    export LD_LIBRARY_PATH="$CARGO_TARGET_DIR/debug/deps:$CARGO_TARGET_DIR/debug:$sysroot_libdir${linked_paths:+:$linked_paths}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    while [ "$#" -gt 0 ]; do
        printf 'Running %s\n' "$2"
        (cd "$1" && "$2")
        shift 2
    done
)
if [ "$run_doc_tests" = true ]; then
    cargo test --locked --offline --workspace --doc
fi
"""


def run_shard(data, members, shard_id):
    shard = next((shard for shard in data["shards"] if shard["id"] == shard_id), None)
    require(shard is not None, f"unknown shard: {shard_id!r}")
    devkit = ["sh", ".devkit/runtime/devkit.sh", "cli", "exec", "--root", str(ROOT),
              "--component", "apps/api", "--network", "none", "--"]
    if shard["needs_build_api"]:
        subprocess.run(["make", "build", "app=api"], cwd=ROOT, check=True)
    metadata = json.loads(subprocess.check_output(
        [*devkit, "cargo", "metadata", "--no-deps", "--format-version=1", "--locked", "--offline"],
        cwd=ROOT,
    ))
    wanted = {str(members[name]): name for name in shard["crates"]}
    workspace = set(metadata["workspace_members"])
    selected = {pkg["id"]: PurePosixPath(pkg["manifest_path"])
                for pkg in metadata["packages"]
                if pkg["id"] in workspace and wanted.get(pkg["manifest_path"]) == pkg["name"]}
    require(len(selected) == len(wanted), "Cargo metadata does not match the shard manifest")
    anchors = data["feature_anchor_crates"]
    # Default test target selection also builds examples such as live_s3_acceptance.
    events = subprocess.check_output(
        [*devkit, "cargo", "test", "--locked", "--offline", "--no-run",
         "--message-format=json-render-diagnostics", *package_flags([*shard["crates"], *anchors])],
        cwd=ROOT,
    )
    tests, linked_dirs = select_binaries(events, selected)
    subprocess.run(
        ["sh", "docker/storage-fixtures/with-storage-fixtures.sh", "exec-custom",
         "sh", "scripts/control-db-fixture.sh", "run",
         *devkit, "sh", "-eu", "-c", RUN_TESTS, "sh",
         str(shard["runs_doc_tests"]).lower(), ":".join(linked_dirs),
         *(arg for test in tests for arg in test)],
        cwd=ROOT, check=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("plan")
    subcommands.add_parser("run").add_argument("shard_id")
    args = parser.parse_args()
    try:
        members = read_members(ROOT)
        manifest = ROOT / "scripts/ci-api-shards.json"
        data = json.loads(manifest.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
        validate_manifest(data, members)
        if args.command == "plan":
            publish_plan(data)
        else:
            run_shard(data, members, args.shard_id)
    except subprocess.CalledProcessError as error:
        sys.exit(f"CI API shards: command failed with status {error.returncode}: {error.cmd[0]}")
    except (ValueError, OSError, KeyError, TypeError) as error:
        sys.exit(f"CI API shards: {error}")


if __name__ == "__main__":
    main()
