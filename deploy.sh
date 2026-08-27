#!/bin/bash
# ============================================================
# Sprite Forge Studio — Build & Deploy to Synology NAS
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="sprite-forge"
DISPLAY_NAME="⚡ Sprite Forge Studio"

source "${SCRIPT_DIR}/../deploy-kit/lib.sh"
