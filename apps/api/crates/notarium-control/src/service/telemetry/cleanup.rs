use super::*;
impl ControlService {
    pub async fn cleanup_telemetry(
        &self,
        ctx: MaintenanceContext,
        limit: u16,
    ) -> Result<TelemetryCleanup, PortError> {
        ctx.authority.require(ServicePurpose::Telemetry)?;
        if !(1..=200).contains(&limit) {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let budget = OperationBudget::new(ctx.budget);
        let mut tx = self.store.write(budget.clone()).await?;
        let result = budget
            .run(
                async {
                    let config = configuration(tx.inner_mut(), false).await?;
                    let now = self.clock.now_ms()?;
                    let compact = now
                        .checked_sub(config.compact_retention_days * DAY)
                        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
                    let detailed = now
                        .checked_sub(config.detailed_retention_days * DAY)
                        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
                    let cutoff_24h = now
                        .checked_sub(DAY)
                        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
                    let cutoff_7d = now
                        .checked_sub(7 * DAY)
                        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
                    let mut remaining = i64::from(limit);
                    let mut result = TelemetryCleanup {
                        details: 0,
                        retrievals: 0,
                        calls: 0,
                        commands: 0,
                        has_more: false,
                    };

                    if remaining > 0 {
                        let deleted = execute!(
                            tx.inner_mut(),
                            "DELETE FROM agent_call_details WHERE call_id IN (SELECT d.call_id FROM agent_call_details d WHERE d.expires_at<=$1 AND EXISTS(SELECT 1 FROM agent_calls c WHERE c.call_id=d.call_id AND (c.finished_at IS NOT NULL OR c.started_at<=$2)) ORDER BY d.expires_at,d.call_id LIMIT $3)",
                            "DELETE FROM v1_control.agent_call_details WHERE call_id IN (SELECT d.call_id FROM v1_control.agent_call_details d WHERE d.expires_at<=$1 AND EXISTS(SELECT 1 FROM v1_control.agent_calls c WHERE c.call_id=d.call_id AND (c.finished_at IS NOT NULL OR c.started_at<=$2)) ORDER BY d.expires_at,d.call_id LIMIT $3 FOR UPDATE OF d SKIP LOCKED)";
                            now, cutoff_24h, remaining
                        )? as i64;
                        result.details += deleted as u16;
                        remaining -= deleted;
                    }
                    if remaining > 0 {
                        let deleted = execute!(
                            tx.inner_mut(),
                            "DELETE FROM agent_call_details WHERE call_id IN (SELECT d.call_id FROM agent_call_details d WHERE d.created_at<=$1 AND EXISTS(SELECT 1 FROM agent_calls c WHERE c.call_id=d.call_id AND (c.finished_at IS NOT NULL OR c.started_at<=$2)) ORDER BY d.created_at,d.call_id LIMIT $3)",
                            "DELETE FROM v1_control.agent_call_details WHERE call_id IN (SELECT d.call_id FROM v1_control.agent_call_details d WHERE d.created_at<=$1 AND EXISTS(SELECT 1 FROM v1_control.agent_calls c WHERE c.call_id=d.call_id AND (c.finished_at IS NOT NULL OR c.started_at<=$2)) ORDER BY d.created_at,d.call_id LIMIT $3 FOR UPDATE OF d SKIP LOCKED)";
                            detailed, cutoff_24h, remaining
                        )? as i64;
                        result.details += deleted as u16;
                        remaining -= deleted;
                    }

                    if remaining > 0 {
                        let deleted = execute!(
                            tx.inner_mut(),
                            "DELETE FROM agent_retrievals WHERE retrieval_id IN (SELECT r.retrieval_id FROM agent_retrievals r WHERE r.created_at<=$1 AND (r.call_id IS NULL OR EXISTS(SELECT 1 FROM agent_calls c WHERE c.call_id=r.call_id AND (c.finished_at IS NOT NULL OR c.started_at<=$2))) ORDER BY r.created_at,r.retrieval_id LIMIT $3)",
                            "DELETE FROM v1_control.agent_retrievals WHERE retrieval_id IN (SELECT r.retrieval_id FROM v1_control.agent_retrievals r WHERE r.created_at<=$1 AND (r.call_id IS NULL OR EXISTS(SELECT 1 FROM v1_control.agent_calls c WHERE c.call_id=r.call_id AND (c.finished_at IS NOT NULL OR c.started_at<=$2))) ORDER BY r.created_at,r.retrieval_id LIMIT $3 FOR UPDATE OF r SKIP LOCKED)";
                            compact, cutoff_24h, remaining
                        )? as i64;
                        result.retrievals += deleted as u16;
                        remaining -= deleted;
                    }

                    if remaining > 0 {
                        let deleted = execute!(
                            tx.inner_mut(),
                            "DELETE FROM agent_calls WHERE call_id IN (SELECT c.call_id FROM agent_calls c WHERE ((c.finished_at IS NOT NULL AND c.finished_at<=$1) OR (c.finished_at IS NULL AND c.started_at<=$2)) AND NOT EXISTS(SELECT 1 FROM agent_retrievals r WHERE r.call_id=c.call_id) AND NOT EXISTS(SELECT 1 FROM agent_call_details d WHERE d.call_id=c.call_id) ORDER BY coalesce(c.finished_at,c.started_at),c.call_id LIMIT $3)",
                            "DELETE FROM v1_control.agent_calls WHERE call_id IN (SELECT c.call_id FROM v1_control.agent_calls c WHERE ((c.finished_at IS NOT NULL AND c.finished_at<=$1) OR (c.finished_at IS NULL AND c.started_at<=$2)) AND NOT EXISTS(SELECT 1 FROM v1_control.agent_retrievals r WHERE r.call_id=c.call_id) AND NOT EXISTS(SELECT 1 FROM v1_control.agent_call_details d WHERE d.call_id=c.call_id) ORDER BY coalesce(c.finished_at,c.started_at),c.call_id LIMIT $3 FOR UPDATE OF c SKIP LOCKED)";
                            compact, cutoff_24h, remaining
                        )? as i64;
                        result.calls += deleted as u16;
                        remaining -= deleted;
                    }

                    // Conservatively preserve command receipts while their own canonical
                    // operation or any contemporaneous revocation obligation is pending.
                    if remaining > 0 {
                        let deleted = execute!(
                            tx.inner_mut(),
                            "DELETE FROM control_commands WHERE (owner,actor,command_key) IN (SELECT c.owner,c.actor,c.command_key FROM control_commands c WHERE c.state='committed' AND c.expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM revocation_events e WHERE e.delivered_at IS NULL AND e.committed_at<=c.expires_at) AND NOT EXISTS(SELECT 1 FROM control_operations o WHERE o.command_key=c.command_key AND o.state<>'committed') ORDER BY c.expires_at,c.owner,c.actor,c.command_key LIMIT $2)",
                            "DELETE FROM v1_control.control_commands WHERE (owner,actor,command_key) IN (SELECT c.owner,c.actor,c.command_key FROM v1_control.control_commands c WHERE c.state='committed' AND c.expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM v1_control.revocation_events e WHERE e.delivered_at IS NULL AND e.committed_at<=c.expires_at) AND NOT EXISTS(SELECT 1 FROM v1_control.control_operations o WHERE o.command_key=c.command_key AND o.state<>'committed') ORDER BY c.expires_at,c.owner,c.actor,c.command_key LIMIT $2 FOR UPDATE OF c SKIP LOCKED)";
                            now, remaining
                        )? as i64;
                        result.commands += deleted as u16;
                        remaining -= deleted;
                    }

                    // 24h after expiry: ephemeral tokens, OIDC transactions, MCP dedup, and closed 1-minute provider budget buckets.
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM one_time_tokens WHERE token_hash IN (SELECT token_hash FROM one_time_tokens WHERE expires_at<=$1 ORDER BY expires_at,token_hash LIMIT $2)",
                            "DELETE FROM v1_control.one_time_tokens WHERE token_hash IN (SELECT token_hash FROM v1_control.one_time_tokens WHERE expires_at<=$1 ORDER BY expires_at,token_hash LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_24h, remaining
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM oauth_auth_codes WHERE code_hash IN (SELECT code_hash FROM oauth_auth_codes WHERE expires_at<=$1 ORDER BY expires_at,code_hash LIMIT $2)",
                            "DELETE FROM v1_control.oauth_auth_codes WHERE code_hash IN (SELECT code_hash FROM v1_control.oauth_auth_codes WHERE expires_at<=$1 ORDER BY expires_at,code_hash LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_24h, remaining
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM oauth_access_tokens WHERE token_id IN (SELECT token_id FROM oauth_access_tokens WHERE expires_at<=$1 ORDER BY expires_at,token_id LIMIT $2)",
                            "DELETE FROM v1_control.oauth_access_tokens WHERE token_id IN (SELECT token_id FROM v1_control.oauth_access_tokens WHERE expires_at<=$1 ORDER BY expires_at,token_id LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_24h, remaining
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM oidc_transactions WHERE transaction_id IN (SELECT transaction_id FROM oidc_transactions WHERE expires_at<=$1 ORDER BY expires_at,transaction_id LIMIT $2)",
                            "DELETE FROM v1_control.oidc_transactions WHERE transaction_id IN (SELECT transaction_id FROM v1_control.oidc_transactions WHERE expires_at<=$1 ORDER BY expires_at,transaction_id LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_24h, remaining
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM mcp_dedup WHERE (owner,actor,request_key) IN (SELECT owner,actor,request_key FROM mcp_dedup WHERE expires_at<=$1 ORDER BY expires_at,owner,actor,request_key LIMIT $2)",
                            "DELETE FROM v1_control.mcp_dedup WHERE (owner,actor,request_key) IN (SELECT owner,actor,request_key FROM v1_control.mcp_dedup WHERE expires_at<=$1 ORDER BY expires_at,owner,actor,request_key LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_24h, remaining
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM provider_budget_buckets WHERE (budget_kind,budget_owner,window_start_ms) IN (SELECT budget_kind,budget_owner,window_start_ms FROM provider_budget_buckets WHERE window_end_ms<=$1 ORDER BY window_end_ms,budget_kind,budget_owner,window_start_ms LIMIT $2)",
                            "DELETE FROM v1_control.provider_budget_buckets WHERE (budget_kind,budget_owner,window_start_ms) IN (SELECT budget_kind,budget_owner,window_start_ms FROM v1_control.provider_budget_buckets WHERE window_end_ms<=$1 ORDER BY window_end_ms,budget_kind,budget_owner,window_start_ms LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_24h, remaining
                        )? as i64;
                    }

                    // 7 days after expiry/revocation/completion: sessions, refresh tokens/families, delivered revocations, committed operations.
                    // Never delete rotated (`used_at`) refresh tokens before `expires_at + 7d`:
                    // retaining used tombstones until token expiry preserves OAuth 2.1 reuse detection.
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM sessions WHERE expires_at<=$1 ORDER BY expires_at,session_id LIMIT $2)",
                            "DELETE FROM v1_control.sessions WHERE session_id IN (SELECT session_id FROM v1_control.sessions WHERE expires_at<=$1 ORDER BY expires_at,session_id LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_7d, remaining
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM sessions WHERE revoked_at IS NOT NULL AND revoked_at<=$1 ORDER BY revoked_at,session_id LIMIT $2)",
                            "DELETE FROM v1_control.sessions WHERE session_id IN (SELECT session_id FROM v1_control.sessions WHERE revoked_at IS NOT NULL AND revoked_at<=$1 ORDER BY revoked_at,session_id LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_7d, remaining
                        )? as i64;
                    }
                    let mut touched_families = std::collections::BTreeSet::new();
                    if remaining > 0 {
                        let deleted_families: Vec<(String,)> = rows!(
                            tx.inner_mut(),
                            (String,),
                            fetch_all,
                            "DELETE FROM oauth_refresh_tokens WHERE token_id IN (SELECT token_id FROM oauth_refresh_tokens WHERE expires_at<=$1 ORDER BY expires_at,token_id LIMIT $2) RETURNING family_id",
                            "DELETE FROM v1_control.oauth_refresh_tokens WHERE token_id IN (SELECT token_id FROM v1_control.oauth_refresh_tokens WHERE expires_at<=$1 ORDER BY expires_at,token_id LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING family_id";
                            cutoff_7d, remaining
                        )?;
                        remaining -= deleted_families.len() as i64;
                        for (fid,) in deleted_families {
                            touched_families.insert(fid);
                        }
                    }
                    for fid in touched_families {
                        execute!(
                            tx.inner_mut(),
                            "UPDATE oauth_refresh_families SET revoked_at=$1,reason_code='expired' WHERE family_id=$2 AND revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM oauth_refresh_tokens t WHERE t.family_id=$2)",
                            "UPDATE v1_control.oauth_refresh_families SET revoked_at=$1,reason_code='expired' WHERE family_id=$2 AND revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM v1_control.oauth_refresh_tokens t WHERE t.family_id=$2)";
                            cutoff_7d, &fid
                        )?;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM oauth_refresh_families WHERE family_id IN (SELECT f.family_id FROM oauth_refresh_families f WHERE f.revoked_at IS NOT NULL AND f.revoked_at<=$1 AND NOT EXISTS(SELECT 1 FROM oauth_refresh_tokens t WHERE t.family_id=f.family_id) AND NOT EXISTS(SELECT 1 FROM oauth_access_tokens a WHERE a.family_id=f.family_id) ORDER BY f.revoked_at,f.family_id LIMIT $2)",
                            "DELETE FROM v1_control.oauth_refresh_families WHERE family_id IN (SELECT f.family_id FROM v1_control.oauth_refresh_families f WHERE f.revoked_at IS NOT NULL AND f.revoked_at<=$1 AND NOT EXISTS(SELECT 1 FROM v1_control.oauth_refresh_tokens t WHERE t.family_id=f.family_id) AND NOT EXISTS(SELECT 1 FROM v1_control.oauth_access_tokens a WHERE a.family_id=f.family_id) ORDER BY f.revoked_at,f.family_id LIMIT $2 FOR UPDATE OF f SKIP LOCKED)";
                            cutoff_7d, remaining
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM oauth_refresh_families WHERE family_id IN (SELECT f.family_id FROM oauth_refresh_families f WHERE f.revoked_at IS NULL AND f.created_at<=$1 AND NOT EXISTS(SELECT 1 FROM oauth_refresh_tokens t WHERE t.family_id=f.family_id) AND NOT EXISTS(SELECT 1 FROM oauth_access_tokens a WHERE a.family_id=f.family_id) ORDER BY f.created_at,f.family_id LIMIT $2)",
                            "DELETE FROM v1_control.oauth_refresh_families WHERE family_id IN (SELECT f.family_id FROM v1_control.oauth_refresh_families f WHERE f.revoked_at IS NULL AND f.created_at<=$1 AND NOT EXISTS(SELECT 1 FROM v1_control.oauth_refresh_tokens t WHERE t.family_id=f.family_id) AND NOT EXISTS(SELECT 1 FROM v1_control.oauth_access_tokens a WHERE a.family_id=f.family_id) ORDER BY f.created_at,f.family_id LIMIT $2 FOR UPDATE OF f SKIP LOCKED)";
                            cutoff_7d, remaining
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM revocation_events WHERE event_id IN (SELECT event_id FROM revocation_events WHERE delivered_at IS NOT NULL AND delivered_at<=$1 ORDER BY delivered_at,event_id LIMIT $2)",
                            "DELETE FROM v1_control.revocation_events WHERE event_id IN (SELECT event_id FROM v1_control.revocation_events WHERE delivered_at IS NOT NULL AND delivered_at<=$1 ORDER BY delivered_at,event_id LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_7d, remaining
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM control_operations WHERE operation_id IN (SELECT operation_id FROM control_operations WHERE state='committed' AND updated_at<=$1 ORDER BY updated_at,operation_id LIMIT $2)",
                            "DELETE FROM v1_control.control_operations WHERE operation_id IN (SELECT operation_id FROM v1_control.control_operations WHERE state='committed' AND updated_at<=$1 ORDER BY updated_at,operation_id LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            cutoff_7d, remaining
                        )? as i64;
                    }

                    // compact_retention_days: settled provider calls, terminal schedule runs, and childless deleted schedule tombstones.
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM provider_call_log WHERE call_id IN (SELECT call_id FROM provider_call_log WHERE delivery_state='settled' AND settled_at IS NOT NULL AND settled_at<=$1 ORDER BY settled_at,call_id LIMIT $2)",
                            "DELETE FROM v1_control.provider_call_log WHERE call_id IN (SELECT call_id FROM v1_control.provider_call_log WHERE delivery_state='settled' AND settled_at IS NOT NULL AND settled_at<=$1 ORDER BY settled_at,call_id LIMIT $2 FOR UPDATE SKIP LOCKED)";
                            compact, remaining
                        )? as i64;
                    }
                    // A legacy due may be the late UTC instant of a repeated civil
                    // time. Each Chrono offset has absolute value below 24 hours,
                    // so the two instants differ by less than 48 hours. Preserve
                    // this small window across configuration changes until the
                    // schedule advances; claims resolve the exact civil instant.
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM agent_schedule_runs WHERE run_id IN (SELECT r.run_id FROM agent_schedule_runs r WHERE r.status IN ('succeeded','failed','unknown') AND r.finished_at IS NOT NULL AND r.finished_at<=$1 AND NOT EXISTS(SELECT 1 FROM agent_schedules s WHERE s.schedule_id=r.schedule_id AND s.deleted_at IS NULL AND r.slot_utc_ms BETWEEN s.next_slot_utc_ms-$3 AND s.next_slot_utc_ms) ORDER BY r.finished_at,r.run_id LIMIT $2)",
                            "DELETE FROM v1_control.agent_schedule_runs WHERE run_id IN (SELECT r.run_id FROM v1_control.agent_schedule_runs r WHERE r.status IN ('succeeded','failed','unknown') AND r.finished_at IS NOT NULL AND r.finished_at<=$1 AND NOT EXISTS(SELECT 1 FROM v1_control.agent_schedules s WHERE s.schedule_id=r.schedule_id AND s.deleted_at IS NULL AND r.slot_utc_ms BETWEEN s.next_slot_utc_ms-$3 AND s.next_slot_utc_ms) ORDER BY r.finished_at,r.run_id LIMIT $2 FOR UPDATE OF r SKIP LOCKED)";
                            compact, remaining, 2 * DAY
                        )? as i64;
                    }
                    if remaining > 0 {
                        remaining -= execute!(
                            tx.inner_mut(),
                            "DELETE FROM agent_schedules WHERE schedule_id IN (SELECT s.schedule_id FROM agent_schedules s WHERE s.deleted_at IS NOT NULL AND s.deleted_at<=$1 AND NOT EXISTS(SELECT 1 FROM agent_schedule_runs r WHERE r.schedule_id=s.schedule_id) ORDER BY s.deleted_at,s.schedule_id LIMIT $2)",
                            "DELETE FROM v1_control.agent_schedules WHERE schedule_id IN (SELECT s.schedule_id FROM v1_control.agent_schedules s WHERE s.deleted_at IS NOT NULL AND s.deleted_at<=$1 AND NOT EXISTS(SELECT 1 FROM v1_control.agent_schedule_runs r WHERE r.schedule_id=s.schedule_id) ORDER BY s.deleted_at,s.schedule_id LIMIT $2 FOR UPDATE OF s SKIP LOCKED)";
                            compact, remaining
                        )? as i64;
                    }

                    result.has_more = remaining == 0;
                    Ok(result)
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(result)
    }
}
