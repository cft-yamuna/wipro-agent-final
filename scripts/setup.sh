#!/usr/bin/env bash
# LIGHTMAN Agent — Device Setup Script (Linux / Raspberry Pi)
# Generates agent.config.json for this specific device.
#
# Usage:
#   sudo bash setup.sh --slug f-av01 --server http://192.168.1.100:3401
#   sudo bash setup.sh --slug f-av01 --server http://192.168.1.100:3401 --timezone Asia/Kolkata --dir /opt/lightman/agent
#
# This script MUST be run once on every new device installation.
# It clears any cached identity so the device provisions fresh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"

# Defaults
SLUG=""
SERVER=""
TIMEZONE="Asia/Kolkata"
INSTALL_DIR="/opt/lightman/agent"

# ── Parse arguments ──
while [[ $# -gt 0 ]]; do
    case $1 in
        --slug)     SLUG="$2";       shift 2 ;;
        --server)   SERVER="$2";     shift 2 ;;
        --timezone) TIMEZONE="$2";   shift 2 ;;
        --dir)      INSTALL_DIR="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: bash setup.sh --slug SLUG --server http://SERVER:3401 [--timezone TZ] [--dir /path]"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [[ -z "$SLUG" ]]; then
    echo "Error: --slug is required"
    echo "Usage: bash setup.sh --slug f-av01 --server http://192.168.1.100:3401"
    exit 1
fi

if [[ -z "$SERVER" ]]; then
    echo "Error: --server is required"
    echo "Usage: bash setup.sh --slug f-av01 --server http://192.168.1.100:3401"
    exit 1
fi

echo ""
echo "=== LIGHTMAN Agent — Device Setup ==="
echo "  Slug:        $SLUG"
echo "  Server:      $SERVER"
echo "  Install dir: $INSTALL_DIR"
echo "  Timezone:    $TIMEZONE"
echo ""

# ── 1. Clear cached identity (CRITICAL — prevents old device credentials leaking) ──
IDENTITY_FILE="$INSTALL_DIR/.lightman-identity.json"
if [[ -f "$IDENTITY_FILE" ]]; then
    rm -f "$IDENTITY_FILE"
    echo "[OK] Cleared old identity cache (.lightman-identity.json)"
else
    echo "[OK] No existing identity cache found (clean install)"
fi

# ── 2. Derive kiosk display URL from server URL ──
# Replace port with 3403 (display server)
KIOSK_BASE="$(echo "$SERVER" | sed 's/:[0-9]*$//')"
KIOSK_URL="${KIOSK_BASE}:3403/display/${SLUG}"

# ── 3. Detect browser ──
BROWSER_PATH="chromium-browser"
if command -v chromium &>/dev/null; then
    BROWSER_PATH="chromium"
elif command -v chromium-browser &>/dev/null; then
    BROWSER_PATH="chromium-browser"
elif command -v google-chrome &>/dev/null; then
    BROWSER_PATH="google-chrome"
fi
CHROME_DATA_DIR="/opt/lightman/chrome-kiosk"

# ── 4. Find template ──
TEMPLATE="$AGENT_DIR/agent.config.template.json"
if [[ ! -f "$TEMPLATE" ]]; then
    # Post-install: template may be in install dir
    TEMPLATE="$INSTALL_DIR/agent.config.template.json"
fi
if [[ ! -f "$TEMPLATE" ]]; then
    echo "[ERROR] Template not found at $TEMPLATE"
    exit 1
fi

# ── 5. Create install dir if needed ──
mkdir -p "$INSTALL_DIR"

# ── 6. Replace placeholders and write config ──
sed \
    -e "s|__SERVER_URL__|${SERVER}|g" \
    -e "s|__DEVICE_SLUG__|${SLUG}|g" \
    -e "s|__KIOSK_URL__|${KIOSK_URL}|g" \
    -e "s|__BROWSER_PATH__|${BROWSER_PATH}|g" \
    -e "s|__CHROME_DATA_DIR__|${CHROME_DATA_DIR}|g" \
    -e "s|Asia/Kolkata|${TIMEZONE}|g" \
    "$TEMPLATE" > "$INSTALL_DIR/agent.config.json"

echo "[OK] Created agent.config.json"
echo ""
echo "  Device slug : $SLUG"
echo "  Server      : $SERVER"
echo "  Kiosk URL   : $KIOSK_URL"
echo ""
echo "Setup complete. Start the agent — it will provision automatically."
echo "(If IP matches, provisioning is instant. Otherwise enter pairing code shown in admin.)"
echo ""
