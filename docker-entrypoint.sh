#!/usr/bin/env sh

set -e

case $1 in
    sh|bash|grpcc)
        exec $@
        ;;
    *)
        exec grpcc $@
        ;;
esac
