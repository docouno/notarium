# Source-built MinIO Community Edition fixture for offline S3 CAS integration tests.
# Upstream repository https://github.com/minio/minio was archived on 2026-04-25;
# this build pins the final Community release tag RELEASE.2025-10-15T17-29-55Z
# at exact commit 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a (AIStor is not used).
FROM golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac AS build

ARG MINIO_CE_TAG=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_CE_VERSION=2025-10-15T17-29-55Z
ARG MINIO_CE_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
ARG MINIO_CE_TARBALL_SHA256=45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841

WORKDIR /src
RUN set -eux; \
    curl --fail --silent --show-error --location \
      "https://codeload.github.com/minio/minio/tar.gz/${MINIO_CE_COMMIT}" \
      --output /tmp/minio-ce.tar.gz; \
    echo "${MINIO_CE_TARBALL_SHA256}  /tmp/minio-ce.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/minio-ce.tar.gz --strip-components=1 -C /src; \
    rm -f /tmp/minio-ce.tar.gz; \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      go build -trimpath \
      -ldflags "-s -w -X github.com/minio/minio/cmd.Version=${MINIO_CE_VERSION} -X github.com/minio/minio/cmd.ReleaseTag=${MINIO_CE_TAG} -X github.com/minio/minio/cmd.CommitID=${MINIO_CE_COMMIT}" \
      -o /out/minio .

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

LABEL org.opencontainers.image.title="notarium-storage-fixture-minio-ce" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.version="RELEASE.2025-10-15T17-29-55Z" \
      org.opencontainers.image.revision="9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" \
      io.notarium.minio-ce.tarball-sha256="45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841"

COPY --from=build /out/minio /usr/local/bin/minio
ENTRYPOINT ["/usr/local/bin/minio"]
