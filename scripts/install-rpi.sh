#!/usr/bin/env bash
# LIGHTMAN Agent — Raspberry Pi Installer
# Extends the standard Linux install with RPi-specific optimizations.
# Run as root: sudo bash install-rpi.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/lightman/agent"

# --- Pre-checks ---
if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

if [[ ! -f /proc/device-tree/model ]]; then
  echo "Error: This does not appear to be a Raspberry Pi."
  exit 1
fi

MODEL=$(tr -d '\0' < /proc/device-tree/model)
echo "=== LIGHTMAN Agent — Raspberry Pi Installer ==="
echo "  Detected: ${MODEL}"
echo ""

# --- Run standard Linux install first ---
echo "[RPi 1/6] Running standard Linux install..."
bash "$SCRIPT_DIR/install-linux.sh"
echo ""

# --- GPU memory split ---
echo "[RPi 2/6] Configuring GPU memory..."
CONFIG_FILE="/boot/config.txt"
if [[ -f /boot/firmware/config.txt ]]; then
  CONFIG_FILE="/boot/firmware/config.txt"
fi

if ! grep -q "^gpu_mem=" "$CONFIG_FILE" 2>/dev/null; then
  echo "gpu_mem=128" >> "$CONFIG_FILE"
  echo "  Set gpu_mem=128 in ${CONFIG_FILE}"
else
  echo "  gpu_mem already configured in ${CONFIG_FILE}"
fi

# --- Disable screensaver / screen blanking ---
echo "[RPi 3/6] Disabling screen blanking..."
# For console blanking
if ! grep -q "consoleblank=0" /boot/cmdline.txt 2>/dev/null; then
  if [[ -f /boot/cmdline.txt ]]; then
    sed -i 's/$/ consoleblank=0/' /boot/cmdline.txt
    echo "  Added consoleblank=0 to /boot/cmdline.txt"
  fi
fi

# For X11 screensaver
LIGHTDM_CONF="/etc/lightdm/lightdm.conf"
if [[ -f "$LIGHTDM_CONF" ]]; then
  if ! grep -q "xserver-command.*-s 0" "$LIGHTDM_CONF" 2>/dev/null; then
    sed -i '/^\[Seat:\*\]/a xserver-command=X -s 0 -dpms' "$LIGHTDM_CONF" 2>/dev/null || true
    echo "  Disabled X11 screensaver via lightdm"
  fi
fi

# --- Hardware watchdog ---
echo "[RPi 4/6] Configuring hardware watchdog..."
if ! grep -q "^dtparam=watchdog=on" "$CONFIG_FILE" 2>/dev/null; then
  echo "dtparam=watchdog=on" >> "$CONFIG_FILE"
  echo "  Enabled BCM2835 watchdog in ${CONFIG_FILE}"
fi

# Load watchdog module
if ! lsmod | grep -q bcm2835_wdt 2>/dev/null; then
  modprobe bcm2835_wdt 2>/dev/null || true
fi

if ! grep -q "bcm2835_wdt" /etc/modules 2>/dev/null; then
  echo "bcm2835_wdt" >> /etc/modules
fi

# Set watchdog device permissions for lightman user
if [[ -e /dev/watchdog ]]; then
  chown root:lightman /dev/watchdog
  chmod 660 /dev/watchdog
  echo "  Set /dev/watchdog permissions for lightman group"
fi

# --- tmpfs for logs (reduce SD card wear) ---
echo "[RPi 5/6] Configuring tmpfs for logs..."
FSTAB_ENTRY="tmpfs /var/log/lightman tmpfs defaults,noatime,nosuid,nodev,noexec,mode=0750,size=50M,uid=lightman,gid=lightman 0 0"
if ! grep -q "/var/log/lightman" /etc/fstab 2>/dev/null; then
  echo "$FSTAB_ENTRY" >> /etc/fstab
  mount -a 2>/dev/null || true
  echo "  Added tmpfs mount for /var/log/lightman"
fi

# --- Sudoers for agent power commands ---
echo "[RPi 6/6] Configuring sudoers..."
SUDOERS_FILE="/etc/sudoers.d/lightman-agent"
cat > "$SUDOERS_FILE" << 'SUDOERS'
# LIGHTMAN Agent - allow power commands without password
lightman ALL=(ALL) NOPASSWD: /sbin/shutdown
lightman ALL=(ALL) NOPASSWD: /sbin/reboot
lightman ALL=(ALL) NOPASSWD: /usr/bin/vcgencmd
SUDOERS
chmod 440 "$SUDOERS_FILE"
echo "  Installed sudoers for lightman agent"

echo ""
echo "=== Raspberry Pi Setup Complete ==="
echo ""
echo "  IMPORTANT: Reboot required for:"
echo "    - GPU memory allocation"
echo "    - Hardware watchdog"
echo "    - Screen blanking changes"
echo ""
echo "  Reboot now:  sudo reboot"
echo ""
