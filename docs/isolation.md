# Pi process isolation

[spec/deployment.md](../spec/deployment.md) § Processes: "Pi processes run as their own unprivileged user in a
dedicated systemd slice." § Network: "only the relay holds the real model key, and Pi gets only its run key", and
"the metadata server is blocked for the Pi user by a host firewall rule covering every configured metadata address.
This is verified at deployment." § Logs: raw content lives in Pi's store, "readable only by the Pi and Coordinator
users".

Each run gets one Pi process (src/runner/main.ts). `PI_RUNNER_ISOLATION` chooses how it is started:

- **`systemd`**, the default on Linux and the deployment mode. src/coordinator/runner-systemd.ts.
- **`process`**, the default elsewhere (macOS). It is the weaker local mode. src/coordinator/runner-launcher.ts.

## What differs

| | `systemd` (Linux) | `process` (Mac, local) |
|---|---|---|
| User | Its own unprivileged user, `PI_RUNNER_USER` (`pi-runner`), and group `PI_RUNNER_GROUP` (`pi-durable`). Never root, never the Coordinator's user | The Coordinator's own user |
| Where it runs | One transient unit per run, `pi-run-<deployment>-r<run>-g<generation>.service`, in the slice `PI_RUNNER_SLICE` (`pi-durable-runs.slice`), started with `systemd-run --pipe --wait --collect` | A child process of the Coordinator in its own process group |
| Channel | Newline-delimited JSON frames on stdin/stdout (src/runner/frames.ts). Stdout carries only frames | Node IPC |
| Run key | The first stdin frame. It is never in argv, the environment or the unit's properties | `OPENAI_API_KEY` in the child's environment, removed by the runner as soon as it starts |
| Other secrets | None | None |
| Filesystem | `ProtectSystem=strict` (read-only system), `ProtectHome=yes`, `PrivateTmp`, `PrivateDevices`, `ProtectProc=invisible`. Only the conversations directory and the Pi home are writable | Everything your user can read and write |
| Network | `IPAddressDeny=any` and `IPAddressAllow=localhost` on each unit and on the slice: Pi reaches only 127.0.0.1, where the relay is. On top of that, the host nftables rule drops the Pi user's metadata traffic and everything else not on loopback | Your user's network. Pi uses only the relay on 127.0.0.1, but nothing enforces that |
| Privileges | `NoNewPrivileges`, an empty capability bounding set, `RestrictNamespaces`, `RestrictSUIDSGID`, `LockPersonality`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` | Your user's privileges |
| Limits | Per unit: `MemoryMax=512M`, `TasksMax=64`, `RuntimeMaxSec` = run deadline + 60 s (an independent stop). The slice carries a budget for all Pi processes together. The runner also exits on its own at deadline + 30 s | Only the runner's own exit at deadline + 30 s |
| Conversation files | `<PI_DATA_DIR>/conversations` is `pi-coordinator:pi-durable` with mode 2770. Files are 0660, so only the Pi and Coordinator users can read them (`UMask=0007`) | Mode 0600 files in 0700 directories: only your user |
| Coordinator database | 0600, while `PI_DATA_DIR` is 0710: the Pi group can traverse the directory but not list it or read the database | 0600 in a 0700 directory |
| Finding a process again | By unit name: the unit is derived from the run's row (run id and generation). `systemctl show` gives its `ActiveState`. Restart cleanup also lists every unit `pi-run-<deployment>-*` | By the recorded pid, accepted only if `ps` shows the runner with this deployment's and this run's markers. Restart cleanup also lists every process with this deployment's markers |
| Kill | `systemctl kill --signal=SIGKILL <unit>` (every process in the unit's control group, including any child that left its session) plus the systemd-run client, whose stdin is closed (a unit that systemd starts only after the kill reads EOF and exits). A stop counts as confirmed only once systemd reports the unit inactive | SIGKILL of the process group. A descendant that left the group with `setsid` would escape it; the runner starts no processes of its own (tools run in containers) |
| Fails closed | No run starts unless: the host is Linux; systemd-run and systemctl exist; the slice is loaded; node and the runner are not under a home directory; the data directory layout below is in place; the Pi user exists and is neither uid 0 nor the Coordinator's uid (whatever its name), and the Pi group exists, is not gid 0 and owns the conversations directory. The group is told once | Only the container check applies |

Both modes pass markers in argv that carry no secret: `--pi-durable-deployment=<first 16 hex digits of
sha256(PI_DATA_DIR)>` and `--pi-durable-run=<run id>`. The runner refuses a start message for another run. On a Mac,
the markers are how the Pi processes of a deployment are found:

```sh
pgrep -fl -- --pi-durable-deployment=      # all Pi processes, of every local deployment
```

On Linux, the units are listed with `systemctl list-units 'pi-run-*'` or
`systemd-cgls /pi.slice/pi-durable.slice/pi-durable-runs.slice`.

Restart cleanup (recovery step 2, at startup and again at the recheck after the owner unfreezes a group) runs in both
modes. It kills the Pi process of every run the database shows in progress, then every other Pi process of this
deployment, whatever run it served: under systemd every unit named `pi-run-<deployment>-*` (in practice everything in
the slice), in the process mode every process carrying this deployment's markers. It verifies each one is gone; if
that cannot be confirmed, or the units or processes cannot be listed, the group freezes. Another deployment's units
or processes are never touched. Doing this from a separate watchdog unit that survives the Coordinator is not built
yet.

## What is verified where

- **In `npm test`, on any POSIX host.** The tests use stand-ins for systemd-run and systemctl
  (test/helpers/systemd-shims.ts). They check:
  - the unit's arguments (name, slice, user, group, every sandbox and limit property, markers);
  - that the run key is in no argument, environment variable or property, only in the first stdin frame;
  - a complete run of the real runner over stdio (tool call, steer, finished);
  - kill through `systemctl kill`, and that `exited` waits for the unit to be gone, also for a unit that runs apart
    from its client and that `systemctl kill` missed (it exits on the closed stdin);
  - restart cleanup of a unit that outlived its Coordinator and of every other unit (or marked process) of this
    deployment, never another deployment's, at restart and at the recheck after an unfreeze, and the freeze when
    systemctl cannot tell;
  - failing closed when the isolation is unusable;
  - `/task` to review through the whole stack (test/runner/systemd.test.ts, test/e2e/isolation.test.ts).
- **Only on Linux, at deployment.** That the process really runs as the Pi user, in the slice. That it reaches
  127.0.0.1 but not the metadata server or an outside address. That it can write only its own directories and
  cannot read the Coordinator's database. That killing a unit also kills a child that escaped its session. That a
  unit outside the slice and without any IP filter (the slice's filter applies to every unit in it) still cannot
  reach the metadata server, so the host firewall rule holds on its own. That the polkit rule lets the Coordinator
  user do exactly this.
  All of these are covered by test/runner/systemd-linux.test.ts ([Verify](#verify-at-deployment)).
- **Not on a Mac at all.** In `process` mode there is no separate user, no slice, no per-unit IP filter and no
  metadata block. Pi processes run as your user and can reach whatever your user can reach.

## One-time host setup (Linux)

Run as root once. The commands use the default names and `PI_DATA_DIR=/var/lib/pi-durable`. Provisioning the VM
itself (GCP) is not covered here.

1. Users and the shared group. The Coordinator and Pi users are system users without a login shell. Only these two
   users belong to `pi-durable`.

   ```sh
   groupadd --system pi-durable
   useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pi-coordinator
   useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pi-runner
   usermod --append --groups pi-durable pi-coordinator
   usermod --append --groups pi-durable pi-runner
   ```

2. Directories and modes. The Coordinator checks these at startup and refuses to run tasks if they are wrong.

   ```sh
   # PI_DATA_DIR: the Pi group may traverse it, nothing more (the Coordinator keeps it at 0710).
   install -d -o pi-coordinator -g pi-durable -m 0710 /var/lib/pi-durable
   # Pi's conversation stores: shared by the two users only; new files keep the group (setgid).
   install -d -o pi-coordinator -g pi-durable -m 2770 /var/lib/pi-durable/conversations
   # HOME and working directory of the Pi processes.
   install -d -o pi-runner -g pi-runner -m 0700 /var/lib/pi-durable/run-home
   # PI_TASK_DIR (git repository, worktrees): the Coordinator's only, never the Pi group.
   install -d -o pi-coordinator -g pi-coordinator -m 0750 /mnt/pi-durable-tasks
   ```

3. Install the application and Node outside `/home`, `/root` and `/run/user`. `ProtectHome` hides those paths from
   the Pi user, and the Coordinator refuses a runner or node that lives there (for example nvm's `~/.nvm`). Use a
   location the Pi user can read: for example `/opt/pi-durable`, owned by root with mode 0755, and the
   distribution's `node` or one in `/usr/local`.

4. The slice, the polkit rule and the firewall rule.

   ```sh
   install -m 0644 deploy/systemd/pi-durable-runs.slice /etc/systemd/system/
   systemctl daemon-reload
   install -m 0644 deploy/polkit/50-pi-durable.rules /etc/polkit-1/rules.d/
   install -d /etc/nftables.d
   install -m 0644 deploy/nftables/pi-durable-metadata.nft /etc/nftables.d/
   nft -f /etc/nftables.d/pi-durable-metadata.nft
   # Load it at boot. On Debian, /etc/nftables.conf is loaded by nftables.service; add this line to it:
   #   include "/etc/nftables.d/pi-durable-metadata.nft"
   systemctl enable nftables
   ```

   - The polkit rule lets only `pi-coordinator` start, stop and kill units named `pi-run-<hex>-r<n>-g<n>.service`.
     It allows nothing else. If your Coordinator user has another name, edit `COORDINATOR` in the rule. polkit sees
     only the unit name and the verb, not the unit's properties, so whoever controls `pi-coordinator` can start such a
     unit as any user. Treat that account as privileged. The Coordinator is a trusted component (Architecture § Trust
     Boundaries).
   - The firewall rule matches the Pi user by name, so load it after step 1. It covers 169.254.169.254
     (`metadata.google.internal`), fd20:ce::254 and fd00:ec2::254. Add any other metadata address your host
     configures. `getent hosts metadata.google.internal` must print an address that is in the rule.

5. The Coordinator's own service runs as `User=pi-coordinator`, with `pi-durable` among its groups (step 1, or
   `SupplementaryGroups=pi-durable`) and `UMask=0077`. Its environment has `PI_DATA_DIR=/var/lib/pi-durable` and
   `PI_TASK_DIR=/mnt/pi-durable-tasks`; leave `PI_RUNNER_ISOLATION` unset (it defaults to `systemd` on Linux). The
   Coordinator talks to systemd over D-Bus, so do not sandbox `AF_UNIX` away from its unit. A unit file for the
   Coordinator and the watchdog unit are not part of this change.

## Verify at deployment

1. The startup log shows `isolation=systemd` and no `runner_isolation_unavailable` line. If the group gets "Task
   execution is paused: Pi process isolation is unavailable", the log line `runner_isolation_unavailable reason=…`
   names the missing piece.

2. The Linux deployment test. Prepare a data directory with the same layout as in step 2 under another path, then
   run the test as the Coordinator user, from the installed tree (not under `/home`):

   ```sh
   install -d -o pi-coordinator -g pi-durable -m 0710 /var/lib/pi-durable-test
   install -d -o pi-coordinator -g pi-durable -m 2770 /var/lib/pi-durable-test/conversations
   install -d -o pi-runner -g pi-runner -m 0700 /var/lib/pi-durable-test/run-home
   cd /opt/pi-durable
   sudo -u pi-coordinator env PI_SYSTEMD_TESTS=1 PI_SYSTEMD_TEST_DATA_DIR=/var/lib/pi-durable-test \
     node --test --test-concurrency=1 test/runner/systemd-linux.test.ts
   ```

   All six tests must pass, not be skipped. Among them: the metadata server and an outside address are unreachable
   from a unit, and also from a unit outside the slice without any IP filter (the firewall rule alone); a child that
   escaped its session dies with the unit.

3. The firewall rule on its own, as the Pi user outside any unit:

   ```sh
   sudo -u pi-runner curl -sS -m 3 -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/ \
     && echo "NOT BLOCKED"   # must fail, printing a timeout or "Operation not permitted"
   nft list table inet pi_durable   # the metadata counters went up
   ```

## Caveats

- `IPAddressDeny=` and `IPAddressAllow=` need cgroup v2 with BPF. Without it, systemd logs a warning and does not
  filter. The firewall rule (metadata addresses, loopback only) still applies to the Pi user.
- Each polkit check sees the unit name and verb only (see step 4).
- The slice name's dashes are its hierarchy: `pi-durable-runs.slice` sits under `pi-durable.slice` and `pi.slice`.
- The `process` mode can be chosen on Linux too (`PI_RUNNER_ISOLATION=process`). It logs `runner_isolation_weak` and
  gives up all of the separation above; it is meant for development only.

---

Back to [security](security.md) or the [README](../README.md).
