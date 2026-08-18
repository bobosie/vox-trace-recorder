#!/bin/bash
echo "🐳 Testing vox-trace installation in Docker..."
docker build -f Dockerfile.test -t vox-trace-install-test . && \
docker run --rm vox-trace-install-test
