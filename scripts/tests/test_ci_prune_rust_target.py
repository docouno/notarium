import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "ci-prune-rust-target.py"
CONTAINER_TARGET = "/workspace/apps/api/target"
STAMP = ".notarium-vendor-pulldown-cmark.sha256"
LIVE = "1" * 16
DEAD = "2" * 16
BUILD = "3" * 16
RUN = "4" * 16
WORKSPACE = "5" * 16
VENDOR = "6" * 16
CORE_ID = "path+file:///workspace/apps/api/crates/notarium-core#0.1.0"


class TargetCacheTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.target = self.root / "target"
        self.vendor = self.root / "vendor" / "pulldown-cmark"
        self.metadata = self.root / "metadata.json"
        self.events = self.root / "events.jsonl"
        self.metadata.write_text(json.dumps({
            "target_directory": CONTAINER_TARGET,
            "workspace_members": [CORE_ID],
            "packages": [{
                "id": CORE_ID,
                "name": "notarium-core",
                "targets": [
                    {"name": "notarium_core", "kind": ["lib"]},
                    {"name": "notarium-sidecar", "kind": ["bin"]},
                    {"name": "keyring", "kind": ["test"]},
                ],
            }],
        }))
        self.put("CACHEDIR.TAG")
        self.source = self.put("src/lib.rs", at=self.vendor)
        self.write_events(
            {"reason": "compiler-artifact", "package_id": "external-keyring",
             "filenames": [f"{CONTAINER_TARGET}/debug/deps/libkeyring-{LIVE}.rlib"],
             "executable": None},
            {"reason": "compiler-artifact", "package_id": "external-zstd-sys",
             "filenames": [f"{CONTAINER_TARGET}/debug/build/zstd-sys-{BUILD}/build-script-build"],
             "executable": None},
            {"reason": "build-script-executed", "package_id": "external-zstd-sys",
             "out_dir": f"{CONTAINER_TARGET}/debug/build/zstd-sys-{RUN}/out"},
            {"reason": "compiler-artifact", "package_id": CORE_ID,
             "filenames": [f"{CONTAINER_TARGET}/debug/deps/keyring-{WORKSPACE}"],
             "executable": f"{CONTAINER_TARGET}/debug/deps/keyring-{WORKSPACE}"},
            {"reason": "build-finished", "success": True},
        )

    def write_events(self, *events):
        self.events.write_text("".join(json.dumps(event) + "\n" for event in events))

    def put(self, relative, *, at=None):
        path = (at or self.target) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"cache test data")
        return path

    def invoke(self, *arguments):
        return subprocess.run(
            [sys.executable, SCRIPT, "--target-dir", self.target, *arguments],
            capture_output=True, text=True,
        )

    def prune(self, *arguments):
        return self.invoke("--metadata", self.metadata, "--cargo-events", self.events, *arguments)

    def stabilize(self):
        return self.invoke("--stabilize-vendor-mtime", self.vendor)

    def test_keeps_live_dependencies_and_both_build_script_units(self):
        keep = [
            self.put(f"debug/deps/libkeyring-{LIVE}.rlib"),
            self.put(f"debug/deps/keyring-{LIVE}.d"),
            self.put(f"debug/.fingerprint/keyring-{LIVE}/lib-keyring"),
            self.put(f"debug/build/zstd-sys-{BUILD}/build-script-build"),
            self.put(f"debug/build/zstd-sys-{RUN}/out/libzstd.a"),
            self.put(f"debug/.fingerprint/zstd-sys-{BUILD}/build-script-build"),
            self.put(f"debug/.fingerprint/zstd-sys-{RUN}/run-build-script-build"),
            self.put(".rustc_info.json"),
            self.put("debug/.cargo-lock"),
            self.put(STAMP),
        ]
        remove = [
            self.put(f"debug/deps/libnotarium_core-{WORKSPACE}.rlib"),
            self.put(f"debug/deps/keyring-{WORKSPACE}"),
            self.put(f"debug/.fingerprint/notarium-core-{WORKSPACE}/lib-notarium_core"),
            self.put(f"debug/deps/libkeyring-{DEAD}.rlib"),
            self.put("debug/deps/rmetaLeftover/lib.rmeta"),
            self.put(f"debug/.fingerprint/keyring-{DEAD}/lib-keyring"),
            self.put(f"debug/build/zstd-sys-{DEAD}/out/libzstd.a"),
            self.put("debug/notarium-sidecar"),
            self.put("debug/notarium-sidecar.d"),
            self.put("debug/libnotarium_core.rlib"),
            self.put("debug/libnotarium_core.d"),
            self.put("debug/examples/probe"),
            self.put("debug/incremental/cache"),
            self.put("tmp/test-output"),
            self.put("control-tests/state.sqlite"),
            self.put("backup-latency-sqlite.json"),
        ]
        before = {path: path.read_bytes() for path in keep}
        dry_run = self.prune("--dry-run")
        self.assertEqual(dry_run.returncode, 0, dry_run.stderr)
        self.assertTrue(all(path.exists() for path in remove))
        result = self.prune()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["removed_files"], len(remove))
        self.assertEqual(json.loads(result.stdout)["live_external_hashes"], 3)
        self.assertEqual({path: path.read_bytes() for path in keep}, before)
        self.assertTrue(all(not path.exists() for path in remove))

    def test_vendor_stamp_controls_mtime_and_invalidation(self):
        result = self.prune("--vendor-dir", self.vendor)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len((self.target / STAMP).read_text().strip()), 64)
        os.utime(self.source, (1_800_000_000, 1_800_000_000))
        cached = [
            self.put(f"debug/deps/libpulldown_cmark-{VENDOR}.rlib"),
            self.put(f"debug/deps/pulldown_cmark-{VENDOR}.d"),
            self.put(f"debug/.fingerprint/pulldown-cmark-{VENDOR}/lib-pulldown_cmark"),
            self.put(f"debug/build/pulldown-cmark-{VENDOR}/out/state"),
            self.put("debug/libpulldown_cmark.rlib"),
        ]
        adjacent = [
            self.put(f"debug/deps/libpulldown_cmark_escape-{LIVE}.rlib"),
            self.put(f"debug/.fingerprint/pulldown-cmark-escape-{LIVE}/lib-pulldown_cmark_escape"),
        ]
        result = self.stabilize()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.source.stat().st_mtime, 1_700_000_000)
        self.assertTrue(all(path.exists() for path in cached))
        self.source.write_bytes(b"new vendor code")
        os.utime(self.source, (1_800_000_000, 1_800_000_000))
        result = self.stabilize()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.source.stat().st_mtime, 1_800_000_000)
        self.assertFalse((self.target / STAMP).exists())
        self.assertTrue(all(not path.exists() for path in cached))
        self.assertTrue(all(path.exists() for path in adjacent))

    def test_rejects_partial_recording_without_removing_files(self):
        victim = self.put("debug/incremental/cache")
        complete = self.events.read_text()
        self.events.write_text(complete.rsplit("\n", 2)[0] + "\n")
        result = self.prune()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("successful full workspace build", result.stderr)
        self.assertTrue(victim.exists())
        self.events.write_text("")
        self.assertNotEqual(self.prune().returncode, 0)
        self.assertTrue(victim.exists())

    def test_rejects_oversize_cache_without_removing_files(self):
        victim = self.put("debug/incremental/cache")
        self.put(f"debug/deps/libkeyring-{LIVE}.rlib")
        result = self.prune("--max-bytes", "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("would exceed --max-bytes", result.stderr)
        self.assertIn(f"libkeyring-{LIVE}.rlib", result.stderr)
        self.assertTrue(victim.exists())

    def test_rejects_non_cargo_directories(self):
        (self.target / "CACHEDIR.TAG").unlink()
        victim = self.put("tmp/unrelated-file")
        result = self.prune()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected a Cargo target directory", result.stderr)
        self.assertEqual(victim.read_bytes(), b"cache test data")


if __name__ == "__main__":
    unittest.main()
