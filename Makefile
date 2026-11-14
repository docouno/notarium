include .devkit/runtime/devkit.mk

# Process tests and desktop packaging consume standalone debug binaries.
test-api: build-api
package-desktop: build-api

# Starter clients use the development API until product lifecycles are added.
dev-web dev-desktop: dev-api

.PHONY: contract-sync
contract-sync:
	@mkdir -p .artifacts/contract-sync
	@set -eu; raw=$$(mktemp .artifacts/contract-sync/raw.XXXXXX); \
	output=$$(mktemp .artifacts/contract-sync/openapi.XXXXXX); \
	trap 'rm -f "$$raw" "$$output"' EXIT HUP INT TERM; \
	sh .devkit/runtime/devkit.sh cli exec --component apps/api --network none -- \
	  cargo run --quiet --locked --offline --package notarium-http --example openapi > "$$raw"; \
	sh .devkit/runtime/devkit.sh cli exec --component packages/api-contract --network none -- \
	  npm exec --offline -- prettier --parser json --config prettier.config.mjs "/workspace/$$raw" > "$$output"; \
	chmod 644 "$$output"; \
	mv "$$output" packages/api-contract/openapi.v1.json
