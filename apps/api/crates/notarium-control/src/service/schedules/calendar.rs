use chrono::{DateTime, LocalResult, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use notarium_core::{DomainError, DomainResult, error::ValidationReason, value::Timestamp};

const MIN_INTERVAL_MS: i64 = 60_000;

pub(super) struct Calendar {
    cron: cron::Schedule,
    zone: Tz,
}

impl Calendar {
    pub(super) fn parse(cron: &str, zone: &str) -> DomainResult<Self> {
        let bad_query = || DomainError::validation(ValidationReason::InvalidQuery);
        if cron.len() > 256 || zone.len() > 128 {
            return Err(bad_query());
        }
        Ok(Self {
            cron: cron.parse().map_err(|_| bad_query())?,
            zone: zone.parse().map_err(|_| bad_query())?,
        })
    }

    fn utc(&self, local: NaiveDateTime) -> Option<DateTime<Utc>> {
        let zoned = match self.zone.from_local_datetime(&local) {
            LocalResult::None => return None,
            LocalResult::Single(value) => value,
            LocalResult::Ambiguous(first, second) => first.min(second),
        };
        Some(zoned.to_utc())
    }

    fn after(&self, instant: Timestamp) -> DomainResult<impl Iterator<Item = i64> + '_> {
        // Cron steps through civil fields carried by UTC. Normalizing each
        // candidate independently gives one window during autumn's fold and
        // no window for a nonexistent local time in the spring.
        let date =
            DateTime::from_timestamp(instant.unix_seconds(), 0).ok_or_else(invalid_timestamp)?;
        let civil = date.with_timezone(&self.zone).naive_local().and_utc();
        Ok(self
            .cron
            .after_owned(civil)
            .filter_map(move |candidate| self.utc(candidate.naive_utc()))
            .map(|candidate| candidate.timestamp_millis())
            .filter(move |candidate| candidate.div_euclid(1000) > instant.unix_seconds()))
    }

    pub(super) fn next_ms(&self, after: Timestamp) -> DomainResult<Option<i64>> {
        Ok(self.after(after)?.next())
    }

    /// Compare a persisted UTC due with the single UTC instant for its civil
    /// label. Existing controls may have stored the late side of an autumn fold.
    pub(super) fn civil_slot_ms(&self, slot: i64) -> DomainResult<i64> {
        if slot % 1000 != 0 {
            return Err(invalid_timestamp());
        }
        let date = DateTime::from_timestamp_millis(slot).ok_or_else(invalid_timestamp)?;
        let civil = date.with_timezone(&self.zone).naive_local();
        if !self.cron.includes(civil.and_utc()) {
            return Err(invalid_timestamp());
        }
        self.utc(civil)
            .map(|value| value.timestamp_millis())
            .ok_or_else(invalid_timestamp)
    }

    pub(super) fn validate_slot(
        &self,
        slot: i64,
        allow_legacy_fold: bool,
        active: bool,
    ) -> DomainResult<()> {
        let normalized = self.civil_slot_ms(slot)?;
        if !allow_legacy_fold && normalized != slot {
            return Err(invalid_timestamp());
        }
        let at = Timestamp::from_unix_parts(slot.div_euclid(1000), 0)?;
        if active {
            let mut previous = slot;
            let check_count = if allow_legacy_fold { 1 } else { 2 };
            for following in self.after(at)?.take(check_count) {
                if following.saturating_sub(previous) < MIN_INTERVAL_MS {
                    return Err(DomainError::validation(ValidationReason::InvalidQuery));
                }
                previous = following;
            }
        }
        Ok(())
    }
}

fn invalid_timestamp() -> DomainError {
    DomainError::validation(ValidationReason::InvalidTimestamp)
}

/// Calculate the next civil window after both the due slot and trusted time.
pub fn compute_next_slot(
    cron: &str,
    zone: &str,
    claimed: Timestamp,
    now: Timestamp,
) -> DomainResult<Option<Timestamp>> {
    Calendar::parse(cron, zone)?
        .next_ms(claimed.max(now))?
        .map(|next| Timestamp::from_unix_parts(next.div_euclid(1000), 0))
        .transpose()
}

pub(crate) fn validate_stored_calendar(
    cron: &str,
    zone: &str,
    slot: Option<i64>,
    active: bool,
) -> DomainResult<()> {
    let calendar = Calendar::parse(cron, zone)?;
    if let Some(slot) = slot {
        calendar.validate_slot(slot, true, active)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_civil_windows_skip_gaps_and_remove_the_late_fold() {
        let tick = |value| Timestamp::parse(value).unwrap();
        let weekly = "0 30 1 * * Sun *";
        let expected = Some(tick("2026-11-08T06:30:00Z"));
        let first = tick("2026-11-01T05:30:00Z");
        for now in [
            "2026-11-01T05:30:00.124Z",
            "2026-11-01T06:10:00Z",
            "2026-11-01T06:30:01Z",
        ] {
            assert_eq!(
                compute_next_slot(weekly, "America/New_York", first, tick(now)),
                Ok(expected)
            );
        }
        let calendar = Calendar::parse(weekly, "America/New_York").unwrap();
        let fold = tick("2026-11-01T06:30:00Z").unix_seconds() * 1000;
        assert_eq!(
            calendar.civil_slot_ms(fold),
            Ok(first.unix_seconds() * 1000)
        );
        assert!(calendar.validate_slot(fold, false, true).is_err());
        let before = tick("2026-03-01T07:30:00Z");
        assert_eq!(
            compute_next_slot("0 30 2 * * Sun *", "America/New_York", before, before),
            Ok(Some(tick("2026-03-15T06:30:00Z")))
        );
    }

    #[test]
    fn finite_calendar_and_distant_misfire_are_bounded_by_the_reference() {
        let tick = |value| Timestamp::parse(value).unwrap();
        let last = tick("2026-12-01T12:00:00Z");
        assert_eq!(
            compute_next_slot("0 0 12 1 12 * 2026", "UTC", last, last),
            Ok(None)
        );
        assert_eq!(
            compute_next_slot(
                "0 0 3 * * Sun *",
                "UTC",
                tick("2000-01-02T03:00:00Z"),
                tick("2026-11-19T12:00:00.900Z"),
            ),
            Ok(Some(tick("2026-11-22T03:00:00Z")))
        );
    }
}
