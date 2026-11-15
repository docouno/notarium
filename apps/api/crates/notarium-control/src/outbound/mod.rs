//! One policy boundary for provider and identity-related outbound requests.
mod policy;
mod resolver;
mod transport;
pub use policy::{CheckedEndpoint, NetworkPolicy, OutboundScope, PrivateNetworkRule, ProviderWire};
pub use resolver::GuardedResolver;
pub use transport::{OutboundRequest, OutboundResponse, OutboundTransport};

#[cfg(test)]
static NETWORK_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
