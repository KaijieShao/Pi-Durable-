# One trusted full-Node test harness and one separate untrusted full-Node application are launched from this pinned
# image. The Coordinator supplies disjoint mounts and mediated pipes; neither container sees the Docker socket.
FROM node:22-slim
COPY run-eval.mjs eval-tests.mjs app-client.mjs eval-app.mjs eval-proxy.mjs suites.json /opt/pi-eval/
RUN chmod 0555 /opt/pi-eval && chmod 0444 /opt/pi-eval/*.mjs /opt/pi-eval/suites.json
LABEL org.opencontainers.image.title="pi-durable-evaluator" \
	org.opencontainers.image.description="Trusted full Node hidden tests observing an independently isolated full Node application"
WORKDIR /scratch
ENTRYPOINT []
CMD ["node", "/opt/pi-eval/run-eval.mjs"]
