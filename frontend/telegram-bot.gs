// Minhas Finanças — bot do Telegram (Google Apps Script).
// A cada minuto lê as mensagens novas do bot, entende com o Gemini ("gastei 25,48 de uber") e anota
// o lançamento no arquivo minhas-financas-telegram.json do seu Drive. O app grava no banco ao abrir.
//
// Configuração (uma vez):
//  1. Ajustes do app › Telegram › Ativar (cria os arquivos no Drive).
//  2. Configurações do projeto › Propriedades do script: TELEGRAM_TOKEN (do @BotFather) e GEMINI_KEY (aistudio.google.com).
//  3. Mande qualquer mensagem para o seu bot e execute a função "configurar" (autorize o acesso).
// Só o chat que mandou a mensagem do passo 3 é atendido.

var INBOX = 'minhas-financas-telegram.json';
var CONTEXT = 'minhas-financas-telegram-contexto.json';
var TZ = 'America/Sao_Paulo';
var props = PropertiesService.getScriptProperties();

/** Liga o bot a este chat e agenda a verificação a cada minuto. */
function configurar() {
  var updates = telegram('getUpdates', {}).result;
  if (!updates.length) throw new Error('Mande uma mensagem para o seu bot no Telegram e execute de novo.');
  var last = updates[updates.length - 1];
  var chat = (last.message || last.edited_message).chat.id;
  props.setProperties({ CHAT_ID: String(chat), OFFSET: String(last.update_id + 1) });
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('verificar').timeBased().everyMinutes(1).create();
  arquivo(INBOX); arquivo(CONTEXT); // confere se o app já criou os arquivos
  telegram('sendMessage', { chat_id: chat, text: 'Pronto! Me conte seus gastos, ex.: "gastei 25,48 de uber".\n\n' + AJUDA });
}

var AJUDA = 'Exemplos:\n• gastei 25,48 de uber\n• mercado 132,90 no cartão Itaú\n• ontem almoço 42\n• recebi 300 de freela\n\n'
  + '"desfazer" remove a última anotação (se o app ainda não importou).';

/** Executada a cada minuto pelo acionador. */
function verificar() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var offset = Number(props.getProperty('OFFSET') || 0);
    var updates = telegram('getUpdates', { offset: offset, timeout: 0 }).result;
    updates.forEach(function (u) {
      props.setProperty('OFFSET', String(u.update_id + 1)); // antes de processar: erro não repete a mensagem
      var msg = u.message;
      if (!msg || !msg.text || String(msg.chat.id) !== props.getProperty('CHAT_ID')) return;
      try { responder(msg.chat.id, tratar(u.update_id, msg.text.trim())); }
      catch (e) { responder(msg.chat.id, '⚠️ Não consegui anotar: ' + e.message); }
    });
  } finally { lock.releaseLock(); }
}

/** Processa uma mensagem e devolve a resposta. */
function tratar(id, texto) {
  if (/^\/(start|help|ajuda)/i.test(texto)) return AJUDA;
  var inboxFile = arquivo(INBOX);
  var inbox = ler(inboxFile, { entries: [] });
  var ctx = ler(arquivo(CONTEXT), {});
  if (/^\/?desfaz(er)?$/i.test(texto)) {
    var ultimo = inbox.entries[inbox.entries.length - 1];
    if (!ultimo) return 'Nada para desfazer.';
    if (ultimo.id <= (ctx.last_id || 0)) return 'Esse já foi para o app (' + ultimo.description + '). Apague por lá.';
    inbox.entries = inbox.entries.filter(function (e) { return e.id !== ultimo.id; });
    inboxFile.setContent(JSON.stringify(inbox));
    return '↩️ Removido: ' + linha(ultimo);
  }
  var itens = entender(texto, ctx);
  if (!itens.length) return 'Não entendi um lançamento nessa mensagem.\n\n' + AJUDA;
  // até 9 lançamentos por mensagem; ids decimais mantêm a ordem do Telegram
  var novos = itens.slice(0, 9).map(function (it, i) {
    return { id: id + i / 10, at: new Date().toISOString(), text: texto, kind: it.tipo === 'entrada' ? 'income' : 'expense',
      description: it.descricao, amount: Math.round(it.valor * 100), date: it.data, category: it.categoria || null,
      payment: it.pagamento || null };
  }).filter(function (e) { return e.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(e.date); });
  if (!novos.length) return 'Não entendi o valor ou a data.\n\n' + AJUDA;
  var limite = Date.now() - 90 * 86400000; // já importados há mais de 90 dias saem do arquivo
  inbox.entries = inbox.entries.filter(function (e) { return e.id > (ctx.last_id || 0) || Date.parse(e.at) > limite; }).concat(novos);
  inboxFile.setContent(JSON.stringify(inbox));
  return '✅ Anotado:\n' + novos.map(function (e) { return '• ' + linha(e); }).join('\n');
}

function linha(e) {
  var hoje = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var ontem = Utilities.formatDate(new Date(Date.now() - 86400000), TZ, 'yyyy-MM-dd');
  var quando = e.date === hoje ? 'hoje' : e.date === ontem ? 'ontem' : e.date.slice(8, 10) + '/' + e.date.slice(5, 7);
  var valor = (e.amount / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (e.kind === 'income' ? '+' : '') + e.description + ' — R$ ' + valor + ' · ' + (e.category || 'sem categoria') + ' · ' + quando
    + (e.payment ? ' · ' + e.payment : '');
}

/** Pede ao Gemini os lançamentos da mensagem, em JSON. */
function entender(texto, ctx) {
  var agora = new Date();
  var cats = ctx.categories || { expense: [], income: [] };
  var prompt = [
    'Você anota lançamentos financeiros de um app pessoal brasileiro a partir de mensagens curtas.',
    'Hoje é ' + Utilities.formatDate(agora, TZ, 'EEEE, yyyy-MM-dd') + ' (fuso de São Paulo).',
    'Categorias de saída: ' + cats.expense.join(', ') + '.',
    'Categorias de entrada: ' + cats.income.join(', ') + '.',
    'Contas: ' + (ctx.accounts || []).join(', ') + '. Cartões de crédito: ' + ((ctx.cards || []).join(', ') || 'nenhum') + '.',
    'Como o usuário costuma categorizar: ' + (ctx.examples || []).map(function (x) { return x.description + ' → ' + x.category; }).join('; ') + '.',
    'Regras: valor em reais (vírgula é decimal: "25,48" = 25.48). data AAAA-MM-DD; sem data na mensagem = hoje; "ontem", "sexta", "dia 10" relativos a hoje (passado).',
    'descricao: curta, com inicial maiúscula, sem o valor (ex.: "Uber", "Almoço", "Mercado").',
    'categoria: exatamente um nome da lista do tipo certo; a mais provável. pagamento: exatamente o nome de uma conta ou cartão citado na mensagem; se não citou, null.',
    'tipo "entrada" só para dinheiro recebido (salário, pix recebido, reembolso). Se a mensagem não for um lançamento, devolva itens vazio.',
    'Mensagem: ' + texto,
  ].join('\n');
  var schema = {
    type: 'OBJECT', required: ['itens'],
    properties: { itens: { type: 'ARRAY', items: { type: 'OBJECT', required: ['tipo', 'descricao', 'valor', 'data', 'categoria'],
      properties: {
        tipo: { type: 'STRING', enum: ['saida', 'entrada'] }, descricao: { type: 'STRING' }, valor: { type: 'NUMBER' },
        data: { type: 'STRING' }, categoria: { type: 'STRING', nullable: true }, pagamento: { type: 'STRING', nullable: true },
      } } } },
  };
  var modelo = props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': props.getProperty('GEMINI_KEY') },
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema } }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  var parts = JSON.parse(res.getContentText()).candidates[0].content.parts;
  return JSON.parse(parts.map(function (p) { return p.text || ''; }).join('')).itens || [];
}

function arquivo(nome) {
  var files = DriveApp.getFilesByName(nome);
  var best = null;
  while (files.hasNext()) {
    var f = files.next();
    if (!f.isTrashed() && (!best || f.getLastUpdated() > best.getLastUpdated())) best = f;
  }
  if (!best) throw new Error('Arquivo ' + nome + ' não encontrado no Drive. Ative o Telegram nos Ajustes do app.');
  return best;
}

function ler(file, padrao) {
  try { return JSON.parse(file.getBlob().getDataAsString('UTF-8')) || padrao; } catch (e) { return padrao; }
}

function telegram(metodo, dados) {
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + props.getProperty('TELEGRAM_TOKEN') + '/' + metodo, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(dados), muteHttpExceptions: true,
  });
  var body = JSON.parse(res.getContentText());
  if (!body.ok) throw new Error('Telegram: ' + body.description);
  return body;
}

function responder(chat, texto) {
  telegram('sendMessage', { chat_id: chat, text: texto });
}
