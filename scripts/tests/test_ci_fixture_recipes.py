import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path("docker/storage-fixtures")


class FixtureRecipeTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        shutil.copytree(ROOT / FIXTURES, self.root / FIXTURES)
        shutil.copyfile(ROOT / "compose.storage-tests.yaml", self.root / "compose.storage-tests.yaml")
        (self.root / ".dockerignore").write_text(".git\n")

    def tags(self):
        script = self.root / FIXTURES / "with-storage-fixtures.sh"
        output = subprocess.check_output(["sh", script, "fixture-images"], text=True)
        minio, bridge = output.splitlines()
        self.assertRegex(minio, r"^notarium-storage-fixture-minio-ce:[a-f0-9]{64}$")
        self.assertRegex(bridge, r"^notarium-storage-fixture-uds-bridge:[a-f0-9]{64}$")
        return minio, bridge

    def test_different_bridge_recipes_can_coexist(self):
        minio, bridge = self.tags()
        source = self.root / FIXTURES / "uds_tcp_bridge.rs"
        original = source.read_bytes()
        source.write_bytes(original + b"\n")
        other_minio, other_bridge = self.tags()
        self.assertEqual(minio, other_minio)
        self.assertNotEqual(bridge, other_bridge)
        source.write_bytes(original)
        self.assertEqual(self.tags(), (minio, bridge))

    def test_cache_tracks_the_effective_docker_ignore_file(self):
        minio, bridge = self.tags()
        root_ignore = self.root / ".dockerignore"
        root_ignore.write_text("*.rs\n")
        changed_minio, changed_bridge = self.tags()
        self.assertNotEqual(minio, changed_minio)
        self.assertNotEqual(bridge, changed_bridge)
        bridge_ignore = self.root / FIXTURES / "uds-bridge.Dockerfile.dockerignore"
        bridge_ignore.write_text("# Include the bridge source.\n")
        specific_minio, specific_bridge = self.tags()
        self.assertEqual(specific_minio, changed_minio)
        self.assertNotEqual(changed_bridge, specific_bridge)
        root_ignore.unlink()
        self.assertEqual(self.tags()[1], specific_bridge)
        bridge_ignore.write_text("*.rs\n")
        self.assertNotEqual(self.tags()[1], specific_bridge)
