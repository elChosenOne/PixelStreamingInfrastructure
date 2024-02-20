#!/bin/bash
# Copyright Epic Games, Inc. All Rights Reserved.
BASH_LOCATION="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"

pushd "${BASH_LOCATION}" > /dev/null

source common_utils.sh

set_start_default_values "n" "y" # Set STUN server defaults only
use_args "$@"
call_setup_sh
print_parameters

peerconnectionoptions='{\"iceServers\":[{\"urls\":[\"stun:${stunserver}\"]}]}'

process="${BASH_LOCATION}/node/lib/node_modules/npm/bin/npm-cli.js run start --"
arguments=""

if [ ! -z $IS_DEBUG ]; then
	arguments+=" --inspect"
fi

arguments+=" --peer_options=\"${peerconnectionoptions}\" --public_ip=${publicip}"
# Add arguments passed to script to arguments for executable
arguments+=" ${servercmd}"

pushd ../..
echo "Running: $process $arguments"
PATH="${BASH_LOCATION}/node/bin:$PATH"
start_process $process $arguments
popd

popd
