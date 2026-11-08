#!/bin/sh
# TEST ONLY stand-in for the docker CLI (see test/helpers/docker-shim.ts): only what the watchdog's container reaper
# uses. Usage: docker-shim.sh STATE ARGS...
#
# A container is a file STATE/containers/<id> with one label per line (key=value). Every call is appended to
# STATE/docker.argv (one line per call).
#   ps -aq --no-trunc [--filter label=k=v]...   the ids of the containers carrying every filtered label
#                                               (fails if STATE/ps-fails exists)
#   rm -f <id>...                               removes them (does nothing if STATE/rm-misses exists)
set -eu
state="$1"
shift
printf '%s\n' "$*" >>"$state/docker.argv"
case "${1:-}" in
ps)
	shift
	if [ -e "$state/ps-fails" ]; then
		echo "docker shim: cannot connect to the daemon" >&2
		exit 1
	fi
	labels=""
	while [ $# -gt 0 ]; do
		if [ "$1" = "--filter" ]; then
			shift
			labels="$labels ${1#label=}"
		fi
		shift
	done
	for file in "$state"/containers/*; do
		[ -f "$file" ] || continue
		ok=1
		for label in $labels; do grep -qxF -- "$label" "$file" || ok=0; done
		if [ "$ok" = 1 ]; then basename "$file"; fi
	done
	;;
rm)
	shift
	if [ "${1:-}" = "-f" ]; then shift; fi
	if [ -e "$state/rm-misses" ]; then exit 0; fi
	for id in "$@"; do rm -f "$state/containers/$id"; done
	;;
*)
	echo "docker shim: unsupported command" >&2
	exit 1
	;;
esac
