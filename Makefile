include .devkit/runtime/devkit.mk

# Add a disposable, socket-only PostgreSQL fixture around the pinned API runner.
devkit_loader := scripts/devkit-with-control-db.sh

# Process tests and desktop packaging consume standalone debug binaries.
# API setup prepares digest-pinned PostgreSQL 16 and source-built MinIO CE fixtures;
# API tests execute offline against ephemeral Unix domain socket fixtures.
setup-api: setup-storage-fixtures setup-onnxruntime-fixture
test-api: build-api
test-api: devkit_loader := docker/storage-fixtures/with-storage-fixtures.sh
package-desktop: build-api

.PHONY: setup-storage-fixtures setup-onnxruntime-fixture benchmark-search
setup-storage-fixtures:
	@sh docker/storage-fixtures/with-storage-fixtures.sh setup-images

setup-onnxruntime-fixture:
	@sh scripts/setup-onnxruntime-fixture.sh

benchmark-search:
	@set -eu; tree=working-tree; \
	if git diff --quiet HEAD && test -z "$$(git ls-files --others --exclude-standard)"; then \
	  tree=$$(git rev-parse 'HEAD^{tree}'); \
	fi; \
	cpu=$$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || true); \
	memory=$$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true); \
	sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
	  cargo run --quiet --locked --offline --release -p notarium-search \
	    --example scale_100k_400k_gate -- --tree "$$tree" --host-cpu "$$cpu" --host-memory "$$memory"

.PHONY: contract-sync
contract-sync:
	@mkdir -p .artifacts/contract-sync
	@set -eu; raw=$$(mktemp .artifacts/contract-sync/raw.XXXXXX); \
	output=$$(mktemp .artifacts/contract-sync/openapi.XXXXXX); \
	trap 'rm -f "$$raw" "$$output"' EXIT HUP INT TERM; \
	sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
	  cargo run --quiet --locked --offline --package notarium-http --example openapi > "$$raw"; \
	sh .devkit/runtime/devkit.sh cli exec --component packages/api-contract --network none -- \
	  pnpm exec prettier --parser json --config prettier.config.mjs "/workspace/$$raw" > "$$output"; \
	chmod 644 "$$output"; \
	mv "$$output" packages/api-contract/openapi.v1.json
