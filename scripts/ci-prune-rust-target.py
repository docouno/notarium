"""Prepare a Cargo dev/test cache using artifacts reported by successful builds."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys


MAX_BYTES = 2 * 1024 * 1024 * 1024
VENDOR_MTIME = 1_700_000_000
VENDOR_STAMP = ".notarium-vendor-pulldown-cmark.sha256"
LIB_KINDS = {"lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"}
LIB_SUFFIXES = (".rlib", ".rmeta", ".so", ".a", ".d")
UNIT_NAME = re.compile(r"(.+)-([0-9a-f]{16})")
DEP_NAME = re.compile(r"(.+)-([0-9a-f]{16})(?:\..+)?")


def entries(directory):
    if directory.is_symlink():
        raise ValueError(f"unexpected symlink directory: {directory}")
    if not directory.exists():
        return []
    return sorted(directory.iterdir())


def files(directory):
    for entry in entries(directory):
        mode = entry.lstat().st_mode
        if stat.S_ISDIR(mode):
            yield from files(entry)
        else:
            yield entry


def vendor_snapshot(vendor):
    paths = sorted(files(vendor))
    if not paths:
        raise ValueError(f"no vendor files found in {vendor}")
    digest = hashlib.sha256()
    for path in paths:
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError(f"expected a regular vendor file: {path}")
        # Frame paths and content independently to hash unambiguously.
        relative = os.fsencode(path.relative_to(vendor).as_posix())
        digest.update(relative + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest() + "\n", paths


def remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def stabilize_vendor(vendor, target):
    digest, paths = vendor_snapshot(vendor)
    entries(target)
    stamp = target / VENDOR_STAMP
    if stamp.is_file() and not stamp.is_symlink() and stamp.read_text() == digest:
        for path in paths:
            os.utime(path, (path.stat().st_atime, VENDOR_MTIME), follow_symlinks=False)
        print("Restored Cargo mtimes for the matching pulldown-cmark source.")
        return

    # Keep checkout mtimes on misses, and invalidate the vendored crate even if
    # the checkout timestamp predates the restored cache's Cargo fingerprints.
    debug = target / "debug"
    aliases = {"libpulldown_cmark" + suffix for suffix in LIB_SUFFIXES}
    stale = [path for path in entries(debug) if path.name in aliases]
    stale.extend(
        path for path in entries(debug / "deps")
        if (match := DEP_NAME.fullmatch(path.name))
        and match[1] in {"pulldown_cmark", "libpulldown_cmark"}
    )
    for directory in (debug / "build", debug / ".fingerprint"):
        stale.extend(
            path for path in entries(directory)
            if (match := UNIT_NAME.fullmatch(path.name)) and match[1] == "pulldown-cmark"
        )
    remove(stamp)
    for path in stale:
        remove(path)
    print("Kept checkout mtimes and invalidated any cached pulldown-cmark artifacts.")


def workspace_targets(metadata):
    members = metadata["workspace_members"]
    packages = {pkg["id"]: pkg for pkg in metadata["packages"]}
    member_ids = set(members)
    if (
        not member_ids
        or len(member_ids) != len(members)
        or len(packages) != len(metadata["packages"])
        or not member_ids <= packages.keys()
    ):
        raise ValueError("Cargo metadata has inconsistent workspace membership")
    aliases = set()
    for member in members:
        for target in packages[member]["targets"]:
            raw = target["name"]
            stem = raw.replace("-", "_")
            for name in (raw, stem):
                aliases.update(name + suffix for suffix in ("", ".d", ".pdb", ".exe"))
            if LIB_KINDS.intersection(target["kind"]):
                aliases.update("lib" + stem + suffix for suffix in LIB_SUFFIXES)
    return member_ids, aliases


def external_hashes(events, cargo_target, members):
    live = set()
    last_reason = None
    covered = set()
    with events.open() as stream:
        for line in stream:
            if not line.strip():
                continue
            event = json.loads(line)
            last_reason = event["reason"]
            if last_reason == "build-finished" and event["success"] is not True:
                raise ValueError("Cargo reported an unsuccessful build")
            if last_reason == "compiler-artifact":
                outputs = event["filenames"] + [event["executable"]]
            elif last_reason == "build-script-executed":
                outputs = [event["out_dir"]]
            else:
                continue
            if event["package_id"] in members:
                if last_reason == "compiler-artifact":
                    covered.add(event["package_id"])
                continue
            for output in filter(None, outputs):
                path = PurePosixPath(output)
                if not path.is_relative_to(cargo_target):
                    continue
                parts = path.relative_to(cargo_target).parts
                if len(parts) < 3 or parts[0] != "debug":
                    continue
                if parts[1] == "deps":
                    match = DEP_NAME.fullmatch(parts[2])
                elif parts[1] == "build":
                    match = UNIT_NAME.fullmatch(parts[2])
                else:
                    continue
                if match:
                    live.add(match[2])
    if not live or last_reason != "build-finished" or covered != members:
        raise ValueError("expected Cargo events from a successful full workspace build")
    return live


def pruning_candidates(target, aliases, live):
    debug = target / "debug"
    candidates = {target / "tmp", target / "control-tests", debug / "incremental", debug / "examples"}
    candidates.update(target.glob("backup-latency-*.json"))
    candidates.update(path for path in entries(debug) if path.name in aliases)
    # Hashes belong to Cargo units. Matching a test's name here would also
    # remove the dep-info for a live external library with the same name.
    for directory in (debug / "deps", debug / "build", debug / ".fingerprint"):
        pattern = DEP_NAME if directory.name == "deps" else UNIT_NAME
        for path in entries(directory):
            match = pattern.fullmatch(path.name)
            if not match or match[2] not in live or path.name.endswith(".dSYM"):
                candidates.add(path)
    return candidates


def prune(args):
    target = args.target_dir
    debug = target / "debug"
    for directory in (target, debug):
        entries(directory)
    if not ((target / "CACHEDIR.TAG").is_file() or debug.is_dir()):
        raise ValueError(f"expected a Cargo target directory: {target}")
    metadata = json.loads(args.metadata.read_text())
    members, aliases = workspace_targets(metadata)
    live = external_hashes(args.cargo_events, PurePosixPath(metadata["target_directory"]), members)
    candidates = pruning_candidates(target, aliases, live)
    stamp = target / VENDOR_STAMP
    digest = vendor_snapshot(args.vendor_dir)[0] if args.vendor_dir else None

    removed = {}
    remaining = {}
    for path in files(target):
        size = path.lstat().st_size
        if path in candidates or not candidates.isdisjoint(path.parents):
            removed[path] = size
        else:
            remaining[path] = size
    if digest is not None:
        remaining[stamp] = len(digest)
    remaining_bytes = sum(remaining.values())
    print(json.dumps({
        "removed_files": len(removed),
        "removed_bytes": sum(removed.values()),
        "remaining_files": len(remaining),
        "remaining_bytes": remaining_bytes,
        "workspace_members": len(members),
        "live_external_hashes": len(live),
        "dry_run": args.dry_run,
    }))
    if remaining_bytes > args.max_bytes:
        for path in sorted(remaining, key=remaining.get, reverse=True)[:10]:
            print(f"{remaining[path]:>12}  {path}", file=sys.stderr)
        raise ValueError(f"pruned cache would exceed --max-bytes ({args.max_bytes})")
    if not args.dry_run:
        for path in sorted(candidates):
            remove(path)
        if digest is not None:
            stamp.unlink(missing_ok=True)
            stamp.write_text(digest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-dir", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--metadata", type=Path, help="cargo metadata --no-deps JSON")
    mode.add_argument("--stabilize-vendor-mtime", type=Path, metavar="VENDOR_DIR")
    parser.add_argument("--cargo-events", type=Path, help="Cargo build events as NDJSON")
    parser.add_argument("--vendor-dir", type=Path, help="vendor source to fingerprint before saving")
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.metadata and not args.cargo_events:
        parser.error("--metadata requires --cargo-events")
    if args.stabilize_vendor_mtime and (args.cargo_events or args.vendor_dir or args.dry_run):
        parser.error("pruning options cannot be used with --stabilize-vendor-mtime")
    if args.max_bytes <= 0:
        parser.error("--max-bytes must be positive")
    try:
        if args.stabilize_vendor_mtime:
            stabilize_vendor(args.stabilize_vendor_mtime, args.target_dir)
        else:
            prune(args)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"ci-prune-rust-target: {error}\n")


if __name__ == "__main__":
    main()
