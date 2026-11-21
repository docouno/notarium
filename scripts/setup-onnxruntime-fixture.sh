#!/bin/sh
set -eu
umask 022

# Extract the official CPU runtime from the SHA-256 pinned release wheel.
# This fixture requires neither a Python installation nor a Cargo download feature.
os=$(uname -s)
arch=$(uname -m)
case "$os:$arch" in
    Linux:x86_64)
        wheel_path=6c/44/1e9e762b95b7da0a8424913a1ed7c38cdaf88624a3c41ddba24ebac88bc9
        wheel_sha=5e129d6c56abd53e659cb70f00a108d6824086470ff99c2e47a82e5786563db3
        lib_sha=21901b1b02233484b80888c16f4f5473742f796bf5528d5d0c4073dbe9802001
        ;;
    Linux:aarch64)
        wheel_path=53/1a/561b43ca1536d9e81d1785bb8a1a260a9e314ef6d04976ba0411c652bda1
        wheel_sha=35758d7606d578ec5b9d65f6e8a1f488013194c3f6097038a3223cb26d35ef9a
        lib_sha=b79d2fcf36b8870f4b2da95784a6ad846c47f05511ffa7be409c79a44f9dc9a4
        ;;
    *)
        echo "ONNX Runtime fixture supports Linux x86_64 and aarch64 (found $os $arch)" >&2
        exit 1
        ;;
esac

reject_symlink() {
    if [ -L "$1" ]; then
        echo "Refusing symlink path in ONNX Runtime fixture: $1" >&2
        exit 1
    fi
}

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifacts_dir="$repo_root/.artifacts"
ort_dir="$artifacts_dir/onnxruntime"
directory="$ort_dir/current"
library="$directory/libonnxruntime.so"
reject_symlink "$artifacts_dir"
reject_symlink "$ort_dir"
reject_symlink "$directory"
reject_symlink "$library"

if [ -f "$library" ] && printf '%s  %s\n' "$lib_sha" "$library" | sha256sum --check --status; then
    exit 0
fi

mkdir -p "$directory"
reject_symlink "$directory"
scratch=$(mktemp -d "$directory/install.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
trap 'exit 1' HUP INT TERM

cache_lib=""
if [ -n "${DEVKIT_CACHE_DIR:-}" ] && [ ! -L "$DEVKIT_CACHE_DIR" ] && [ -d "$DEVKIT_CACHE_DIR" ]; then
    cache_root="$DEVKIT_CACHE_DIR/onnxruntime"
    cache_ver="$cache_root/1.31.0"
    cache_dir="$cache_ver/$arch"
    if [ ! -L "$cache_root" ] && [ ! -L "$cache_ver" ] && [ ! -L "$cache_dir" ]; then
        candidate="$cache_dir/libonnxruntime.so"
        if [ ! -L "$candidate" ] && [ -f "$candidate" ] \
            && printf '%s  %s\n' "$lib_sha" "$candidate" | sha256sum --check --status; then
            cp "$candidate" "$scratch/libonnxruntime.so"
            printf '%s  %s\n' "$lib_sha" "$scratch/libonnxruntime.so" | sha256sum --check --status
            chmod 0644 "$scratch/libonnxruntime.so"
            mv -f "$scratch/libonnxruntime.so" "$library"
            exit 0
        fi
        cache_lib="$candidate"
    fi
fi

wheel="onnxruntime-1.31.0-cp312-cp312-manylinux_2_28_$arch.whl"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 --max-time 120 \
    "https://files.pythonhosted.org/packages/$wheel_path/$wheel" -o "$scratch/$wheel"
printf '%s  %s\n' "$wheel_sha" "$scratch/$wheel" | sha256sum --check
unzip -p "$scratch/$wheel" onnxruntime/capi/libonnxruntime.so.1.31.0 > "$scratch/libonnxruntime.so"
printf '%s  %s\n' "$lib_sha" "$scratch/libonnxruntime.so" | sha256sum --check
chmod 0644 "$scratch/libonnxruntime.so"

if [ -n "$cache_lib" ]; then
    cache_dir=$(dirname -- "$cache_lib")
    if mkdir -p "$cache_dir" 2>/dev/null && [ ! -L "$cache_dir" ] && [ ! -L "$cache_lib" ]; then
        if cache_tmp=$(mktemp "$cache_dir/libonnxruntime.so.XXXXXXXX" 2>/dev/null); then
            if cp "$scratch/libonnxruntime.so" "$cache_tmp" 2>/dev/null; then
                chmod 0644 "$cache_tmp" 2>/dev/null || true
                mv -f "$cache_tmp" "$cache_lib" 2>/dev/null || rm -f "$cache_tmp"
            else
                rm -f "$cache_tmp"
            fi
        fi
    fi
fi

mv -f "$scratch/libonnxruntime.so" "$library"
