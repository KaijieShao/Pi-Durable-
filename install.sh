#!/usr/bin/env bash
# pi-durable telegram installer.
#
#   curl -fsSL https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/install.sh | bash
#
# Installs the official pi from pi.dev, lets you log in with pi's own /login, installs the pi-durable-telegram
# daemon from the latest GitHub release, connects your Telegram bot and starts it as a systemd user service.
# Run it as the user the agent should work as, not as root.
#
# Unattended use (all optional): PDT_YES=1 PDT_BOT_TOKEN=... PDT_USER_ID=... PDT_DEEPGRAM_API_KEY=...
# PDT_WORKDIR=... PDT_ARCHIVE_URL=... PDT_TELEGRAM_API=...

set -euo pipefail

ARCHIVE_URL="${PDT_ARCHIVE_URL:-https://github.com/smixs/pi-durable-telegram/releases/latest/download/pi-durable-telegram.tgz}"
PI_INSTALLER_URL="https://pi.dev/install.sh"
TG_API="${PDT_TELEGRAM_API:-https://api.telegram.org}"
WORKDIR="${PDT_WORKDIR:-$HOME/pi-agent}"
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/pi-durable-telegram"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pi-durable-telegram"
ENV_FILE="$CONFIG_DIR/env"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="pi-durable-telegram"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); red=$(printf '\033[31m'); green=$(printf '\033[32m'); off=$(printf '\033[0m')
say() { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$off"; }
ok() { printf '%s✓%s %s\n' "$green" "$off" "$*"; }
die() { printf '%serror:%s %s\n' "$red" "$off" "$*" >&2; exit 1; }

# Prompts read from the terminal even when the script itself comes from a pipe.
ask() { # ask VAR "question" [default]
	local __var=$1 __q=$2 __def=${3:-} __ans=""
	if [ -n "${!__var:-}" ]; then return 0; fi
	[ -r /dev/tty ] || die "no terminal to ask: $__q (set $__var)"
	printf '%s%s%s ' "$bold" "$__q" "$off" >/dev/tty
	IFS= read -r __ans </dev/tty || true
	printf -v "$__var" '%s' "${__ans:-$__def}"
}
confirm() { # confirm "question" -> 0 for yes
	[ "${PDT_YES:-}" = 1 ] && return 0
	local answer=""
	ask answer "$1 [Y/n]" y
	case "$answer" in n | N | no | NO) return 1 ;; *) return 0 ;; esac
}

json_get() { # json_get FILE|- 'js expression on v' (- reads stdin); uses the node we found
	local js='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(1)}const r=('"$2"');if(r===undefined||r===null)process.exit(1);process.stdout.write(String(r))})'
	if [ "$1" = - ]; then "$NODE" -e "$js"; else "$NODE" -e "$js" <"$1"; fi
}

node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; }

find_node() {
	local candidate
	for candidate in "$(command -v node 2>/dev/null || true)" \
		"${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin/node"; do
		if [ -n "$candidate" ] && [ -x "$candidate" ] && node_ok "$candidate"; then
			NODE=$candidate
			return 0
		fi
	done
	return 1
}

find_pi() {
	local candidate
	for candidate in "$(command -v pi 2>/dev/null || true)" "$HOME/.local/bin/pi" "$AGENT_DIR/bin/pi" "$HOME/bin/pi"; do
		if [ -n "$candidate" ] && [ -x "$candidate" ]; then
			PI=$candidate
			return 0
		fi
	done
	return 1
}

logged_in() { # any provider in pi's auth.json
	[ -s "$AGENT_DIR/auth.json" ] && json_get "$AGENT_DIR/auth.json" 'Object.keys(v).length>0||undefined' >/dev/null 2>&1
}

# Ask pi itself which model it runs by default (it resolves one from the login even when no default is saved).
pi_model() {
	local state
	state=$( (printf '{"id":"1","type":"get_state"}\n'; sleep 6) | (cd "$HOME" && timeout 25 "$PI" --mode rpc --no-session 2>/dev/null) |
		"$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n")){try{const j=JSON.parse(l);const d=j.data||j;if(d.model){process.stdout.write([d.model.provider,d.model.id,d.thinkingLevel||""].join("\t"));return}}catch{}}process.exit(1)})') || return 1
	MODEL_PROVIDER=$(printf '%s' "$state" | cut -f1)
	MODEL_ID=$(printf '%s' "$state" | cut -f2)
	MODEL_THINKING=$(printf '%s' "$state" | cut -f3)
	[ -n "$MODEL_PROVIDER" ] && [ -n "$MODEL_ID" ]
}

tg() { curl -fsS --max-time 20 "$TG_API/bot$BOT_TOKEN/$1"; }

# ---------------------------------------------------------------------------------------------------------------------

preflight() {
	[ "$(uname -s)" = Linux ] || die "this installer is for Linux servers (systemd). See the README for other setups."
	[ "$(id -u)" != 0 ] || [ "${PDT_ALLOW_ROOT:-}" = 1 ] ||
		die "run it as a normal user: the agent gets a shell as the user that installs it."
	command -v curl >/dev/null || die "curl is required"
	command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 ||
		die "systemd user services are not available for this user (log in over SSH as this user, not with su)."
}

explain() {
	cat <<EOF

${bold}pi-durable telegram${off}: an always-on, durable pi agent on this server that you talk to in Telegram.

This script will:
  1. Install the official pi from ${PI_INSTALLER_URL} (skipped if pi is already installed).
  2. Open pi so you can log in with ${bold}/login${off} to any provider pi supports (skipped if already logged in).
  3. Ask for a Telegram bot token from @BotFather and find your Telegram id when you message the bot.
  4. Install the pi-durable-telegram daemon from the latest GitHub release into ${dim}${PREFIX}${off}.
  5. Write ${dim}${ENV_FILE}${off} (mode 600) and the agent's workspace ${dim}${WORKDIR}${off}.
  6. Start the systemd user service ${bold}${UNIT}${off} and check that the bot answers.

${bold}Note:${off} the agent gets a full shell as ${bold}$(id -un)${off}. Only the Telegram ids you allow can talk to it.
EOF
	confirm "Continue?" || die "cancelled"
}

install_pi() {
	step "1/6 pi"
	if find_pi; then
		ok "pi is installed: $PI ($("$PI" --version 2>/dev/null || echo unknown version))"
	else
		say "Running the official pi installer from $PI_INSTALLER_URL ..."
		# Its output goes through cat so it does not offer to start pi; we start it ourselves for /login.
		curl -fsSL "$PI_INSTALLER_URL" | sh | cat
		find_pi || die "pi was installed but not found; open a new shell and run this installer again."
		ok "pi installed: $PI"
	fi
	find_node || die "Node.js 22.19+ not found after installing pi."
	ok "Node.js $("$NODE" --version) at $NODE"
}

login_pi() {
	step "2/6 Log in to a model provider"
	local tries=0
	while ! logged_in; do
		tries=$((tries + 1))
		[ "$tries" -le 3 ] || die "pi is still not logged in. Run pi, use /login, then run this installer again."
		say "pi will open now. In pi:"
		say "  1. type ${bold}/login${off} and pick a provider (a Claude or ChatGPT subscription, an API key, ...)"
		say "  2. when it says you are logged in, type ${bold}/quit${off} to come back here"
		confirm "Open pi?" || die "cancelled"
		(cd "$HOME" && "$PI" </dev/tty >/dev/tty 2>&1) || true
	done
	ok "pi is logged in ($(json_get "$AGENT_DIR/auth.json" 'Object.keys(v).join(", ")'))"
	if pi_model; then
		ok "model: $MODEL_PROVIDER / $MODEL_ID${MODEL_THINKING:+ (thinking $MODEL_THINKING)}"
	else
		MODEL_PROVIDER="" MODEL_ID="" MODEL_THINKING=""
		say "${dim}Could not read pi's model; set PI_PROVIDER and PI_MODEL in $ENV_FILE if the bot does not start.${off}"
	fi
}

# A re-run (update) keeps the bot, the allowed ids and the Deepgram key from the existing env file.
load_existing() {
	[ -f "$ENV_FILE" ] || return 1
	local token ids deepgram workdir
	token=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$ENV_FILE" | tail -1)
	ids=$(sed -n 's/^TELEGRAM_ALLOWED_USER_IDS=//p' "$ENV_FILE" | tail -1)
	deepgram=$(sed -n 's/^DEEPGRAM_API_KEY=//p' "$ENV_FILE" | tail -1)
	workdir=$(sed -n 's/^PI_WORKDIR=//p' "$ENV_FILE" | tail -1)
	[ -n "$token" ] && [ -n "$ids" ] || return 1
	BOT_TOKEN=$token
	BOT_USERNAME=$(tg getMe 2>/dev/null | json_get - 'v.result.username' || echo "your bot")
	confirm "Keep the configured bot @$BOT_USERNAME and allowed ids $ids?" || return 1
	USER_ID=$ids
	DEEPGRAM=${PDT_DEEPGRAM_API_KEY:-$deepgram}
	WORKDIR=${workdir:-$WORKDIR}
	UPDATING=1
}

setup_bot() {
	step "3/6 Telegram bot"
	if load_existing; then
		ok "keeping @$BOT_USERNAME, allowed ids $USER_ID"
		return 0
	fi
	if [ -z "${PDT_BOT_TOKEN:-}" ]; then
		say "Create a bot: open @BotFather in Telegram, send /newbot, pick a name, copy the token."
	fi
	local me username webhook
	while :; do
		BOT_TOKEN="${PDT_BOT_TOKEN:-}"
		ask BOT_TOKEN "Bot token:"
		BOT_TOKEN=$(printf '%s' "$BOT_TOKEN" | tr -d '[:space:]')
		if me=$(tg getMe 2>/dev/null) && username=$(printf '%s' "$me" | json_get - 'v.ok?v.result.username:undefined'); then
			break
		fi
		[ -z "${PDT_BOT_TOKEN:-}" ] || die "Telegram rejected the bot token"
		say "${red}Telegram rejected this token.${off} Try again."
	done
	ok "bot @$username"
	webhook=$(tg getWebhookInfo | json_get - 'v.result.url' || true)
	[ -z "$webhook" ] || die "@$username has a webhook ($webhook): another program uses this bot. Use a separate bot."
	BOT_USERNAME=$username

	USER_ID="${PDT_USER_ID:-}"
	if [ -z "$USER_ID" ]; then
		say "Now send any message to ${bold}@$username${off} in Telegram from your account (waiting up to 3 minutes)..."
		local deadline=$((SECONDS + 180)) found=""
		while [ $SECONDS -lt $deadline ]; do
			found=$(tg "getUpdates?timeout=10&allowed_updates=%5B%22message%22%5D" 2>/dev/null |
				json_get - 'v.result.map(u=>u.message).filter(m=>m&&m.chat.type==="private").map(m=>m.from.id+" "+(m.from.username?"@"+m.from.username:m.from.first_name)).pop()' || true)
			[ -n "$found" ] && break
		done
		[ -n "$found" ] || die "no message reached @$username. Run the installer again."
		confirm "Message from ${found#* } (id ${found%% *}). Is that you?" || die "cancelled"
		USER_ID=${found%% *}
	fi
	ok "allowed Telegram user id: $USER_ID"

	DEEPGRAM="${PDT_DEEPGRAM_API_KEY:-}"
	[ "${PDT_YES:-}" = 1 ] || ask DEEPGRAM "Deepgram API key for voice messages (Enter to skip):" ""
}

install_daemon() {
	step "4/6 Daemon"
	local npm
	npm="$(dirname "$NODE")/npm"
	[ -x "$npm" ] || npm=$(command -v npm) || die "npm not found next to $NODE"
	PATH="$(dirname "$NODE"):$PATH" "$npm" install --global --prefix "$PREFIX" --no-audit --no-fund --loglevel=error "$ARCHIVE_URL"
	MAIN="$PREFIX/lib/node_modules/pi-durable-telegram/dist/cli/main.js"
	[ -f "$MAIN" ] || die "the daemon did not install into $PREFIX"
	ok "pi-durable-telegram $("$NODE" "$MAIN" --version) in $PREFIX"
}

write_config() {
	step "5/6 Configuration"
	mkdir -p "$CONFIG_DIR" "$WORKDIR"
	if [ "${UPDATING:-}" = 1 ]; then
		add_model_to_env
		ok "kept $ENV_FILE"
	else
		write_env
	fi
	write_agents_md
}

write_env() {
	(
		umask 077
		{
			printf 'TELEGRAM_BOT_TOKEN=%s\n' "$BOT_TOKEN"
			printf 'TELEGRAM_ALLOWED_USER_IDS=%s\n' "$USER_ID"
			printf 'PI_WORKDIR=%s\n' "$WORKDIR"
			[ -z "$MODEL_PROVIDER" ] || printf 'PI_PROVIDER=%s\nPI_MODEL=%s\n' "$MODEL_PROVIDER" "$MODEL_ID"
			[ -z "$MODEL_THINKING" ] || printf 'PI_THINKING=%s\n' "$MODEL_THINKING"
			[ -z "$DEEPGRAM" ] || printf 'DEEPGRAM_API_KEY=%s\n' "$DEEPGRAM"
		} >"$ENV_FILE"
	)
	chmod 600 "$ENV_FILE"
	ok "$ENV_FILE (mode 600)"
}

# An env file written before the model was known gets it now; an explicit choice in the file is left alone.
add_model_to_env() {
	[ -n "$MODEL_PROVIDER" ] || return 0
	grep -q '^PI_PROVIDER=' "$ENV_FILE" && return 0
	{
		printf 'PI_PROVIDER=%s\nPI_MODEL=%s\n' "$MODEL_PROVIDER" "$MODEL_ID"
		[ -z "$MODEL_THINKING" ] || grep -q '^PI_THINKING=' "$ENV_FILE" || printf 'PI_THINKING=%s\n' "$MODEL_THINKING"
	} >>"$ENV_FILE"
}

write_agents_md() {
	if [ ! -f "$WORKDIR/AGENTS.md" ]; then
		cat >"$WORKDIR/AGENTS.md" <<'EOF'
# Instructions for the agent

You are a personal agent running on this server. The user talks to you in Telegram.

- Answer in the user's language, briefly, result first.
- Your workspace is this folder. Files the user sends land in ./inbox/.
- Before anything hard to undo (deleting, overwriting, pushing, deploying, restarting services), say what you will do
  and wait for a yes.
- Never print secrets (tokens, keys, .env files) into the chat.
- Say "done" only after you checked the result.

## This server

Describe here what runs on this machine, where projects and notes live, and what you must not touch.
EOF
		ok "$WORKDIR/AGENTS.md (edit it to tell the agent about this server)"
	fi
}

start_service() {
	step "6/6 Service"
	mkdir -p "$UNIT_DIR"
	cat >"$UNIT_DIR/$UNIT.service" <<EOF
[Unit]
Description=pi-durable telegram (durable pi agent in Telegram)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORKDIR
ExecStart=$NODE $MAIN run --env-file $ENV_FILE
Environment=NODE_ENV=production
Environment=PATH=$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=3
# Exit codes 2 (bad config), 3 (data dir in use) and 4 (not logged in) need a person, not a restart loop.
RestartPreventExitStatus=2 3 4
TimeoutStopSec=30
KillMode=mixed
MemoryMax=1G

[Install]
WantedBy=default.target
EOF
	systemctl --user daemon-reload
	systemctl --user enable "$UNIT" >/dev/null 2>&1
	systemctl --user restart "$UNIT"
	if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
		loginctl enable-linger "$(id -un)" 2>/dev/null || sudo loginctl enable-linger "$(id -un)" 2>/dev/null ||
			say "${dim}Could not enable lingering. Run 'sudo loginctl enable-linger $(id -un)' so the bot keeps running after you log out.${off}"
	fi
	local deadline=$((SECONDS + 30))
	until journalctl --user -u "$UNIT" --since "-2 min" -o cat 2>/dev/null | grep -q polling_started; do
		if [ $SECONDS -ge $deadline ]; then
			journalctl --user -u "$UNIT" -n 20 -o cat --no-pager || true
			die "the service did not start; the log is above."
		fi
		sleep 1
	done
	ok "service $UNIT is running"
}

verify() {
	[ "${UPDATING:-}" != 1 ] || return 0
	say "Waiting for the bot to answer your message (up to 3 minutes)..."
	local deadline=$((SECONDS + 180))
	until journalctl --user -u "$UNIT" --since "-5 min" -o cat 2>/dev/null | grep -q " delivered "; do
		if [ $SECONDS -ge $deadline ]; then
			say "${dim}No answer yet. Send @$BOT_USERNAME a message and watch: journalctl --user -u $UNIT -f${off}"
			return 0
		fi
		sleep 2
	done
	ok "the bot answered in Telegram"
}

finish() {
	cat <<EOF

${green}${bold}Done.${off} Write to ${bold}@$BOT_USERNAME${off} in Telegram.

  Logs:      journalctl --user -u $UNIT -f
  Restart:   systemctl --user restart $UNIT
  Update:    curl -fsSL https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/install.sh | bash
  Settings:  $ENV_FILE
  Agent:     $WORKDIR/AGENTS.md (what the agent knows about this server)
EOF
}

main() {
	preflight
	explain
	install_pi
	login_pi
	setup_bot
	install_daemon
	write_config
	start_service
	verify
	finish
}

main "$@"
