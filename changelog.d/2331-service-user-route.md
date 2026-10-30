### Added

- Platform-admin-only service-user provisioning routes (#2331 slice 1): POST /api/admin/service-user/provision (platform tier and tenant tier with tenantId), POST /api/admin/service-user/revoke (tier or full offboard), and GET /api/admin/service-user/status. Provisioning goes through the existing grant path (narrow member bindings only, never admin) and every grant and revoke is audited through the orchestrator audit funnel. No production provisioning is performed by this change; that remains a separate owner step.
