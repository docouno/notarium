FROM rust:1.99.1-slim-bookworm@sha256:86234e857a413004348b471d11a4ebe1aa92d2eae2b6b143cac68fd1ac3c48be AS build
WORKDIR /build
COPY apps/api/ ./
ARG CARGO_BUILD_JOBS=4
RUN cargo build --locked --release --package notarium-bin --bin notariumd --jobs ${CARGO_BUILD_JOBS}

FROM debian:bookworm-slim
RUN groupadd --gid 1000 notarium && useradd --uid 1000 --gid 1000 --no-create-home notarium
COPY --from=build /build/target/release/notariumd /usr/local/bin/notariumd
USER 1000:1000
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/notariumd"]
