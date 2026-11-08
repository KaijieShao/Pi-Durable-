#!/usr/bin/env python3
"""Generate a reviewable local plan using only the explicitly authorized gcloud account."""

import os
from pathlib import Path
import subprocess
import sys


ACCOUNT = "nkshao17@gmail.com"
INFRA = Path(__file__).resolve().parent
ARTIFACTS = INFRA.parent / ".context"


def gcloud(*args: str) -> str:
    result = subprocess.run(
        ["gcloud", *args], check=True, text=True, capture_output=True,
        env={**os.environ, "CLOUDSDK_CORE_LOG_HTTP": "false"},
    )
    return result.stdout.strip()


def main() -> int:
    configured = gcloud("config", "get-value", "account")
    active = gcloud("auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
    impersonation = gcloud("config", "get-value", "auth/impersonate_service_account")
    if configured != ACCOUNT or active != ACCOUNT or impersonation not in ("", "(unset)"):
        sys.exit(f"Stopped: both active and configured accounts must be {ACCOUNT}, without impersonation.")

    print(f"Verified gcloud account: {ACCOUNT}", flush=True)
    # Never use ADC belonging to another login. The token stays in process memory.
    token = gcloud("auth", "print-access-token", f"--account={ACCOUNT}")
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("GOOGLE_", "GCLOUD_", "TF_LOG", "TF_CLI_ARGS", "TF_VAR_"))
        and key not in ("TF_DATA_DIR", "TF_WORKSPACE")
    }
    env["GOOGLE_OAUTH_ACCESS_TOKEN"] = token
    env["TF_IN_AUTOMATION"] = "1"
    env["TF_INPUT"] = "0"
    ARTIFACTS.mkdir(exist_ok=True)

    # This script deliberately has no apply path.
    for command in (
        ["init", "-input=false", "-no-color"],
        ["fmt", "-check", "-recursive"],
        ["validate", "-no-color"],
    ):
        subprocess.run(["terraform", *command], cwd=INFRA, env=env, check=True)

    plan_file = ARTIFACTS / "infra.tfplan"
    text_file = ARTIFACTS / "terraform-plan.txt"
    result = subprocess.run(
        ["terraform", "plan", "-input=false", "-no-color", "-detailed-exitcode",
         "-var-file=terraform.tfvars", f"-out={plan_file}"],
        cwd=INFRA, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    text_file.write_text(result.stdout)
    print(result.stdout, end="", flush=True)
    if result.returncode not in (0, 2):
        return result.returncode
    with (ARTIFACTS / "terraform-plan.json").open("w") as output:
        subprocess.run(
            ["terraform", "show", "-json", str(plan_file)],
            cwd=INFRA, env=env, stdout=output, check=True,
        )
    print(f"Full plan output: {text_file}")
    print("No apply was run. Explicit owner approval is required before any apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
