# Minhas Finanças

Controle de finanças pessoais: gastos do dia a dia, contas fixas/recorrentes, boletos,
faturas de cartão de crédito (com parcelamento) e lembretes de vencimento.

**Sem servidor:** é uma página estática (HTML/CSS/JS, sem build) publicada no GitHub Pages. O banco é um
arquivo SQLite (`minhas-financas.db`) no **seu Google Drive**; a página o baixa, roda o SQLite no próprio
navegador ([sql.js](https://sql.js.org)) e grava de volta a cada alteração. Mesmo endereço no celular e no PC.

```
frontend/
  index.html, css/, sql/schema.sql, sql/seed.sql
  js/app.js          telas
  js/api.js          api.get/post/put/del -> "servidor" local
  js/core/server.js  regras e rotas (faturas, recorrências, grade de saldos, lembretes)
  js/core/dates.js   datas, dias úteis/feriados, vencimento de faturas
  js/store.js        sql.js + Google Drive (login, download/upload, conflito) ou modo local (IndexedDB)
  js/config.js       Client ID do Google
tests/server.test.mjs
```

## Desenvolvimento

```bash
npm install
npm test     # regras (node:test + sql.js)
npm start    # http://localhost:8000
```

Sem Client ID configurado, use "Só neste navegador" (dados no IndexedDB) para testar.

## Google Drive (configuração única)

1. <https://console.cloud.google.com> → crie um projeto → **APIs e serviços › Biblioteca** → ative a **Google Drive API**.
2. **Tela de consentimento OAuth**: tipo *Externo*, preencha nome/e-mail; em *Usuários de teste* adicione seu e-mail.
3. **Credenciais › Criar credenciais › ID do cliente OAuth** → *Aplicativo da Web*. Em *Origens JavaScript
   autorizadas* coloque `https://yurigabrielferraz.github.io` e `http://localhost:8000`.
4. Copie o Client ID para `frontend/js/config.js`.

Escopo usado: `drive.file` — a página só enxerga os arquivos que ela mesma criou no seu Drive.
O acesso do Google dura 1 h (limite do Google para apps sem servidor). Vencido, o site abre pela cópia local
deste aparelho e o primeiro clique em qualquer lugar renova o acesso (janela do Google abre e fecha) e sincroniza.

Conflito: antes de enviar, a página compara o arquivo do Drive com o da última sincronização; se mudou em
outro aparelho enquanto havia alterações aqui, pergunta qual versão manter (não mescla).

## Importar fatura do Itaú

Em **Cartões › [cartão] › Importar fatura (PDF)**: escolha o PDF baixado no app do Itaú. O PDF é lido no
navegador (pdf.js; o arquivo não sai do aparelho) por `js/core/itau.js`, e uma prévia mostra cada lançamento com
status (novo / já lançado / valor diferente), categoria sugerida e a conferência da soma com o total da fatura.

- Parcela `k/n`: entra na fatura atual e as parcelas seguintes são criadas nas próximas faturas.
- Reimportar (ou importar o mês seguinte) não duplica: casa por fatura, data da compra, parcela e valor.
- Nome editável na prévia; o nome escolhido fica lembrado para o mesmo estabelecimento nas próximas faturas.
- Categoria: a última usada para esse nome no app; senão, a categoria que o Itaú informa.
- Ignora "Pagamentos efetuados", "Compras parceladas - próximas faturas" e encargos.

## Lembretes no Google Agenda

Ajustes › Google Agenda › Ativar. Pede o escopo `calendar.app.created` (o app só vê a agenda que ele cria) e
cria a agenda **Minhas Finanças**. `js/calendar.js` mantém um evento por conta a pagar e por vencimento de fatura
(vencidos e próximos 60 dias, via `/upcoming`), como evento de dia inteiro no vencimento, com lembrete às
`notify_hour`h N dias antes (antecedência da conta) e na véspera. IDs fixos (`fin` + hex da chave): sincronizar de novo não duplica; pago/excluído some.
Atualiza ao abrir o site e ~3 s depois de cada alteração. Requer a Google Calendar API ativada no projeto.

## Conceitos

| Conceito | Como funciona |
|---|---|
| **Lançamento** | Receita ou despesa com data, categoria e conta *ou* cartão. Pode ser parcelado (`installments`). |
| **Conta fixa (recorrência)** | Aluguel, internet, assinatura, boleto, salário... Gera automaticamente um lançamento pendente por período (semanal, mensal, anual). Editar atualiza os meses ainda não pagos. Excluir um mês específico não o recria. |
| **Cartão** | Tem dia de fechamento e vencimento. Cada compra vai para a fatura certa (`invoice_month` = mês em que a fatura vence). Compras no dia do fechamento ou depois entram na fatura seguinte. Parcelas caem uma em cada fatura. |
| **Fatura** | Soma das compras do cartão naquele mês. Pagar a fatura debita a conta escolhida e quita todos os lançamentos dela. |
| **Saldo da conta** | Saldo inicial + receitas recebidas − despesas pagas − faturas pagas. |
| **Resumo do mês** | Visão de caixa: despesas = contas do mês + faturas que vencem no mês. Gastos por categoria usam a data da compra. |
| **Dia útil** | Vencimento de fatura em fim de semana/feriado vai para o próximo dia útil (feriados nacionais + Carnaval, Sexta-feira Santa e Corpus Christi). Em cada conta fixa escolhe-se: adia, antecipa ou mantém (padrão: despesa adia, receita antecipa). |
| **Parcelado** | Informe o valor total (dividido entre as parcelas) ou o valor de cada parcela. Ao editar uma parcela, escolhe-se: só esta, esta e as seguintes ou todas. |
| **Lembretes** | Contas não pagas que vencem dentro de N dias (por conta fixa, cartão ou lançamento; senão o padrão). Vencidas sempre aparecem. |

Valores monetários são armazenados em **centavos** (inteiros). Datas em `AAAA-MM-DD`, meses em `AAAA-MM`.

## Versões anteriores

Até outubro/2026 havia uma API em Python (FastAPI) e um app Android nativo; foram removidos (estão no
histórico do git). A cópia local dos dados daquela versão fica em `legado/` (fora do git).
