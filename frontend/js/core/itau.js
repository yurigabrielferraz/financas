// Leitor da fatura do cartão Itaú em PDF (texto extraído pelo pdf.js, com posições).
// Cada página: lista de itens { s: texto, x, y, w }. Função pura, sem DOM.
//
// Layout: blocos com cabeçalho "DATA | ESTABELECIMENTO | VALOR EM R$" (às vezes duas colunas por
// página), título da seção logo acima do cabeçalho; cada lançamento ocupa uma linha
// (dd/mm, descrição, valor) seguida de outra com "categoria cidade".

const SKIP_SECTIONS = /pagamentos efetuados|pr[oó]ximas faturas/i;

export function parseMoneyBR(s) {
  const m = /^(-)?\s*([\d.]+),(\d{2})$/.exec(String(s).trim());
  return m ? (m[1] ? -1 : 1) * (parseInt(m[2].replace(/\./g, ''), 10) * 100 + +m[3]) : null;
}

/** Junta itens de texto: espaço só quando há distância entre eles (acentos vêm como itens separados). */
function joinItems(items) {
  let out = '';
  let end = null;
  for (const it of items) {
    if (end != null && it.x - end > 1.5) out += ' ';
    out += it.s;
    end = it.x + (it.w || 0);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Agrupa itens em linhas (mesma altura, tolerância de 2pt), de cima para baixo. */
function toLines(items) {
  const lines = [];
  for (const it of items.filter(i => i.s.trim())) {
    let line = lines.find(l => Math.abs(l.y - it.y) <= 2);
    if (!line) lines.push(line = { y: it.y, items: [] });
    line.items.push(it);
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => b.y - a.y);
}

/**
 * @param pages array de páginas; cada uma, array de { s, x, y, w }
 * @returns {{ dueDate, total, launchesTotal, last4, items: Array<{date, description, amount,
 *            installmentNo, installmentTotal, itauCategory, section}> }}
 */
export function parseItau(pages) {
  const allLines = pages.map(toLines);
  const fullText = allLines.flat().map(l => joinItems(l.items)).join('\n');
  const find = re => re.exec(fullText)?.[1] ?? null;

  const dueBR = find(/Vencimento:\s*(\d{2}\/\d{2}\/\d{4})/);
  if (!dueBR) throw new Error('Não parece uma fatura do cartão Itaú (vencimento não encontrado).');
  const [dd, mm, yyyy] = dueBR.split('/').map(Number);
  const dueDate = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const toISO = ddmm => {
    const [d, m] = ddmm.split('/').map(Number);
    const y = m > mm ? yyyy - 1 : yyyy; // compra de um mês "depois" do vencimento é do ano anterior
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  const items = [];
  allLines.forEach(lines => {
    // cabeçalhos de bloco: "DATA" com "VALOR EM R$" à direita na mesma linha
    const headers = [];
    for (const l of lines) {
      l.items.forEach((it, i) => {
        if (it.s.trim() !== 'DATA') return;
        const valor = l.items.slice(i + 1).find(v => /VALOR EM R\$/.test(v.s));
        if (valor) headers.push({ y: l.y, x0: it.x - 6, x1: valor.x + (valor.w || 50) + 6 });
      });
    }
    const inCol = (h, it) => it.x >= h.x0 && it.x < h.x1;
    for (const h of headers) {
      const colText = l => joinItems(l.items.filter(it => inCol(h, it)));
      const title = lines.filter(l => l.y > h.y && l.y - h.y <= 35)
        .map(colText).reverse().find(t => /pagamentos|lan[cç]amentos|compras/i.test(t)) || '';
      if (SKIP_SECTIONS.test(title)) continue;
      const nextHeader = headers.filter(o => o.y < h.y && Math.abs(o.x0 - h.x0) < 30).sort((a, b) => b.y - a.y)[0];
      // só as linhas (e itens) desta coluna: a outra coluna da página tem alturas intercaladas
      const body = lines.filter(l => l.y < h.y && (!nextHeader || l.y > nextHeader.y))
        .map(l => ({ y: l.y, items: l.items.filter(it => inCol(h, it)) })).filter(l => l.items.length);

      body.forEach((l, i) => {
        const its = l.items;
        if (its.length < 3 || !/^\d{2}\/\d{2}$/.test(its[0].s.trim())) return;
        const amount = parseMoneyBR(its[its.length - 1].s);
        if (amount == null) return;
        let description = joinItems(its.slice(1, -1));
        let installmentNo = null, installmentTotal = null;
        const inst = /\s(\d{2})\/(\d{2})$/.exec(description);
        if (inst && +inst[1] >= 1 && +inst[1] <= +inst[2]) {
          [installmentNo, installmentTotal] = [+inst[1], +inst[2]];
          description = description.slice(0, inst.index).trim();
        }
        // linha seguinte (mesma coluna, até 12pt abaixo): "categoria cidade"
        const next = body[i + 1];
        const nextIts = next && l.y - next.y <= 12 ? next.items : [];
        const catLine = nextIts.length && !/^\d{2}\/\d{2}$/.test(nextIts[0].s.trim()) ? joinItems(nextIts) : '';
        items.push({
          date: toISO(its[0].s.trim()), description, amount, installmentNo, installmentTotal,
          itauCategory: catLine.split(' ')[0]?.toLowerCase() || null, section: title,
        });
      });
    }
  });

  return {
    dueDate,
    total: parseMoneyBR(find(/Total desta fatura\s+(-?[\d.]+,\d{2})/) ?? ''),
    launchesTotal: parseMoneyBR(find(/Total dos lan[cç]amentos atuais\s+(-?[\d.]+,\d{2})/) ?? ''),
    last4: find(/\d{4}\.XXXX\.XXXX\.(\d{4})/),
    items: items.sort((a, b) => a.date.localeCompare(b.date)),
  };
}
