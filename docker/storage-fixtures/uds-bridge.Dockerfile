# Pure-std Rust Unix-to-TCP bridge for the isolated S3 integration fixture.
FROM rust:1.99.1-slim-bookworm@sha256:86234e857a413004348b471d11a4ebe1aa92d2eae2b6b143cac68fd1ac3c48be AS build

WORKDIR /src
COPY docker/storage-fixtures/uds_tcp_bridge.rs ./uds_tcp_bridge.rs
RUN rustc --edition=2024 -O ./uds_tcp_bridge.rs -o /usr/local/bin/uds-tcp-bridge

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

LABEL org.opencontainers.image.title="notarium-storage-fixture-uds-bridge"
COPY --from=build /usr/local/bin/uds-tcp-bridge /usr/local/bin/uds-tcp-bridge
ENTRYPOINT ["/usr/local/bin/uds-tcp-bridge"]
