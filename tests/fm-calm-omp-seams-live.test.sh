#!/usr/bin/env bash
# Live guard: the installed omp still exports every host seam Calm's presentation
# adapters patch.
#
# Calm on omp is harness-dependent by construction - .omp/extensions/lib/fm-calm-omp-layout.ts
# patches omp's own presentation methods, because omp's extension UI context cannot hide
# the working row or a transcript row. A stub can only confirm the assumption written
# into the stub, so the seams themselves are proven here against the real binary.
#
# This guard spends no model tokens: an extension factory runs during omp's load phase,
# before any provider request, so the probe reports and exits there.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

fm_live_gate default-on FM_CALM_OMP_SEAMS_LIVE omp

TMP_ROOT=$(fm_test_tmproot fm-calm-omp-seams-live)
REPORT="$TMP_ROOT/seams.json"

OMP_VERSION=$(omp --version 2>/dev/null | head -1) || OMP_VERSION=""
[ -n "$OMP_VERSION" ] || fail "could not determine the installed omp version"

# Every seam the adapters patch, as <export>.<method>. Keep this list and
# .omp/extensions/lib/fm-calm-omp-layout.ts in step: a seam added there without a row
# here is a seam nothing proves.
cat > "$TMP_ROOT/probe.ts" <<'TS'
import { writeFileSync } from "node:fs";

const SEAMS: Record<string, string[]> = {
  InteractiveMode: ["addMessageToChat", "ensureLoadingAnimation"],
  AssistantMessageComponent: ["updateContent"],
  ToolExecutionComponent: ["render"],
  ReadToolGroupComponent: ["render"],
};

export default function (pi: any) {
  const missing: string[] = [];
  const host = pi?.pi;
  for (const [name, methods] of Object.entries(SEAMS)) {
    const exported = host?.[name];
    if (typeof exported !== "function" || typeof exported.prototype !== "object") {
      missing.push(`${name} (export)`);
      continue;
    }
    for (const method of methods) {
      if (typeof exported.prototype[method] !== "function") missing.push(`${name}.${method}`);
    }
  }
  writeFileSync(process.env.FM_CALM_OMP_SEAM_REPORT!, JSON.stringify({ missing }));
  // Report from the load phase so the guard never reaches a provider request.
  process.exit(0);
}
TS

FM_CALM_OMP_SEAM_REPORT="$REPORT" omp -p --no-session --no-extensions --no-tools --no-lsp \
  --no-skills --no-rules --no-title -e "$TMP_ROOT/probe.ts" "unused" >/dev/null 2>&1 || true

[ -f "$REPORT" ] ||
  fail "omp $OMP_VERSION: the Calm seam probe never ran; omp did not load the extension factory"

MISSING=$(node -e 'const r = require(process.argv[1]); process.stdout.write(r.missing.join(", "));' "$REPORT" 2>/dev/null) ||
  fail "omp $OMP_VERSION: the Calm seam report could not be read"

[ -z "$MISSING" ] ||
  fail "omp $OMP_VERSION no longer exports the host seams Calm patches: $MISSING (see .omp/extensions/lib/fm-calm-omp-layout.ts and docs/calm.md)"

pass "omp $OMP_VERSION: every host seam Calm's presentation adapters patch is still exported"
