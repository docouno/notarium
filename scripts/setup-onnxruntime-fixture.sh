#!/bin/sh
set -eu
umask 022

# Extract the official CPU runtime from the SHA-256 pinned release wheel.
# This fixture requires neither a Python installation nor a Cargo download feature.
case "$(uname -m)" in
    x86_64)
        wheel_path=6c/44/1e9e762b95b7da0a8424913a1ed7c38cdaf88624a3c41ddba24ebac88bc9
        wheel_sha=5e129d6c56abd53e659cb70f00a108d6824086470ff99c2e47a82e5786563db3
        lib_sha=21901b1b02233484b80888c16f4f5473742f796bf5528d5d0c4073dbe9802001
        ;;
    aarch64)
        wheel_path=53/1a/561b43ca1536d9e81d1785bb8a1a260a9e314ef6d04976ba0411c652bda1
        wheel_sha=35758d7606d578ec5b9d65f6e8a1f488013194c3f6097038a3223cb26d35ef9a
        lib_sha=b79d2fcf36b8870f4b2da95784a6ad846c47f05511ffa7be409c79a44f9dc9a4
        ;;
    *)
        echo "ONNX Runtime fixture supports x86_64 and aarch64 Linux" >&2
        exit 1
        ;;
esac

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
directory="$repo_root/.artifacts/onnxruntime/current"
library="$directory/libonnxruntime.so"
if [ -f "$library" ] && printf '%s  %s\n' "$lib_sha" "$library" | sha256sum --check --status; then
    exit 0
fi

mkdir -p "$directory"
scratch=$(mktemp -d "$directory/install.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
trap 'exit 1' HUP INT TERM
wheel="onnxruntime-1.31.0-cp312-cp312-manylinux_2_28_$(uname -m).whl"
curl --fail --silent --show-error --location --retry 3 --max-time 120 \
    "https://files.pythonhosted.org/packages/$wheel_path/$wheel" -o "$scratch/$wheel"
printf '%s  %s\n' "$wheel_sha" "$scratch/$wheel" | sha256sum --check
unzip -p "$scratch/$wheel" onnxruntime/capi/libonnxruntime.so.1.31.0 > "$scratch/libonnxruntime.so"
printf '%s  %s\n' "$lib_sha" "$scratch/libonnxruntime.so" | sha256sum --check
mv -f "$scratch/libonnxruntime.so" "$library"
