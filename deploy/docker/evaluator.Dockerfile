# Evaluator image: the trusted grader of the sealed snapshot (Architecture § Isolated evaluator). Node, the launcher
# and its fixed suite list (suites.json: each module's hidden tests, the integration test, the baseline suite), nothing
# else. Built offline from the local base image (scripts/build-images.sh); no package installs, no network at build.
# Containers run with --user <uid:gid>, --read-only, --network none, --cap-drop ALL, 2 vCPU / 2 GiB, the snapshot and
# the hidden tests mounted read-only and a scratch directory (src/coordinator/sandbox/evaluator.ts).
FROM node:22-slim
COPY run-eval.mjs suites.json /opt/pi-eval/
RUN chmod 0555 /opt/pi-eval && chmod 0444 /opt/pi-eval/run-eval.mjs /opt/pi-eval/suites.json
LABEL org.opencontainers.image.title="pi-durable-evaluator" \
	org.opencontainers.image.description="Pi Durable evaluator: grades the sealed snapshot with the hidden tests, one suite at a time"
WORKDIR /scratch
ENTRYPOINT []
CMD ["node", "/opt/pi-eval/run-eval.mjs"]
