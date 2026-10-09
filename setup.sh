#!/usr/bin/env bash
# The related public repos cloned beside this one (README), for a Claude
# cloud session or a fresh checkout: no credentials needed, all are public.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
top=$(dirname "$here")
clone() { # repo [branch]
	if [ -d "$top/$1/.git" ]; then
		git -C "$top/$1" pull -q --ff-only
	else
		git clone -q --depth 50 ${2:+--branch "$2"} "https://github.com/mj41/$1.git" "$top/$1"
	fi
}
clone s-w42-eu-assets
clone s-w42-eu-raw
clone StackChan embody-mj41
clone s-w42-eu-pet
clone s-w42-eu-focus
clone s-w42-eu-manager
clone w42-eu-web
clone home-w42-eu
go -C "$top/s-w42-eu-assets" build ./... # robot3d builds: the model's source is usable
echo "s3d setup: ready ($(go version | cut -d' ' -f3))"
