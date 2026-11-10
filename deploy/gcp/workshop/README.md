# Always-on Workshop profile on GCP

This directory preserves the existing Workshop deployment as parameterized assets. It does **not** deploy
anything on merge. The current app release is recorded in `profile-fingerprints.json`; that is the running
application release, not this preservation PR's commit. The status-display PR is a separate change.

## Layout and behavior

| Asset | Installed role |
|---|---|
| `systemd/pi-durable-workshop-coordinator.service.in` | Boot-enabled Coordinator; restart on failure; exclusive-poller guard; mount/metadata dependencies; original General paths inaccessible |
| `systemd/pi-durable-workshop-watchdog.service.in` | Independent boot-enabled watchdog; survives Coordinator failure; kill-only capability, Unix sockets only, no network |
| `systemd/mnt-pi-durable-workshop.mount.in` | Bind `/mnt/pi-durable-tasks/workshop-live` to `/mnt/pi-durable-workshop`; follows the existing task-disk mount |
| `start-workshop.mjs.in` | Check release/repo/group/topic/data-path/isolation bindings, fetch three credentials from Secret Manager into memory, then start the Coordinator |
| `require-exclusive.py` | Refuse start while any known General/acceptance Coordinator still has a PID |
| `docker-scoped.in` | Scope Docker discovery/removal to this Workshop instance's container label |
| `manage.py`, `probe.py` | Local private rendering, read-only inspection and fingerprint verification; no install, restart, task-command or Terraform operation |

Application code lives at `/opt/pi-durable`; Workshop control files at `/opt/pi-durable-workshop`.
Workshop has its own `/var/lib/pi-durable-workshop/coordinator.sqlite`, conversations, run home and task
mount. Original General files remain separate. General's Coordinator/watchdog remain stopped and disabled;
known acceptance pollers have no PID. Do not automatically restore General after a demo. Mac/other hosts
must also keep their poller stopped; the local systemd guard is not a distributed lock across machines.

Configuration/lock exits 2/3 deliberately require an operator rather than a restart loop (watchdog: config exit 2).
The VM uses standard provisioning, automatic restart and host-maintenance migration. These settings are
fingerprinted and inspected as well as the service files. This profile reuses the existing disk, Docker,
canonical users/groups, Pi slice, polkit rules and metadata firewall; prerequisites remain in
[isolation](../../../docs/isolation.md) and [security](../../../docs/security.md). It creates no cloud resources.

## Private configuration stays outside Git

No environment files, environment values, credential values, database/state snapshots or rendered private
assets are committed. `manifest.json` lists required binding **names** and installed paths/modes only.
`profile-fingerprints.json` records hashes of the approved private environment files and the rendered assets,
plus the app release and VM scheduling policy. A hash match confirms the private profile did not drift
without publishing its values. Fixed paths, Unix users, service dependencies and sandbox settings are code.

Keep the binding JSON owner-only outside the checkout. Fill exactly the names in `manifest.json`, using
strings: expected route/path/release checks, cloud project and secret identifiers/versions, instance label,
and fixed systemd environment assignments. These bindings are identifiers/configuration, **not tokens**.
Credential-shaped input is rejected. The actual credential values stay in Secret Manager and process memory.
The Coordinator and watchdog each use their own existing private environment file; the watchdog receives no
credentials. The entry point preserves provider configuration before scrubbing child environments.

Templates use `{{json:NAME}}` for escaped JS literals and restricted `{{word:NAME}}`/`{{unit:NAME}}` substitutions.
Rendering must target a new owner-only directory outside the checkout. It does not install or execute the files.

```sh
python3 deploy/gcp/workshop/manage.py render \
  --bindings <private-bindings-json> --output <new-private-output-directory>

python3 deploy/gcp/workshop/manage.py inspect \
  --bindings <private-bindings-json> \
  --project <project> --zone <zone> --instance <vm> --account <operator> \
  --output <local-audit-json> --snapshot-output <local-probe-json>
```

`inspect` uses authenticated IAP SSH to run a read-only Python probe and `systemctl show`, then reads VM
scheduling with `gcloud compute instances describe`. It does not source, return or print environment values,
fetch credentials, write VM files, run task commands, or change services. It checks all effective unit
directives (only comments/blank lines omitted), exact script SHA-256, modes, private-config hashes, release
and route guards, mount, active/enabled units, absent Workshop drop-ins, loaded fragment paths with no pending daemon reload, the actual bind source,
control files predating the running process, and inactive competing VM pollers.
It reads the protected General task table query-only and returns its digest for before/after comparison.
Any mismatch exits nonzero. JSON contains booleans/hashes only, not raw errors or private values.

A previously captured probe can be checked offline with `verify --snapshot <probe-json>` and the same private
bindings. A successful current inspection proves configuration preservation; it is not a new fault/stress
acceptance run or proof of a disaster-recovery restore.

## Approved changes and recovery

No installation or restart is authorized by this preservation PR. A later change requires owner approval.
Before an approved change, record current fingerprints, health, private-config backups and both database
snapshots. Verify no Mac/other poller and drain active runs, merge work and required replies. Use the existing
pause/restore procedure: stop the one Workshop Coordinator before source/entry changes; keep the watchdog's
independent stop path available; restore the same profile promptly if health fails. Never overwrite a live
database or cursor with an older snapshot, switch repositories by reusing a task directory, or touch General
Tasks 8/9 and their PRs.

On a fresh approved host, complete shared host prerequisites first; create the isolated directories and the
bind-mount source with canonical ownership, watchdog traversal ACLs and runner-home isolation. Render privately,
review every target/mode in the manifest, install root-owned controls/units and separate private environment
files, then enable the mount and watchdog before the Coordinator. This directory deliberately provides no
one-command destructive install/switch helper and includes no old migration payload/database.

An approved source release must update the private source guard and the reviewed fingerprint receipt too;
otherwise inspection fails rather than silently declaring an old profile current. Only then verify owner
status and Telegram status in the configured Workshop topic. Task approvals/cancellations/merges stay in
Telegram. Source PR merges follow their separately authorized GitHub review path.

Owner read-only status on the existing profile:

```sh
sudo -u pi-coordinator node /opt/pi-durable/src/cli/main.ts owner status \
  --env-file /opt/pi-durable-workshop/coordinator.env
```

Terraform state backup and the proposed remote-backend migration are documented in
[the state backup plan](../../../docs/terraform-state-backup.md). No Terraform operation is part of these tools.
