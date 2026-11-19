# Managed component registration.
DEVKIT_REGISTERED_APPS := api desktop web
DEVKIT_REGISTERED_PACKAGES := api-contract client
DEVKIT_DESKTOP_APPS := desktop
DEVKIT_PACKAGEABLE_PACKAGES := api-contract
setup-desktop: setup-node-workspace
check-desktop: check/packages/api-contract build/packages/api-contract check/packages/client build/packages/client
test-desktop: build/packages/api-contract build/packages/client
build-desktop: build/packages/api-contract build/packages/client
dev-desktop: build/packages/api-contract build/packages/client
package-desktop: build-desktop
setup-web: setup-node-workspace
check-web: check/packages/api-contract build/packages/api-contract check/packages/client build/packages/client
test-web: build/packages/api-contract build/packages/client
build-web: build/packages/api-contract build/packages/client
dev-web: build/packages/api-contract build/packages/client
setup/packages/api-contract: setup-node-workspace
package/packages/api-contract: build/packages/api-contract
setup/packages/client: setup-node-workspace
check/packages/client: check/packages/api-contract build/packages/api-contract
test/packages/client: build/packages/api-contract
build/packages/client: build/packages/api-contract
DEVKIT_EXPECTED_PLAN := f58c7bfea7df1ace478e0746ef3378d3b648dc4cc123a6f74ed32447fdb54923
