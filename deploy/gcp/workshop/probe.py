"""Read-only VM probe, piped over authenticated SSH by manage.py; no file writes or credential access."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import time

COORDINATOR = "pi-durable-workshop-coordinator.service"
WATCHDOG = "pi-durable-workshop-watchdog.service"
OTHER_POLLERS = ["pi-durable-coordinator.service", "pi-durable-acceptance-coordinator.service",
                 "pi-durable-acceptance-s2-coordinator.service", "pi-durable-acceptance-s3-coordinator.service"]
ENV_FILES = ["/opt/pi-durable-workshop/coordinator.env", "/opt/pi-durable-workshop/watchdog.env"]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unit_text(text):
    return "\n".join(line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")) + "\n"


def unit_state(unit):
    result = subprocess.run(["systemctl", "show", unit, "-p", "ActiveState", "-p", "MainPID", "-p", "UnitFileState",
                             "-p", "DropInPaths", "-p", "Restart", "-p", "FragmentPath", "-p", "NeedDaemonReload"], capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise RuntimeError("unit_query_failed")
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def environment(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        parsed = shlex.split(value, comments=True)
        values[key.strip()] = parsed[0] if len(parsed) == 1 else value.strip()
    return values


def task_hash(database):
    connection = sqlite3.connect("file:" + database + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    rows = [dict(row) for row in connection.execute("SELECT * FROM tasks ORDER BY id")]
    connection.close()
    return digest(json.dumps(rows, sort_keys=True).encode())


def controls_precede_process(pid, files):
    # Linux process start time, not a new invocation of the entry point.
    boot = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
    tail = Path("/proc/" + str(pid) + "/stat").read_text().rsplit(")", 1)[1].split()
    started = boot + int(tail[19]) / os.sysconf("SC_CLK_TCK")
    return all(Path(path).stat().st_mtime <= started + 2 for path in files)


def collect(manifest):
    artifacts = {}
    for file in manifest["files"]:
        path = Path(file["target"])
        data = path.read_bytes()
        if file["kind"] == "systemd":
            data = unit_text(data.decode()).encode()
        artifacts[file["template"]] = {"sha256": digest(data), "mode": oct(path.stat().st_mode & 0o777)}
    units = {unit: unit_state(unit) for unit in [COORDINATOR, WATCHDOG, *OTHER_POLLERS]}
    mount_file = next(f["target"] for f in manifest["files"] if f["template"].endswith(".mount.in"))
    mount_unit = Path(mount_file).name
    mount = unit_state(mount_unit)
    loaded = {COORDINATOR: "/etc/systemd/system/" + COORDINATOR,
              WATCHDOG: "/etc/systemd/system/" + WATCHDOG, mount_unit: mount_file}
    loaded_states = {**units, mount_unit: mount}
    target_stat = Path("/mnt/pi-durable-workshop").stat()
    source_stat = Path("/mnt/pi-durable-tasks/workshop-live").stat()
    config = environment(Path(ENV_FILES[0]))
    source = Path("/opt/pi-durable-workshop/start-workshop.mjs").read_text()
    guards = [(key, json.loads(value)) for key, value in re.findall(r'env\.([A-Z_0-9]+) !== ("[^"\n]*")', source)]
    checks = {"coordinator_active_enabled": units[COORDINATOR]["ActiveState"] == "active" and units[COORDINATOR]["UnitFileState"] == "enabled",
              "watchdog_active_enabled": units[WATCHDOG]["ActiveState"] == "active" and units[WATCHDOG]["UnitFileState"] == "enabled",
              "automatic_process_restart": all(units[u]["Restart"] == "always" for u in [COORDINATOR, WATCHDOG]),
              "no_workshop_dropins": all(not units[u]["DropInPaths"] for u in [COORDINATOR, WATCHDOG]),
              "one_vm_bot_poller": int(units[COORDINATOR]["MainPID"]) > 0 and all(units[u]["MainPID"] == "0" for u in OTHER_POLLERS),
              "general_stays_disabled": all(unit_state(u)["UnitFileState"] == "disabled" for u in [OTHER_POLLERS[0], "pi-durable-watchdog.service"]),
              "task_mount_present": os.path.ismount("/mnt/pi-durable-workshop"),
              "task_mount_active_enabled": mount["ActiveState"] == "active" and mount["UnitFileState"] == "enabled",
              "task_mount_source_matches": (target_stat.st_dev, target_stat.st_ino) == (source_stat.st_dev, source_stat.st_ino),
              "loaded_fragments_match": all(loaded_states[u]["FragmentPath"] == path for u, path in loaded.items()),
              "no_pending_daemon_reload": all(loaded_states[u]["NeedDaemonReload"] == "no" for u in loaded),
              "controls_precede_running_process": controls_precede_process(units[COORDINATOR]["MainPID"],
                   [f["target"] for f in manifest["files"]] + ENV_FILES + ["/opt/pi-durable/.deployed-commit"]),
              "entry_route_guards_match_private_config": len(guards) == 6 and all(config.get(k) == v for k, v in guards),
              "no_credential_variables_in_env_files": all(not ({"TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"} & environment(Path(p)).keys()) for p in ENV_FILES)}
    result = {"ok": True, "observed_at_ms": int(time.time() * 1000), "artifacts": artifacts,
              "environment_files": {p: {"sha256": digest(Path(p).read_bytes()), "mode": oct(Path(p).stat().st_mode & 0o777)} for p in ENV_FILES},
              "runtime_source_sha": Path("/opt/pi-durable/.deployed-commit").read_text().strip(), "checks": checks,
              "protected_general_tasks_sha256": task_hash("/var/lib/pi-durable/coordinator.sqlite")}
    return result


def run(manifest):
    try:
        print(json.dumps(collect(manifest)))
    except Exception as error:
        print(json.dumps({"ok": False, "error_type": type(error).__name__}))
        raise SystemExit(1)
