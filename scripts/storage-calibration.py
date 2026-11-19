"""Run the Linux durable append and local CAS calibration on the selected data volume."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import statistics
import subprocess
import tempfile
import time


def disk_probe(directory):
    sizes = (4096, 262144)
    rng = random.Random(466)
    blocks = {n: rng.randbytes(n) for n in sizes}
    samples = {n: [] for n in sizes}
    with tempfile.NamedTemporaryFile(dir=directory) as stream:
        for round_index in range(32 + 320):
            for size in sizes if round_index % 2 == 0 else reversed(sizes):
                start = time.perf_counter_ns()
                written = os.write(stream.fileno(), blocks[size])
                if written != size:
                    raise OSError(f"short append: {written} of {size} bytes")
                os.fdatasync(stream.fileno())
                elapsed = time.perf_counter_ns() - start
                if round_index >= 32:
                    samples[size].append(elapsed)
    metrics = {}
    for size, values in samples.items():
        ordered = sorted(values)
        metrics[size] = {
            "input_sha256": hashlib.sha256(blocks[size]).hexdigest(),
            "samples_ns": values,
            "p50_ms": statistics.median(ordered) / 1e6,
            "p95_ms": ordered[math.ceil(0.95 * len(ordered)) - 1] / 1e6,
            "p99_ms": ordered[math.ceil(0.99 * len(ordered)) - 1] / 1e6,
        }
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("codec_binary", type=Path, help="release storage_codec_probe executable")
    parser.add_argument("data_volume", type=Path, help="existing directory on the database mount")
    args = parser.parse_args()
    binary = args.codec_binary.resolve(strict=True)
    directory = args.data_volume.resolve(strict=True)
    binary_sha = hashlib.sha256(binary.read_bytes()).hexdigest()
    disk = disk_probe(directory)
    codec = json.loads(subprocess.check_output([binary]))
    codec["median_us_per_document"] = statistics.median(codec["batch_ns"]) / codec["items_per_batch"] / 1000
    print(json.dumps({
        "format": "storage_calibration_v1",
        "data_directory": str(directory),
        "filesystem_device": directory.stat().st_dev,
        "codec_binary_sha256": binary_sha,
        "driver_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "codec": codec,
        "append_fdatasync": disk,
    }, indent=2))


if __name__ == "__main__":
    main()
