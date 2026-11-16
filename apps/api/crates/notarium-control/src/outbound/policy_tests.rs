use super::*;

fn provider(number: u8, wire: ProviderWire) -> OutboundScope {
    OutboundScope::Provider {
        resource: ProviderResourceId::from_bytes([number; 16]),
        runtime_epoch: 1,
        credential_epoch: None,
        wire,
    }
}
fn answer(ip: &str) -> [SocketAddr; 1] {
    [SocketAddr::new(ip.parse().unwrap(), 1234)]
}
fn private() -> NetworkPolicy {
    NetworkPolicy::new(vec![
        PrivateNetworkRule::new(
            ProviderResourceId::from_bytes([1; 16]),
            "http://local.example:11434",
            ["127.0.0.0/8", "10.0.0.0/8", "fc00::/7"]
                .into_iter()
                .map(|net| net.parse().unwrap())
                .collect(),
        )
        .unwrap(),
    ])
    .unwrap()
}

#[test]
fn public_policy_denies_special_addresses_and_the_whole_mixed_dns_answer() {
    let policy = NetworkPolicy::default();
    let endpoint = policy
        .endpoint(OutboundScope::Cimd, "https://client.example/metadata")
        .unwrap();
    for ip in [
        "0.0.0.0",
        "0.1.2.3",
        "10.0.0.1",
        "100.64.0.1",
        "100.127.255.255",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.0.0.9",
        "192.0.2.1",
        "192.31.196.1",
        "192.52.193.1",
        "192.88.99.2",
        "192.168.1.1",
        "192.175.48.1",
        "198.18.0.1",
        "198.19.255.255",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "239.255.255.255",
        "240.0.0.1",
        "255.255.255.255",
        "168.63.129.16",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::808:808",
        "64:ff9b:1::1",
        "100::1",
        "100:0:0:1::1",
        "2001::1",
        "2001:3::1",
        "2001:20::1",
        "2001:db8::1",
        "2002::1",
        "2620:4f:8000::1",
        "3fff::1",
        "3fff:fff::1",
        "5f00::1",
        "fc00::1",
        "fd00:ec2::254",
        "fd20:ce::254",
        "fe80::1",
        "ff02::1",
    ] {
        assert!(endpoint.addresses(answer(ip)).is_err(), "must deny {ip}");
        let host = if ip.contains(':') {
            format!("[{ip}]")
        } else {
            ip.into()
        };
        assert!(
            policy
                .endpoint(OutboundScope::Cimd, &format!("https://{host}/"))
                .is_err(),
            "literal must deny {ip}"
        );
        assert!(
            endpoint
                .addresses([answer("8.8.8.8")[0], answer(ip)[0]])
                .is_err(),
            "mixed answer must deny {ip}"
        );
    }
    for ip in [
        "8.8.8.8",
        "1.1.1.1",
        "192.0.1.1",
        "172.32.0.1",
        "2001:4860:4860::8888",
        "2606:4700:4700::1111",
        "::ffff:8.8.8.8",
    ] {
        let addresses = endpoint.addresses(answer(ip)).unwrap();
        assert_eq!(addresses[0].port(), 0);
        assert_eq!(addresses[0].ip(), canonical_ip(ip.parse().unwrap()));
    }
    assert!(endpoint.addresses([]).is_err());
    assert!(
        endpoint
            .addresses(std::iter::repeat_n(answer("8.8.8.8")[0], 33))
            .is_err()
    );
}

#[test]
fn urls_reject_parser_ambiguity_and_keep_idna_and_origin_identity() {
    let policy = NetworkPolicy::default();
    for value in [
        "https://2130706433/",
        "https://0177.0.0.1/",
        "https://127.1/",
        "https://0x7f000001/",
        "https://127.0.0.1./",
        "https://134744072/",
        "https://8.8.8.008/",
        " https://public.example/",
        "https://pub\tlic.example/",
        "https://public.example\\@private/",
        "https://user@public.example/",
        "https://@public.example/",
        "https://:password@public.example/",
        "https://public.example/#",
        "https://public.example/#fragment",
        "http://public.example/",
        "https://public.example:/",
        "https://public.example:0/",
        "https://public.example:65536/",
        "https://[fe80::1%25eth0]/",
        "https://*.example/",
        "https://public..example/",
        "https://-bad.example/",
        "https:///public.example/",
        "//public.example/",
        "file:///etc/hosts",
    ] {
        assert!(
            policy.endpoint(OutboundScope::Cimd, value).is_err(),
            "must reject {value}"
        );
    }
    let endpoint = policy
        .endpoint(OutboundScope::Cimd, "HTTPS://BÜCHER.example:443/path?q=x")
        .unwrap();
    assert_eq!(endpoint.origin(), "https://xn--bcher-kva.example");
    assert_eq!(endpoint.url().path(), "/path");
    assert!(
        policy
            .endpoint(
                OutboundScope::Cimd,
                &format!("https://public.example/{}", "x".repeat(2048))
            )
            .is_err()
    );
}

#[test]
fn operator_exception_is_exact_resource_origin_and_ollama_only_with_metadata_denials() {
    let policy = private();
    let endpoint = policy
        .endpoint(
            provider(1, ProviderWire::Ollama),
            "http://local.example:11434/api/chat",
        )
        .unwrap();
    for ip in ["127.0.0.1", "10.42.0.1", "fd42::1", "::ffff:10.42.0.1"] {
        endpoint.addresses(answer(ip)).unwrap();
    }
    for ip in [
        "8.8.8.8",
        "192.168.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "168.63.129.16",
        "fd00:ec2::254",
        "fd20:ce::254",
        "fe80::1",
    ] {
        assert!(
            endpoint.addresses(answer(ip)).is_err(),
            "operator rule cannot grant {ip}"
        );
    }
    for scope in [
        provider(2, ProviderWire::Ollama),
        provider(1, ProviderWire::OpenAi),
        OutboundScope::Cimd,
        OutboundScope::Oidc {
            issuer: "https://issuer.example/".into(),
        },
    ] {
        assert!(
            policy
                .endpoint(scope, "http://local.example:11434/api/chat")
                .is_err()
        );
    }
    for url in [
        "http://local.example:11435/api/chat",
        "http://other.example:11434/api/chat",
        "http://127.0.0.1:11434/api/chat",
    ] {
        assert!(
            policy
                .endpoint(provider(1, ProviderWire::Ollama), url)
                .is_err()
        );
    }
    for net in [
        "0.0.0.0/0",
        "::/0",
        "10.0.0.1/8",
        "169.254.0.0/16",
        "100.64.0.0/10",
        "8.8.8.8/32",
        "::ffff:127.0.0.1/128",
    ] {
        assert!(
            PrivateNetworkRule::new(
                ProviderResourceId::from_bytes([1; 16]),
                "http://local.example:11434",
                vec![net.parse().unwrap()]
            )
            .is_err(),
            "invalid operator network {net}"
        );
    }
    let scoped = SocketAddr::V6(std::net::SocketAddrV6::new(
        "fd42::1".parse().unwrap(),
        0,
        0,
        1,
    ));
    assert!(endpoint.addresses([scoped]).is_err());
    for origin in [
        "http://[fd00:ec2::254]",
        "http://[fd20:ce::254]",
        "http://8.8.8.8",
        "http://192.168.1.1",
    ] {
        assert!(
            PrivateNetworkRule::new(
                ProviderResourceId::from_bytes([1; 16]),
                origin,
                vec!["fc00::/7".parse().unwrap(), "127.0.0.1/32".parse().unwrap()]
            )
            .is_err()
        );
    }
}
