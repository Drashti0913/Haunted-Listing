#!/bin/bash
# Free deploy on AWS: run this inside a fresh Amazon Linux 2023 EC2 instance
# (EC2 > Instances > Connect > EC2 Instance Connect opens a browser terminal).
#   curl -fsSL https://raw.githubusercontent.com/Drashti0913/Haunted-Listing/main/deploy/ec2_setup.sh | bash
# Re-run it any time to pull the latest code from GitHub and restart the game.
set -e

if [ "$(uname)" != "Linux" ] || ! command -v dnf >/dev/null 2>&1; then
  echo "STOP: this is your own computer, not the AWS server."
  echo "Open AWS > EC2 > your instance > Connect > EC2 Instance Connect > Connect,"
  echo "then paste this command into that BROWSER terminal (prompt: ec2-user@ip-...)."
  exit 1
fi

echo "==> Installing Docker and git"
sudo dnf install -y docker git >/dev/null
sudo systemctl enable --now docker

# Small free instances have 1 GB RAM; add swap so the Docker build doesn't run out of memory.
if [ ! -f /swapfile ]; then
  echo "==> Adding 2 GB swap"
  sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
fi

echo "==> Getting the code"
cd ~
[ -d Haunted-Listing ] || git clone -q https://github.com/Drashti0913/Haunted-Listing.git
cd Haunted-Listing && git pull -q

if [ ! -f .env ]; then
  echo "==> Your keys (typing is hidden; they stay on this server only)"
  read -rsp "Capital One NESSIE_API_KEY: " NESSIE < /dev/tty; echo
  read -rsp "Gemini GOOGLE_API_KEY: " GOOGLE < /dev/tty; echo
  printf "NESSIE_API_KEY=%s\nGOOGLE_API_KEY=%s\nGEMINI_MODEL=gemini-2.5-flash\n" "$NESSIE" "$GOOGLE" > .env
  chmod 600 .env
fi

echo "==> Building and starting the game (first build takes a few minutes)"
sudo docker build -q -t haunted-listing . >/dev/null
sudo docker rm -f haunted-listing >/dev/null 2>&1 || true
sudo docker run -d --name haunted-listing --restart unless-stopped \
  --env-file .env -p 80:8080 haunted-listing >/dev/null

echo "==> Turning on auto-update (checks GitHub every 2 minutes)"
sudo tee /etc/systemd/system/haunted-update.service >/dev/null <<UNIT
[Service]
Type=oneshot
User=root
ExecStart=/bin/bash /home/ec2-user/Haunted-Listing/deploy/auto_update.sh
UNIT
sudo tee /etc/systemd/system/haunted-update.timer >/dev/null <<UNIT
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT
sudo git config --global --add safe.directory /home/ec2-user/Haunted-Listing
sudo systemctl daemon-reload
sudo systemctl enable --now haunted-update.timer >/dev/null 2>&1

sleep 5
echo
echo "Live at: http://$(curl -s https://checkip.amazonaws.com)"
echo "Auto-update is on: new pushes to GitHub go live within about 5 minutes."
