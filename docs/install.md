# Installing

The Coordinator is not packaged for servers yet. To run it, follow [RUN-LOCAL.md](../RUN-LOCAL.md): `npm ci`, build
the container images with `scripts/build-images.sh`, configure a private env file from
[.env.example](../.env.example), then start the watchdog, `node src/cli/main.ts watchdog --env-file <file>`, and in a
second terminal the Coordinator, `node src/cli/main.ts run --env-file <file>` (or `node dist/cli/main.js …` after
`npm run build`). Without a running watchdog the Coordinator queues commands but starts no task.

`npm ci` runs no lifecycle script of this package any more: the `postinstall` patch of Pi Durable's authentication
retry is removed, and Pi Durable 1.5.0 is used unmodified.

The GCP deployment described in [spec/deployment.md](../spec/deployment.md) (VM, task disk, Cloud NAT, IAP, Secret
Manager) is not built yet. The systemd units for a Linux host are in `deploy/systemd/`: the Pi slice, the watchdog
(`pi-durable-watchdog.service`), the Coordinator (`pi-durable-coordinator.service`) and a Docker drop-in for the task
disk; the host setup is in [isolation.md](isolation.md) and [security.md](security.md#the-watchdog). The one-command installer `install.sh`, the
setup skill in `skills/` and the systemd user unit in `deploy/pi-durable-telegram.service` belong to the earlier
private-chat bot and do not install the Coordinator.

Exit codes of `run`: 0 clean shutdown, 1 fatal error, 2 configuration error or a rejected bot token, 3 the data
directory is used by another running Coordinator. A service manager should not restart it on 2 or 3. Exit codes of
`watchdog`: 0 clean shutdown, 1 fatal error, 2 configuration error (do not restart it on 2).

---

Back to the [README](../README.md).
