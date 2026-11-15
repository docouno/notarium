use super::ProviderService;
use notarium_core::{
    ids::*,
    ports::{control::*, *},
};

impl ProviderAdminPort for ProviderService {
    fn create_credential(
        &self,
        ctx: AccountContext,
        request: AccountMutation<NewProviderCredential>,
    ) -> PortFuture<'_, ControlCommit<ProviderCredentialInfo>> {
        Box::pin(ProviderService::create_credential(self, ctx, request))
    }
    fn update_credential(
        &self,
        ctx: AccountContext,
        request: AccountMutation<UpdateProviderCredential>,
    ) -> PortFuture<'_, ControlCommit<ProviderCredentialInfo>> {
        Box::pin(ProviderService::update_credential(self, ctx, request))
    }
    fn delete_credential(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteProviderCredential>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(ProviderService::delete_credential(self, ctx, request))
    }
    fn list_credentials(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderCredentialInfo>> {
        Box::pin(ProviderService::list_credentials(self, ctx, page))
    }
    fn create_resource(
        &self,
        ctx: AccountContext,
        request: AccountMutation<ProviderResourceSpec>,
    ) -> PortFuture<'_, ControlCommit<ProviderResourceInfo>> {
        Box::pin(ProviderService::create_resource(self, ctx, request))
    }
    fn update_resource(
        &self,
        ctx: AccountContext,
        request: AccountMutation<UpdateProviderResource>,
    ) -> PortFuture<'_, ControlCommit<ProviderResourceInfo>> {
        Box::pin(ProviderService::update_resource(self, ctx, request))
    }
    fn delete_resource(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteProviderResource>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(ProviderService::delete_resource(self, ctx, request))
    }
    fn list_resources(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderResourceInfo>> {
        Box::pin(ProviderService::list_resources(self, ctx, page))
    }
    fn put_model(
        &self,
        ctx: AccountContext,
        request: AccountMutation<PutProviderModel>,
    ) -> PortFuture<'_, ControlCommit<ProviderModelInfo>> {
        Box::pin(ProviderService::put_model(self, ctx, request))
    }
    fn delete_model(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteProviderModel>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(ProviderService::delete_model(self, ctx, request))
    }
    fn list_models(
        &self,
        ctx: AccountContext,
        resource: ProviderResourceId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderModelInfo>> {
        Box::pin(ProviderService::list_models(self, ctx, resource, page))
    }
    fn request_attachment(
        &self,
        ctx: AccountContext,
        request: AccountMutation<RequestProviderAttachment>,
    ) -> PortFuture<'_, ControlCommit<ProviderAttachmentInfo>> {
        Box::pin(ProviderService::request_attachment(self, ctx, request))
    }
    fn approve_attachment(
        &self,
        ctx: AccountContext,
        request: AccountMutation<ApproveProviderAttachment>,
    ) -> PortFuture<'_, ControlCommit<ProviderAttachmentInfo>> {
        Box::pin(ProviderService::approve_attachment(self, ctx, request))
    }
    fn revoke_attachment(
        &self,
        ctx: AccountContext,
        request: AccountMutation<RevokeProviderAttachment>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(ProviderService::revoke_attachment(self, ctx, request))
    }
    fn list_attachments(
        &self,
        ctx: AccountContext,
        resource: ProviderResourceId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderAttachmentInfo>> {
        Box::pin(ProviderService::list_attachments(self, ctx, resource, page))
    }
    fn inspect_attachment(
        &self,
        ctx: AccountContext,
        attachment: RequestId,
    ) -> PortFuture<'_, ProviderAttachmentReview> {
        Box::pin(ProviderService::inspect_attachment(self, ctx, attachment))
    }
    fn set_preference(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetProviderPreference>,
    ) -> PortFuture<'_, ControlCommit<SetProviderPreference>> {
        Box::pin(ProviderService::set_preference(self, ctx, request))
    }
    fn list_offers(
        &self,
        ctx: SpaceContext,
        query: ProviderOfferQuery,
    ) -> PortFuture<'_, ControlPage<ProviderAttachmentReview>> {
        Box::pin(ProviderService::list_offers(self, ctx, query))
    }
    fn list_offer_models(
        &self,
        ctx: SpaceContext,
        offer: RequestId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProviderModelInfo>> {
        Box::pin(ProviderService::list_offer_models(self, ctx, offer, page))
    }
    fn inspect_call(
        &self,
        ctx: AccountContext,
        call: RequestId,
    ) -> PortFuture<'_, ProviderCallStatus> {
        Box::pin(ProviderService::inspect_call(self, ctx, call))
    }
    fn check_connection(
        &self,
        ctx: AccountContext,
        request: CheckProviderConnection,
    ) -> PortFuture<'_, ProviderConnectionStatus> {
        Box::pin(ProviderService::check_connection(self, ctx, request))
    }
}
