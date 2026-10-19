#!/usr/bin/env bash
# Builds with sentinel secret values and verifies none reach browser assets (.next/static).
set -euo pipefail
cd "$(dirname "$0")/.."
TS=$(date +%s)
S1="SENTINEL_AI_KEY_${TS}_9f3a"
S2="SENTINEL_SERVICE_ROLE_${TS}_77b1"
S3="SENTINEL_SESSION_SECRET_${TS}_c0de"
AI_PROVIDER=groq AI_MODEL=sentinel-model AI_API_KEY="$S1" SUPABASE_SERVICE_ROLE_KEY="$S2" SESSION_SIGNING_SECRET="$S3" npx next build >/dev/null
printf "%s\n%s\n%s\n" "$S1" "$S2" "$S3" > .next/SECURITY_SENTINEL_BUILD
if grep -rlF -e "$S1" -e "$S2" -e "$S3" .next/static; then echo "LEAK DETECTED"; exit 1; fi
npx vitest run tests/unit/security.test.ts
echo "No sentinel secrets found in browser assets."
