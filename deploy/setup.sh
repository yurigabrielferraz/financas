#!/usr/bin/env bash
# Instala o Minhas Finanças numa VM Debian 12 (Google Cloud e2-micro).
# Na VM:  curl -fsSLO <url deste arquivo>  ou cole o conteúdo, depois:  sudo bash setup.sh
# Pode ser rodado de novo com segurança (não recria token nem banco).
set -euo pipefail
REPO="git@github.com:yurigabrielferraz/financas.git"
APP=/opt/financas
DATA=/var/lib/financas
ENVF=/etc/financas.env
HOMEDIR=/home/financas

[[ $EUID -eq 0 ]] || { echo "Rode com: sudo bash setup.sh"; exit 1; }
read -rp "Subdomínio DuckDNS (só o nome, ex.: minhasfinancas): " SUB
read -rsp "Token do DuckDNS: " DUCK; echo
DOMAIN="$SUB.duckdns.org"

echo "==> Pacotes"
apt-get update -q
apt-get install -y -q git python3-venv sqlite3 caddy unattended-upgrades curl

echo "==> Usuário e pastas"
id financas &>/dev/null || useradd --system --create-home --home-dir "$HOMEDIR" --shell /usr/sbin/nologin financas
install -d -o financas -g financas "$DATA" "$DATA/backups"

echo "==> DuckDNS ($DOMAIN -> IP desta VM, atualizado a cada 5 min)"
cat > /etc/cron.d/duckdns <<EOF
*/5 * * * * root curl -fsS "https://www.duckdns.org/update?domains=$SUB&token=$DUCK&ip=" >/dev/null
EOF
chmod 600 /etc/cron.d/duckdns
curl -fsS "https://www.duckdns.org/update?domains=$SUB&token=$DUCK&ip=" | grep -q OK \
  || { echo "DuckDNS recusou o subdomínio/token"; exit 1; }

echo "==> Código"
KEY="$HOMEDIR/.ssh/id_ed25519"
if [[ ! -f $KEY ]]; then
  install -d -m 700 -o financas -g financas "$HOMEDIR/.ssh"
  sudo -H -u financas ssh-keygen -q -t ed25519 -N "" -C "financas-vm" -f "$KEY"
  ssh-keyscan -q github.com | sudo -H -u financas tee -a "$HOMEDIR/.ssh/known_hosts" >/dev/null
fi
if [[ ! -d $APP/.git ]]; then
  echo
  echo "Adicione esta chave como Deploy key (SOMENTE LEITURA) do repositório:"
  echo "  https://github.com/yurigabrielferraz/financas/settings/keys/new"
  echo
  cat "$KEY.pub"
  echo
  read -rp "Pressione Enter depois de adicionar a chave no GitHub..."
  install -d -o financas -g financas "$APP"
  sudo -H -u financas git clone -q "$REPO" "$APP"
fi
sudo -H -u financas python3 -m venv "$APP/backend/.venv"
sudo -H -u financas "$APP/backend/.venv/bin/pip" install -q -r "$APP/backend/requirements.txt"

if [[ ! -f $ENVF ]]; then
  TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  umask 027
  printf 'FINANCAS_TOKEN=%s\nFINANCAS_DB=%s/financas.db\nTZ=America/Sao_Paulo\n' "$TOKEN" "$DATA" > "$ENVF"
  chown root:financas "$ENVF"
  echo
  echo "################################################################"
  echo "TOKEN DE ACESSO — guarde no seu gerenciador de senhas:"
  echo "  $TOKEN"
  echo "(para ver de novo: sudo cat $ENVF)"
  echo "################################################################"
  echo
fi

echo "==> Serviço"
cp "$APP/deploy/financas.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable -q --now financas
systemctl restart financas

echo "==> HTTPS (Caddy + Let's Encrypt)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8000
}
EOF
systemctl reload caddy

echo "==> Backup diário (mantém 30 dias em $DATA/backups)"
cat > /etc/cron.daily/financas-backup <<EOF
#!/bin/sh
sqlite3 $DATA/financas.db ".backup '$DATA/backups/financas-\$(date +%F).db'"
find $DATA/backups -name 'financas-*.db' -mtime +30 -delete
EOF
chmod +x /etc/cron.daily/financas-backup

echo
echo "Pronto: https://$DOMAIN  (o certificado HTTPS pode levar ~1 min na primeira vez)"
