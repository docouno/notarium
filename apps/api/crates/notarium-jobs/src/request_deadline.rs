use crate::import::check_cancelled;
use notarium_canonical::codec;
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ports::CallBudget,
};
use std::{future::Future, time::Duration};
use tokio::time::Instant;

pub(crate) struct RequestDeadline {
    pub(crate) budget: CallBudget,
    ends: Instant,
}

impl RequestDeadline {
    pub(crate) fn new(budget: CallBudget) -> Result<Self, PortError> {
        let ends = Instant::now()
            .checked_add(budget.remaining)
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidRange))?;
        Ok(Self { budget, ends })
    }

    pub(crate) fn check(&self) -> Result<Duration, PortError> {
        check_cancelled(&self.budget.cancellation)?;
        let remaining = self.ends.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(deadline_error());
        }
        Ok(remaining)
    }

    pub(crate) fn remaining(&self) -> Result<CallBudget, PortError> {
        Ok(CallBudget {
            remaining: self.check()?,
            ..self.budget.clone()
        })
    }

    pub(crate) async fn wait<T>(
        &self,
        operation: impl Future<Output = Result<T, PortError>>,
    ) -> Result<T, PortError> {
        self.check()?;
        tokio::select! {
            biased;
            () = self.budget.cancellation.cancelled() => {
                Err(codec::cancelled_not_committed("archive_request", "archive request cancelled"))
            }
            () = tokio::time::sleep_until(self.ends) => Err(deadline_error()),
            result = operation => result,
        }
    }
}

fn deadline_error() -> PortError {
    codec::deadline_not_committed("archive_request", "archive request deadline exceeded")
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::{ids::RequestId, ports::Cancellation};

    #[tokio::test]
    async fn a_waiting_read_uses_the_original_request_deadline() {
        let request = RequestDeadline::new(CallBudget {
            request: RequestId::from_bytes([1; 16]),
            remaining: Duration::from_millis(10),
            cancellation: Cancellation::default(),
        })
        .unwrap();
        let result = request
            .wait(std::future::pending::<Result<(), PortError>>())
            .await;
        assert!(matches!(result, Err(PortError::DeadlineExceeded(_))));
        assert!(matches!(
            request.remaining(),
            Err(PortError::DeadlineExceeded(_))
        ));
    }
}
