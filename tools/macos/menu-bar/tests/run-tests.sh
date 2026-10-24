#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swiftc -module-cache-path /tmp/nousos-swift-module-cache StateClassifier.swift tests/ClassifierTests.swift -o /tmp/nousos-classifier-tests
/tmp/nousos-classifier-tests
