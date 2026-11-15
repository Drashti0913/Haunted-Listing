#!/bin/bash
# One-time: add the CoStar track data + keys to the EC2 server (run in the EC2 Instance
# Connect browser terminal, AFTER ec2_setup.sh). CoStar's data never goes to GitHub:
# it is downloaded and processed on the server itself.
#   curl -fsSL https://raw.githubusercontent.com/Drashti0913/Haunted-Listing/main/deploy/ec2_costar.sh | bash
set -e
if [ "$(uname)" != "Linux" ] || ! command -v dnf >/dev/null 2>&1; then
  echo "STOP: this is your own computer, not the AWS server. Paste this into the EC2 browser terminal."
  exit 1
fi
cd ~/Haunted-Listing
git pull -q

ask() { local v=""; while [ -z "$v" ]; do read -rsp "$1: " v < /dev/tty; echo >&2; done; echo "  ...${v: -4}" >&2; echo "$v"; }
set_env() { grep -v "^$1=" .env > .env.tmp || true; echo "$1=$2" >> .env.tmp; mv .env.tmp .env; chmod 600 .env; }

echo "==> CoStar track keys (typing is hidden)"
set_env MATTERPORT_API_KEY   "$(ask 'Matterport API key')"
set_env MATTERPORT_API_TOKEN "$(ask 'Matterport API token')"
set_env MATTERPORT_SDK_KEY   "$(ask 'Matterport SDK key')"
set_env VEXCEL_API_KEY       "$(ask 'Vexcel api_key')"

echo "==> CoStar hackathon kit"
read -rp "Download link of the kit zip (right-click the Discord link > Copy Link): " KIT_URL < /dev/tty
KIT_PW="$(ask 'Zip password')"
curl -fsSL -o /tmp/costar-kit.zip "$KIT_URL"
rm -rf costar-kit && mkdir costar-kit
sudo dnf install -y unzip python3-pip >/dev/null
unzip -q -P "$KIT_PW" /tmp/costar-kit.zip -d costar-kit && rm -f /tmp/costar-kit.zip

echo "==> Picking real buildings (CoStar + Matterport)"
python3 -m pip install -q --user httpx python-dotenv
python3 scripts/build_costar_buildings.py --per-city 10
rm -rf costar-kit            # keep only the small derived file

echo "==> Rebuilding the game"
sudo docker build -q -t haunted-listing . >/dev/null
sudo docker rm -f haunted-listing >/dev/null 2>&1 || true
sudo docker run -d --name haunted-listing --restart unless-stopped --env-file .env -p 80:8080 haunted-listing >/dev/null
echo "Done: http://$(curl -s https://checkip.amazonaws.com) now uses real CoStar, Vexcel and Matterport data."
