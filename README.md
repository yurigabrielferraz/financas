# Minhas Finanças

Controle de finanças pessoais: gastos do dia a dia, contas fixas/recorrentes, boletos,
faturas de cartão de crédito (com parcelamento) e lembretes de vencimento.

- **Backend:** Python + FastAPI + SQLite (`backend/`)
- **Frontend:** HTML/CSS/JS puro, sem build, responsivo (`frontend/`)
- **API REST** em `/api/...`, a mesma que o futuro app Android vai consumir. Documentação interativa em <http://localhost:8000/docs>.

## Rodando

```bash
./run.sh
```

Abra <http://localhost:8000>. Na primeira execução ele cria o ambiente virtual e instala as dependências.
O banco fica em `backend/data/financas.db`. Para fazer backup, basta copiar esse arquivo.

Para abrir pelo celular na mesma rede Wi-Fi (sem autenticação ainda, use só em rede de confiança):

```bash
HOST=0.0.0.0 ./run.sh
```

e acesse `http://IP-DO-COMPUTADOR:8000`. No Chrome do Android dá pra usar "Adicionar à tela inicial".

Variáveis de ambiente: `FINANCAS_DB` (caminho do banco), `HOST`, `PORT`, `FINANCAS_DISABLE_NOTIFIER=1`.

## Dados no Google Drive (web + app Android)

O banco é **um arquivo só** (`financas.db`) numa pasta do Google Drive, usado pelos dois:

- **Mac/web:** o app *Google Drive para computador* sincroniza a pasta. O `run.sh` encontra sozinho
  `~/Library/CloudStorage/GoogleDrive-*/<Meu Drive>/Financas/financas.db` (ou use `FINANCAS_DB=...`).
- **Android:** o app abre o mesmo arquivo pelo seletor de arquivos do sistema (Drive), trabalha numa cópia
  local e grava de volta a cada alteração; ao abrir, baixa a versão mais nova.

Configuração:

1. Instale o Drive para computador (`brew install --cask google-drive`), entre na conta e marque a pasta
   `Meu Drive/Financas` como **Disponível off-line**.
2. Com o servidor parado, mova o banco: `mv backend/data/financas.db "<pasta do Drive>/Financas/"`.
3. No celular: instale o APK e toque em **Abrir arquivo do Drive** → `Financas/financas.db`.

Limite: é "último a gravar vence". Se editar no Mac e no celular antes do Drive sincronizar, o app detecta
e pergunta qual versão manter (não mescla). Na prática: um aparelho por vez.

## App Android (`android/`)

Kotlin + Jetpack Compose + Material 3, sem servidor. As regras de `backend/app/logic.py` estão portadas em
`android/app/src/main/java/app/financas/data/` (mesmo SQL; `schema.sql`/`seed.sql` são compartilhados).
Mudou uma regra no Python? Mude também no Kotlin e rode os testes dos dois lados.

```bash
cd android
./gradlew testDebugUnitTest      # regras (JVM, sqlite-jdbc)
./gradlew assembleRelease        # APK em app/build/outputs/apk/release/app-release.apk
```

Requer JDK 17 (`brew install openjdk@17`) e Android SDK (`brew install --cask android-commandlinetools`),
com `JAVA_HOME` e `ANDROID_HOME` apontando para eles (ou `local.properties` com `sdk.dir`).

Lembretes: verificação diária local (WorkManager) no horário configurado em Ajustes, com botão
"Marcar como paga" na notificação.

## Servidor na nuvem (Google Cloud, custo zero) — opcional, não usado no momento

1. Crie uma VM **e2-micro**, Debian 12, em `us-central1`, `us-west1` ou `us-east1` (free tier), disco padrão de 30 GB,
   marcando "Permitir tráfego HTTP/HTTPS".
2. Crie um subdomínio grátis em <https://www.duckdns.org>.
3. Na VM (SSH pelo console): copie `deploy/setup.sh` e rode `sudo bash setup.sh`. O script instala tudo
   (Caddy com HTTPS, serviço systemd, backup diário, DuckDNS), pede para cadastrar uma *deploy key* no GitHub
   e mostra o **token de acesso** uma única vez.
4. Abra `https://SEU-SUBDOMINIO.duckdns.org`, cole o token e importe seu backup em Ajustes → Dados.

Atualizar a VM depois de um `git push`:

```bash
sudo -H -u financas git -C /opt/financas pull && sudo systemctl restart financas
```

Com `FINANCAS_TOKEN` definido, toda a API exige `Authorization: Bearer <token>` (a página web pede o token uma vez).

## Testes

```bash
cd backend && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest
```

## Conceitos

| Conceito | Como funciona |
|---|---|
| **Lançamento** | Receita ou despesa com data, categoria e conta *ou* cartão. Pode ser parcelado (`installments`). |
| **Conta fixa (recorrência)** | Aluguel, internet, assinatura, boleto, salário... Gera automaticamente um lançamento pendente por período (semanal, mensal, anual). Editar atualiza só os meses futuros ainda não pagos. Excluir um mês específico não o recria. |
| **Cartão** | Tem dia de fechamento e vencimento. Cada compra vai para a fatura certa (`invoice_month` = mês em que a fatura vence). Compras no dia do fechamento ou depois entram na fatura seguinte. Parcelas caem uma em cada fatura. |
| **Fatura** | Soma das compras do cartão naquele mês. Pagar a fatura debita a conta escolhida e quita todos os lançamentos dela. |
| **Saldo da conta** | Saldo inicial + receitas recebidas − despesas pagas − faturas pagas. |
| **Resumo do mês** | Visão de caixa: despesas = contas do mês + faturas que vencem no mês. Gastos por categoria usam a data da compra. |
| **Dia útil** | Vencimentos de contas fixas (despesas) e de faturas que caem em fim de semana ou feriado vão para o próximo dia útil (feriados nacionais + Carnaval, Sexta-feira Santa e Corpus Christi). Receitas não são deslocadas. |
| **Parcelado** | Informe o valor total (`amount_mode: total`, dividido entre as parcelas) ou o valor de cada parcela (`amount_mode: installment`). |
| **Lembretes** | Contas não pagas que vencem dentro de N dias (por conta fixa, cartão ou lançamento; senão o padrão). Vencidas sempre aparecem. |

Valores monetários trafegam e são armazenados em **centavos** (inteiros). Datas em `AAAA-MM-DD`, meses em `AAAA-MM`.

## Notificações

- **Navegador:** Ajustes → "Ativar notificações" (funciona com a página aberta).
- **Celular (ntfy):** instale o app gratuito [ntfy](https://ntfy.sh) no Android, assine um tópico com nome difícil de adivinhar
  e configure o mesmo tópico em Ajustes. O servidor envia um resumo diário no horário escolhido.
  Atenção: no servidor público ntfy.sh, qualquer pessoa que souber o nome do tópico pode ler as mensagens.

## Principais endpoints

| Método | Rota | |
|---|---|---|
| GET | `/api/summary?month=AAAA-MM` | Resumo do mês |
| GET/POST | `/api/transactions` | Lista (filtros: `month, kind, status, category_id, account_id, card_id, q`) / cria |
| PUT/DELETE | `/api/transactions/{id}` | Edita / exclui (`scope=one\|future\|all` para parcelados) |
| POST | `/api/transactions/{id}/pay` | Marca como pago (`{paid, paid_date, account_id, amount}`) |
| GET/POST/PUT/DELETE | `/api/recurrences` | Contas fixas |
| GET/POST/PUT/DELETE | `/api/cards` | Cartões (com fatura atual e limite usado) |
| GET | `/api/cards/{id}/invoice?month=` | Fatura com itens |
| POST/DELETE | `/api/cards/{id}/invoice/{month}/pay` | Paga / desfaz pagamento da fatura |
| GET/POST/PUT/DELETE | `/api/accounts`, `/api/categories` | Cadastros |
| GET | `/api/reminders` | Contas vencidas / a vencer |
| GET | `/api/upcoming?days=60` | Contas não pagas até N dias, com `remind_on` (para notificações do app) |
| GET/PUT | `/api/settings` | Configurações |
| GET | `/api/daily?start=AAAA-MM&months=12` | Grade de saldos dia a dia |
| GET | `/api/backup` | Baixa uma cópia do banco |
| POST | `/api/restore` | Importa um backup (corpo binário do arquivo `.db`); salva antes uma cópia em `data/backups/` |
| POST | `/api/reset` | Apaga todos os dados (`{"confirm": "APAGAR"}`) |

## Próximos passos sugeridos

1. **Autenticação** (token/JWT) antes de expor o servidor fora da rede local.
2. **Hospedar o backend** (VPS, Fly.io, Railway...) ou usar Tailscale para acessar de qualquer lugar.
3. **App Android** (Kotlin + Jetpack Compose, ou Flutter/React Native) consumindo esta API, com notificações locais
   agendadas a partir de `/api/reminders`.
4. Orçamento/meta por categoria, importação de extrato (OFX/CSV) e da fatura do cartão, gráficos de evolução mensal.
