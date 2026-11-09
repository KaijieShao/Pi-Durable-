#!/bin/bash
# GCE host preparation only. Never fetch credentials or install/start the bot here.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

task_device=/dev/disk/by-id/google-pi-durable-tasks
task_mount=/mnt/pi-durable-tasks

# Prevent package installation from starting Docker before storage is ready.
systemctl mask containerd.service docker.service docker.socket
apt-get -o Acquire::Retries=5 update
apt-get -o Acquire::Retries=5 install -y --no-install-recommends docker.io docker-cli nftables

# Match the application units, runner policy and polkit rule exactly. These users have no login shell.
getent group pi-durable >/dev/null || groupadd --system pi-durable
for account in pi-runner pi-coordinator pi-watchdog; do
  getent group "$account" >/dev/null || groupadd --system "$account"
  id "$account" >/dev/null 2>&1 || useradd --system --gid "$account" --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin "$account"
  test "$(id -u "$account")" -ne 0
done
usermod -aG pi-durable pi-runner
usermod -aG pi-durable,pi-watchdog,docker pi-coordinator
usermod -aG docker pi-watchdog
# An existing unsafe runner account is a hard failure; never grant it Docker or shared watchdog-state access.
for group in $(id -nG pi-runner); do
  if [[ "$group" == docker || "$group" == pi-watchdog ]]; then
    echo 'Refusing an existing Pi runner with privileged supplementary groups.' >&2
    exit 1
  fi
done

# A missing/unknown disk is a hard failure, never a fallback onto the boot disk.
udevadm settle
test -b "$task_device"
disk_type=$(blkid -p -s TYPE -o value "$task_device" || true)
if [[ -z "$disk_type" ]]; then
  signatures=$(wipefs --no-act --noheadings --output TYPE "$task_device")
  test -z "$signatures"
  mkfs.ext4 "$task_device"
elif [[ "$disk_type" != ext4 ]]; then
  echo 'Refusing to change an existing task-disk filesystem.' >&2
  exit 1
fi

mkdir -p "$task_mount" /etc/pi-durable /etc/docker /etc/containerd
mount_unit=$(systemd-escape --path --suffix=mount "$task_mount")
cat >"/etc/systemd/system/$mount_unit" <<EOF
[Unit]
Description=Pi Durable separate task disk

[Mount]
What=$task_device
Where=$task_mount
Type=ext4
Options=defaults,nodev,nosuid
TimeoutSec=60

[Install]
WantedBy=multi-user.target
EOF

# Keep this embedded asset identical to deploy/nftables/pi-durable-metadata.nft.
cat >/etc/pi-durable/metadata.nft <<'EOF'
#!/usr/sbin/nft -f
# Pi Durable: the host firewall rule of spec/deployment.md § Network ("The metadata server is blocked for the Pi user
# by a host firewall rule covering every configured metadata address. This is verified at deployment.").
#
# For traffic sent by the Pi user (pi-runner): drop every metadata address below (counted, so the deployment check
# shows the hits), then everything that does not leave through loopback. The second rule backs the per-unit IP
# filter (IPAddressDeny=any, IPAddressAllow=localhost), which systemd silently skips on kernels without cgroup BPF.
# Pi needs only 127.0.0.1 (the relay). Install, load at boot and verify: docs/isolation.md.
#
# Metadata addresses: 169.254.169.254 (GCE; metadata.google.internal resolves to it, check with
# `getent hosts metadata.google.internal`), fd20:ce::254 (GCE IPv6), fd00:ec2::254 (AWS IPv6). Add any other
# metadata address configured on your host to the sets. The user must exist when this file is loaded.

table inet pi_durable
delete table inet pi_durable

table inet pi_durable {
	set metadata_v4 {
		type ipv4_addr
		elements = { 169.254.169.254 }
	}

	set metadata_v6 {
		type ipv6_addr
		elements = { fd20:ce::254, fd00:ec2::254 }
	}

	chain output {
		type filter hook output priority filter; policy accept;
		meta skuid "pi-runner" ip daddr @metadata_v4 counter drop comment "metadata server: never for the Pi user"
		meta skuid "pi-runner" ip6 daddr @metadata_v6 counter drop comment "metadata server: never for the Pi user"
		meta skuid "pi-runner" oifname != "lo" counter drop comment "the Pi user reaches loopback only"
	}
}
EOF
cat >/etc/systemd/system/pi-durable-metadata.service <<'EOF'
[Unit]
Description=Block all GCE metadata traffic from the unprivileged Pi user
# The runs slice precedes slices.target/basic.target. Avoid a default After=basic.target boot cycle.
DefaultDependencies=no
After=local-fs.target
Before=slices.target pi-durable-runs.slice pi-durable-coordinator.service shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/pi-durable/metadata.nft
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

# Keep the canonical runtime slice controls; add host-only firewall ordering in a drop-in.
# Embedded asset: deploy/systemd/pi-durable-runs.slice.
cat >/etc/systemd/system/pi-durable-runs.slice <<'EOF'
# Pi Durable: the dedicated slice of the Pi processes (spec/deployment.md § Processes: "Pi processes run as their own
# unprivileged user in a dedicated systemd slice"). The Coordinator starts every run as one transient unit
#   pi-run-<deployment>-r<run>-g<generation>.service
# in this slice, as the Pi user, with systemd-run (src/coordinator/runner-systemd.ts). Install and verify: see
# docs/isolation.md. The Coordinator refuses to run tasks while this slice is not loaded (fails closed).
#
#   sudo install -m 0644 deploy/systemd/pi-durable-runs.slice /etc/systemd/system/
#   sudo systemctl daemon-reload
#   systemctl show --property=LoadState --value pi-durable-runs.slice     # loaded
#
# Dashes are the slice hierarchy: this slice lives at pi.slice/pi-durable.slice/pi-durable-runs.slice.

[Unit]
Description=Pi Durable: Pi processes (one transient unit per run)
Before=slices.target

[Slice]
# Budget of all Pi processes together, inside the host reserve of spec/capacity.md (Coordinator, watchdog, the
# concurrent Pi processes and Docker share 1 vCPU and 2 GiB). Provisional, to be validated by the stress test. Each
# unit has its own MemoryMax=512M, TasksMax=64 and RuntimeMaxSec = run deadline + 60 s on top.
CPUAccounting=yes
CPUQuota=100%
MemoryAccounting=yes
MemoryMax=1G
TasksAccounting=yes
TasksMax=256
# The same IP filter as every unit (loopback only: the relay is on 127.0.0.1), at the slice level too.
IPAccounting=yes
IPAddressDeny=any
IPAddressAllow=localhost
EOF
mkdir -p /etc/systemd/system/pi-durable-runs.slice.d
cat >/etc/systemd/system/pi-durable-runs.slice.d/10-metadata.conf <<'EOF'
[Unit]
Requires=pi-durable-metadata.service
After=pi-durable-metadata.service
EOF

mkdir -p /etc/systemd/system/containerd.service.d /etc/systemd/system/docker.service.d /etc/systemd/system/pi-durable-coordinator.service.d
for unit in containerd.service docker.service pi-durable-coordinator.service; do
  cat >"/etc/systemd/system/$unit.d/10-task-disk.conf" <<EOF
[Unit]
RequiresMountsFor=$task_mount
BindsTo=$mount_unit
After=$mount_unit
ConditionPathIsMountPoint=$task_mount
EOF
done
cat >/etc/systemd/system/pi-durable-coordinator.service.d/20-metadata.conf <<'EOF'
[Unit]
Requires=pi-durable-metadata.service
After=pi-durable-metadata.service
EOF

cat >/etc/docker/daemon.json <<'EOF'
{
  "data-root": "/mnt/pi-durable-tasks/docker",
  "bridge": "none",
  "log-driver": "none"
}
EOF

cat >/etc/containerd/config.toml <<'EOF'
version = 2
root = "/mnt/pi-durable-tasks/containerd"
state = "/run/containerd"
EOF

systemctl daemon-reload
systemctl enable --now "$mount_unit" pi-durable-metadata.service
mountpoint -q "$task_mount"
# The application creates repo.git, worktrees, scratch, snapshots and eval-scratch below this root.
# Docker/containerd remain root-owned private children; the runner has no access to this tree.
chown pi-coordinator:pi-coordinator "$task_mount"
chmod 0750 "$task_mount"
# A retained task disk can carry the previous OS's numeric application uid/gid.
# Restore application-owned trees only; Docker/containerd remain root-owned.
for application_dir in repo.git git-home worktrees repository check-scratch build scratch snapshots eval-scratch; do
  application_path="$task_mount/$application_dir"
  if [[ -d "$application_path" && ! -L "$application_path" ]]; then
    chown -R --no-dereference pi-coordinator:pi-coordinator "$application_path"
  fi
done
install -d -o root -g root -m 0700 "$task_mount/docker" "$task_mount/containerd"
systemctl unmask containerd.service docker.service docker.socket
systemctl enable --now containerd.service docker.service
# No Coordinator/watchdog implementation, Pi installation or application workloads.
