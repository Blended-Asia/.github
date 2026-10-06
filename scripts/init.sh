#!/usr/bin/env bash
# Thay placeholder YOUR_ORG bằng tên org thật trong toàn bộ repo.
#   ./scripts/init.sh my-org
set -euo pipefail
ORG=${1:?Thiếu tên org}
cd "$(dirname "$0")/.."
grep -rlI --exclude-dir=.git --exclude=init.sh 'YOUR_ORG' . | while read -r f; do
  sed -i.bak "s/YOUR_ORG/$ORG/g" "$f" && rm -f "$f.bak"
  echo "✓ $f"
done
