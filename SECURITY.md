# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/smixs/pi-durable-telegram/security/advisories/new).
Do not open a public issue for a security problem. Include the version, what an attacker can do, and the steps to
reproduce.

## Supported versions

Only the latest published version gets fixes.

## Threat model in short

- The agent's `bash` tool is a full shell under the service user. The allow-list of Telegram user ids
  (`TELEGRAM_ALLOWED_USER_IDS`) is the boundary: anyone on it can run commands on the server.
- Messages from users outside the allow-list must never reach the model, the disk or the transcription service. A
  bypass of that rule is a vulnerability.
- Secrets (bot token, provider keys, OAuth credentials) must not appear in logs, in the shell's environment or in
  Telegram messages written by the daemon. A leak through any of those paths is a vulnerability.
- Prompt injection through content the user forwards or asks the agent to read is a known, accepted risk of any
  agent with a shell; forwarded messages are marked as third-party content to lower it.
