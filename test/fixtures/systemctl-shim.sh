#!/bin/sh
# TEST ONLY stand-in for systemctl (see test/helpers/systemd-shims.ts). Usage: systemctl-shim.sh STATE ARGS...
#
# Records its arguments to STATE/systemctl.argv and implements what the systemd launcher uses, for the units the
# systemd-run shim started (by their recorded pid):
#   show --property=LoadState --value -- <x.slice>     loaded (not-found if STATE/no-slice exists)
#   show --property=ActiveState --value -- <unit>      active while its pid lives, else inactive
#                                                      (fails if STATE/systemctl-broken exists: "cannot tell")
#   kill --signal=SIGKILL -- <unit>                    SIGKILL the unit's process group (by pid); does nothing if
#                                                      STATE/kill-misses exists (a unit systemd had not created yet)
#   list-units ... <pattern>                           "<unit> loaded active running" for each live unit matching
#                                                      the glob (dead ones are gone, as with --collect; fails if
#                                                      STATE/systemctl-broken exists)
set -eu
state="$1"
shift
for arg in "$@"; do printf '%s\n' "$arg"; done >>"$state/systemctl.argv"
printf '%s\n' "--END--" >>"$state/systemctl.argv"
verb=""
property=""
unit=""
for arg in "$@"; do
	case "$arg" in
	--property=*) property="${arg#--property=}" ;;
	-*) ;;
	show | kill | list-units) if [ -z "$verb" ]; then verb="$arg"; fi ;;
	*) unit="$arg" ;;
	esac
done
pid=""
if [ -f "$state/units/$unit.pid" ]; then pid="$(cat "$state/units/$unit.pid")"; fi
alive() {
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
case "$verb" in
show)
	if [ -e "$state/systemctl-broken" ]; then
		echo "systemctl shim: broken" >&2
		exit 1
	fi
	case "$property" in
	LoadState)
		case "$unit" in
		*.slice) if [ -e "$state/no-slice" ]; then echo not-found; else echo loaded; fi ;;
		*) if alive; then echo loaded; else echo not-found; fi ;;
		esac
		;;
	ActiveState) if alive; then echo active; else echo inactive; fi ;;
	*)
		echo "systemctl shim: unsupported property" >&2
		exit 1
		;;
	esac
	;;
kill)
	if [ -e "$state/kill-misses" ]; then exit 0; fi
	if alive; then kill -s KILL -- "-$pid" 2>/dev/null || kill -s KILL "$pid" 2>/dev/null || true; fi
	;;
list-units)
	if [ -e "$state/systemctl-broken" ]; then
		echo "systemctl shim: broken" >&2
		exit 1
	fi
	for file in "$state"/units/*.pid; do
		[ -f "$file" ] || continue
		name="$(basename "$file" .pid)"
		# shellcheck disable=SC2254 # the pattern is a glob on purpose
		case "$name" in
		$unit) ;;
		*) continue ;;
		esac
		listed="$(cat "$file")"
		if [ -n "$listed" ] && kill -0 "$listed" 2>/dev/null; then printf '%s loaded active running shim\n' "$name"; fi
	done
	;;
*)
	echo "systemctl shim: unsupported command" >&2
	exit 1
	;;
esac
