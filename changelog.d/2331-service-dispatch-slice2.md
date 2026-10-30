### Service dispatch enforcement (#2331 slice 2)

- Every unattended dispatch path now resolves its run-as identity through the provisioned service user (ownerless/system work) or the owner (owner-attached work): schedule callbacks, async-job execution, Worker scheduled() cron dispatch, and Worker queue() options-analysis messages.
- Platform tier enforces a live platform-scope member binding for the service id (membership check, not PDP authorize, per the slice-1 caveat: a platform-scope member binding carries no PDP permission under current policy); tenant tier enforces a live tenant member binding plus a PDP task:create check, never across tenants.
- Broker independence at dispatch: service-identity work that needs brokerage (token renewal, IV collection, order-draft expiry) denies with BROKER_REQUIRED; brokerage-attached work dispatches as the owner or not at all.
- Denials fail closed, are funnel-audited (async_job.dispatch_denied, schedule.dispatch_denied), and preserve the schedule (except the pre-existing unowned-schedule removal, now audited); denied async jobs are marked failed, denied queue messages are dropped, not retried.
- LOUD CONSEQUENCE: after this deploys, scheduled goals pause until a platform admin provisions the platform tier via POST /api/admin/service-user/provision (nothing is provisioned today). That is the fail-closed intent, not a surprise outage.
