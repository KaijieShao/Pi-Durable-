# Agent container image: Node plus the confined file-operation helper, nothing else (no shell tools are used).
# Built offline from the local base image (scripts/build-images.sh); no package installs, no network at build.
# Containers run with --user <uid:gid>, --read-only, --network none, --cap-drop ALL (src/coordinator/sandbox/docker.ts).
FROM node:22-slim
COPY fsop.mjs /opt/pi-agent/fsop.mjs
RUN chmod 0555 /opt/pi-agent && chmod 0444 /opt/pi-agent/fsop.mjs
LABEL org.opencontainers.image.title="pi-durable-agent" \
	org.opencontainers.image.description="Pi Durable agent container: confined read/edit/write under /work"
WORKDIR /work
ENTRYPOINT []
CMD ["sleep", "infinity"]
