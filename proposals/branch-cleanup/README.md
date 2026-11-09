# Post-acceptance branch cleanup

The owner-approved implementation is an independent, default-disabled worker. It reads Coordinator metadata in query-only mode and maintains a separate durable journal. It never approves, cancels or merges a task. Activation is allowed only after the formal phase has finished and the owner has approved the policy. The original frozen acceptance build stays unchanged.

See [the operational policy and runbook](../../docs/branch-cleanup.md) for exact eligibility, activation/cutoff, historical authorizations, leased deletion, recovery and retry semantics. Keep GitHub immediate branch deletion disabled.

```sh
node --test proposals/branch-cleanup/*.test.ts
node proposals/branch-cleanup/worker.ts --config /absolute/reviewed-config.json --report
```

The example configuration is disabled. The supplied systemd timer is installed/enabled only in an explicitly authorized post-acceptance deployment. No Coordinator database migration or Coordinator restart is required.
