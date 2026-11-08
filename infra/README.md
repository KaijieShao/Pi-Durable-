# Pi Durable Agents — GCP infrastructure

Source: the [v64 Architecture](https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/architecture.html),
[Deployment](https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/deployment.html), and
[Capacity](https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/capacity.html) pages.

This folder prepares the single-VM GCP infrastructure. It does not install or start
the bot, Coordinator, Pi, watchdog application or task/evaluator containers, and it
does not change GitHub settings. The Coordinator source is outside this work.

## Reviewed configuration

| Setting | Value |
| --- | --- |
| Authorized gcloud account | `nkshao17@gmail.com` |
| Existing project | `project-9824d5fb-1d2b-4351-a2b` |
| Region / zone | `us-central1` / `us-central1-a` |
| VM | 1 continuously running `e2-standard-4`, 4 vCPU / 16 GiB |
| VM addressing | Private IPv4 only, dedicated custom VPC and subnet |
| SSH | IAP only, source `35.235.240.0/20`, TCP 22; OS Login |
| Outbound | 1 Cloud Router, 1 Public Cloud NAT, 1 reserved regional IPv4 |
| Boot disk | 20 GiB `pd-balanced`, Debian 12 |
| Task disk | 50 GiB `pd-balanced`, separate zonal disk, deletion protected in Terraform |
| VM identity | Dedicated service account, cloud-platform scope, no key file |
| Secrets | 3 empty Secret Manager containers; per-secret accessor grants to VM identity |

The [v64 Build Plan](https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/build-plan.html)
explicitly identifies this project. It is also the only project listed for the
authorized account and already has billing enabled. Region, zone, Debian version and disk class are implementation
choices, not v64 requirements. The 50 GiB task disk is a provisional budget;
v64 deliberately leaves its size to stress testing. These choices are shown in
the plan for owner review before any resources are created.

The project and billing relationship already exist. Terraform neither creates a
project nor changes billing. Existing default-network resources are untouched.
API enablement is included in the plan; APIs remain enabled on destroy.

## Plan, without applying

From this worktree:

```sh
cp infra/terraform.tfvars.example infra/terraform.tfvars
python3 infra/plan.py
```

The script refuses to proceed unless both configured and credentialed active
gcloud identities are exactly `nkshao17@gmail.com` and impersonation is unset.
It never switches accounts. It supplies a short-lived access token to Terraform
in memory, bypassing unrelated Application Default Credentials. Debug logging
is disabled. It runs init, format validation, configuration validation and plan;
there is no apply operation in the script.

Complete unabridged output is saved at `.context/terraform-plan.txt`, the saved
binary plan at `.context/infra.tfplan`, and inspectable plan JSON at
`.context/terraform-plan.json`. State is local to `infra/` and ignored; no remote
state bucket is provisioned. `.terraform.lock.hcl` records the selected provider.

**Wait for the owner's explicit yes before any apply.** Applying the reviewed
plan starts the VM and host preparation, so billing for VM time, both disks,
Cloud NAT, the reserved public IPv4 and any outbound traffic can begin. Terraform
plan lists resources and configuration; it does not quote dollar costs or cap
usage charges. Empty secret containers contain no values; adding versions and
accessing them later can have Secret Manager usage charges. No budget service,
backup, autoscaling, database, load balancer or object storage is added.

## Host preparation contract

The startup script only installs Docker and nftables, creates the canonical `pi-runner`,
`pi-coordinator` and `pi-watchdog` non-login users, mounts the task disk at `/mnt/pi-durable-tasks`, and configures:

- Task-disk root owned by `pi-coordinator:pi-coordinator` with mode `0750`, so the application can create its own
  `repo.git`, worktrees and scratch/snapshot directories. Docker/containerd children stay root-owned and private.
- Docker and containerd data under the task disk, with no default network bridge or container logs.
- Required mount dependencies and mount-point checks for Docker, containerd and the future
  `pi-durable-coordinator.service`; loss of the mount stops the services.
- An independent metadata firewall unit blocking all IPv4 and IPv6 metadata
  traffic from `pi-runner`, plus every non-loopback destination. The embedded rule is identical to
  `deploy/nftables/pi-durable-metadata.nft`, including the documented IPv4/IPv6 sets and denial counters.
- The canonical `pi-durable-runs.slice` with its CPU/memory/PID/network controls, identical to
  `deploy/systemd/pi-durable-runs.slice`, plus a drop-in requiring the metadata firewall. The firewall service
  disables ordinary service boot dependencies and starts after local filesystems, before slices, to avoid a
  `basic.target`/`slices.target` ordering cycle.
- Only the Coordinator and runner join `pi-durable`; the Coordinator joins `pi-watchdog` and Docker, the watchdog
  joins Docker, and the runner never joins Docker or the watchdog group. Existing unsafe runner membership fails
  preparation rather than silently accepting it.

Disk formatting is restricted to an attached disk without existing signatures.
An unknown filesystem or missing disk fails preparation. A 50 GiB task disk is
not a backup; no VM-loss or zone-loss recovery is claimed.

Application deployment remains separate and mandatory before any application service starts. Complete
`docs/isolation.md` and `docs/security.md` host setup: create the canonical `/var/lib/pi-durable` data,
conversations and runner-home layout with its documented ownership/modes and watchdog traversal ACL; install the
polkit rule, Node/Pi/application files and the Coordinator/watchdog units; supply separate owner-managed environment
files. This startup script does not provision those application prerequisites or start those units. Preserve the
slice metadata drop-in when installing the canonical slice asset, and keep `PI_TASK_DIR=/mnt/pi-durable-tasks`.
Linux requires `PI_RUNNER_ISOLATION=systemd`; the local process mode is refused.

Keep Docker control with the trusted Coordinator/watchdog, run every task/check/evaluator container with
`--network=none`, enforce resource and mount limits, and run the real Linux user/slice/cgroup/polkit/firewall,
mount-loss, independent-watchdog and v64 deployment checks. Those runtime behaviors have not been deployed or
verified by Terraform schema/syntax checks on a Mac. The task-disk size remains provisional; runtime disk-full
handling, per-container quotas and retention budgets remain application gaps. No secret is read by the startup
script. Merging this source does not run it: a later explicitly approved Terraform apply/VM startup would execute
host preparation and may start Docker/containerd, never the bot.

## Owner-managed secret values

After an approved infrastructure apply, the owner adds values directly in the
Google Cloud Secret Manager console, under these IDs:

- `pi-durable-telegram-token`
- `pi-durable-model-api-key`
- `pi-durable-github-token`

The GitHub token must be fine-grained for the intended repository, with contents
and pull-request access only. Never put a value in Terraform variables, metadata,
shell commands, files in this repository, outputs, logs or chat. There are no
`google_secret_manager_secret_version` resources or secret-value inputs.

The dedicated VM service account receives `roles/secretmanager.secretAccessor`
on exactly these three secrets, with no project-wide role. The named operator
receives instance-scoped OS Admin Login and IAP tunneling (port 22 condition),
plus permission to act as this VM service account for SSH. Existing project-owner
permissions remain unchanged.

Provider details: [Google provider](https://registry.terraform.io/providers/hashicorp/google/latest/docs),
[OS Login setup](https://docs.cloud.google.com/compute/docs/oslogin/set-up-oslogin),
[GCE metadata endpoints](https://docs.cloud.google.com/compute/docs/metadata/overview#metadata_server_endpoints).
