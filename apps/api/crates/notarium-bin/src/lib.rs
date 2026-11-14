//! Composition entry points for the bootstrap daemon.

use std::io;

/// Parse the infrastructure listener port. Port zero requests an ephemeral port.
pub fn port(value: Option<&str>) -> io::Result<u16> {
    value.unwrap_or("3000").parse().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid PORT: {error}"),
        )
    })
}

pub async fn serve() -> io::Result<()> {
    let value = std::env::var("PORT")
        .map(Some)
        .or_else(|error| match error {
            std::env::VarError::NotPresent => Ok(None),
            _ => Err(io::Error::new(io::ErrorKind::InvalidInput, error)),
        })?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port(value.as_deref())?)).await?;
    println!("notariumd listening on {}", listener.local_addr()?);
    axum::serve(listener, notarium_http::router())
        .with_graceful_shutdown(shutdown())
        .await
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn port_defaults_and_rejects_invalid_configuration() {
        assert_eq!(super::port(None).unwrap(), 3000);
        assert_eq!(super::port(Some("8080")).unwrap(), 8080);
        assert_eq!(super::port(Some("0")).unwrap(), 0);
        for value in ["", "-1", "65536", "http"] {
            assert!(super::port(Some(value)).is_err(), "accepted {value:?}");
        }
    }
}
