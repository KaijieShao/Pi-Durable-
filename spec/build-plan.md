---
title: "Pi Durable Agents"
slug: pi-durable-agents-0rrc3e
version: 64
htmlUrl: https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/build-plan.html
reviewUrl: https://artifact.cafe/a/pi-durable-agents-0rrc3e
---
[Skip to content](#main)

[Pi Durable Agents](requirements.html)

[Docs](requirements.html)[Changelog](changelog.html)[Build plan](build-plan.html)

# Build Plan

What we coordinate to get the backend working on GCP and tested in the Smule Dev group. The goal is a working GCP deployment with a recording of a real end-to-end test. Secrets are entered only in 1:1 chats or directly in Secret Manager.

| #  | Item                                                                                                                                                                 | Owner                          | Status                                                           |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| 1  | Build: scaffold changes, /task to pull request, /approve and merge, tests, GCP deploy scripts                                                                        | System Design School           | In progress                                                      |
| 2  | Review the code and tests against the docs                                                                                                                           | Newsletter                     | After 1                                                          |
| 3  | Choose the model provider and the GitHub test repo                                                                                                                   | Nick                           | Needed                                                           |
| 4  | Verify GCP project and deployment permissions                                                                                                                        | Smule                          | Done: project-9824d5fb-1d2b-4351-a2b, Compute Engine API enabled |
| 5  | Provision GCP as in Deployment: VM, task disk, Cloud NAT, IAP, service account, Secret Manager                                                                       | Smule                          | Waiting for the deploy script from 1                             |
| 6  | Store the 3 secrets in Secret Manager: Smule Dev bot token, model key, GitHub token for the test repo                                                                | Nick and Smule                 | After 3 and 5                                                    |
| 7  | Confirm which updates reach @smule\_code\_bot: /task, /task@smule\_code\_bot and replies                                                                             | Smule                          | After 9                                                          |
| 8  | Package the build for the VM                                                                                                                                         | System Design School           | After 2                                                          |
| 9  | Deploy to the VM and run a smoke test                                                                                                                                | Smule and System Design School | After 5, 6 and 8                                                 |
| 10 | Smoke test in Smule Dev: /task to pull request, follow-up, /status and /cancel                                                                                       | Smule                          | After 7 and 9                                                    |
| 11 | Final acceptance test in Smule Dev, recorded with no secrets on screen: /task, follow-up, /approve and merge, and an approval rejected after the head commit changes | Smule                          | After 10                                                         |
| 12 | Check the test evidence against the docs                                                                                                                             | Newsletter                     | After 11                                                         |
