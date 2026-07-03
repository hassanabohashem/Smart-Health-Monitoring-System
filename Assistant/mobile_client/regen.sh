#!/usr/bin/env bash
# Regenerate TypeScript types from the FastAPI OpenAPI schema.
# Run from the Assistant/ directory with the API running on localhost:8000.
set -euo pipefail

cd "$(dirname "$0")"
echo "Fetching OpenAPI schema..."
curl -sf http://127.0.0.1:8000/openapi.json -o openapi.json
echo "Generating TypeScript types..."
npx -y openapi-typescript openapi.json -o types.ts
echo "Done. Types written to $(pwd)/types.ts"
