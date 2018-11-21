#!/bin/sh
set -eoux pipefail
npm install
node_modules/.bin/tsc
cat header.js webgl-profiler.js footer.js > webgl-profiler.js.tmp
mv webgl-profiler.js.tmp webgl-profiler.js