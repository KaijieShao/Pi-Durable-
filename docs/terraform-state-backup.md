# Terraform state backup: current audit and proposed GCS migration

The current configuration has no remote backend block. `infra/terraform.tfstate` is local and ignored by Git.
During the 2026-11-10 read-only audit, it had serial **30** and matched this existing copy byte for byte:

- `.context/state-audit/20261108T235853Z/working.tfstate` — serial 30, current matching snapshot.
- `infra/terraform.tfstate.backup` — serial 23, older automatic backup.
- `.context/state-audit/20261108T235853Z/working-prior.tfstate` — serial 23, matching older backup.

All four verified paths are on the operator's Mac, in this checkout. No state file was found in the restored
Desktop checkout, or in the VM's deployed `infra` directory. The GCP project bucket inventory was empty.
These checks establish no off-device/GCS backup in the inspected project; they do not inventory independent
Time Machine, other projects or unrelated cloud accounts. Application/database/code backups on the VM are
not Terraform-state backups. The earlier restored-original-state reconciliation remains unresolved.

State contents may be sensitive. Keep both current and prior copies private and out of Git; audit/report only
lineage, serial, byte hash, resource count, permissions and location. An old `.backup` filename alone does
not establish that it is the latest or authoritative state.

## Proposal — approval required, not applied

Use a dedicated private GCS bucket as the Terraform **backend**, rather than a one-time file upload. The
[GCS backend](https://developer.hashicorp.com/terraform/language/backend/gcs) supports Terraform state locking
and recommends Object Versioning for recovery. The bucket must exist before backend initialization.

Proposed settings:

- Dedicated bucket/prefix for this state; same approved region as the deployment.
- Uniform bucket-level IAM and enforced public-access prevention; no public principals.
- Object Versioning, with lifecycle/soft-delete retention reviewed before enabling any deletion of old versions.
- Bucket-scoped least-privilege state-object access for approved Terraform operators/automation. The coding
  runner and application VM do not need access to infrastructure state. Do not grant project-wide storage roles.
- Authentication through the approved operator/identity flow, without service-account keys or access tokens in
  HCL, backend arguments, plans or Git. No credential value belongs in a backend configuration file.
- Do not impose an immutable bucket-retention policy on Terraform lock objects; lock creation/removal must work.
  This follows from [Bucket Lock](https://docs.cloud.google.com/storage/docs/bucket-lock) preventing deletion
  during retention. Any separate archival/WORM requirement needs its own design and approval.

See Google's [Object Versioning](https://docs.cloud.google.com/storage/docs/object-versioning),
[uniform access](https://docs.cloud.google.com/storage/docs/using-uniform-bucket-level-access) and
[public access prevention](https://docs.cloud.google.com/storage/docs/public-access-prevention) documentation.

## Migration gates

1. Obtain explicit owner approval for bucket creation/IAM, backend changes and migration. This PR grants none.
2. Locate or resolve the missing original/restored state; compare lineage, serial and resource identities with
   the working/current/prior copies and GCP using read-only inspection. Never blindly replace either state.
3. Save independent owner-only copies and hashes of both states. Choose one authoritative state only after
   reconciliation; keep all current local evidence and private variable files untouched.
4. Bootstrap the reviewed bucket separately. Propose a backend block with reviewed bucket/prefix settings;
   it is deliberately **not added** to `infra/versions.tf` by this documentation-only proposal.
5. In a separately authorized session, migrate with `terraform init -migrate-state`, then read back the backend
   and verify lineage, serial, resource inventory and object generation/versioning. Check locking with a safe
   reviewed procedure; no infrastructure apply is implied by state migration.
6. Retain the local rollback copy securely. Record the actual bucket/prefix and restore procedure privately.
   Never overwrite the remote object with an older local file to resolve a disagreement.

This audit ran no Terraform command, created no bucket, changed no backend or IAM, and uploaded no state.
