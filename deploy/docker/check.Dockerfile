# Check container image: the pinned run_check launcher and its fixed operation list (ops.json), outside any worktree.
# Dependencies for checks come from this image only (containers have no network). Built offline from the local base
# image (scripts/build-images.sh); no package installs, no network at build.
FROM node:22-slim
COPY run-check.mjs ops.json /opt/pi-check/
RUN chmod 0555 /opt/pi-check && chmod 0444 /opt/pi-check/run-check.mjs /opt/pi-check/ops.json
LABEL org.opencontainers.image.title="pi-durable-check" \
	org.opencontainers.image.description="Pi Durable check container: run-check launcher and fixed operation list"
WORKDIR /work
ENTRYPOINT []
CMD ["node", "/opt/pi-check/run-check.mjs"]
