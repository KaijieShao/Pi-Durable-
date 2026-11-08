# Installing

The Coordinator is not packaged for servers yet. To run it, follow [RUN-LOCAL.md](../RUN-LOCAL.md): `npm ci`, build
the container images with `scripts/build-images.sh`, configure a private env file from
[.env.example](../.env.example), then `node src/cli/main.ts run --env-file <file>` (or `node dist/cli/main.js run`
after `npm run build`).

`npm ci` runs no lifecycle script of this package any more: the `postinstall` patch of Pi Durable's authentication
retry is removed, and Pi Durable 1.5.0 is used unmodified.

The GCP deployment described in [spec/deployment.md](../spec/deployment.md) (VM, task disk, Cloud NAT, IAP, Secret
Manager, watchdog and coordinator systemd units) is not built yet. The one-command installer `install.sh`, the
setup skill in `skills/` and the systemd user unit in `deploy/pi-durable-telegram.service` belong to the earlier
private-chat bot and do not install the Coordinator.

Exit codes of `run`: 0 clean shutdown, 1 fatal error, 2 configuration error or a rejected bot token, 3 the data
directory is used by another running Coordinator. A service manager should not restart it on 2 or 3.

---

Back to the [README](../README.md).
