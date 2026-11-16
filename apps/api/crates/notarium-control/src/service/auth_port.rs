use super::ControlService;
use notarium_core::{
    auth::EngineAuthContext,
    ids::PrincipalId,
    ports::{control::*, *},
};

impl AuthPort for ControlService {
    fn admit_space_management(
        &self,
        ctx: AccountContext,
        scope: notarium_core::model::HistoryScope,
    ) -> PortFuture<'_, SpaceContext> {
        Box::pin(Self::admit_space_management(self, ctx, scope))
    }
    fn bootstrap(
        &self,
        authorization: EmptyRootAuthorization,
        budget: CallBudget,
        request: BootstrapAccount,
    ) -> PortFuture<'_, BootstrapAccountResult> {
        Box::pin(Self::bootstrap(self, authorization, budget, request))
    }
    fn login(&self, budget: CallBudget, request: PasswordLogin) -> PortFuture<'_, IssuedSession> {
        Box::pin(Self::login(self, budget, request))
    }
    fn resolve(&self, ctx: PreAuthContext) -> PortFuture<'_, EngineAuthContext> {
        Box::pin(Self::resolve(self, ctx))
    }
    fn trusted_none(
        &self,
        perimeter: PerimeterAttestation,
        budget: CallBudget,
    ) -> PortFuture<'_, EngineAuthContext> {
        Box::pin(Self::trusted_none(self, perimeter, budget))
    }
    fn logout(&self, ctx: PreAuthContext) -> PortFuture<'_, ()> {
        Box::pin(Self::logout(self, ctx))
    }
    fn account(&self, ctx: AccountContext, account: PrincipalId) -> PortFuture<'_, AccountInfo> {
        Box::pin(Self::account(self, ctx, account))
    }
    fn create_account(
        &self,
        ctx: AccountContext,
        request: AccountMutation<NewAccount>,
    ) -> PortFuture<'_, ControlCommit<AccountInfo>> {
        Box::pin(Self::create_account(self, ctx, request))
    }
    fn change_password(
        &self,
        ctx: AccountContext,
        request: ChangePassword,
    ) -> PortFuture<'_, ControlCommit<AccountInfo>> {
        Box::pin(Self::change_password(self, ctx, request))
    }
    fn set_disabled(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetAccountDisabled>,
    ) -> PortFuture<'_, ControlCommit<AccountInfo>> {
        Box::pin(Self::set_disabled(self, ctx, request))
    }
    fn issue_one_time(
        &self,
        ctx: AccountContext,
        request: IssueOneTime,
    ) -> PortFuture<'_, ControlCommit<IssuedOneTime>> {
        Box::pin(Self::issue_one_time(self, ctx, request))
    }
    fn consume_one_time(
        &self,
        budget: CallBudget,
        request: ConsumeOneTime,
    ) -> PortFuture<'_, IssuedSession> {
        Box::pin(Self::consume_one_time(self, budget, request))
    }
    fn create_pat(
        &self,
        ctx: AccountContext,
        request: CreatePat,
    ) -> PortFuture<'_, ControlCommit<IssuedPat>> {
        Box::pin(Self::create_pat(self, ctx, request))
    }
    fn list_pats(
        &self,
        ctx: AccountContext,
        account: PrincipalId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<PatInfo>> {
        Box::pin(Self::list_pats(self, ctx, account, page))
    }
    fn revoke_pat(
        &self,
        ctx: AccountContext,
        request: AccountMutation<RevokePat>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(Self::revoke_pat(self, ctx, request))
    }
    fn drain_revocations(
        &self,
        ctx: MaintenanceContext,
        limit: u16,
    ) -> PortFuture<'_, RevocationDrain> {
        Box::pin(Self::drain_revocations(self, ctx, limit))
    }
}
