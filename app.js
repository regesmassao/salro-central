'use strict';
/* Salro Central — dashboard pessoal.
   Lê SOMENTE os backups que os apps Salário, IR, Recibos e Vendas
   guardam no Drive (via as pontes Apps Script que o dono configura
   em ⚙️ Conexões).
   Link e chave das pontes ficam só no localStorage deste aparelho —
   nunca no código, nunca em exportações. Os apps continuam
   independentes; aqui é só leitura. */

/* ================= Cálculos puros (testáveis) ================= */
const SalroCalc = (() => {
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  function ymShift(ym, n) {
    let [y, m] = ym.split('-').map(Number);
    m += n;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return y + '-' + pad2(m);
  }
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const ymLabel = (ym) => MESES[Number(ym.split('-')[1]) - 1] + '/' + ym.split('-')[0].slice(2);

  function fmtJPY(v) {
    if (v == null || isNaN(v)) return '—';
    return '¥ ' + Math.round(v).toLocaleString('pt-BR');
  }
  function fmtBRL(v) {
    if (v == null || isNaN(v)) return '—';
    return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtBRL0(v) {
    if (v == null || isNaN(v)) return '—';
    return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
  }
  function parseSafe(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  }

  /* ---- Salário: wrapper.data.data = dump do localStorage do app ---- */
  function msjMonth(inner, refDate) {
    const ym = ymOf(refDate);
    const employees = parseSafe(inner && inner['msj-employees'], []);
    const list = (Array.isArray(employees) ? employees : []).map((emp) => {
      const isPrincipal = emp.id === 'principal';
      const snapKey = isPrincipal ? 'msj-v4-3-months-' + ym : 'msj-func-' + emp.id + '-months-' + ym;
      const daysPrefix = isPrincipal ? 'msj-v4-2-days-' + ym + '-' : 'msj-func-' + emp.id + '-days-' + ym + '-';
      const snap = parseSafe(inner && inner[snapKey], null);
      let days = 0;
      if (inner) for (const k in inner) if (k.indexOf(daysPrefix) === 0) days++;
      return {
        id: emp.id, name: emp.name || emp.id,
        hasSnap: !!snap,
        net: snap ? Number(snap.net) || 0 : null,
        gross: snap ? Number(snap.gross) || 0 : null,
        days
      };
    });
    const withSnap = list.filter((e) => e.hasSnap);
    return {
      ym, employees: list,
      totalNet: withSnap.reduce((s, e) => s + e.net, 0),
      totalGross: withSnap.reduce((s, e) => s + e.gross, 0),
      complete: list.length > 0 && withSnap.length === list.length,
      anySnap: withSnap.length > 0,
      totalDays: list.reduce((s, e) => s + e.days, 0)
    };
  }

  /* ---- IR: data = {assets, operations, histProventos, quotes, ...} ---- */
  const CLASS_LABEL = { acao: 'Ações', fii: 'FIIs', etf: 'ETFs', tesouro: 'Tesouro Direto' };
  function irSummary(data) {
    const assets = (data && data.assets) || [];
    const ops = (data && data.operations) || [];
    const amap = {};
    assets.forEach((a) => { amap[a.id] = a; });
    const pos = {}; // assetId -> {qty, cost} pelo preço médio
    ops.forEach((op) => {
      const p = pos[op.assetId] || (pos[op.assetId] = { qty: 0, cost: 0 });
      const q = Number(op.qty) || 0, price = Number(op.price) || 0, fees = Number(op.fees) || 0;
      if (op.side === 'compra') { p.cost += q * price + fees; p.qty += q; }
      else if (op.side === 'venda' && p.qty > 0) {
        const avg = p.cost / p.qty;
        p.cost -= avg * q; p.qty -= q;
        if (p.qty <= 0) { p.qty = 0; p.cost = 0; }
      }
    });
    let totalCost = 0;
    const classMap = {};
    let market = 0, marketOk = true, marketDate = '';
    const quotes = (data && data.quotes) || {};
    Object.keys(pos).forEach((aid) => {
      const p = pos[aid];
      if (p.qty <= 0) return;
      totalCost += p.cost;
      const type = (amap[aid] && amap[aid].type) || 'outro';
      classMap[type] = (classMap[type] || 0) + p.cost;
      const q = quotes[aid];
      if (q && q.value != null) {
        market += p.qty * Number(q.value);
        if (q.date && q.date > marketDate) marketDate = q.date;
      } else marketOk = false;
    });
    const byClass = Object.keys(classMap).map((k) => ({
      key: k, label: CLASS_LABEL[k] || k, value: classMap[k],
      pct: totalCost > 0 ? (classMap[k] / totalCost) * 100 : 0
    })).sort((a, b) => b.value - a.value);

    const hp = (data && data.histProventos) || {};
    const keys = Object.keys(hp).sort();
    let series = [], total12 = 0, allTime = 0;
    keys.forEach((k) => { allTime += Number(hp[k]) || 0; });
    if (keys.length) {
      const endYm = keys[keys.length - 1];
      for (let i = 11; i >= 0; i--) {
        const ym = ymShift(endYm, -i);
        const v = Number(hp[ym]) || 0;
        series.push({ ym, label: ymLabel(ym), value: v });
        total12 += v;
      }
    }
    return {
      totalCost, byClass, series, total12, allTime,
      market: marketOk && totalCost > 0 ? market : null, marketDate,
      nAssets: Object.keys(pos).filter((a) => pos[a].qty > 0).length
    };
  }

  /* ---- Recibos: data = {app:'recibos-jp', version, exportedAt, items:[...]}
     Gasto do mês segue a definição da tela inicial do próprio app Recibos:
     soma dos itens do tipo 'recibo' cuja data cai no mês de referência. */
  function recibosSummary(data, refDate) {
    const ym = ymOf(refDate);
    const todayIso = refDate.getFullYear() + '-' + pad2(refDate.getMonth() + 1) + '-' + pad2(refDate.getDate());
    const raw = (data && Array.isArray(data.items)) ? data.items : [];
    // lista branca: só os campos que a Central lê
    const items = raw.filter((it) => it && typeof it === 'object').map((it) => ({
      type: typeof it.type === 'string' ? it.type : '',
      date: typeof it.date === 'string' ? it.date : '',
      store: typeof it.store === 'string' ? it.store : '',
      amount: Math.max(0, Number(it.amount) || 0),
      dueDate: (typeof it.dueDate === 'string' && it.dueDate) ? it.dueDate : null,
      paid: !!it.paid
    }));
    let monthTotal = 0, monthCount = 0;
    items.forEach((it) => {
      if (it.type === 'recibo' && it.date.slice(0, 7) === ym) { monthTotal += it.amount; monthCount++; }
    });
    const bills = items.filter((it) => it.type === 'conta' && !it.paid)
      .map((it) => {
        const due = it.dueDate || it.date || null;
        return { store: it.store, amount: it.amount, due, overdue: !!due && due < todayIso };
      })
      .sort((a, b) => String(a.due || '9999-99').localeCompare(String(b.due || '9999-99')));
    return {
      ym, monthTotal, monthCount,
      bills,
      billsCount: bills.length,
      billsTotal: bills.reduce((s, b) => s + b.amount, 0),
      nextDue: bills.length ? bills[0] : null,
      overdueCount: bills.filter((b) => b.overdue).length
    };
  }

  /* ---- Vendas: data = {vendas, despesas, saques, campanhas, config, resumo}
     O resumo é calculado pelo próprio app Salro Vendas e os valores
     monetários dele chegam em CENTAVOS inteiros — aqui só exibimos.
     Sem resumo, cai para a soma da lista de vendas (gross em reais). */
  function vendasSummary(data) {
    if (!data || typeof data !== 'object') return null;
    /* A ponte devolve o envelope do app ({app, version, exportedAt, data:{...}});
       desce um nível quando o conteúdo vem embrulhado e ainda não está no formato interno. */
    if (data.data && typeof data.data === 'object' && !data.resumo && !Array.isArray(data.vendas)) data = data.data;
    const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
    const pick = (obj, keys) => {
      if (!obj || typeof obj !== 'object') return 0;
      for (const k of keys) if (obj[k] != null) return num(obj[k]);
      return 0;
    };
    const r = (data.resumo && typeof data.resumo === 'object') ? data.resumo : null;
    if (r) {
      /* O app real guarda o balde do mês em resumo.vendasMes (resumo.mes é a
         string 'AAAA-MM'); demo/fixtures antigos usam resumo.mes como objeto. */
      const mesB = [r.vendasMes, r.mes, r.month, r.mensal].find((b) => b && typeof b === 'object') || {};
      const totB = r.totais || r.total || r.geral || {};
      return {
        hasResumo: true,
        mes: {
          qtd: pick(mesB, ['qtd', 'count', 'n', 'quantidade']),
          bruto: pick(mesB, ['bruto', 'gross']) / 100,
          liquido: pick(mesB, ['liquido', 'netPlataforma', 'liquidoPlataforma', 'net']) / 100,
          reserva: pick(mesB, ['reserva']) / 100,
          lucro: pick(mesB, ['lucro', 'profit']) / 100
        },
        totais: {
          qtd: pick(totB, ['qtd', 'count', 'n', 'quantidade']),
          bruto: pick(totB, ['bruto', 'gross']) / 100,
          lucro: pick(totB, ['lucro', 'profit']) / 100
        }
      };
    }
    if (Array.isArray(data.vendas)) {
      let brutoTotal = 0;
      data.vendas.forEach((v) => { if (v && isFinite(Number(v.gross))) brutoTotal += Number(v.gross); });
      return { hasResumo: false, qtdTotal: data.vendas.length, brutoTotal };
    }
    return null;
  }

  /* ---- Salro Link: texto de conexão que o dono cola no assistente dele ---- */
  const LINK_APPS = {
    sal: { nome: 'Salro Salário', dica: 'Os dados são um despejo das chaves internas do app (prefixo msj-); os meses fechados ficam nas chaves msj-v4-3-months-AAAA-MM e os dias nas chaves msj-v4-2-days-AAAA-MM-DD.' },
    ir: { nome: 'Salro IR (Minha Declaração de IR)', dica: 'Os dados têm assets (ativos), operations (operações), histProventos (proventos por mês) e quotes (cotações manuais).' },
    rec: { nome: 'Salro Recibos (Meus Recibos JP)', dica: 'Os dados têm items: a lista de recibos, contas com vencimento e promoções fotografados.' },
    ven: { nome: 'Salro Vendas', dica: 'Os dados têm as vendas, despesas, saques e campanhas registradas no app, além de um resumo.' }
  };
  function linkPrompt(appKey, url, key) {
    const app = LINK_APPS[appKey];
    if (!app || !url || !key) return '';
    return [
      'Você agora está conectado ao meu app ' + app.nome + ' (padrão Salro Link). Meus dados ficam numa ponte na nuvem, no meu próprio Google Drive:',
      '- Link da ponte: ' + url,
      '- Chave: ' + key,
      '',
      'COMO LER: faça GET em "' + url + '?action=read&key=' + key + '". A resposta é um JSON com o envelope {app, version, exportedAt, data} — é dentro de data que ficam os registros. ' + app.dica,
      'COMO ESCREVER: primeiro leia o estado atual; aplique a alteração sobre ele; depois faça POST em "' + url + '?action=write&key=' + key + '" com o envelope COMPLETO atualizado (corpo JSON, content-type text/plain). Nunca envie um envelope parcial — a escrita substitui o arquivo inteiro. Confirme a escrita com um novo GET e compare o que voltou.',
      '',
      'REGRAS DE SEGURANÇA (obrigatórias):',
      '1. Nunca sobrescreva um backup com MENOS registros do que o que você leu, sem me avisar antes.',
      '2. Ao juntar dados, una pelos IDs dos registros — nunca apague um registro que você não criou.',
      '3. Nunca mostre a minha chave em respostas, arquivos ou registros; ela é uma senha.',
      '4. Valores e datas devem ser fiéis à fonte (foto, holerite, recibo) — o que não der para ler com segurança fica em branco, nunca inventado.',
      '5. Valores em ienes (¥) e em reais (R$) sempre separados; se converter, diga a taxa usada.',
      '',
      'Para confirmar que entendeu: leia a ponte agora e me diga quantos registros encontrou e de que período eles são.'
    ].join('\n');
  }

  return { ymOf, ymShift, ymLabel, fmtJPY, fmtBRL, fmtBRL0, msjMonth, irSummary, recibosSummary, vendasSummary, parseSafe, linkPrompt, LINK_APPS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SalroCalc;

/* ================= App (navegador) ================= */
if (typeof document !== 'undefined') (() => {
  const $ = (id) => document.getElementById(id);
  const LS = {
    salUrl: 'central-conn-salario-url', salKey: 'central-conn-salario-key',
    irUrl: 'central-conn-ir-url', irKey: 'central-conn-ir-key',
    recUrl: 'central-recibosUrl', recKey: 'central-recibosKey',
    venUrl: 'central-conn-vendas-url', venKey: 'central-conn-vendas-key',
    cacheSal: 'central-cache-salario', cacheIr: 'central-cache-ir', cacheRec: 'central-cache-recibos',
    cacheVen: 'central-cache-vendas',
    checklist: 'central-checklist', demo: 'central-demo', remessas: 'central-remessas'
  };
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    getRaw(k, fb) { const v = localStorage.getItem(k); return v == null ? fb : v; },
    setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  const isDemo = () => store.getRaw(LS.demo, '') === '1';
  const CONN_KEYS = {
    sal: { url: LS.salUrl, key: LS.salKey },
    ir: { url: LS.irUrl, key: LS.irKey },
    rec: { url: LS.recUrl, key: LS.recKey },
    ven: { url: LS.venUrl, key: LS.venKey }
  };
  const CACHE_KEYS = { sal: LS.cacheSal, ir: LS.cacheIr, rec: LS.cacheRec, ven: LS.cacheVen };
  const conn = (app) => {
    const k = CONN_KEYS[app];
    return {
      url: (store.getRaw(k.url, '') || '').trim(),
      key: (store.getRaw(k.key, '') || '').trim()
    };
  };
  const hasConn = (app) => { const c = conn(app); return !!(c.url && c.key); };

  /* ---------- Mapa-múndi pontilhado (grade ASCII estilizada) ---------- */
  const WORLD_MAP = [
    '',
    '  #####                        #########  ###################',
    ' #########                    ########### #####################',
    '###########                    #########  ######################',
    ' ##########                     #######   ####################',
    '  ########                       #####     ##################',
    '   ######                         ##########################',
    '    ####                           ########################',
    '     ##                             ####################',
    '     ###                             #################',
    '    #####                             ###############',
    '    ######                             ##############',
    '     ######                             ############',
    '     ######                              ##########',
    '     #####                                ########       ########',
    '      ####                                ########      ##########',
    '      ####                                 ######       ##########',
    '       ###                                 #####         ########',
    '       ###                                  ###           ######',
    '        ##                                  #              ####',
    '        #',
    '', '', '', '', ''
  ];
  function buildWorld() {
    const g = $('worldDots');
    if (!g) return;
    const NS = 'http://www.w3.org/2000/svg';
    WORLD_MAP.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== '#') continue;
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', c * 6 + 3);
        dot.setAttribute('cy', r * 6.8 + 4);
        dot.setAttribute('r', 1.15);
        g.appendChild(dot);
      }
    });
    // Japão em destaque: arco de pontinhos cobre a leste da Ásia
    [[306, 14], [313, 19], [318, 27], [322, 36], [325, 45], [327, 54], [315, 12], [321, 20]].forEach(([x, y]) => {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', 1.5);
      dot.setAttribute('class', 'jp');
      g.appendChild(dot);
    });
  }

  /* ---------- Demonstração (dados fictícios) ---------- */
  function makeDemo(ref) {
    const ym = SalroCalc.ymOf(ref);
    const msjInner = {
      'msj-employees': JSON.stringify([
        { id: 'principal', name: 'Ana (demo)' }, { id: 'demo2', name: 'Bruno (demo)' }
      ])
    };
    msjInner['msj-v4-3-months-' + ym] = JSON.stringify({ gross: 286000, net: 212400 });
    msjInner['msj-func-demo2-months-' + ym] = JSON.stringify({ gross: 243000, net: 178900 });
    for (let d = 1; d <= 9; d++) msjInner['msj-v4-2-days-' + ym + '-0' + d] = JSON.stringify({ in: '09:00', out: '17:45' });
    for (let d = 1; d <= 8; d++) msjInner['msj-func-demo2-days-' + ym + '-0' + d] = JSON.stringify({ in: '09:00', out: '17:45' });
    const hp = {};
    const base = [95, 130, 110, 160, 140, 175, 150, 190, 170, 205, 185, 220];
    for (let i = 11; i >= 0; i--) hp[SalroCalc.ymShift(ym, -i)] = base[11 - i];
    const irData = {
      assets: [
        { id: 'd1', ticker: 'DEMO3', type: 'acao' }, { id: 'd2', ticker: 'DEMF11', type: 'fii' },
        { id: 'd3', ticker: 'DEME11', type: 'etf' }, { id: 'd4', ticker: 'Tesouro Demo', type: 'tesouro' }
      ],
      operations: [
        { id: 'o1', assetId: 'd1', side: 'compra', qty: 100, price: 100, fees: 0 },
        { id: 'o2', assetId: 'd2', side: 'compra', qty: 200, price: 85, fees: 0 },
        { id: 'o3', assetId: 'd3', side: 'compra', qty: 50, price: 130, fees: 0 },
        { id: 'o4', assetId: 'd4', side: 'compra', qty: 1, price: 9000, fees: 0 }
      ],
      quotes: {}, histProventos: hp
    };
    const isoDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const DAY = 86400000;
    const recItem = (id, type, date, store, amount, extra) => Object.assign({
      id, type, date, store, amount, category: 'Outros',
      dueDate: null, validUntil: null, paid: false, note: '', link: '', photo: null, createdAt: Date.now()
    }, extra || {});
    const recData = {
      app: 'recibos-jp', version: 1, exportedAt: new Date().toISOString(),
      items: [
        recItem('r1', 'recibo', isoDay(ref), 'Supermercado (demo)', 12480, { category: 'Supermercado' }),
        recItem('r2', 'recibo', isoDay(ref), 'Konbini (demo)', 1360, { category: 'Konbini' }),
        recItem('r3', 'conta', isoDay(new Date(ref.getTime() - 5 * DAY)), 'Conta de luz (demo)', 6540,
          { dueDate: isoDay(new Date(ref.getTime() + 4 * DAY)) }),
        recItem('r4', 'conta', isoDay(new Date(ref.getTime() - 9 * DAY)), 'Conta de água (demo)', 3280,
          { dueDate: isoDay(new Date(ref.getTime() - 2 * DAY)) }),
        recItem('r5', 'conta', isoDay(new Date(ref.getTime() - 6 * DAY)), 'Internet (demo)', 4180,
          { dueDate: isoDay(new Date(ref.getTime() + 9 * DAY)), paid: true })
      ]
    };
    const venData = {
      app: 'salro-vendas', version: 1, exportedAt: new Date().toISOString(),
      vendas: [1, 2, 3].map((i) => ({
        id: 'dv' + i, date: isoDay(ref), product: 'Miniguia — Chegada ao Japão sem perrengue (demo)',
        channel: 'kiwify', gross: 47, txid: null, origin: 'manual', campaignId: null
      })),
      despesas: [], saques: [], campanhas: [],
      config: { taxPct: 20 },
      /* resumo como o app Vendas calcula: valores em CENTAVOS.
         3 × R$ 47 na Kiwify: taxa 672/venda → líquido 4028,
         reserva 20% = 806, lucro 3222 por venda. */
      resumo: {
        mes: { qtd: 3, bruto: 14100, liquido: 12084, reserva: 2418, lucro: 9666 },
        totais: { qtd: 3, bruto: 14100, lucro: 9666 }
      }
    };
    return {
      sal: { ok: true, exists: true, updatedAt: new Date().toISOString(), data: { app: 'demo', data: msjInner } },
      ir: { ok: true, exists: true, updatedAt: new Date().toISOString(), data: irData },
      rec: { ok: true, exists: true, updatedAt: new Date().toISOString(), data: recData },
      ven: { ok: true, exists: true, updatedAt: new Date().toISOString(), data: venData }
    };
  }

  /* ---------- Render: Salário ---------- */
  function fmtSync(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return 'sync ' + d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' · ' +
      d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function renderSalario(state) {
    const val = $('hubSalarioValue'), sub = $('hubSalarioSub'), sync = $('hubSalarioSync'),
      node = $('hubNodeSalarioValue'), kpi = $('kpiSalario'), kpiSub = $('kpiSalarioSub');
    if (!state || state.status === 'none') {
      val.textContent = '—'; node.textContent = 'sem ponte';
      sub.textContent = 'Configure a ponte em ⚙️ Conexões para ver o resumo do mês.';
      sync.textContent = ''; kpi.textContent = '—'; kpiSub.textContent = 'ponte não configurada';
      return;
    }
    if (state.status === 'error') {
      val.textContent = '—'; node.textContent = 'erro';
      sub.textContent = 'Não foi possível ler a nuvem — confira o link e a chave em ⚙️ Conexões.';
      sync.textContent = ''; kpi.textContent = '—'; kpiSub.textContent = 'erro de leitura';
      return;
    }
    const resp = state.resp;
    sync.textContent = fmtSync(resp.updatedAt);
    if (!resp.exists || !resp.data || !resp.data.data) {
      val.textContent = '—'; node.textContent = 'sem backup';
      sub.textContent = 'A ponte respondeu, mas ainda não há backup na nuvem. Abra o app Salário e envie um backup.';
      kpi.textContent = '—'; kpiSub.textContent = 'sem backup na nuvem';
      return;
    }
    const m = SalroCalc.msjMonth(resp.data.data, new Date());
    const parts = m.employees.map((e) => e.hasSnap
      ? e.name + ' ' + SalroCalc.fmtJPY(e.net)
      : e.name + ': ' + e.days + ' dia(s) lançado(s), sem cálculo no app');
    if (m.anySnap) {
      val.textContent = SalroCalc.fmtJPY(m.totalNet) + ' líq.';
      node.textContent = SalroCalc.fmtJPY(m.totalNet);
      kpi.textContent = SalroCalc.fmtJPY(m.totalNet);
      kpiSub.textContent = (m.complete ? 'líquido do casal no mês' : 'líquido parcial — falta cálculo de alguém') +
        ' · bruto ' + SalroCalc.fmtJPY(m.totalGross);
    } else {
      val.textContent = m.totalDays + ' dias lançados';
      node.textContent = m.totalDays + ' dias';
      kpi.textContent = '—';
      kpiSub.textContent = 'abra o app Salário e toque em Calcular para ver os valores';
    }
    sub.textContent = parts.join(' · ') || 'sem funcionários no backup';
  }

  /* ---------- Render: IR ---------- */
  function renderIr(state) {
    const val = $('hubIrValue'), sub = $('hubIrSub'), sync = $('hubIrSync'),
      node = $('hubNodeIrValue'), kpi = $('kpiProventos'), kpiSub = $('kpiProventosSub');
    const chartP = $('chartProventos'), chartA = $('chartAlocacao');
    if (!state || state.status === 'none') {
      val.textContent = '—'; node.textContent = 'sem ponte';
      sub.textContent = 'Configure a ponte em ⚙️ Conexões para ver a carteira.';
      sync.textContent = ''; kpi.textContent = '—'; kpiSub.textContent = 'ponte não configurada';
      chartP.innerHTML = '<p class="chart-empty">Configure a ponte do IR em ⚙️ Conexões.</p>';
      chartA.innerHTML = '<p class="chart-empty">Configure a ponte do IR em ⚙️ Conexões.</p>';
      return;
    }
    if (state.status === 'error') {
      val.textContent = '—'; node.textContent = 'erro';
      sub.textContent = 'Não foi possível ler a nuvem — confira o link e a chave em ⚙️ Conexões.';
      sync.textContent = ''; kpi.textContent = '—'; kpiSub.textContent = 'erro de leitura';
      chartP.innerHTML = '<p class="chart-empty">Erro ao ler a nuvem do IR.</p>';
      chartA.innerHTML = '<p class="chart-empty">Erro ao ler a nuvem do IR.</p>';
      return;
    }
    const resp = state.resp;
    sync.textContent = fmtSync(resp.updatedAt);
    if (!resp.exists || !resp.data) {
      val.textContent = '—'; node.textContent = 'sem backup';
      sub.textContent = 'A ponte respondeu, mas ainda não há backup na nuvem. Abra o app Meu IR e envie um backup.';
      kpi.textContent = '—'; kpiSub.textContent = 'sem backup na nuvem';
      chartP.innerHTML = '<p class="chart-empty">Sem backup na nuvem ainda.</p>';
      chartA.innerHTML = '<p class="chart-empty">Sem backup na nuvem ainda.</p>';
      return;
    }
    const s = SalroCalc.irSummary(resp.data);
    val.textContent = SalroCalc.fmtBRL(s.totalCost);
    node.textContent = SalroCalc.fmtBRL0(s.totalCost);
    sub.textContent = 'carteira a custo · ' + s.nAssets + ' ativos' +
      (s.market != null ? ' · a mercado ≈ ' + SalroCalc.fmtBRL(s.market) : '');
    kpi.textContent = SalroCalc.fmtBRL(s.total12);
    kpiSub.textContent = 'média de ' + SalroCalc.fmtBRL(s.total12 / 12) + '/mês · desde 2021: ' + SalroCalc.fmtBRL(s.allTime);

    // barras de proventos
    if (s.series.length) {
      const max = Math.max.apply(null, s.series.map((x) => x.value).concat([1]));
      chartP.innerHTML = '<div class="prov-chart">' + s.series.map((x) => {
        const h = Math.max(2, Math.round((x.value / max) * 100));
        const lab = x.value >= 1000 ? (x.value / 1000).toFixed(1).replace('.', ',') + ' mil' : String(Math.round(x.value));
        return '<div class="prov-col"><div class="prov-bar" style="height:' + h + '%"><span class="prov-val">' + lab + '</span></div><div class="prov-lab">' + x.label + '</div></div>';
      }).join('') + '</div>';
    } else chartP.innerHTML = '<p class="chart-empty">Sem histórico de proventos no backup.</p>';

    // alocação por classe
    if (s.byClass.length) {
      chartA.innerHTML = s.byClass.map((c) =>
        '<div class="alloc-row"><div class="alloc-head"><span class="alloc-name">' + c.label + '</span>' +
        '<span class="alloc-val">' + SalroCalc.fmtBRL(c.value) + ' · ' + c.pct.toFixed(1).replace('.', ',') + '%</span></div>' +
        '<div class="alloc-track"><div class="alloc-fill" style="width:' + c.pct.toFixed(1) + '%"></div></div></div>'
      ).join('');
    } else chartA.innerHTML = '<p class="chart-empty">Sem posições no backup.</p>';
  }

  /* ---------- Render: Recibos ---------- */
  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function fmtDateShort(iso) {
    if (!iso) return '—';
    const p = String(iso).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso);
  }
  function daysUntil(iso) {
    if (!iso) return null;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return null;
    return Math.round((d - t) / 86400000);
  }
  function setNodeAlert(target, on, badgeId, badgeTextId, count) {
    const g = document.querySelector('.hub-node[data-target="' + target + '"]');
    if (g) g.classList.toggle('node-alert', !!on);
    const b = badgeId ? $(badgeId) : null;
    if (b) {
      b.classList.toggle('show', !!count);
      if (count) $(badgeTextId).textContent = String(count);
    }
  }
  function renderRecibos(state) {
    const val = $('hubRecibosValue'), sub = $('hubRecibosSub'), sync = $('hubRecibosSync'),
      node = $('hubNodeRecibosValue'), list = $('hubRecibosBills'),
      kGasto = $('kpiRecibosGasto'), kGastoSub = $('kpiRecibosGastoSub'),
      kContas = $('kpiRecibosContas'), kContasSub = $('kpiRecibosContasSub');
    const gastoCard = kGasto.closest('.kpi-card'), contasCard = kContas.closest('.kpi-card');
    const reset = () => {
      list.innerHTML = '';
      gastoCard.classList.add('muted'); contasCard.classList.add('muted');
      kContas.classList.remove('danger');
      setNodeAlert('sheet-recibos', false, 'hubBadgeRecibos', 'hubBadgeRecibosText', 0);
    };
    if (!state || state.status === 'none') {
      reset();
      val.textContent = '—'; node.textContent = 'sem ponte';
      sub.textContent = 'Configure a ponte do Recibos em ⚙️ Conexões para ver o gasto do mês e as contas a pagar.';
      sync.textContent = ''; kGasto.textContent = '—'; kGastoSub.textContent = 'ponte não configurada';
      kContas.textContent = '—'; kContasSub.textContent = 'ponte não configurada';
      return;
    }
    if (state.status === 'error') {
      reset();
      val.textContent = '—'; node.textContent = 'erro';
      sub.textContent = 'Não foi possível ler a nuvem — confira o link e a chave em ⚙️ Conexões.';
      sync.textContent = ''; kGasto.textContent = '—'; kGastoSub.textContent = 'erro de leitura';
      kContas.textContent = '—'; kContasSub.textContent = 'erro de leitura';
      return;
    }
    const resp = state.resp;
    sync.textContent = fmtSync(resp.updatedAt);
    if (!resp.exists || !resp.data || !Array.isArray(resp.data.items)) {
      reset();
      val.textContent = '—'; node.textContent = 'sem backup';
      sub.textContent = 'A ponte respondeu, mas ainda não há backup na nuvem. Abra o app Recibos JP e envie um backup.';
      kGasto.textContent = '—'; kGastoSub.textContent = 'sem backup na nuvem';
      kContas.textContent = '—'; kContasSub.textContent = 'sem backup na nuvem';
      return;
    }
    const s = SalroCalc.recibosSummary(resp.data, new Date());
    const soonDays = s.nextDue && s.nextDue.due ? daysUntil(s.nextDue.due) : null;
    setNodeAlert('sheet-recibos', s.overdueCount > 0 || (soonDays !== null && soonDays <= 3),
      'hubBadgeRecibos', 'hubBadgeRecibosText', s.overdueCount);
    gastoCard.classList.remove('muted'); contasCard.classList.remove('muted');
    val.textContent = SalroCalc.fmtJPY(s.monthTotal);
    node.textContent = SalroCalc.fmtJPY(s.monthTotal);
    sub.textContent = 'gasto do mês · ' + s.monthCount + (s.monthCount === 1 ? ' recibo' : ' recibos') +
      ' · ' + s.billsCount + (s.billsCount === 1 ? ' conta a pagar' : ' contas a pagar');
    kGasto.textContent = SalroCalc.fmtJPY(s.monthTotal);
    kGastoSub.textContent = s.monthCount + (s.monthCount === 1 ? ' recibo no mês' : ' recibos no mês');
    kContas.textContent = s.billsCount === 0 ? 'nenhuma 🎉' : String(s.billsCount);
    kContas.classList.toggle('danger', s.overdueCount > 0);
    kContasSub.innerHTML = s.billsCount === 0
      ? 'nenhuma conta a pagar'
      : (s.overdueCount > 0
          ? '<span class="err">' + s.overdueCount + (s.overdueCount === 1 ? ' atrasada' : ' atrasadas') + '</span> · '
          : '') +
        'próxima: ' + fmtDateShort(s.nextDue.due) + ' · ' + SalroCalc.fmtJPY(s.nextDue.amount) +
        ' · total ' + SalroCalc.fmtJPY(s.billsTotal);
    list.innerHTML = s.bills.length
      ? '<div class="app-list-title">Contas a vencer</div>' + s.bills.slice(0, 5).map((b) =>
          '<div class="bill-row' + (b.overdue ? ' overdue' : '') + '">' +
          '<span class="bill-name">' + escHtml(b.store || 'Conta') + '</span>' +
          '<span class="bill-meta">' + SalroCalc.fmtJPY(b.amount) + ' · ' +
          (b.due ? (b.overdue ? 'venceu ' : 'vence ') + fmtDateShort(b.due) : 'sem vencimento') +
          '</span></div>').join('')
      : '';
  }

  /* ---------- Render: Vendas ---------- */
  function renderVendas(state) {
    const val = $('hubVendasValue'), sub = $('hubVendasSub'), sync = $('hubVendasSync'),
      node = $('hubNodeVendasValue'),
      kMes = $('kpiVendasMes'), kMesSub = $('kpiVendasMesSub'),
      kLuc = $('kpiVendasLucro'), kLucSub = $('kpiVendasLucroSub'),
      kTot = $('kpiVendasTotal'), kTotSub = $('kpiVendasTotalSub');
    const cards = [kMes, kLuc, kTot].map((el) => el.closest('.kpi-card'));
    const setMuted = (on) => cards.forEach((c) => c.classList.toggle('muted', on));
    const blank = (subText) => {
      kMes.textContent = '—'; kMesSub.textContent = subText;
      kLuc.textContent = '—'; kLucSub.textContent = subText;
      kTot.textContent = '—'; kTotSub.textContent = subText;
    };
    if (!state || state.status === 'none') {
      setMuted(true);
      val.textContent = '—'; node.textContent = 'sem ponte';
      sub.textContent = 'Configure a ponte do Vendas em ⚙️ Conexões para ver as vendas do mês.';
      sync.textContent = ''; blank('ponte não configurada');
      return;
    }
    if (state.status === 'error') {
      setMuted(true);
      val.textContent = '—'; node.textContent = 'erro';
      sub.textContent = 'Não foi possível ler a nuvem — confira o link e a chave em ⚙️ Conexões.';
      sync.textContent = ''; blank('erro de leitura');
      return;
    }
    const resp = state.resp;
    sync.textContent = fmtSync(resp.updatedAt);
    const s = (resp.exists && resp.data) ? SalroCalc.vendasSummary(resp.data) : null;
    if (!s) {
      setMuted(true);
      val.textContent = '—'; node.textContent = 'sem backup';
      sub.textContent = 'A ponte respondeu, mas ainda não há backup na nuvem. Abra o app Salro Vendas e envie um backup.';
      blank('sem backup na nuvem');
      return;
    }
    setMuted(false);
    if (s.hasResumo) {
      val.textContent = SalroCalc.fmtBRL(s.mes.bruto);
      node.textContent = SalroCalc.fmtBRL0(s.mes.lucro);
      sub.textContent = 'vendas do mês · ' + s.mes.qtd + (s.mes.qtd === 1 ? ' venda' : ' vendas') +
        ' · lucro ' + SalroCalc.fmtBRL(s.mes.lucro);
      kMes.textContent = SalroCalc.fmtBRL(s.mes.bruto);
      kMesSub.textContent = s.mes.qtd + (s.mes.qtd === 1 ? ' venda no mês' : ' vendas no mês') +
        ' · líquido da plataforma ' + SalroCalc.fmtBRL(s.mes.liquido);
      kLuc.textContent = SalroCalc.fmtBRL(s.mes.lucro);
      kLucSub.textContent = 'reserva de imposto ' + SalroCalc.fmtBRL(s.mes.reserva) +
        ' · líquido ' + SalroCalc.fmtBRL(s.mes.liquido);
      kTot.textContent = SalroCalc.fmtBRL(s.totais.lucro);
      kTotSub.textContent = s.totais.qtd + (s.totais.qtd === 1 ? ' venda' : ' vendas') +
        ' · bruto ' + SalroCalc.fmtBRL(s.totais.bruto) + ' · lucro ' + SalroCalc.fmtBRL(s.totais.lucro);
    } else {
      val.textContent = SalroCalc.fmtBRL(s.brutoTotal);
      node.textContent = SalroCalc.fmtBRL0(s.brutoTotal);
      sub.textContent = s.qtdTotal + (s.qtdTotal === 1 ? ' venda' : ' vendas') + ' no backup · bruto ' +
        SalroCalc.fmtBRL(s.brutoTotal) + ' (resumo detalhado vem do app Vendas)';
      kMes.textContent = '—'; kMesSub.textContent = 'resumo detalhado vem do app Vendas';
      kLuc.textContent = '—'; kLucSub.textContent = 'resumo detalhado vem do app Vendas';
      kTot.textContent = SalroCalc.fmtBRL(s.brutoTotal);
      kTotSub.textContent = s.qtdTotal + (s.qtdTotal === 1 ? ' venda' : ' vendas') + ' · bruto total (sem resumo do app)';
    }
  }

  /* ---------- Sincronização ---------- */
  async function fetchBridge(c) {
    const sep = c.url.indexOf('?') >= 0 ? '&' : '?';
    const r = await fetch(c.url + sep + 'key=' + encodeURIComponent(c.key) + '&action=read');
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (!j || j.ok === false) throw new Error((j && j.error) || 'resposta inválida');
    return j;
  }
  function cachedState(cacheKey) {
    const c = store.get(cacheKey, null);
    return c ? { status: 'ok', resp: c } : { status: 'none' };
  }
  async function syncApp(app, status) {
    const cacheKey = CACHE_KEYS[app];
    if (!hasConn(app)) { status[app] = cachedState(cacheKey); if (status[app].status === 'none') status[app] = { status: 'none' }; return; }
    try {
      const resp = await fetchBridge(conn(app));
      store.set(cacheKey, resp);
      status[app] = { status: 'ok', resp };
    } catch (e) {
      const c = store.get(cacheKey, null);
      status[app] = c ? { status: 'ok', resp: c, stale: true } : { status: 'error' };
      status[app].error = true;
    }
  }
  function renderSyncPill(st) {
    const pill = $('syncPill');
    if (!pill) return;
    if (isDemo()) { pill.textContent = '✦ demonstração'; pill.hidden = false; return; }
    let latest = null;
    ['sal', 'ir', 'rec', 'ven'].forEach((k) => {
      const s = st && st[k];
      if (s && s.status === 'ok' && s.resp && s.resp.updatedAt) {
        const t = new Date(s.resp.updatedAt).getTime();
        if (!isNaN(t) && (latest === null || t > latest)) latest = t;
      }
    });
    if (latest === null) { pill.hidden = true; return; }
    pill.textContent = 'sincronizado · ' + new Date(latest).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    pill.hidden = false;
  }
  let lastEff = null;
  function renderAll(status) {
    let eff = status;
    if (isDemo()) {
      const demo = makeDemo(new Date());
      eff = {
        sal: { status: 'ok', resp: demo.sal },
        ir: { status: 'ok', resp: demo.ir },
        rec: { status: 'ok', resp: demo.rec },
        ven: { status: 'ok', resp: demo.ven }
      };
    }
    renderSalario(eff.sal);
    renderIr(eff.ir);
    renderRecibos(eff.rec);
    renderVendas(eff.ven);
    lastEff = eff;
    renderHoje();
    renderSyncPill(eff);
    $('demoBanner').hidden = !isDemo();
    $('demoToggle').textContent = isDemo() ? 'Sair do modo demonstração' : 'Ver modo demonstração';
  }
  async function syncAll(manual) {
    const statusEl = $('connStatus');
    if (manual) statusEl.textContent = 'Sincronizando…';
    const status = {};
    await Promise.all([syncApp('sal', status), syncApp('ir', status), syncApp('rec', status), syncApp('ven', status)]);
    renderAll(status);
    if (manual) {
      const parts = [];
      parts.push(hasConn('sal') ? (status.sal.status === 'ok' ? '<span class="ok">Salário ✓</span>' : '<span class="err">Salário: não foi possível ler — confira link e chave</span>') : 'Salário: ponte não configurada');
      parts.push(hasConn('ir') ? (status.ir.status === 'ok' ? '<span class="ok">IR ✓</span>' : '<span class="err">IR: não foi possível ler — confira link e chave</span>') : 'IR: ponte não configurada');
      parts.push(hasConn('rec') ? (status.rec.status === 'ok' ? '<span class="ok">Recibos ✓</span>' : '<span class="err">Recibos: não foi possível ler — confira link e chave</span>') : 'Recibos: ponte não configurada');
      parts.push(hasConn('ven') ? (status.ven.status === 'ok' ? '<span class="ok">Vendas ✓</span>' : '<span class="err">Vendas: não foi possível ler — confira link e chave</span>') : 'Vendas: ponte não configurada');
      statusEl.innerHTML = parts.join(' · ');
    }
    window.__centralStatus = status;
  }

  /* ---------- Checklist ---------- */
  const SEED = [
    { id: 'seed-gensen', text: 'Levar os dois Gensen à fábrica', due: null, done: false },
    { id: 'seed-holerite-out', text: 'Holerite de outubro da Creative — chega 30/11', due: '2026-11-30', done: false },
    { id: 'seed-ebina', text: 'Boletos do juminzei de Ebina — aguardar chegada (1ª parcela do casal ¥42.350)', due: null, done: false },
    { id: 'seed-aluguel', text: 'Aluguel de dezembro — ¥90.000 (confirmar dia e forma de pagamento)', due: null, done: false },
    { id: 'seed-contrato', text: 'Documento de correção do contrato — aguardando a administradora', due: null, done: false }
  ];
  function loadChecklist() {
    let items = store.get(LS.checklist, null);
    if (!Array.isArray(items)) { items = SEED.slice(); store.set(LS.checklist, items); }
    return items;
  }
  function saveChecklist(items) { store.set(LS.checklist, items); renderChecklist(); }
  function fmtDue(iso) {
    const [y, m, d] = iso.split('-');
    return 'vence ' + d + '/' + m + '/' + y;
  }
  function renderChecklist() {
    const items = loadChecklist();
    const ul = $('checkList');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const sorted = items.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.due && b.due) return a.due < b.due ? -1 : 1;
      if (a.due) return -1; if (b.due) return 1; return 0;
    });
    if (!sorted.length) ul.innerHTML = '<li class="check-empty">Nada por aqui — adicione o primeiro item abaixo.</li>';
    else ul.innerHTML = sorted.map((it) => {
      const overdue = it.due && !it.done && new Date(it.due + 'T00:00:00') < today;
      return '<li class="check-item' + (it.done ? ' done' : '') + '">' +
        '<input type="checkbox" data-act="toggle" data-id="' + it.id + '"' + (it.done ? ' checked' : '') + ' aria-label="Marcar como feito">' +
        '<div class="check-body"><div class="check-text"></div>' +
        (it.due ? '<div class="check-due' + (overdue ? ' overdue' : '') + '">' + fmtDue(it.due) + (overdue ? ' · atrasado' : '') + '</div>' : '') +
        '</div><button type="button" class="check-del" data-act="del" data-id="' + it.id + '" aria-label="Apagar item">✕</button></li>';
    }).join('');
    // texto via textContent (nunca innerHTML com texto do usuário)
    ul.querySelectorAll('.check-item').forEach((li, i) => {
      li.querySelector('.check-text').textContent = sorted[i].text;
    });
    const pending = items.filter((i) => !i.done).length;
    $('hubNodeChecklistValue').textContent = pending === 0 ? 'tudo feito ✓' : pending + (pending === 1 ? ' pendente' : ' pendentes');
    const urgent = items.filter((i) => !i.done && i.due && daysUntil(i.due) !== null && daysUntil(i.due) <= 3).length;
    setNodeAlert('sheet-checklist', urgent > 0, 'hubBadgeChecklist', 'hubBadgeChecklistText', urgent);
    renderHoje();
  }

  /* ---------- Painel Hoje ---------- */
  function renderHoje() {
    const al = $('hojeAlertas'), rs = $('hojeResumo');
    if (!al || !rs) return;
    const lines = [];
    loadChecklist().filter((i) => !i.done && i.due).forEach((i) => {
      const du = daysUntil(i.due);
      if (du !== null && du <= 7) {
        lines.push({ when: du, html: '<div class="bill-row' + (du < 0 ? ' overdue' : '') + '"><span class="bill-name">' + escHtml(i.text) + '</span><span class="bill-meta">' + (du < 0 ? 'venceu ' : 'vence ') + fmtDateShort(i.due) + '</span></div>' });
      }
    });
    const recState = lastEff && lastEff.rec;
    const recOk = recState && recState.status === 'ok' && recState.resp && recState.resp.exists && recState.resp.data && Array.isArray(recState.resp.data.items);
    let recSum = null;
    if (recOk) {
      recSum = SalroCalc.recibosSummary(recState.resp.data, new Date());
      recSum.bills.forEach((b) => {
        if (!b.due) return;
        const du = daysUntil(b.due);
        if (du !== null && du <= 7) {
          lines.push({ when: du, html: '<div class="bill-row' + (b.overdue ? ' overdue' : '') + '"><span class="bill-name">' + escHtml(b.store || 'Conta') + '</span><span class="bill-meta">' + SalroCalc.fmtJPY(b.amount) + ' · ' + (b.overdue ? 'venceu ' : 'vence ') + fmtDateShort(b.due) + '</span></div>' });
        }
      });
    }
    lines.sort((a, b) => a.when - b.when);
    al.innerHTML = lines.length ? lines.map((l) => l.html).join('') : '<p class="chart-empty">Nada vencendo nos próximos 7 dias 🎉</p>';
    const parts = [];
    const salState = lastEff && lastEff.sal;
    if (salState && salState.status === 'ok' && salState.resp && salState.resp.exists && salState.resp.data && salState.resp.data.data) {
      const m = SalroCalc.msjMonth(salState.resp.data.data, new Date());
      if (m.anySnap) parts.push('<div class="bill-row"><span class="bill-name">🌳 Salário do mês (casal)</span><span class="bill-meta">' + SalroCalc.fmtJPY(m.totalNet) + ' líq.</span></div>');
      else if (m.totalDays) parts.push('<div class="bill-row"><span class="bill-name">🌳 Salário do mês</span><span class="bill-meta">' + m.totalDays + ' dias lançados</span></div>');
    }
    if (recSum) parts.push('<div class="bill-row"><span class="bill-name">🧾 Gasto no mês (Recibos)</span><span class="bill-meta">' + SalroCalc.fmtJPY(recSum.monthTotal) + '</span></div>');
    const irState = lastEff && lastEff.ir;
    if (irState && irState.status === 'ok' && irState.resp && irState.resp.exists && irState.resp.data) {
      const si = SalroCalc.irSummary(irState.resp.data);
      parts.push('<div class="bill-row"><span class="bill-name">📊 Proventos · 12 meses</span><span class="bill-meta">' + SalroCalc.fmtBRL(si.total12) + '</span></div>');
    }
    const venState = lastEff && lastEff.ven;
    if (venState && venState.status === 'ok' && venState.resp && venState.resp.exists && venState.resp.data) {
      const vs = SalroCalc.vendasSummary(venState.resp.data);
      if (vs && vs.hasResumo) {
        parts.push('<div class="bill-row"><span class="bill-name">💰 Vendas do mês</span><span class="bill-meta">' + vs.mes.qtd + (vs.mes.qtd === 1 ? ' venda' : ' vendas') + ' · lucro ' + SalroCalc.fmtBRL(vs.mes.lucro) + '</span></div>');
      }
    }
    const rems = loadRemessas();
    if (rems.length) {
      const tj = rems.reduce((s2, r) => s2 + (Number(r.jpy) || 0), 0);
      parts.push('<div class="bill-row"><span class="bill-name">✈️ Remessas anotadas</span><span class="bill-meta">' + SalroCalc.fmtJPY(tj) + ' enviados</span></div>');
    }
    rs.innerHTML = parts.length ? parts.join('') : '<p class="chart-empty">Configure as pontes em ⚙️ Conexões para ver o resumo.</p>';
  }

  /* ---------- Remessas (diário local) ---------- */
  function loadRemessas() {
    const v = store.get(LS.remessas, []);
    return Array.isArray(v) ? v.filter((r) => r && r.date && isFinite(Number(r.jpy)) && isFinite(Number(r.brl))) : [];
  }
  function saveRemessas(list) { store.set(LS.remessas, list); renderRemessas(); renderHoje(); }
  function fmtJpyCompact(v) {
    if (v >= 10000) return '¥ ' + Math.round(v / 1000).toLocaleString('pt-BR') + ' mil';
    return SalroCalc.fmtJPY(v);
  }
  function renderRemessas() {
    const ul = $('remList'), box = $('remResumo'), pill = $('hubNodeRemessasValue');
    if (!ul || !box || !pill) return;
    const list = loadRemessas().slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!list.length) {
      box.innerHTML = '<p class="chart-empty">Nenhuma remessa anotada ainda.</p>';
      ul.innerHTML = '';
      pill.textContent = '—';
      return;
    }
    const tj = list.reduce((s, r) => s + Number(r.jpy || 0), 0);
    const tb = list.reduce((s, r) => s + Number(r.brl || 0), 0);
    const taxa = tj > 0 ? (tb / tj * 1000) : 0;
    box.innerHTML =
      '<div class="bill-row"><span class="bill-name">Total enviado</span><span class="bill-meta">' + SalroCalc.fmtJPY(tj) + '</span></div>' +
      '<div class="bill-row"><span class="bill-name">Total recebido</span><span class="bill-meta">' + SalroCalc.fmtBRL(tb) + '</span></div>' +
      '<div class="bill-row"><span class="bill-name">Taxa média efetiva</span><span class="bill-meta">R$ ' + taxa.toFixed(2).replace('.', ',') + ' por ¥ 1.000</span></div>';
    ul.innerHTML = list.map((r) => {
      const t = Number(r.jpy) > 0 ? (Number(r.brl) / Number(r.jpy) * 1000) : 0;
      return '<li class="check-item"><div class="check-body"><div class="check-text"></div>' +
        '<div class="check-due">' + SalroCalc.fmtJPY(r.jpy) + ' → ' + SalroCalc.fmtBRL(r.brl) + ' · R$ ' + t.toFixed(2).replace('.', ',') + '/¥1.000</div></div>' +
        '<button type="button" class="check-del" data-rem-del="' + r.id + '" aria-label="Apagar remessa">✕</button></li>';
    }).join('');
    ul.querySelectorAll('.check-item').forEach((li, i) => {
      li.querySelector('.check-text').textContent = fmtDateShort(list[i].date);
    });
    pill.textContent = fmtJpyCompact(tj);
  }

  /* ---------- Painéis (sheets) e menu lateral ---------- */
  function showBackdrop(on) { $('backdrop').hidden = !on; }
  function openSheet(id) {
    const s = document.getElementById(id);
    if (!s) return;
    closeDrawer();
    document.querySelectorAll('.sheet').forEach((x) => { x.classList.remove('open'); x.hidden = true; });
    s.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => s.classList.add('open')));
    showBackdrop(true);
    document.body.classList.add('no-scroll');
  }
  function closeSheets() {
    document.querySelectorAll('.sheet.open').forEach((x) => x.classList.remove('open'));
    setTimeout(() => document.querySelectorAll('.sheet').forEach((x) => { x.hidden = true; }), 260);
    if (!$('drawer').classList.contains('open')) { showBackdrop(false); document.body.classList.remove('no-scroll'); }
  }
  function openDrawer() {
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    showBackdrop(true);
    document.body.classList.add('no-scroll');
  }
  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
  }
  function wirePanels() {
    $('menuBtn').addEventListener('click', openDrawer);
    $('drawerClose').addEventListener('click', () => { closeDrawer(); showBackdrop(false); document.body.classList.remove('no-scroll'); });
    document.querySelectorAll('.drawer-item[data-sheet]').forEach((b) => {
      b.addEventListener('click', () => openSheet(b.getAttribute('data-sheet')));
    });
    $('drawerSync').addEventListener('click', () => { closeDrawer(); showBackdrop(false); document.body.classList.remove('no-scroll'); syncAll(true); });
    document.querySelectorAll('.sheet [data-close]').forEach((b) => b.addEventListener('click', closeSheets));
    $('backdrop').addEventListener('click', () => { closeSheets(); closeDrawer(); showBackdrop(false); document.body.classList.remove('no-scroll'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheets(); closeDrawer(); showBackdrop(false); document.body.classList.remove('no-scroll'); } });
  }

  /* ---------- Hub: nós → painéis ---------- */
  function wireHub() {
    document.querySelectorAll('.hub-node').forEach((n) => {
      const go = () => openSheet(n.getAttribute('data-target'));
      n.addEventListener('click', go);
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  /* ---------- Inicialização ---------- */
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    $('todayLine').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    buildWorld();
    wireHub();
    wirePanels();
    renderChecklist();

    // conexões: preencher e salvar
    $('connSalarioUrl').value = store.getRaw(LS.salUrl, '');
    $('connSalarioKey').value = store.getRaw(LS.salKey, '');
    $('connIrUrl').value = store.getRaw(LS.irUrl, '');
    $('connIrKey').value = store.getRaw(LS.irKey, '');
    $('connRecibosUrl').value = store.getRaw(LS.recUrl, '');
    $('connRecibosKey').value = store.getRaw(LS.recKey, '');
    $('connVendasUrl').value = store.getRaw(LS.venUrl, '');
    $('connVendasKey').value = store.getRaw(LS.venKey, '');
    $('connSave').addEventListener('click', () => {
      store.setRaw(LS.salUrl, $('connSalarioUrl').value.trim());
      store.setRaw(LS.salKey, $('connSalarioKey').value.trim());
      store.setRaw(LS.irUrl, $('connIrUrl').value.trim());
      store.setRaw(LS.irKey, $('connIrKey').value.trim());
      store.setRaw(LS.recUrl, $('connRecibosUrl').value.trim());
      store.setRaw(LS.recKey, $('connRecibosKey').value.trim());
      store.setRaw(LS.venUrl, $('connVendasUrl').value.trim());
      store.setRaw(LS.venKey, $('connVendasKey').value.trim());
      if (isDemo()) store.setRaw(LS.demo, '');
      $('connStatus').textContent = 'Conexões salvas. Sincronizando…';
      refreshLinkStates();
      syncAll(true);
    });
    $('syncNow').addEventListener('click', () => syncAll(true));

    // Salro Link: gerar e copiar o texto de conexão de cada app
    function refreshLinkStates() {
      Object.keys(SalroCalc.LINK_APPS).forEach((k) => {
        const el = document.querySelector('[data-link-state="' + k + '"]');
        if (!el) return;
        const ok = !!(store.getRaw(CONN_KEYS[k].url, '') && store.getRaw(CONN_KEYS[k].key, ''));
        el.textContent = ok ? 'ponte configurada ✔' : 'configure a ponte acima primeiro';
        el.classList.toggle('ok', ok);
      });
    }
    function copyText(text, doneMsg) {
      const status = $('linkStatus');
      const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); status.textContent = doneMsg; }
        catch (e) { status.textContent = 'Não consegui copiar automaticamente — segure o texto e copie manualmente.'; }
        ta.remove();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => { status.textContent = doneMsg; }, fallback);
      } else fallback();
    }
    const linkCard = $('linkCard');
    if (linkCard) {
      linkCard.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-link-copy]');
        if (!btn) return;
        const k = btn.getAttribute('data-link-copy');
        const url = store.getRaw(CONN_KEYS[k].url, '');
        const key = store.getRaw(CONN_KEYS[k].key, '');
        if (!url || !key) {
          $('linkStatus').textContent = 'Configure a ponte desse app aqui em cima (link + chave) e salve as conexões primeiro.';
          return;
        }
        copyText(SalroCalc.linkPrompt(k, url, key), 'Texto de conexão do ' + SalroCalc.LINK_APPS[k].nome + ' copiado ✔ Agora é só colar numa conversa com o seu Muse.');
      });
    }
    refreshLinkStates();
    $('demoToggle').addEventListener('click', () => {
      store.setRaw(LS.demo, isDemo() ? '' : '1');
      syncAll(false);
    });

    // checklist: adicionar / alternar / apagar / exportar / importar
    $('checkForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('checkText').value.trim();
      if (!text) return;
      const items = loadChecklist();
      items.push({ id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 999), text, due: $('checkDue').value || null, done: false });
      saveChecklist(items);
      $('checkText').value = ''; $('checkDue').value = '';
    });
    $('checkList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const items = loadChecklist();
      const it = items.find((i) => i.id === btn.getAttribute('data-id'));
      if (!it) return;
      if (btn.getAttribute('data-act') === 'del') saveChecklist(items.filter((i) => i.id !== it.id));
      else if (btn.getAttribute('data-act') === 'toggle') { it.done = btn.checked; saveChecklist(items); }
    });
    $('checkExport').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ app: 'salro-central', kind: 'checklist', items: loadChecklist() }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'salro-central-checklist.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('checkImport').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const parsed = JSON.parse(rd.result);
          const incoming = Array.isArray(parsed) ? parsed : parsed.items;
          if (!Array.isArray(incoming)) throw new Error('formato');
          const items = loadChecklist();
          const byId = {};
          items.forEach((i) => { byId[i.id] = i; });
          incoming.forEach((i) => {
            if (i && i.id && typeof i.text === 'string') {
              byId[i.id] = { id: i.id, text: i.text, due: i.due || null, done: !!i.done };
            }
          });
          saveChecklist(Object.values(byId));
          $('connStatus').textContent = 'Checklist importada (itens juntados, nada foi apagado).';
        } catch (err) { $('connStatus').innerHTML = '<span class="err">Não consegui importar esse arquivo.</span>'; }
        e.target.value = '';
      };
      rd.readAsText(f);
    });

    // remessas: anotar / apagar
    const nowD = new Date();
    $('remDate').value = nowD.getFullYear() + '-' + String(nowD.getMonth() + 1).padStart(2, '0') + '-' + String(nowD.getDate()).padStart(2, '0');
    renderRemessas();
    $('remForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const date = $('remDate').value;
      const jpy = Number($('remJpy').value);
      const brl = Number($('remBrl').value);
      if (!date || !(jpy > 0) || !(brl >= 0)) return;
      const list = loadRemessas();
      list.push({ id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 999), date, jpy, brl });
      saveRemessas(list);
      $('remJpy').value = ''; $('remBrl').value = '';
    });
    $('remList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-rem-del]');
      if (!b) return;
      saveRemessas(loadRemessas().filter((r) => r.id !== b.getAttribute('data-rem-del')));
    });

    // primeira pintura a partir do cache, depois sincroniza
    renderAll({ sal: cachedState(LS.cacheSal), ir: cachedState(LS.cacheIr), rec: cachedState(LS.cacheRec), ven: cachedState(LS.cacheVen) });
    syncAll(false);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', init);
})();
