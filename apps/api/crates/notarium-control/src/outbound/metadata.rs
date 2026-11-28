//! Bounded freshness for identity metadata; zero means fetch for each operation.
use http::header::{AGE, CACHE_CONTROL, HeaderMap};
pub(crate) fn freshness_ms(headers: &HeaderMap, default_seconds: u64, maximum_seconds: u64) -> i64 {
    let mut seconds: Option<u64> = None;
    for header in headers.get_all(CACHE_CONTROL) {
        let Ok(value) = header.to_str() else { return 0 };
        for part in value.split(',').map(str::trim) {
            if part.eq_ignore_ascii_case("no-store") || part.eq_ignore_ascii_case("no-cache") {
                return 0;
            }
            if let Some((key, value)) = part.split_once('=')
                && key.trim().eq_ignore_ascii_case("max-age")
            {
                let Ok(value) = value.trim().trim_matches('"').parse::<u64>() else {
                    return 0;
                };
                seconds =
                    Some(seconds.map_or(value.min(maximum_seconds), |prior| prior.min(value)));
            }
        }
    }
    let age = match headers.get(AGE) {
        Some(value) => match value.to_str().ok().and_then(|v| v.parse::<u64>().ok()) {
            Some(age) => age,
            None => return 0,
        },
        None => 0,
    };
    seconds
        .unwrap_or(default_seconds.min(maximum_seconds))
        .saturating_sub(age)
        .saturating_mul(1000)
        .min(i64::MAX as u64) as i64
}
