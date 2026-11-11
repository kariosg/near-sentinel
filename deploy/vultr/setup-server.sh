#!/usr/bin/env bash
# NEAR Sentinel: first-boot setup for a fresh Ubuntu 24.04 LTS server. Run as root. Safe to re-run.
#
#   curl -fsSLO <raw URL of this file>   (or copy it over with scp)
#   sudo bash setup-server.sh
#
# What it does:
#   1. apt update + upgrade
#   2. Docker Engine + Compose plugin from Docker's official apt repository
#   3. a non-root deploy user (default: sentinel) in the docker group, with root's SSH keys copied over
#   4. UFW firewall: allow only 22/tcp, 80/tcp, 443/tcp, 443/udp
#   5. unattended security upgrades
#   6. fail2ban for sshd
#   7. optional swap file (default 2G; SWAP_SIZE=0 to skip) so small plans can build the image
#   8. SSH password login disabled ONLY if the deploy user has an authorized_keys file
#
# Options (environment variables):
#   DEPLOY_USER=sentinel   name of the deploy user
#   SWAP_SIZE=2G           swap file size if the server has no swap yet; 0 = skip
#   COPY_ROOT_KEYS=1       copy /root/.ssh/authorized_keys to the deploy user if it has none; 0 = skip
#   HARDEN_SSH=1           disable SSH password login when safe; 0 = leave SSH config alone
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-sentinel}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
COPY_ROOT_KEYS="${COPY_ROOT_KEYS:-1}"
HARDEN_SSH="${HARDEN_SSH:-1}"
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    WARNING: %s\033[0m\n' "$*" >&2; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this as root (sudo bash $0)." >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "This script targets Ubuntu 24.04 LTS; detected ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi
[[ "${VERSION_ID:-}" == "24.04" ]] || warn "Tested on Ubuntu 24.04; detected ${PRETTY_NAME}. Continuing."

APT_OPTS=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

step "1/8 Updating packages (apt update + upgrade)"
apt-get update
apt-get "${APT_OPTS[@]}" upgrade
apt-get "${APT_OPTS[@]}" install ca-certificates curl gnupg git ufw fail2ban python3-systemd unattended-upgrades

step "2/8 Installing Docker Engine + Compose plugin (official Docker apt repository)"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  CODENAME="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get "${APT_OPTS[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  info "Docker already installed."
fi
systemctl enable --now docker
info "$(docker --version)"
info "$(docker compose version)"

step "3/8 Creating deploy user '${DEPLOY_USER}' (docker group)"
if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  info "User exists."
else
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  info "Created ${DEPLOY_USER} (no password: log in with an SSH key)."
fi
usermod -aG docker "$DEPLOY_USER"
info "Note: membership of the docker group is equivalent to root on this machine."
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
DEPLOY_KEYS="${DEPLOY_HOME}/.ssh/authorized_keys"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "${DEPLOY_HOME}/.ssh"
if [[ ! -s "$DEPLOY_KEYS" && "$COPY_ROOT_KEYS" == "1" && -s /root/.ssh/authorized_keys ]]; then
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/authorized_keys "$DEPLOY_KEYS"
  info "Copied root's SSH authorized_keys to ${DEPLOY_USER} (the key you added in the provider panel)."
elif [[ -s "$DEPLOY_KEYS" ]]; then
  info "${DEPLOY_USER} already has authorized_keys."
else
  warn "${DEPLOY_USER} has no SSH authorized_keys. Add your PUBLIC key to ${DEPLOY_KEYS} to log in as ${DEPLOY_USER}."
fi

step "4/8 Firewall (UFW): allow only 22/tcp, 80/tcp, 443/tcp, 443/udp"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http (ACME + redirect)'
ufw allow 443/tcp comment 'https'
ufw allow 443/udp comment 'https (HTTP/3)'
ufw --force enable
ufw status verbose | sed 's/^/    /'

step "5/8 Unattended security upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades
info "Enabled (security updates install daily; no automatic reboots)."

step "6/8 fail2ban for sshd"
cat > /etc/fail2ban/jail.d/sshd-sentinel.local <<'EOF'
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable fail2ban
systemctl restart fail2ban
info "fail2ban active: 5 failed SSH logins in 10 min => 1 h ban."

step "7/8 Swap"
if [[ "$SWAP_SIZE" == "0" ]]; then
  info "Skipped (SWAP_SIZE=0)."
elif [[ -n "$(swapon --show --noheadings)" ]]; then
  info "Swap already active:"
  swapon --show | sed 's/^/    /'
elif [[ -e /swapfile ]]; then
  warn "/swapfile exists but is not active; leaving it alone. Enable it with: swapon /swapfile"
else
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  cat > /etc/sysctl.d/90-sentinel-swap.conf <<'EOF'
vm.swappiness=10
EOF
  sysctl -q -p /etc/sysctl.d/90-sentinel-swap.conf
  info "Created ${SWAP_SIZE} /swapfile (persistent, swappiness=10)."
fi

step "8/8 SSH hardening"
SSHD_DROPIN=/etc/ssh/sshd_config.d/10-sentinel-hardening.conf
if [[ "$HARDEN_SSH" != "1" ]]; then
  info "Skipped (HARDEN_SSH=0)."
elif [[ -s "$DEPLOY_KEYS" ]] && grep -qE '^(ssh-|ecdsa-|sk-)' "$DEPLOY_KEYS"; then
  # 10- sorts before the cloud image's 50-cloud-init.conf, and the first value sshd reads wins.
  cat > "$SSHD_DROPIN" <<'EOF'
# Written by NEAR Sentinel setup-server.sh. Key-only SSH logins.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl restart ssh
    info "Password logins disabled. Key logins for root and ${DEPLOY_USER} still work."
  else
    mv "$SSHD_DROPIN" "${SSHD_DROPIN}.invalid"
    warn "sshd rejected the hardening config; it was renamed to ${SSHD_DROPIN}.invalid and SSH is unchanged."
  fi
else
  warn "NOT disabling SSH password login: ${DEPLOY_KEYS} has no SSH public key."
  warn "Add a key for ${DEPLOY_USER}, confirm you can log in with it, then re-run this script."
fi

step "Done"
info "Next, in a NEW terminal (keep this one open until it works):"
info "  ssh ${DEPLOY_USER}@<server-ip>"
info "  git clone <REPO_URL> near-sentinel && cd near-sentinel"
info "  cp deploy/vultr/env.production.example deploy/vultr/.env.production && nano deploy/vultr/.env.production"
info "  bash deploy/vultr/deploy.sh"
if [[ -f /var/run/reboot-required ]]; then
  warn "A reboot is required to finish the upgrade: run 'reboot' once you have confirmed SSH access as ${DEPLOY_USER}."
fi
