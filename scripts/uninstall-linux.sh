#!/usr/bin/env bash
# LIGHTMAN Agent — Linux Uninstaller
# Run as root: sudo bash uninstall-linux.sh
set -euo pipefail

INSTALL_DIR="/opt/lightman/agent"
LOG_DIR="/var/log/lightman"
SERVICE_NAME="lightman-agent"

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

echo "=== LIGHTMAN Agent — Linux Uninstaller ==="
echo ""

# --- Stop and disable service ---
echo "[1/5] Stopping service..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true

# --- Remove systemd unit ---
echo "[2/5] Removing systemd unit..."
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

# --- Remove logrotate config ---
echo "[3/5] Removing logrotate config..."
rm -f "/etc/logrotate.d/${SERVICE_NAME}"

# --- Remove installation directory ---
echo "[4/5] Removing ${INSTALL_DIR}..."
rm -rf "$INSTALL_DIR"

# --- Remove log directory ---
echo "[5/5] Removing ${LOG_DIR}..."
rm -rf "$LOG_DIR"

# --- Remove user/group (optional) ---
read -rp "Remove 'lightman' user and group? [y/N]: " REMOVE_USER
if [[ "$REMOVE_USER" =~ ^[Yy]$ ]]; then
  userdel lightman 2>/dev/null || true
  groupdel lightman 2>/dev/null || true
  echo "User and group removed."
fi

echo ""
echo "=== Uninstallation Complete ==="
echo ""
