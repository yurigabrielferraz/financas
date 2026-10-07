#!/usr/bin/env bash
# Sobe a API + interface web em http://localhost:8000
# Para acessar pelo celular na mesma rede Wi-Fi: HOST=0.0.0.0 ./run.sh
set -e
cd "$(dirname "$0")/backend"
# Usa o banco da pasta do Google Drive (Meu Drive/Financas/financas.db), se existir
if [ -z "$FINANCAS_DB" ]; then
  for f in "$HOME"/Library/CloudStorage/GoogleDrive-*/*/Financas/financas.db; do
    [ -f "$f" ] && export FINANCAS_DB="$f" && break
  done
fi
echo "Banco: ${FINANCAS_DB:-backend/data/financas.db (local)}"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
exec .venv/bin/uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}" "$@"
