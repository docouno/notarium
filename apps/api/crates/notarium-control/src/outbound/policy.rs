use crate::error::invalid;
use ipnet::IpNet;
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::ProviderResourceId,
};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::LazyLock,
};
use url::{Host, Url};

const MAX_URL: usize = 2048;
const MAX_DNS_ANSWERS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProviderWire {
    OpenAi,
    Ollama,
}

/// Identities partition pools. Provider dispatch must independently revalidate
/// current database authority, epochs and disclosure consent before each send.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum OutboundScope {
    Provider {
        resource: ProviderResourceId,
        runtime_epoch: u64,
        credential_epoch: Option<u64>,
        wire: ProviderWire,
    },
    Cimd,
    Oidc {
        issuer: String,
    },
}

fn denied() -> PortError {
    DomainError::AccessDenied.into()
}
fn bad_url() -> PortError {
    invalid(ValidationReason::InvalidQuery)
}

fn parse_url(value: &str) -> Result<Url, PortError> {
    if value.is_empty()
        || value.len() > MAX_URL
        || value.bytes().any(|b| b <= 32 || b == 127 || b == b'\\')
    {
        return Err(bad_url());
    }
    let (_, rest) = value.split_once("://").ok_or_else(bad_url)?;
    let authority = rest.split(['/', '?', '#']).next().ok_or_else(bad_url)?;
    if authority.is_empty() || authority.contains('@') || authority.ends_with(':') {
        return Err(bad_url());
    }
    let url = Url::parse(value).map_err(|_| bad_url())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().len() > MAX_URL
        || url.port_or_known_default() == Some(0)
    {
        return Err(bad_url());
    }
    match url.host().ok_or_else(bad_url)? {
        Host::Ipv4(ip) => {
            // WHATWG parsing accepts integer, octal, hex and short IPv4 forms.
            // Require a canonical dotted-decimal authority before normalizing.
            let raw_host = authority.split(':').next().ok_or_else(bad_url)?;
            if raw_host != ip.to_string() {
                return Err(bad_url());
            }
        }
        Host::Ipv6(_) => {
            if !authority.starts_with('[') || authority.contains('%') {
                return Err(bad_url());
            }
        }
        Host::Domain(host) => {
            let host = host.strip_suffix('.').unwrap_or(host);
            if host.is_empty()
                || host.len() > 253
                || host.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
            {
                return Err(bad_url());
            }
        }
    }
    Ok(url)
}

fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        ip => ip,
    }
}
fn networks(values: &[&str]) -> Vec<IpNet> {
    values
        .iter()
        .map(|value| value.parse().expect("fixed network policy prefix"))
        .collect()
}
// IANA IPv4/IPv6 Special-Purpose Address Registries, 2025-10-09. All special
// allocations are excluded, including globally reachable special services.
static SPECIAL: LazyLock<Vec<IpNet>> = LazyLock::new(|| {
    networks(&[
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.31.196.0/24",
        "192.52.193.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "192.175.48.0/24",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "2001::/23",
        "2001:db8::/32",
        "2002::/16",
        "2620:4f:8000::/48",
        "3fff::/20",
    ])
});
static PRIVATE: LazyLock<Vec<IpNet>> = LazyLock::new(|| {
    networks(&[
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "::1/128",
        "fc00::/7",
    ])
});
fn hard_denied(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip == Ipv4Addr::new(168, 63, 129, 16),
        IpAddr::V6(ip) => matches!(
            ip.segments(),
            [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254] | [0xfd20, 0xce, 0, 0, 0, 0, 0, 0x254]
        ),
    }
}
fn public(ip: IpAddr) -> bool {
    if hard_denied(ip) || SPECIAL.iter().any(|prefix| prefix.contains(&ip)) {
        return false;
    }
    match ip {
        IpAddr::V4(_) => true,
        // Only ordinary global unicast is eligible; NAT64, mapped forms,
        // local, multicast, discard and future allocations remain denied.
        IpAddr::V6(ip) => ip.segments()[0] & 0xe000 == 0x2000,
    }
}

#[derive(Clone)]
pub struct PrivateNetworkRule {
    resource: ProviderResourceId,
    origin: String,
    networks: Vec<IpNet>,
}
impl PrivateNetworkRule {
    /// Operator-only configuration. CIDRs must lie wholly within loopback,
    /// RFC1918 or ULA space. Metadata/platform addresses remain hard denied.
    pub fn new(
        resource: ProviderResourceId,
        origin: &str,
        networks: Vec<IpNet>,
    ) -> Result<Self, PortError> {
        let url = parse_url(origin)?;
        if url.path() != "/"
            || url.query().is_some()
            || networks.is_empty()
            || networks.len() > 32
            || networks.iter().any(|network| {
                *network != network.trunc()
                    || !PRIVATE.iter().any(|allowed| {
                        allowed.contains(&network.network())
                            && allowed.contains(&network.broadcast())
                    })
            })
        {
            return Err(bad_url());
        }
        if let Some(ip) = literal(&url) {
            let ip = canonical_ip(ip);
            if hard_denied(ip) || !networks.iter().any(|network| network.contains(&ip)) {
                return Err(bad_url());
            }
        }
        Ok(Self {
            resource,
            origin: url.origin().ascii_serialization(),
            networks,
        })
    }
}

#[derive(Clone, Default)]
pub struct NetworkPolicy {
    rules: Vec<PrivateNetworkRule>,
}
impl NetworkPolicy {
    pub fn new(rules: Vec<PrivateNetworkRule>) -> Result<Self, PortError> {
        if rules.len() > 128
            || rules.iter().enumerate().any(|(index, rule)| {
                rules[..index]
                    .iter()
                    .any(|old| old.resource == rule.resource && old.origin == rule.origin)
            })
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        Ok(Self { rules })
    }
    pub fn endpoint(
        &self,
        scope: OutboundScope,
        value: &str,
    ) -> Result<CheckedEndpoint, PortError> {
        let url = parse_url(value)?;
        let origin = url.origin().ascii_serialization();
        let private = match &scope {
            OutboundScope::Provider {
                resource,
                wire: ProviderWire::Ollama,
                ..
            } => self
                .rules
                .iter()
                .find(|rule| rule.resource == *resource && rule.origin == origin)
                .map(|rule| rule.networks.clone()),
            _ => None,
        };
        if url.scheme() != "https" && private.is_none() {
            return Err(denied());
        }
        if let OutboundScope::Oidc { issuer } = &scope {
            let issuer = parse_url(issuer)?;
            if issuer.scheme() != "https" || issuer.query().is_some() {
                return Err(denied());
            }
            if let Some(ip) = literal(&issuer)
                && !public(canonical_ip(ip))
            {
                return Err(denied());
            }
        }
        let endpoint = CheckedEndpoint {
            scope,
            url,
            origin,
            private,
        };
        if let Some(ip) = literal(&endpoint.url) {
            endpoint.addresses([SocketAddr::new(ip, 0)])?;
        }
        Ok(endpoint)
    }
}
fn literal(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
        Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
        Host::Domain(_) => None,
    }
}

/// Only NetworkPolicy can create this value. Cloning it does not attest current
/// provider consent; it holds URL and address rules for the connector itself.
#[derive(Clone)]
pub struct CheckedEndpoint {
    pub(super) scope: OutboundScope,
    pub(super) url: Url,
    pub(super) origin: String,
    private: Option<Vec<IpNet>>,
}
impl CheckedEndpoint {
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn url(&self) -> &Url {
        &self.url
    }
    pub fn scope(&self) -> &OutboundScope {
        &self.scope
    }
    /// Validate the whole answer before returning any candidate. Resolver ports
    /// are discarded: the checked URL's port is the sole connection authority.
    pub fn addresses(
        &self,
        values: impl IntoIterator<Item = SocketAddr>,
    ) -> Result<Vec<SocketAddr>, PortError> {
        let mut checked = Vec::new();
        for (index, address) in values.into_iter().enumerate() {
            if index >= MAX_DNS_ANSWERS {
                return Err(denied());
            }
            let ip = canonical_ip(address.ip());
            let allowed = !hard_denied(ip)
                && match &self.private {
                    Some(networks) => networks.iter().any(|network| network.contains(&ip)),
                    None => public(ip),
                };
            if !allowed || matches!(address, SocketAddr::V6(v6) if v6.scope_id() != 0) {
                return Err(denied());
            }
            let address = SocketAddr::new(ip, 0);
            if !checked.contains(&address) {
                checked.push(address);
            }
        }
        if checked.is_empty() {
            return Err(denied());
        }
        Ok(checked)
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
