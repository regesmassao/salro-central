'use strict';
/* Salro Central — dashboard pessoal.
   Lê SOMENTE os backups que os apps Salário e IR guardam no Drive (via as
   pontes Apps Script que o dono configura em ⚙️ Conexões). Link e chave das
   pontes ficam só no localStorage deste aparelho — nunca no código, nunca
   em exportações. Os apps continuam independentes; aqui é só leitura. */

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

  return { ymOf, ymShift, ymLabel, fmtJPY, fmtBRL, fmtBRL0, msjMonth, irSummary, parseSafe };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SalroCalc;

/* ================= App (navegador) ================= */
if (typeof document !== 'undefined') (() => {
  const $ = (id) => document.getElementById(id);
  const LS = {
    salUrl: 'central-conn-salario-url', salKey: 'central-conn-salario-key',
    irUrl: 'central-conn-ir-url', irKey: 'central-conn-ir-key',
    cacheSal: 'central-cache-salario', cacheIr: 'central-cache-ir',
    checklist: 'central-checklist', demo: 'central-demo'
  };
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    getRaw(k, fb) { const v = localStorage.getItem(k); return v == null ? fb : v; },
    setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  const isDemo = () => store.getRaw(LS.demo, '') === '1';
  const conn = (app) => ({
    url: (store.getRaw(app === 'sal' ? LS.salUrl : LS.irUrl, '') || '').trim(),
    key: (store.getRaw(app === 'sal' ? LS.salKey : LS.irKey, '') || '').trim()
  });
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
    return {
      sal: { ok: true, exists: true, updatedAt: new Date().toISOString(), data: { app: 'demo', data: msjInner } },
      ir: { ok: true, exists: true, updatedAt: new Date().toISOString(), data: irData }
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

  /* ---------- Render: Recibos (v1: sem ponte) ---------- */
  function renderRecibos() {
    $('hubRecibosValue').textContent = '—';
    $('hubNodeRecibosValue').textContent = 'em breve';
    $('hubRecibosSub').textContent = 'A ponte do Recibos ainda não existe — gasto do mês e contas a pagar entram numa próxima versão.';
    $('hubRecibosSync').textContent = 'ponte em breve';
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
    const cacheKey = app === 'sal' ? LS.cacheSal : LS.cacheIr;
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
  function renderAll(status) {
    if (isDemo()) {
      const demo = makeDemo(new Date());
      renderSalario({ status: 'ok', resp: demo.sal });
      renderIr({ status: 'ok', resp: demo.ir });
    } else {
      renderSalario(status.sal);
      renderIr(status.ir);
    }
    renderRecibos();
    $('demoBanner').hidden = !isDemo();
    $('demoToggle').textContent = isDemo() ? 'Sair do modo demonstração' : 'Ver modo demonstração';
  }
  async function syncAll(manual) {
    const statusEl = $('connStatus');
    if (manual) statusEl.textContent = 'Sincronizando…';
    const status = {};
    await Promise.all([syncApp('sal', status), syncApp('ir', status)]);
    renderAll(status);
    if (manual) {
      const parts = [];
      parts.push(hasConn('sal') ? (status.sal.status === 'ok' ? '<span class="ok">Salário ✓</span>' : '<span class="err">Salário: não foi possível ler — confira link e chave</span>') : 'Salário: ponte não configurada');
      parts.push(hasConn('ir') ? (status.ir.status === 'ok' ? '<span class="ok">IR ✓</span>' : '<span class="err">IR: não foi possível ler — confira link e chave</span>') : 'IR: ponte não configurada');
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
  }

  /* ---------- Hub: nós → cartões ---------- */
  function wireHub() {
    document.querySelectorAll('.hub-node').forEach((n) => {
      const go = () => {
        const t = document.getElementById(n.getAttribute('data-target'));
        if (!t) return;
        t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const card = t.classList.contains('glass-card') ? t : t.querySelector('.glass-card');
        if (card) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600); }
      };
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
    renderChecklist();

    // conexões: preencher e salvar
    $('connSalarioUrl').value = store.getRaw(LS.salUrl, '');
    $('connSalarioKey').value = store.getRaw(LS.salKey, '');
    $('connIrUrl').value = store.getRaw(LS.irUrl, '');
    $('connIrKey').value = store.getRaw(LS.irKey, '');
    $('connSave').addEventListener('click', () => {
      store.setRaw(LS.salUrl, $('connSalarioUrl').value.trim());
      store.setRaw(LS.salKey, $('connSalarioKey').value.trim());
      store.setRaw(LS.irUrl, $('connIrUrl').value.trim());
      store.setRaw(LS.irKey, $('connIrKey').value.trim());
      if (isDemo()) store.setRaw(LS.demo, '');
      $('connStatus').textContent = 'Conexões salvas. Sincronizando…';
      syncAll(true);
    });
    $('syncNow').addEventListener('click', () => syncAll(true));
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

    // primeira pintura a partir do cache, depois sincroniza
    renderAll({ sal: cachedState(LS.cacheSal), ir: cachedState(LS.cacheIr) });
    syncAll(false);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', init);
})();
