#!/usr/bin/env bash
# Replace the YOUR_ORG placeholder with the real org name across the repo.
#   ./scripts/init.sh my-org
set -euo pipefail
ORG=${1:?Missing org name}
cd "$(dirname "$0")/.."
grep -rlI --exclude-dir=.git --exclude=init.sh 'YOUR_ORG' . | while read -r f; do
  sed -i.bak "s/YOUR_ORG/$ORG/g" "$f" && rm -f "$f.bak"
  echo "✓ $f"
done
