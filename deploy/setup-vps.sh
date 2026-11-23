#!/usr/bin/env bash
# Publica o Desapego em um VPS Ubuntu/Debian com Nginx, systemd e HTTPS (Let's Encrypt).
#
# Uso (no VPS, como root, a partir da pasta do projeto enviada ao servidor):
#   SETUP_EMAIL=seu@email.com bash deploy/setup-vps.sh
#
# O script é repetível: pode ser executado de novo para atualizar o código.
# Não apaga dados: o banco e as fotos ficam em /var/lib/desapego-arrivoinitalia.

set -euo pipefail

DOMINIO="desapego.arrivoinitalia.com"
PORTA="3111"
USUARIO="desapego"
APP_DIR="/opt/desapego-arrivoinitalia"
DATA_DIR="/var/lib/desapego-arrivoinitalia"
ENV_FILE="/etc/desapego-arrivoinitalia.env"
SERVICO="desapego-arrivoinitalia"
ORIGEM="$(cd "$(dirname "$0")/.." && pwd)"

function passo() { echo; echo "==> $1"; }
function erro() { echo "ERRO: $1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || erro "execute como root (sudo bash deploy/setup-vps.sh)"
[[ -n "${SETUP_EMAIL:-}" ]] || erro "defina SETUP_EMAIL=seu@email.com (exigido pelo Let's Encrypt)"

passo "Verificando Node.js 22 ou superior"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  erro "Node.js 22+ não encontrado. Instale com: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
fi
NODE_BIN="$(command -v node)"
echo "Node: $("$NODE_BIN" --version) em $NODE_BIN"

passo "Instalando Nginx e Certbot (se necessário)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx rsync >/dev/null

passo "Criando usuário e pastas"
id "$USUARIO" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$USUARIO"
mkdir -p "$APP_DIR" "$DATA_DIR/uploads"
chown -R "$USUARIO:$USUARIO" "$DATA_DIR"

passo "Copiando o código para $APP_DIR"
rsync -a --delete \
  --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude '.git' \
  "$ORIGEM/" "$APP_DIR/"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

passo "Configuração de ambiente ($ENV_FILE)"
if [[ ! -f "$ENV_FILE" ]]; then
  read -r -s -p "Defina a senha do painel administrativo: " SENHA; echo
  [[ ${#SENHA} -ge 12 ]] || erro "use uma senha com pelo menos 12 caracteres"
  read -r -p "Chave Pix (CPF, e-mail ou +55telefone): " PIX
  cat > "$ENV_FILE" <<EOF
PORT=$PORTA
PUBLIC_BASE_URL=https://$DOMINIO
DATA_DIR=$DATA_DIR
ADMIN_PASSWORD=$SENHA
RESERVA_HORAS=48
WHATSAPP_NUMERO=5548984443883
PIX_CHAVE=$PIX
PIX_NOME=CLEO M GARCIA
PIX_CIDADE=FLORIANOPOLIS
MP_MODO_JUROS=link
EOF
  chmod 600 "$ENV_FILE"
  echo "Arquivo criado com permissão restrita (600)."
else
  echo "Arquivo já existe; mantido sem alteração."
fi

passo "Serviço systemd"
cat > "/etc/systemd/system/$SERVICO.service" <<EOF
[Unit]
Description=Desapego (desapego.arrivoinitalia.com)
After=network.target

[Service]
Type=simple
User=$USUARIO
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICO" >/dev/null
systemctl restart "$SERVICO"

passo "Nginx"
cp "$APP_DIR/deploy/nginx-desapego.conf" "/etc/nginx/sites-available/$DOMINIO"
ln -sf "/etc/nginx/sites-available/$DOMINIO" "/etc/nginx/sites-enabled/$DOMINIO"
nginx -t
systemctl reload nginx

passo "Certificado HTTPS (Let's Encrypt)"
certbot --nginx -d "$DOMINIO" --non-interactive --agree-tos -m "$SETUP_EMAIL" --redirect

passo "Verificação"
sleep 2
systemctl is-active --quiet "$SERVICO" || erro "o serviço não iniciou. Veja: journalctl -u $SERVICO -n 50"
curl -fsS "http://127.0.0.1:$PORTA/api/config" >/dev/null && echo "Aplicação respondendo localmente."
curl -fsS "https://$DOMINIO/api/config" >/dev/null && echo "HTTPS público funcionando: https://$DOMINIO"

echo
echo "Concluído. Acesse https://$DOMINIO e o painel em https://$DOMINIO/admin/"
