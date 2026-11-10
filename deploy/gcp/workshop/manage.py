#!/usr/bin/env python3
"""Render private Workshop assets or audit an existing VM. No install/start/stop/Terraform operation exists."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
MARKER = re.compile(r"\{\{(json|word|unit):([A-Z_0-9]+)\}\}")
CREDENTIAL = re.compile(r"github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|sk-proj-[A-Za-z0-9_-]{25,}|-----BEGIN .*PRIVATE KEY")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical_unit(text):
    """Compare every directive, including duplicate/reset directives; omit comments/blank lines only."""
    return "\n".join(line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")) + "\n"


def private_path(path):
    path = Path(path).resolve()
    if path.is_relative_to(REPO):
        raise ValueError("private_files_must_be_outside_checkout")
    return path


def read_bindings(path, manifest):
    path = private_path(path)
    if path.stat().st_mode & 0o077:
        raise ValueError("private_bindings_permissions_too_broad")
    values = json.loads(path.read_text())
    if set(values) != set(manifest["bindings"]):
        raise ValueError("binding_keys_do_not_match_manifest")
    if any(not isinstance(value, str) or CREDENTIAL.search(value) for value in values.values()):
        raise ValueError("bindings_must_not_contain_credentials")
    return values


def render_text(text, values):
    def replace(match):
        kind, key = match.groups()
        value = values[key]
        if kind == "json":
            return json.dumps(value)
        if kind == "word" and re.fullmatch(r"[A-Za-z0-9_.:-]+", value):
            return value
        if kind == "unit" and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:-]+", value):
            return value
        raise ValueError("unsafe_binding_syntax")
    result = MARKER.sub(replace, text)
    if "{{" in result or "}}" in result:
        raise ValueError("unresolved_template_marker")
    return result


def rendered(manifest, values):
    result = {}
    for file in manifest["files"]:
        source = (HERE / file["template"]).resolve()
        if not source.is_relative_to(HERE):
            raise ValueError("template_path_outside_assets")
        result[file["template"]] = render_text(source.read_text(), values)
    return result


def write_rendered(manifest, texts, destination):
    destination = private_path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    for file in manifest["files"]:
        target = destination / Path(file["target"]).relative_to("/")
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_text(texts[file["template"]])
        target.chmod(int(file["mode"], 8))


def compare(manifest, expected, texts, observed):
    checks = {}
    for file in manifest["files"]:
        name = file["template"]
        text = texts[name]
        digest = sha((canonical_unit(text) if file["kind"] == "systemd" else text).encode())
        checks[name] = digest == expected["artifacts"][name]["sha256"] == observed["artifacts"][name]["sha256"]
        checks[name + ":mode"] = file["mode"] == observed["artifacts"][name]["mode"]
    checks["private_environment_fingerprints"] = expected["environment_files"] == observed["environment_files"]
    checks["runtime_source"] = expected["runtime_source_sha"] == observed["runtime_source_sha"] == values_source(texts)
    checks.update(observed["checks"])
    checks["vm_scheduling"] = expected.get("vm_scheduling") == observed.get("vm_scheduling")
    return {"ok": all(checks.values()), "checks": checks, "runtime_source_sha": observed["runtime_source_sha"],
            "observed_at_ms": observed["observed_at_ms"], "protected_general_tasks_sha256": observed["protected_general_tasks_sha256"], "changes_made": False}


def values_source(texts):
    match = re.search(r'readFileSync\([^\n]+\.trim\(\) !== "([a-f0-9]{40})"', texts["start-workshop.mjs.in"])
    if not match:
        raise ValueError("source_guard_not_found")
    return match.group(1)


def inspect_vm(args, manifest):
    probe = (HERE / "probe.py").read_text()
    payload = probe + "\nrun(" + repr(manifest) + ")\n"
    command = ["gcloud", "compute", "ssh", args.instance, "--project=" + args.project, "--zone=" + args.zone,
               "--account=" + args.account, "--tunnel-through-iap", "--quiet", "--verbosity=error",
               "--command=sudo python3 -"]
    result = subprocess.run(command, input=payload, text=True, capture_output=True, timeout=90,
                            env={**os.environ, "CLOUDSDK_CORE_LOG_HTTP": "false"})
    if result.returncode:
        raise RuntimeError("read_only_vm_probe_failed")
    observed = json.loads(result.stdout)
    if not observed.get("ok"):
        raise RuntimeError("read_only_vm_probe_failed")
    cloud = subprocess.run(["gcloud", "compute", "instances", "describe", args.instance,
                            "--project=" + args.project, "--zone=" + args.zone, "--account=" + args.account,
                            "--format=json(status,scheduling)", "--verbosity=error"],
                           capture_output=True, text=True, timeout=45,
                           env={**os.environ, "CLOUDSDK_CORE_LOG_HTTP": "false"})
    if cloud.returncode:
        raise RuntimeError("read_only_scheduling_query_failed")
    instance = json.loads(cloud.stdout)
    observed["checks"]["vm_running"] = instance["status"] == "RUNNING"
    observed["vm_scheduling"] = {key: instance["scheduling"].get(key) for key in
                               ["automaticRestart", "onHostMaintenance", "provisioningModel"]}
    return observed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["render", "verify", "inspect"])
    parser.add_argument("--bindings", required=True, help="Owner-only JSON outside checkout; names only in manifest")
    parser.add_argument("--output", help="New private render directory, or JSON audit result file")
    parser.add_argument("--snapshot", help="An earlier read-only probe result (verify only)")
    parser.add_argument("--snapshot-output", help="Save hashes/checks from a live read-only probe (inspect only)")
    for name in ["project", "zone", "instance", "account"]:
        parser.add_argument("--" + name)
    args = parser.parse_args()
    manifest = json.loads((HERE / "manifest.json").read_text())
    expected = json.loads((HERE / "profile-fingerprints.json").read_text())
    values = read_bindings(args.bindings, manifest)
    texts = rendered(manifest, values)
    if args.action == "render":
        if not args.output:
            parser.error("render requires --output")
        write_rendered(manifest, texts, args.output)
        print(json.dumps({"ok": True, "rendered_files": len(texts), "installed": False}))
        return 0
    if args.action == "inspect":
        if not all(getattr(args, key) for key in ["project", "zone", "instance", "account"]):
            parser.error("inspect requires explicit project, zone, instance and account")
        observed = inspect_vm(args, manifest)
        if args.snapshot_output:
            snapshot_output = Path(args.snapshot_output)
            snapshot_output.write_text(json.dumps(observed, indent=2) + "\n")
            snapshot_output.chmod(0o600)
    else:
        if not args.snapshot:
            parser.error("verify requires --snapshot")
        observed = json.loads(Path(args.snapshot).read_text())
    report = compare(manifest, expected, texts, observed)
    if args.output:
        output = Path(args.output)
        output.write_text(json.dumps(report, indent=2) + "\n")
        output.chmod(0o600)
    print(json.dumps(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # Do not print source/binding values, subprocess stderr, URLs or raw exceptions.
        print(json.dumps({"ok": False, "error_type": type(error).__name__, "details_suppressed": True}), file=sys.stderr)
        raise SystemExit(1)
