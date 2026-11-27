#!/bin/sh
# The project check: types + motion regression tests. Run after any change
# to viewer/ or tasks/.
set -e
cd "$(dirname "$0")/.."
npx -y -p typescript@5.7.2 tsc --noEmit
node --test
echo "check: OK"
