#!/bin/bash
# Runs on the EC2 server every 2 minutes (systemd timer set up by ec2_setup.sh):
# if GitHub has new commits, pull them, rebuild the image and restart the game.
cd /home/ec2-user/Haunted-Listing || exit 0
git fetch -q origin main || exit 0
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
git reset -q --hard origin/main
docker build -q -t haunted-listing . >/dev/null || exit 1
docker rm -f haunted-listing >/dev/null 2>&1 || true
docker run -d --name haunted-listing --restart unless-stopped --env-file .env -p 80:8080 haunted-listing >/dev/null
echo "updated to $(git rev-parse --short HEAD)"
