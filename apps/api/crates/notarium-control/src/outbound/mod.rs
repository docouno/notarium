//! One policy boundary for provider and identity-related outbound requests.
pub(crate) mod metadata;
mod policy;
mod resolver;
#[cfg(test)]
pub(crate) mod test_https;
mod transport;
pub use policy::{CheckedEndpoint, NetworkPolicy, OutboundScope, PrivateNetworkRule, ProviderWire};
pub use resolver::GuardedResolver;
pub use transport::{OutboundRequest, OutboundResponse, OutboundTransport};

#[cfg(test)]
pub(crate) static NETWORK_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
