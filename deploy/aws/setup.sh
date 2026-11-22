#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 EC2 server for LifeLink.   Usage:  sudo bash setup.sh api.example.com you@example.com
# (domain = the name whose DNS A record already points to this server's Elastic IP; email = for the certificate notices)
set -euo pipefail
DOMAIN="${1:?domain missing, e.g. api.example.com}"; EMAIL="${2:?email missing}"
REPO="${REPO:-https://github.com/vm0699/BloodBank.git}"
apt-get update -y && apt-get install -y curl git nginx certbot python3-certbot-nginx unattended-upgrades
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
id lifelink >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin lifelink
mkdir -p /var/lib/lifelink && chown lifelink:lifelink /var/lib/lifelink && chmod 700 /var/lib/lifelink
if [ ! -d /opt/lifelink/.git ]; then git clone "$REPO" /opt/lifelink; fi
chown -R lifelink:lifelink /opt/lifelink
sudo -u lifelink bash -c 'cd /opt/lifelink/server && npm ci --omit=dev'
[ -f /etc/lifelink.env ] || { install -m 600 -o root -g root /dev/null /etc/lifelink.env; echo "Created empty /etc/lifelink.env: fill it in (copy the layout from /opt/lifelink/deploy/aws/lifelink.env.example), then run: sudo systemctl restart lifelink"; }
cp /opt/lifelink/deploy/aws/lifelink.service /etc/systemd/system/lifelink.service
sed "s/__DOMAIN__/$DOMAIN/g" /opt/lifelink/deploy/aws/nginx-lifelink.conf > /etc/nginx/sites-available/lifelink
ln -sf /etc/nginx/sites-available/lifelink /etc/nginx/sites-enabled/lifelink; rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
systemctl daemon-reload && systemctl enable lifelink
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email --redirect -n
echo "Done. Fill /etc/lifelink.env, then: sudo systemctl restart lifelink && curl https://$DOMAIN/api/health"
