#!/bin/sh
# TEST ONLY stand-in for systemd-run (see test/helpers/systemd-shims.ts). Usage: systemd-run-shim.sh STATE ARGS...
#
# Records its arguments (one per line, then "--END--") to STATE/systemd-run.argv, drops what only systemd can do
# (--uid, --gid, --slice, every --property=..., --pipe, --wait, ...), and runs the command after "--" with the
# --setenv variables in --working-directory, as the unit's only process: it execs the command, so the unit's process
# keeps this pid (recorded in STATE/units/<unit>.pid for the systemctl shim). Nothing here runs as another user, in a
# slice or with an IP filter: that is verified on Linux only (test/runner/systemd-linux.test.ts).
#
# STATE/fail-start makes the start fail (like a refused transient unit). STATE/detached-unit runs the command apart
# from this client, in its own session, as real systemd does (test/fixtures/detached-unit.mjs; the command must be
# node): killing the client's process group then no longer kills the unit.
set -eu
state="$1"
shift
mkdir -p "$state/units"
for arg in "$@"; do printf '%s\n' "$arg"; done >>"$state/systemd-run.argv"
printf '%s\n' "--END--" >>"$state/systemd-run.argv"
unit=""
dir=""
while [ $# -gt 0 ]; do
	case "$1" in
	--)
		shift
		break
		;;
	--unit=*) unit="${1#--unit=}" ;;
	--working-directory=*) dir="${1#--working-directory=}" ;;
	--setenv=*) export "${1#--setenv=}" ;;
	*) ;;
	esac
	shift
done
if [ -z "$unit" ] || [ $# -eq 0 ]; then
	echo "systemd-run shim: --unit and a command are required" >&2
	exit 1
fi
if [ -e "$state/fail-start" ]; then
	echo "systemd-run shim: start refused" >&2
	exit 1
fi
if [ -n "$dir" ]; then cd "$dir"; fi
if [ -e "$state/detached-unit" ]; then
	exec "$1" "$(dirname "$0")/detached-unit.mjs" "$state/units/$unit.pid" "$@"
fi
printf '%s\n' "$$" >"$state/units/$unit.pid"
exec "$@"
