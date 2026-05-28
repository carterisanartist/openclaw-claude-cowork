#!/usr/bin/env bash
# Build and pack the MCPB extension.
# Produces company-claw-bridge.mcpb at the repo root.
#
# Strategy (faster than the older 3-npm-install dance):
#   1. Use the existing node_modules in-tree to run `tsc` (no install needed
#      when devDependencies are already present).
#   2. Build a fresh worktree under build/pack-tree that contains ONLY the
#      files we want shipped:
#          - dist/ (the compiled output)
#          - manifest.json + .claude-plugin/plugin.json
#          - package.json (so MCPB knows the entry point)
#          - server/ (sources for stack traces)
#          - node_modules/ (production-only, installed inside the tree)
#   3. Run `mcpb pack` against that tree, producing the .mcpb at the repo root.
#   4. Throw the temp tree away.
#
# This avoids:
#   - mutating the repo's node_modules with `npm prune --omit=dev` (which
#     forces a re-install after every pack).
#   - shipping the installer/ directory by accident (any future addition
#     under the repo root is automatically excluded because we only copy
#     the explicit allowlist below).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PACK_DIR="$ROOT_DIR/build/pack-tree"

echo "==> Cleaning previous build artifacts"
rm -rf dist build company-claw-bridge.mcpb

echo "==> Ensuring local dependencies are installed (idempotent)"
if [[ ! -d node_modules ]]; then
  npm install --include=dev --no-audit --no-fund
fi

echo "==> Validating manifest.json"
npx --yes @anthropic-ai/mcpb validate manifest.json

echo "==> Compiling TypeScript"
npx tsc

echo "==> Assembling isolated pack tree at $PACK_DIR"
mkdir -p "$PACK_DIR"
cp -R dist "$PACK_DIR/"
cp -R server "$PACK_DIR/"
cp -R .claude-plugin "$PACK_DIR/"
[[ -d assets ]] && cp -R assets "$PACK_DIR/"
cp manifest.json "$PACK_DIR/"
cp package.json "$PACK_DIR/"
cp package-lock.json "$PACK_DIR/" 2>/dev/null || true
[[ -f README.md ]] && cp README.md "$PACK_DIR/"

echo "==> Installing production-only dependencies inside the pack tree"
( cd "$PACK_DIR" && npm install --omit=dev --no-audit --no-fund --ignore-scripts )

echo "==> Packing MCPB bundle"
npx --yes @anthropic-ai/mcpb pack "$PACK_DIR" company-claw-bridge.mcpb

echo "==> Cleaning up pack tree"
rm -rf "$PACK_DIR"

echo "==> Bundle info"
npx --yes @anthropic-ai/mcpb info company-claw-bridge.mcpb || true

echo "==> Done. Produced: $ROOT_DIR/company-claw-bridge.mcpb"
