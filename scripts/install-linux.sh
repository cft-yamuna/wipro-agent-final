#!/usr/bin/env bash
# LIGHTMAN Agent — Linux Installer
# Run as root:
#   sudo bash install-linux.sh --slug f-av01 --server http://192.168.1.100:3401
set -euo pipefail

INSTALL_DIR="/opt/lightman/agent"
LOG_DIR="/var/log/lightman"
SERVICE_NAME="lightman-agent"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"

# Defaults
SLUG=""
SERVER=""
TIMEZONE="Asia/Kolkata"

# ── Parse arguments ──
while [[ $# -gt 0 ]]; do
    case $1 in
        --slug)     SLUG="$2";     shift 2 ;;
        --server)   SERVER="$2";   shift 2 ;;
        --timezone) TIMEZONE="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: sudo bash install-linux.sh --slug f-av01 --server http://192.168.1.100:3401 [--timezone Asia/Kolkata]"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ── Validate required args ──
if [[ -z "$SLUG" ]]; then
    echo "Error: --slug is required"
    echo "Usage: sudo bash install-linux.sh --slug f-av01 --server http://192.168.1.100:3401"
    exit 1
fi

if [[ -z "$SERVER" ]]; then
    echo "Error: --server is required"
    echo "Usage: sudo bash install-linux.sh --slug f-av01 --server http://192.168.1.100:3401"
    exit 1
fi

# ── Pre-checks ──
if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root (use sudo)."
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Install Node.js 20+ first."
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 20 ]]; then
    echo "Error: Node.js 20+ required, found v${NODE_VERSION}."
    exit 1
fi

echo ""
echo "=== LIGHTMAN Agent — Linux Installer ==="
echo "  Device slug : $SLUG"
echo "  Server URL  : $SERVER"
echo ""

# --- Create user/group ---
if ! id -u lightman &> /dev/null; then
    echo "[1/7] Creating lightman user and group..."
    groupadd --system lightman
    useradd --system --gid lightman --home-dir /opt/lightman --shell /usr/sbin/nologin lightman
else
    echo "[1/7] User 'lightman' already exists, skipping."
fi

# --- Create directories ---
echo "[2/7] Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$LOG_DIR"

# --- Copy agent files ---
echo "[3/7] Copying agent files to ${INSTALL_DIR}..."
cp -r "$AGENT_DIR/dist"                         "$INSTALL_DIR/"
cp    "$AGENT_DIR/package.json"                 "$INSTALL_DIR/"
cp    "$AGENT_DIR/package-lock.json"            "$INSTALL_DIR/" 2>/dev/null || true
# Copy template so setup.sh can use it post-install
cp    "$AGENT_DIR/agent.config.template.json"   "$INSTALL_DIR/"

# Install production dependencies
echo "[4/7] Installing production dependencies..."
cd "$INSTALL_DIR"
npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

# --- Configure this device (generates agent.config.json, clears any stale identity) ---
echo "[5/7] Configuring device '$SLUG'..."
bash "$SCRIPT_DIR/setup.sh" \
    --slug     "$SLUG" \
    --server   "$SERVER" \
    --timezone "$TIMEZONE" \
    --dir      "$INSTALL_DIR"

# --- Set permissions ---
echo "[6/7] Setting permissions..."
chown -R lightman:lightman "$INSTALL_DIR"
chown -R lightman:lightman "$LOG_DIR"
chmod 750 "$INSTALL_DIR"
chmod 750 "$LOG_DIR"

# --- Install systemd service ---
echo "[7/7] Installing systemd service..."
cp "$SCRIPT_DIR/lightman-agent.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

# --- Install logrotate config ---
cp "$SCRIPT_DIR/lightman-agent.logrotate" "/etc/logrotate.d/${SERVICE_NAME}" 2>/dev/null || true

echo ""
echo "=== Installation Complete ==="
echo ""
echo "  Device slug : $SLUG"
echo "  Server      : $SERVER"
echo "  Install dir : ${INSTALL_DIR}"
echo "  Log dir     : ${LOG_DIR}"
echo "  Service     : ${SERVICE_NAME}"
echo ""
echo "  Start   :  sudo systemctl start ${SERVICE_NAME}"
echo "  Status  :  sudo systemctl status ${SERVICE_NAME}"
echo "  Logs    :  sudo journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "The agent will now provision with the LIGHTMAN server."
echo "If pairing is needed, a 6-digit code will appear in the logs."
echo ""
