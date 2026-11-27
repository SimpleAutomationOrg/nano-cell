#!/bin/sh
# The project check: types + motion regression tests. Run after any change
# to viewer/, a robot or an application.
set -e
cd "$(dirname "$0")/.."
npx -y -p typescript@5.7.2 tsc --noEmit
node --test
echo "check: OK"
