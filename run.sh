#!/usr/bin/env bash
# Sobe a API + interface web em http://localhost:8000
# Para acessar pelo celular na mesma rede Wi-Fi: HOST=0.0.0.0 ./run.sh
set -e
cd "$(dirname "$0")/backend"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
exec .venv/bin/uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}" "$@"
