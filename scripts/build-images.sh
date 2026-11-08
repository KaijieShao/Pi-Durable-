#!/bin/sh
# Build the agent and check images offline from the local node:22-slim base (no pull, no network during the build).
# Usage: scripts/build-images.sh   (env: DOCKER_BIN, AGENT_IMAGE, CHECK_IMAGE, BASE_IMAGE to override the defaults)
# Prints the image IDs and the base image digest; record them in RUN-LOCAL.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
docker_bin=${DOCKER_BIN:-docker}
agent_image=${AGENT_IMAGE:-pi-durable-agent:demo}
check_image=${CHECK_IMAGE:-pi-durable-check:demo}
base_image=${BASE_IMAGE:-node:22-slim}
context="$root/deploy/docker"

if ! "$docker_bin" image inspect "$base_image" >/dev/null 2>&1; then
	echo "build-images: base image $base_image is not present locally (pull it once: docker pull $base_image)" >&2
	exit 1
fi

build() {
	"$docker_bin" build --quiet --pull=false --network none -f "$context/$1" -t "$2" "$context" >/dev/null
}

build agent.Dockerfile "$agent_image"
build check.Dockerfile "$check_image"

base_digest=$("$docker_bin" image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' "$base_image")
echo "base  $base_image $base_digest"
echo "agent $agent_image $("$docker_bin" image inspect --format '{{.Id}}' "$agent_image")"
echo "check $check_image $("$docker_bin" image inspect --format '{{.Id}}' "$check_image")"
