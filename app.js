/* LedgerZero - Offline PWA Personal Accounting
   No external libs. IndexedDB storage. Turkish UI.
*/
"use strict";

// ---------- Utilities ----------
const $ = (sel, el=document) => el.querySelector(sel);
const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(16) + Math.random().toString(16).slice(2)));
const fmt = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "EUR" });
const fmtNum = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });
const toISODate = (d) => {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth()+1).padStart(2,"0");
  const dd = String(dt.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
};
const startOfMonthISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`;
};
const endOfMonthISO = () => {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth()+1, 0);
  return toISODate(last);
};
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function money(v, currency="EUR"){
  try {
    return new Intl.NumberFormat("tr-TR", { style:"currency", currency }).format(v || 0);
  } catch {
    return `${fmtNum.format(v || 0)} ${currency}`;
  }
}
function parseAmount(s){
  if (typeof s === "number") return s;
  if (!s) return 0;
  const raw = String(s).trim();
  // remove currency symbols and spaces
  let t = raw.replace(/[^\d.,\-+]/g, "");
  // If comma used as decimal (common TR/NL), convert
  // Strategy: last occurrence of '.' or ',' is decimal separator.
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  let decSep = null;
  if (lastDot > lastComma) decSep = ".";
  else if (lastComma > lastDot) decSep = ",";
  if (decSep){
    const parts = t.split(decSep);
    const frac = parts.pop();
    const intPart = parts.join("").replace(/[.,]/g,"");
    t = intPart + "." + frac;
  } else {
    t = t.replace(/[.,]/g,"");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}
function parseDateLoose(s){
  if (!s) return null;
  if (s instanceof Date) return toISODate(s);
  const t = String(s).trim();
  // Try ISO first
  const iso = toISODate(t);
  if (iso) return iso;
  // Try dd.mm.yyyy or dd/mm/yyyy or dd-mm-yyyy
  const m = t.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/);
  if (m){
    const dd = String(parseInt(m[1],10)).padStart(2,"0");
    const mm = String(parseInt(m[2],10)).padStart(2,"0");
    let yy = parseInt(m[3],10);
    if (yy < 100) yy += 2000;
    return `${yy}-${mm}-${dd}`;
  }
  return null;
}
function downloadText(filename, text){
  const blob = new Blob([text], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
}
function csvSplitLine(line, delim){
  // Very simple CSV split, supports quoted fields
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (ch === '"'){
      if (inQ && line[i+1] === '"'){ cur += '"'; i++; }
      else inQ = !inQ;
    } else if (!inQ && ch === delim){
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s=>s.trim());
}
function detectDelimiter(text){
  const sample = text.split(/\r?\n/).slice(0,10).join("\n");
  const counts = [",",";","\t"].map(d => ({d, c:(sample.match(new RegExp(`\\${d}`,"g"))||[]).length}));
  counts.sort((a,b)=>b.c-a.c);
  return counts[0].c ? counts[0].d : ",";
}

// ---------- IndexedDB ----------
const DB_NAME = "LedgerZeroDB";
const DB_VERSION = 1;

let db = null;

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;

      const mk = (name, opts) => d.objectStoreNames.contains(name) ? d.transaction.objectStore(name) : d.createObjectStore(name, opts);

      mk("accounts", { keyPath:"id" }).createIndex("byType", "type", { unique:false });

      const tx = mk("transactions", { keyPath:"id" });
      tx.createIndex("byDate", "date", { unique:false });
      tx.createIndex("byAccount", "accountId", { unique:false });
      tx.createIndex("byType", "type", { unique:false });
      tx.createIndex("byHash", "hash", { unique:false });

      mk("categories", { keyPath:"id" }).createIndex("byName", "name", { unique:false });

      mk("instruments", { keyPath:"id" }).createIndex("bySymbol", "symbol", { unique:false });
      mk("positions", { keyPath:"id" }).createIndex("byInstrument", "instrumentId", { unique:false });

      mk("debts", { keyPath:"id" }).createIndex("byDirection", "direction", { unique:false });
      mk("trades", { keyPath:"id" }).createIndex("byDate", "date", { unique:false });
      mk("goals", { keyPath:"id" }).createIndex("byType", "type", { unique:false });
      mk("snapshots", { keyPath:"id" }).createIndex("byDate", "date", { unique:false });

      mk("meta", { keyPath:"key" });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function txStore(storeName, mode="readonly"){
  const t = db.transaction(storeName, mode);
  return t.objectStore(storeName);
}

function idbGetAll(storeName){
  return new Promise((resolve, reject)=>{
    const req = txStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(storeName, value){
  return new Promise((resolve, reject)=>{
    const req = txStore(storeName, "readwrite").put(value);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(storeName, key){
  return new Promise((resolve, reject)=>{
    const req = txStore(storeName, "readwrite").delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
function idbClear(storeName){
  return new Promise((resolve, reject)=>{
    const req = txStore(storeName, "readwrite").clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(storeName, key){
  return new Promise((resolve, reject)=>{
    const req = txStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
function idbGetMeta(key){
  return idbGet("meta", key);
}
function idbSetMeta(key, value){
  return idbPut("meta", { key, value });
}

// ---------- Seed defaults ----------
async function seedIfNeeded(){
  const seeded = await idbGetMeta("seeded");
  if (seeded?.value) return;

  const defaultCats = ["Maaş", "Kira", "Market", "Ulaşım", "Fatura", "Eğlence", "Yemek", "Sağlık", "Eğitim", "Diğer"]
    .map(name => ({ id: uid(), name }));
  for (const c of defaultCats) await idbPut("categories", c);

  const euro = "EUR";
  const acc1 = { id: uid(), name:"Ana Banka", type:"Banka", currency:euro, startingBalance:0, note:"", createdAt:Date.now() };
  const acc2 = { id: uid(), name:"Nakit", type:"Nakit", currency:euro, startingBalance:0, note:"", createdAt:Date.now() };
  await idbPut("accounts", acc1);
  await idbPut("accounts", acc2);

  await idbSetMeta("seeded", true);
}

// ---------- App state ----------
const state = {
  tab: "dashboard",
  currency: "EUR",
  horizonDays: 30, // expected cash horizon
  includeConfidenceMin: 60, // default include for Expected
};

async function loadCurrency(){
  const cur = await idbGetMeta("baseCurrency");
  if (cur?.value) state.currency = cur.value;
}

async function ensureCurrency(){
  await idbSetMeta("baseCurrency", state.currency);
}

// ---------- Modal ----------
function openModal(title, html, footerButtons=[]){
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  const f = $("#modalFooter");
  f.innerHTML = "";
  footerButtons.forEach(btn => f.appendChild(btn));
  $("#modalBackdrop").classList.add("show");
  $("#modalBackdrop").setAttribute("aria-hidden", "false");
}
function closeModal(){
  $("#modalBackdrop").classList.remove("show");
  $("#modalBackdrop").setAttribute("aria-hidden", "true");
  $("#modalBody").innerHTML = "";
  $("#modalFooter").innerHTML = "";
}
$("#modalClose").addEventListener("click", closeModal);
$("#modalBackdrop").addEventListener("click", (e)=>{ if (e.target === $("#modalBackdrop")) closeModal(); });

// ---------- Service worker update ----------
let swReg = null;
async function registerSW(){
  if (!("serviceWorker" in navigator)) return;
  try{
    swReg = await navigator.serviceWorker.register("./service-worker.js");
    // Update found?
    swReg.addEventListener("updatefound", () => {
      const newWorker = swReg.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller){
          $("#updateNotice").classList.remove("hidden");
        }
      });
    });
  }catch(e){
    console.warn("SW register failed:", e);
  }
}
$("#btnUpdate").addEventListener("click", async ()=>{
  if (!swReg) return;
  const w = swReg.waiting;
  if (w) w.postMessage({type:"SKIP_WAITING"});
  // reload when controller changes
  navigator.serviceWorker.addEventListener("controllerchange", ()=>window.location.reload());
});

// ---------- Calculations ----------
async function computeBalances(){
  const [accounts, txs, debts, positions] = await Promise.all([
    idbGetAll("accounts"), idbGetAll("transactions"), idbGetAll("debts"), idbGetAll("positions")
  ]);

  // Base currency assumption for display. We don't FX convert in MVP.
  const actualCash = accounts.reduce((sum,a)=> sum + (a.startingBalance || 0), 0)
    + txs.reduce((sum,t)=> sum + (t.amount || 0), 0);

  const cashInBank = accounts.filter(a=>a.type==="Banka")
    .reduce((sum,a)=> sum + (a.startingBalance || 0), 0)
    + txs.filter(t=>accounts.find(a=>a.id===t.accountId)?.type==="Banka")
          .reduce((sum,t)=> sum + (t.amount || 0), 0);

  const openReceivables = debts.filter(d=>d.direction==="receivable" && d.status==="open");
  const openPayables = debts.filter(d=>d.direction==="payable" && d.status==="open");

  const today = new Date();
  const horizon = new Date(today.getTime() + state.horizonDays*86400000);

  const dueWithin = openReceivables.filter(d=>{
    const dd = d.dueDate ? new Date(d.dueDate) : null;
    if (!dd || Number.isNaN(dd.getTime())) return true; // if no due date, include
    return dd <= horizon;
  });

  const expectedIncluded = dueWithin.filter(d => (d.confidence ?? 60) >= state.includeConfidenceMin);
  const expectedCash = actualCash + expectedIncluded.reduce((s,d)=>s+(d.amount||0),0);

  const riskAdjustedCash = actualCash + dueWithin.reduce((s,d)=>{
    const p = clamp((d.confidence ?? 60)/100, 0, 1);
    return s + (d.amount||0)*p;
  },0);

  const investmentsCurrent = positions.reduce((s,p)=> s + (p.currentValue || 0), 0);
  const investmentsCost = positions.reduce((s,p)=> s + ((p.qty||0)*(p.avgCost||0)), 0);

  const debtTotal = openPayables.reduce((s,d)=> s + (d.amount||0), 0);

  const netWorth = (actualCash + investmentsCurrent) - debtTotal;

  return {
    accounts, txs, debts, positions,
    actualCash, cashInBank,
    expectedCash, riskAdjustedCash,
    investmentsCurrent, investmentsCost,
    openReceivablesTotal: openReceivables.reduce((s,d)=>s+(d.amount||0),0),
    openPayablesTotal: openPayables.reduce((s,d)=>s+(d.amount||0),0),
    debtTotal,
    netWorth
  };
}

async function computeMonthlyPnl(){
  const txs = await idbGetAll("transactions");
  const start = startOfMonthISO();
  const end = endOfMonthISO();
  let income = 0, expense = 0;
  for (const t of txs){
    if (!t.date) continue;
    if (t.date < start || t.date > end) continue;
    if (t.type === "transfer") continue;
    const amt = t.amount || 0;
    if (amt >= 0) income += amt;
    else expense += Math.abs(amt);
  }
  return { income, expense, net: income - expense, start, end };
}

async function computeTradeStats(){
  const trades = await idbGetAll("trades");
  const start = startOfMonthISO();
  const end = endOfMonthISO();
  const month = trades.filter(t=>t.date && t.date>=start && t.date<=end);
  const total = month.length;
  const wins = month.filter(t=>t.result==="win").length;
  const bes = month.filter(t=>t.result==="be").length;
  const losses = month.filter(t=>t.result==="loss").length;
  const totalR = month.reduce((s,t)=> s + (t.rMultiple||0), 0);
  const winRate = total ? (wins/total)*100 : 0;

  // simple max drawdown on cumulative R
  let peak = 0, dd = 0, cum = 0;
  for (const t of month.sort((a,b)=>(a.date||"").localeCompare(b.date||""))){
    cum += (t.rMultiple||0);
    if (cum > peak) peak = cum;
    dd = Math.min(dd, cum - peak);
  }
  return { total, wins, losses, bes, totalR, winRate, maxDrawdownR: dd };
}

// ---------- Rendering helpers ----------
function card(title, inner, cls=""){
  return `<div class="card ${cls}"><h2>${title}</h2>${inner}</div>`;
}
function kpiBox(label, value, sub="", tag=""){
  return `
  <div class="kpi">
    <div>
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="sub">${sub}</div>
    </div>
    ${tag ? `<div class="tag">${tag}</div>` : ``}
  </div>`;
}
function btn(text, cls="btn primary", onClick=null){
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

// ---------- Views ----------
async function render(){
  const view = $("#view");
  const balances = await computeBalances();
  $("#kpiActual").textContent = money(balances.actualCash, state.currency);

  // Goal alerts
  await renderAlerts(balances);

  switch(state.tab){
    case "dashboard": view.innerHTML = await viewDashboard(balances); break;
    case "transactions": view.innerHTML = await viewTransactions(); break;
    case "accounts": view.innerHTML = await viewAccounts(); break;
    case "portfolio": view.innerHTML = await viewPortfolio(); break;
    case "debts": view.innerHTML = await viewDebts(); break;
    case "trades": view.innerHTML = await viewTrades(); break;
    case "goals": view.innerHTML = await viewGoals(balances); break;
    default: view.innerHTML = await viewDashboard(balances);
  }

  bindViewHandlers();
}

async function renderAlerts(balances){
  const goals = await idbGetAll("goals");
  const alerts = [];
  const now = new Date();
  const thisMonth = startOfMonthISO();

  const monthly = await computeMonthlyPnl();
  for (const g of goals){
    if (g.status === "archived") continue;
    if (g.endDate){
      const ed = new Date(g.endDate);
      if (!Number.isNaN(ed.getTime()) && ed < now) continue;
    }
    const pct = goalProgress(g, balances, monthly);
    if (pct !== null){
      if (g.type === "monthlyExpenseCap"){
        // reversed: lower is better, warn at 80% of cap
        if (pct >= 80) alerts.push(`⚠️ Gider limiti ${Math.round(pct)}% doldu (${g.name || "Aylık gider"}).`);
      } else {
        if (pct < 80) continue;
        alerts.push(`🎯 ${g.name || goalTypeLabel(g.type)} hedefi ${Math.round(pct)}% ilerledi.`);
      }
    }
  }
  const el = $("#alerts");
  if (!alerts.length){
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = `<div><b>Uyarılar</b><div class="muted">${alerts.slice(0,3).join("<br>")}</div></div>`;
}

function goalTypeLabel(type){
  const m = {
    cashInBank:"Bankada Duran Para",
    actualCash:"Toplam Kasa",
    investments:"Yatırım",
    netWorth:"Net Worth",
    monthlyExpenseCap:"Aylık Gider Limiti"
  };
  return m[type] || type;
}

function goalProgress(goal, balances, monthly){
  const target = goal.targetValue ?? null;
  if (target === null || target === undefined) return null;
  const cur = (() => {
    switch(goal.type){
      case "cashInBank": return balances.cashInBank;
      case "actualCash": return balances.actualCash;
      case "investments": return balances.investmentsCurrent;
      case "netWorth": return balances.netWorth;
      case "monthlyExpenseCap": return monthly.expense; // used amount
      default: return null;
    }
  })();
  if (cur === null) return null;
  if (goal.type === "monthlyExpenseCap"){
    return target ? (cur/target)*100 : 0;
  }
  return target ? (cur/target)*100 : 0;
}

async function viewDashboard(balances){
  const monthly = await computeMonthlyPnl();
  const trades = await computeTradeStats();

  const cards = `
  <div class="grid">
    <div class="card span6">
      <h2>Kasa</h2>
      <div class="row">
        ${kpiBox("Gerçek Kasa", money(balances.actualCash, state.currency), "Sadece hesap bakiyeleri (alacak dahil değil)")}
        ${kpiBox("Bankada Duran Para", money(balances.cashInBank, state.currency), "Banka türündeki hesaplar")}
      </div>
      <div style="height:10px"></div>
      <div class="row">
        ${kpiBox(`Beklenen Kasa (${state.horizonDays} gün)`, money(balances.expectedCash, state.currency), `Açık alacaklar (min güven: ${state.includeConfidenceMin})`)}
        ${kpiBox(`Risk Ayarlı Kasa (${state.horizonDays} gün)`, money(balances.riskAdjustedCash, state.currency), "Alacak * olasılık")}
      </div>
      <div style="height:10px"></div>
      <div class="row">
        ${kpiBox("Açık Alacak", money(balances.openReceivablesTotal, state.currency), "Tahsil edilmemiş")}
        ${kpiBox("Açık Borç", money(balances.openPayablesTotal, state.currency), "Ödenmemiş")}
      </div>
    </div>

    <div class="card span6">
      <h2>Net Worth</h2>
      <div class="row">
        ${kpiBox("Yatırımlar (Güncel)", money(balances.investmentsCurrent, state.currency), `Maliyet: ${money(balances.investmentsCost, state.currency)}`)}
        ${kpiBox("Net Worth", money(balances.netWorth, state.currency), "(Actual Cash + Investments) - DebtTotal")}
      </div>
      <hr>
      <h3>Bu Ay (Muhasebe)</h3>
      <div class="row">
        ${kpiBox("Gelir", money(monthly.income, state.currency), `${monthly.start} → ${monthly.end}`)}
        ${kpiBox("Gider", money(monthly.expense, state.currency), "Transferler hariç", monthly.expense > monthly.income ? "⚠️" : "")}
        ${kpiBox("Net", money(monthly.net, state.currency), "Gelir - Gider", monthly.net >= 0 ? "✅" : "⚠️")}
      </div>
      <hr>
      <h3>Bu Ay (Trading)</h3>
      <div class="row">
        ${kpiBox("Trade", `${trades.total}`, `Win: ${trades.wins} • Loss: ${trades.losses} • BE: ${trades.bes}`)}
        ${kpiBox("Toplam R", `${fmtNum.format(trades.totalR)}`, `Win rate: ${fmtNum.format(trades.winRate)}%`)}
        ${kpiBox("Max DD (R)", `${fmtNum.format(trades.maxDrawdownR)}`, "Cumulative R drawdown")}
      </div>
    </div>

    <div class="card span4">
      <h2>Hızlı Ayar</h2>
      <label>Beklenen kasa vade filtresi</label>
      <div class="row">
        <select id="horizonDays">
          ${[7,30,90].map(d=>`<option value="${d}" ${state.horizonDays===d?"selected":""}>${d} gün</option>`).join("")}
        </select>
        <select id="confMin">
          ${[0,30,60,90].map(v=>`<option value="${v}" ${state.includeConfidenceMin===v?"selected":""}>Min güven ${v}</option>`).join("")}
        </select>
      </div>
      <div style="height:10px"></div>
      <button class="btn block" data-action="openSettings">⚙️ Yedek / Ayarlar</button>
    </div>

    <div class="card span8">
      <h2>Son Kayıtlar</h2>
      <div class="row">
        <button class="btn block" data-action="quickAddTx">🧾 İşlem Ekle</button>
        <button class="btn block" data-action="quickImportCsv">📥 CSV Import</button>
        <button class="btn block" data-action="quickAddTrade">⚔️ Trade Ekle</button>
      </div>
      <div style="height:12px"></div>
      ${await recentList()}
    </div>
  </div>
  `;
  return cards;
}

async function recentList(){
  const txs = (await idbGetAll("transactions")).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,6);
  const trades = (await idbGetAll("trades")).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,4);
  const debts = (await idbGetAll("debts")).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,4);

  const lineTx = txs.map(t=> `<tr>
    <td>${t.date || ""}</td>
    <td>${escapeHtml(t.description||t.type||"")}${t.type==="transfer" ? ` <span class="badge">transfer</span>`:""}</td>
    <td style="text-align:right">${money(t.amount||0, state.currency)}</td>
  </tr>`).join("") || `<tr><td colspan="3" class="mini">Henüz işlem yok.</td></tr>`;

  const lineTr = trades.map(t=> `<tr>
    <td>${t.date || ""}</td>
    <td>${escapeHtml(t.symbol||"")}</td>
    <td>${t.result ? `<span class="badge ${t.result==="win"?"good":t.result==="loss"?"bad":"warn"}">${t.result}</span>`:""}</td>
    <td style="text-align:right">${fmtNum.format(t.rMultiple||0)} R</td>
  </tr>`).join("") || `<tr><td colspan="4" class="mini">Henüz trade yok.</td></tr>`;

  const lineDb = debts.map(d=> `<tr>
    <td>${escapeHtml(d.person||"")}</td>
    <td>${d.direction==="receivable" ? `<span class="badge good">alacak</span>` : `<span class="badge bad">borç</span>`}</td>
    <td>${d.status==="open" ? `<span class="badge warn">açık</span>` : `<span class="badge">kapalı</span>`}</td>
    <td style="text-align:right">${money(d.amount||0, state.currency)}</td>
  </tr>`).join("") || `<tr><td colspan="4" class="mini">Henüz borç/alacak yok.</td></tr>`;

  return `
  <div class="grid">
    <div class="card span6">
      <h3>Son İşlemler</h3>
      <table class="table"><thead><tr><th>Tarih</th><th>Açıklama</th><th style="text-align:right">Tutar</th></tr></thead>
      <tbody>${lineTx}</tbody></table>
    </div>
    <div class="card span6">
      <h3>Son Trade</h3>
      <table class="table"><thead><tr><th>Tarih</th><th>Enstrüman</th><th>Sonuç</th><th style="text-align:right">R</th></tr></thead>
      <tbody>${lineTr}</tbody></table>
      <div style="height:10px"></div>
      <h3>Son Borç/Alacak</h3>
      <table class="table"><thead><tr><th>Kişi</th><th>Tür</th><th>Durum</th><th style="text-align:right">Tutar</th></tr></thead>
      <tbody>${lineDb}</tbody></table>
    </div>
  </div>
  `;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

// Transactions view
async function viewTransactions(){
  const [accounts, cats, txs] = await Promise.all([idbGetAll("accounts"), idbGetAll("categories"), idbGetAll("transactions")]);
  const accMap = new Map(accounts.map(a=>[a.id,a]));
  const catMap = new Map(cats.map(c=>[c.id,c]));

  const rows = txs.sort((a,b)=>(b.date||"").localeCompare(a.date||"")).slice(0,200).map(t=>{
    const acc = accMap.get(t.accountId);
    const cat = catMap.get(t.categoryId);
    const badge = t.type==="transfer" ? `<span class="badge">transfer</span>` : "";
    return `<tr>
      <td>${t.date||""}</td>
      <td>${escapeHtml(acc?.name||"")}</td>
      <td>${escapeHtml(cat?.name||t.type||"")}${badge}</td>
      <td>${escapeHtml(t.description||"")}</td>
      <td style="text-align:right">${money(t.amount||0, state.currency)}</td>
      <td style="text-align:right">
        <button class="btn small ghost" data-act="editTx" data-id="${t.id}">Düzenle</button>
        <button class="btn small danger" data-act="delTx" data-id="${t.id}">Sil</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="mini">Henüz işlem yok.</td></tr>`;

  return `
  ${card("İşlemler", `
    <div class="row">
      <button class="btn primary" data-action="addTx">➕ İşlem Ekle</button>
      <button class="btn" data-action="addTransfer">🔁 Transfer</button>
      <button class="btn" data-action="importCsv">📥 CSV Import</button>
      <button class="btn" data-action="manageCats">🏷️ Kategoriler</button>
    </div>
    <div style="height:12px"></div>
    <table class="table">
      <thead>
        <tr><th>Tarih</th><th>Hesap</th><th>Kategori</th><th>Açıklama</th><th style="text-align:right">Tutar</th><th style="text-align:right">İşlem</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="mini" style="margin-top:10px">Not: Transfer işlemleri gelir/gider raporundan hariç tutulur.</div>
  `)}
  `;
}

// Accounts view
async function viewAccounts(){
  const [accounts, txs] = await Promise.all([idbGetAll("accounts"), idbGetAll("transactions")]);

  const rows = accounts.map(a=>{
    const bal = (a.startingBalance||0) + txs.filter(t=>t.accountId===a.id).reduce((s,t)=>s+(t.amount||0),0);
    return `<tr>
      <td>${escapeHtml(a.name)}</td>
      <td><span class="badge">${escapeHtml(a.type)}</span></td>
      <td>${escapeHtml(a.currency||state.currency)}</td>
      <td style="text-align:right">${money(bal, state.currency)}</td>
      <td style="text-align:right">
        <button class="btn small ghost" data-act="editAcc" data-id="${a.id}">Düzenle</button>
        <button class="btn small" data-act="adjustAcc" data-id="${a.id}">Düzeltme</button>
        <button class="btn small danger" data-act="delAcc" data-id="${a.id}">Sil</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" class="mini">Hesap yok.</td></tr>`;

  return `
  ${card("Hesaplar", `
    <div class="row">
      <button class="btn primary" data-action="addAcc">➕ Hesap Ekle</button>
      <button class="btn" data-action="openSettings">⚙️ Yedek / Ayarlar</button>
    </div>
    <div style="height:12px"></div>
    <table class="table">
      <thead><tr><th>Ad</th><th>Tür</th><th>Para Birimi</th><th style="text-align:right">Bakiye</th><th style="text-align:right">İşlem</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `)}
  `;
}

// Portfolio view
async function viewPortfolio(){
  const [instr, pos] = await Promise.all([idbGetAll("instruments"), idbGetAll("positions")]);
  const im = new Map(instr.map(i=>[i.id,i]));
  const rows = pos.map(p=>{
    const i = im.get(p.instrumentId);
    const cost = (p.qty||0)*(p.avgCost||0);
    return `<tr>
      <td>${escapeHtml(i?.symbol||"")}</td>
      <td>${escapeHtml(i?.type||"")}</td>
      <td style="text-align:right">${fmtNum.format(p.qty||0)}</td>
      <td style="text-align:right">${money(cost, state.currency)}</td>
      <td style="text-align:right">${money(p.currentValue||0, state.currency)}</td>
      <td style="text-align:right">
        <button class="btn small ghost" data-act="editPos" data-id="${p.id}">Düzenle</button>
        <button class="btn small danger" data-act="delPos" data-id="${p.id}">Sil</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="mini">Pozisyon yok.</td></tr>`;

  return `
  ${card("Yatırımlar (Portfolio)", `
    <div class="row">
      <button class="btn primary" data-action="addInstr">➕ Enstrüman</button>
      <button class="btn" data-action="addPos">📌 Pozisyon</button>
    </div>
    <div style="height:12px"></div>
    <table class="table">
      <thead><tr><th>Sembol</th><th>Tür</th><th style="text-align:right">Miktar</th><th style="text-align:right">Maliyet</th><th style="text-align:right">Güncel</th><th style="text-align:right">İşlem</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="mini" style="margin-top:10px">MVP: canlı fiyat yok. Güncel değeri manuel gir.</div>
  `)}
  `;
}

// Debts view
async function viewDebts(){
  const debts = await idbGetAll("debts");
  const rows = debts.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).map(d=>{
    const dir = d.direction==="receivable" ? `<span class="badge good">alacak</span>` : `<span class="badge bad">borç</span>`;
    const st = d.status==="open" ? `<span class="badge warn">açık</span>` : `<span class="badge">kapalı</span>`;
    const conf = d.confidence ?? 60;
    return `<tr>
      <td>${escapeHtml(d.person||"")}</td>
      <td>${dir}</td>
      <td>${st}</td>
      <td>${d.dueDate || ""}</td>
      <td>${conf}</td>
      <td style="text-align:right">${money(d.amount||0, state.currency)}</td>
      <td style="text-align:right">
        <button class="btn small ghost" data-act="editDebt" data-id="${d.id}">Düzenle</button>
        <button class="btn small" data-act="markPaidDebt" data-id="${d.id}">Kapat</button>
        <button class="btn small danger" data-act="delDebt" data-id="${d.id}">Sil</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="mini">Henüz borç/alacak yok.</td></tr>`;

  return `
  ${card("Borç / Alacak", `
    <div class="row">
      <button class="btn primary" data-action="addDebt">➕ Kayıt Ekle</button>
      <button class="btn" data-action="debtToTxHelp">🔗 Tahsil/Ödeme Eşleştir</button>
    </div>
    <div style="height:12px"></div>
    <table class="table">
      <thead><tr><th>Kişi</th><th>Tür</th><th>Durum</th><th>Vade</th><th>Güven</th><th style="text-align:right">Tutar</th><th style="text-align:right">İşlem</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `)}
  `;
}

// Trades view
async function viewTrades(){
  const trades = await idbGetAll("trades");
  const rows = trades.sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map(t=>{
    const res = t.result ? `<span class="badge ${t.result==="win"?"good":t.result==="loss"?"bad":"warn"}">${t.result}</span>` : "";
    return `<tr>
      <td>${t.date||""}</td>
      <td>${escapeHtml(t.symbol||"")}</td>
      <td>${escapeHtml(t.side||"")}</td>
      <td>${res}</td>
      <td style="text-align:right">${fmtNum.format(t.rMultiple||0)} R</td>
      <td style="text-align:right">
        <button class="btn small ghost" data-act="editTrade" data-id="${t.id}">Düzenle</button>
        <button class="btn small danger" data-act="delTrade" data-id="${t.id}">Sil</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="mini">Henüz trade yok.</td></tr>`;

  return `
  ${card("Trade Journal", `
    <div class="row">
      <button class="btn primary" data-action="addTrade">➕ Trade Ekle</button>
    </div>
    <div style="height:12px"></div>
    <table class="table">
      <thead><tr><th>Tarih</th><th>Enstrüman</th><th>Yön</th><th>Sonuç</th><th style="text-align:right">R</th><th style="text-align:right">İşlem</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="mini" style="margin-top:10px">R-multiple girersen strateji kıyasın anlamlı olur.</div>
  `)}
  `;
}

// Goals view
async function viewGoals(balances){
  const goals = await idbGetAll("goals");
  const monthly = await computeMonthlyPnl();

  const cards = goals.map(g=>{
    const pct = clamp(goalProgress(g, balances, monthly) ?? 0, 0, 999);
    const pctShow = Math.round(pct);
    const cur = (() => {
      switch(g.type){
        case "cashInBank": return balances.cashInBank;
        case "actualCash": return balances.actualCash;
        case "investments": return balances.investmentsCurrent;
        case "netWorth": return balances.netWorth;
        case "monthlyExpenseCap": return monthly.expense;
        default: return 0;
      }
    })();
    const target = g.targetValue || 0;
    const reversed = (g.type==="monthlyExpenseCap");
    const info = reversed
      ? `Kullanım: ${money(cur, state.currency)} / Limit: ${money(target, state.currency)}`
      : `Mevcut: ${money(cur, state.currency)} / Hedef: ${money(target, state.currency)}`;
    const barPct = reversed ? clamp((cur/target)*100, 0, 999) : clamp((cur/target)*100, 0, 999);
    const colorTag = reversed ? (barPct >= 100 ? "⚠️ Aşıldı" : barPct >= 80 ? "⚠️ Yakın" : "✅ İyi") : (barPct >= 100 ? "✅ Tamam" : barPct >= 80 ? "⚠️ Yakın" : "⏳ Devam");
    return `
      <div class="card span6">
        <h2>${escapeHtml(g.name || goalTypeLabel(g.type))}</h2>
        <div class="mini">${escapeHtml(g.description || "")}</div>
        <div style="height:10px"></div>
        <div class="row">
          ${kpiBox("Durum", colorTag, info)}
        </div>
        <div style="height:10px"></div>
        <div class="progress"><div style="width:${clamp(barPct,0,100)}%"></div></div>
        <div class="mini" style="margin-top:8px">İlerleme: ${pctShow}% • Bitiş: ${g.endDate || "yok"}</div>
        <div style="height:12px"></div>
        <div class="row">
          <button class="btn small ghost" data-act="editGoal" data-id="${g.id}">Düzenle</button>
          <button class="btn small danger" data-act="delGoal" data-id="${g.id}">Sil</button>
        </div>
      </div>
    `;
  }).join("") || `<div class="card"><div class="mini">Henüz hedef yok. Bir tane ekle, sonra sistem seni uyararak rahatsız etmeye başlasın.</div></div>`;

  return `
  ${card("Hedefler", `
    <div class="row">
      <button class="btn primary" data-action="addGoal">➕ Hedef Ekle</button>
      <button class="btn" data-action="addSnapshot">📸 Snapshot</button>
      <button class="btn" data-action="openSettings">⚙️ Yedek / Ayarlar</button>
    </div>
    <div style="height:12px"></div>
    <div class="grid">${cards}</div>
    <hr>
    <h3>Snapshot</h3>
    ${await viewSnapshotsInline(balances)}
  `)}
  `;
}

async function viewSnapshotsInline(balances){
  const snaps = (await idbGetAll("snapshots")).sort((a,b)=>(b.date||"").localeCompare(a.date||"")).slice(0,10);
  const rows = snaps.map(s=>`<tr>
    <td>${s.date||""}</td>
    <td style="text-align:right">${money(s.netWorth||0,state.currency)}</td>
    <td style="text-align:right">${money(s.cashTotal||0,state.currency)}</td>
    <td style="text-align:right">${money(s.investmentsValue||0,state.currency)}</td>
    <td style="text-align:right"><button class="btn small danger" data-act="delSnap" data-id="${s.id}">Sil</button></td>
  </tr>`).join("") || `<tr><td colspan="5" class="mini">Snapshot yok.</td></tr>`;
  return `
    <table class="table">
      <thead><tr><th>Tarih</th><th style="text-align:right">Net Worth</th><th style="text-align:right">Kasa</th><th style="text-align:right">Yatırım</th><th style="text-align:right">İşlem</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ---------- View handlers binding ----------
function bindViewHandlers(){
  // Dashboard quick settings
  const hd = $("#horizonDays");
  if (hd) hd.addEventListener("change", async (e)=>{ state.horizonDays = Number(e.target.value); await render(); });
  const cm = $("#confMin");
  if (cm) cm.addEventListener("change", async (e)=>{ state.includeConfidenceMin = Number(e.target.value); await render(); });

  // Global action buttons inside views
  $$("[data-action]").forEach(b=>{
    b.addEventListener("click", async ()=>{
      const act = b.getAttribute("data-action");
      if (act === "addTx" || act === "quickAddTx") return openTxModal();
      if (act === "addTransfer") return openTransferModal();
      if (act === "importCsv" || act === "quickImportCsv") return openCsvImportModal();
      if (act === "manageCats") return openCategoriesModal();
      if (act === "addAcc") return openAccountModal();
      if (act === "addInstr") return openInstrumentModal();
      if (act === "addPos") return openPositionModal();
      if (act === "addDebt") return openDebtModal();
      if (act === "addTrade" || act === "quickAddTrade") return openTradeModal();
      if (act === "addGoal") return openGoalModal();
      if (act === "openSettings") return openSettingsModal();
      if (act === "debtToTxHelp") return openDebtToTxHelp();
      if (act === "addSnapshot") return openSnapshotModal();
    });
  });

  // Table row actions
  $$("[data-act]").forEach(b=>{
    b.addEventListener("click", async ()=>{
      const a = b.getAttribute("data-act");
      const id = b.getAttribute("data-id");
      if (a === "delTx") return confirmDelete("İşlem silinsin mi?", async ()=>{ await idbDelete("transactions", id); await render(); });
      if (a === "editTx") return openTxModal(id);
      if (a === "delAcc") return confirmDelete("Hesap silinsin mi? (işlemler kalır)", async ()=>{ await idbDelete("accounts", id); await render(); });
      if (a === "editAcc") return openAccountModal(id);
      if (a === "adjustAcc") return openAdjustmentModal(id);
      if (a === "delPos") return confirmDelete("Pozisyon silinsin mi?", async ()=>{ await idbDelete("positions", id); await render(); });
      if (a === "editPos") return openPositionModal(id);
      if (a === "delDebt") return confirmDelete("Kayıt silinsin mi?", async ()=>{ await idbDelete("debts", id); await render(); });
      if (a === "editDebt") return openDebtModal(id);
      if (a === "markPaidDebt") return markDebtClosed(id);
      if (a === "delTrade") return confirmDelete("Trade silinsin mi?", async ()=>{ await idbDelete("trades", id); await render(); });
      if (a === "editTrade") return openTradeModal(id);
      if (a === "delGoal") return confirmDelete("Hedef silinsin mi?", async ()=>{ await idbDelete("goals", id); await render(); });
      if (a === "editGoal") return openGoalModal(id);
      if (a === "delSnap") return confirmDelete("Snapshot silinsin mi?", async ()=>{ await idbDelete("snapshots", id); await render(); });
    });
  });

  // Quick add button in topbar
  const q = $("#btnOpenQuick");
  if (q){
    q.onclick = () => openQuickModal();
  }
}

// ---------- Quick modal ----------
function openQuickModal(){
  openModal("Hızlı Ekle", `
    <div class="row">
      <button class="btn block primary" id="qTx">🧾 İşlem</button>
      <button class="btn block" id="qCsv">📥 CSV Import</button>
    </div>
    <div style="height:10px"></div>
    <div class="row">
      <button class="btn block" id="qDebt">🤝 Borç/Alacak</button>
      <button class="btn block" id="qTrade">⚔️ Trade</button>
    </div>
    <div style="height:10px"></div>
    <div class="row">
      <button class="btn block" id="qGoal">🎯 Hedef</button>
      <button class="btn block" id="qSettings">⚙️ Yedek/Ayar</button>
    </div>
  `, [btn("Kapat", "btn", closeModal)]);
  $("#qTx").onclick = ()=>{ closeModal(); openTxModal(); };
  $("#qCsv").onclick = ()=>{ closeModal(); openCsvImportModal(); };
  $("#qDebt").onclick = ()=>{ closeModal(); openDebtModal(); };
  $("#qTrade").onclick = ()=>{ closeModal(); openTradeModal(); };
  $("#qGoal").onclick = ()=>{ closeModal(); openGoalModal(); };
  $("#qSettings").onclick = ()=>{ closeModal(); openSettingsModal(); };
}

// ---------- CRUD modals ----------
async function openAccountModal(id=null){
  const existing = id ? await idbGet("accounts", id) : null;
  openModal(existing ? "Hesap Düzenle" : "Hesap Ekle", `
    <label>Hesap Adı</label>
    <input id="accName" value="${escapeHtml(existing?.name||"")}" placeholder="Örn: ING, Rabobank, Nakit" />
    <div class="row">
      <div>
        <label>Tür</label>
        <select id="accType">
          ${["Banka","Nakit","Broker"].map(t=>`<option ${existing?.type===t?"selected":""}>${t}</option>`).join("")}
        </select>
      </div>
      <div>
        <label>Para Birimi</label>
        <input id="accCur" value="${escapeHtml(existing?.currency||state.currency)}" />
      </div>
    </div>
    <label>Başlangıç Bakiyesi</label>
    <input id="accStart" inputmode="decimal" value="${existing?.startingBalance ?? 0}" />
    <label>Not</label>
    <textarea id="accNote" placeholder="opsiyon">${escapeHtml(existing?.note||"")}</textarea>
  `, [
    btn("İptal", "btn", closeModal),
    btn("Kaydet", "btn primary", async ()=>{
      const v = {
        id: existing?.id || uid(),
        name: $("#accName").value.trim() || "Hesap",
        type: $("#accType").value,
        currency: $("#accCur").value.trim().toUpperCase() || state.currency,
        startingBalance: parseAmount($("#accStart").value),
        note: $("#accNote").value.trim(),
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      await idbPut("accounts", v);
      closeModal();
      await render();
    })
  ]);
}

async function openTxModal(id=null){
  const [accounts, cats] = await Promise.all([idbGetAll("accounts"), idbGetAll("categories")]);
  const existing = id ? await idbGet("transactions", id) : null;

  const accOpts = accounts.map(a=>`<option value="${a.id}" ${(existing?.accountId===a.id)?"selected":""}>${escapeHtml(a.name)} (${a.type})</option>`).join("");
  const catOpts = cats.map(c=>`<option value="${c.id}" ${(existing?.categoryId===c.id)?"selected":""}>${escapeHtml(c.name)}</option>`).join("");

  openModal(existing ? "İşlem Düzenle" : "İşlem Ekle", `
    <div class="row">
      <div>
        <label>Tarih</label>
        <input id="txDate" type="date" value="${existing?.date || toISODate(new Date())}" />
      </div>
      <div>
        <label>Hesap</label>
        <select id="txAcc">${accOpts}</select>
      </div>
    </div>
    <div class="row">
      <div>
        <label>Kategori</label>
        <select id="txCat">${catOpts}</select>
      </div>
      <div>
        <label>Tutar (+ gelir / - gider)</label>
        <input id="txAmt" inputmode="decimal" value="${existing?.amount ?? ""}" placeholder="-12.50" />
      </div>
    </div>
    <label>Açıklama</label>
    <input id="txDesc" value="${escapeHtml(existing?.description||"")}" placeholder="market, kira, maaş..." />
  `, [
    btn("İptal", "btn", closeModal),
    btn("Kaydet", "btn primary", async ()=>{
      const date = $("#txDate").value || toISODate(new Date());
      const amount = parseAmount($("#txAmt").value);
      const desc = $("#txDesc").value.trim();
      const accountId = $("#txAcc").value;
      const categoryId = $("#txCat").value;

      const hash = await hashString(`${date}|${amount}|${desc}|${accountId}|${categoryId}|tx`);
      const v = {
        id: existing?.id || uid(),
        type: existing?.type || "normal",
        date,
        accountId,
        categoryId,
        description: desc,
        amount,
        currency: state.currency,
        hash,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      await idbPut("transactions", v);
      closeModal();
      await render();
    })
  ]);
}

async function openTransferModal(){
  const accounts = await idbGetAll("accounts");
  const opts = accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.name)} (${a.type})</option>`).join("");
  openModal("Transfer", `
    <div class="row">
      <div>
        <label>Tarih</label>
        <input id="trDate" type="date" value="${toISODate(new Date())}" />
      </div>
      <div>
        <label>Tutar</label>
        <input id="trAmt" inputmode="decimal" placeholder="100" />
      </div>
    </div>
    <div class="row">
      <div>
        <label>Gönderen hesap</label>
        <select id="trFrom">${opts}</select>
      </div>
      <div>
        <label>Alan hesap</label>
        <select id="trTo">${opts}</select>
      </div>
    </div>
    <label>Not</label>
    <input id="trNote" placeholder="opsiyon" />
    <div class="mini">Transferler gelir/gider olarak sayılmaz, sadece hesap bakiyesini taşır.</div>
  `, [
    btn("İptal", "btn", closeModal),
    btn("Kaydet", "btn primary", async ()=>{
      const date = $("#trDate").value || toISODate(new Date());
      const amt = Math.abs(parseAmount($("#trAmt").value));
      const from = $("#trFrom").value;
      const to = $("#trTo").value;
      if (!amt || from === to){
        alert("Tutar 0 olamaz ve hesaplar farklı olmalı.");
        return;
      }
      const groupId = uid();
      const note = $("#trNote").value.trim();
      const hashBase = `${date}|${amt}|${from}|${to}|${note}|transfer`;

      const fromTx = {
        id: uid(),
        type: "transfer",
        transferGroupId: groupId,
        date,
        accountId: from,
        categoryId: null,
        description: `Transfer → ${note}`,
        amount: -amt,
        currency: state.currency,
        hash: await hashString(hashBase + "|from"),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      const toTx = {
        id: uid(),
        type: "transfer",
        transferGroupId: groupId,
        date,
        accountId: to,
        categoryId: null,
        description: `Transfer ← ${note}`,
        amount: amt,
        currency: state.currency,
        hash: await hashString(hashBase + "|to"),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await idbPut("transactions", fromTx);
      await idbPut("transactions", toTx);
      closeModal();
      await render();
    })
  ]);
}

async function openAdjustmentModal(accountId){
  const acc = await idbGet("accounts", accountId);
  const txs = await idbGetAll("transactions");
  const current = (acc?.startingBalance||0) + txs.filter(t=>t.accountId===accountId).reduce((s,t)=>s+(t.amount||0),0);

  openModal("Bakiye Düzeltme", `
    <div class="mini">Bu hesap için mevcut hesaplanan bakiye: <b>${money(current, state.currency)}</b></div>
    <div style="height:10px"></div>
    <label>Gerçek bakiye (senin dediğin)</label>
    <input id="adjTarget" inputmode="decimal" placeholder="Örn: 1234.56" />
    <label>Not</label>
    <input id="adjNote" placeholder="Örn: Banka kesinti / yuvarlama / kontrol" />
    <div class="mini">Sistem farkı “adjustment” olarak işlem listesine ekler.</div>
  `, [
    btn("İptal", "btn", closeModal),
    btn("Uygula", "btn primary", async ()=>{
      const target = parseAmount($("#adjTarget").value);
      const diff = target - current;
      if (!Number.isFinite(diff)){
        alert("Geçerli bir sayı gir.");
        return;
      }
      if (Math.abs(diff) < 0.000001){
        alert("Fark yok. (Mucize.)");
        return;
      }
      const date = toISODate(new Date());
      const note = $("#adjNote").value.trim();
      const hash = await hashString(`${date}|${diff}|${accountId}|adjustment|${note}`);
      await idbPut("transactions", {
        id: uid(),
        type: "adjustment",
        date,
        accountId,
        categoryId: null,
        description: `Adjustment: ${note}`,
        amount: diff,
        currency: state.currency,
        hash,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      closeModal();
      await render();
    })
  ]);
}

async function openCategoriesModal(){
  const cats = await idbGetAll("categories");
  const rows = cats.sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td style="text-align:right">
        <button class="btn small danger" data-act="delCat" data-id="${c.id}">Sil</button>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="2" class="mini">Kategori yok.</td></tr>`;

  openModal("Kategoriler", `
    <label>Yeni kategori</label>
    <div class="row">
      <input id="newCat" placeholder="Örn: Sigorta" />
      <button class="btn primary" id="btnAddCat">Ekle</button>
    </div>
    <div style="height:12px"></div>
    <table class="table"><thead><tr><th>Ad</th><th style="text-align:right">İşlem</th></tr></thead><tbody>${rows}</tbody></table>
  `, [btn("Kapat", "btn", closeModal)]);
  $("#btnAddCat").onclick = async ()=>{
    const name = $("#newCat").value.trim();
    if (!name) return;
    await idbPut("categories", { id: uid(), name });
    closeModal();
    await render();
  };
  $$('[data-act="delCat"]').forEach(b=>{
    b.onclick = async ()=>{
      const id = b.getAttribute("data-id");
      await idbDelete("categories", id);
      closeModal();
      await render();
    };
  });
}

async function openInstrumentModal(id=null){
  const existing = id ? await idbGet("instruments", id) : null;
  openModal(existing ? "Enstrüman Düzenle" : "Enstrüman Ekle", `
    <label>Sembol</label>
    <input id="insSym" value="${escapeHtml(existing?.symbol||"")}" placeholder="XAUUSD / BTC / AAPL" />
    <label>Ad</label>
    <input id="insName" value="${escapeHtml(existing?.name||"")}" placeholder="Altın / Bitcoin / Apple" />
    <label>Tür</label>
    <select id="insType">
      ${["Altın","Hisse","ETF","Kripto","FX","Diğer"].map(t=>`<option ${existing?.type===t?"selected":""}>${t}</option>`).join("")}
    </select>
    <label>Para Birimi</label>
    <input id="insCur" value="${escapeHtml(existing?.currency||state.currency)}" />
  `, [
    btn("İptal", "btn", closeModal),
    btn("Kaydet", "btn primary", async ()=>{
      const v = {
        id: existing?.id || uid(),
        symbol: $("#insSym").value.trim().toUpperCase() || "SYM",
        name: $("#insName").value.trim(),
        type: $("#insType").value,
        currency: $("#insCur").value.trim().toUpperCase() || state.currency,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      await idbPut("instruments", v);
      closeModal();
      await render();
    })
  ]);
}

async function openPositionModal(id=null){
  const [instr, existing] = await Promise.all([idbGetAll("instruments"), id ? idbGet("positions", id) : null]);
  if (!instr.length){
    alert("Önce enstrüman ekle.");
    return;
  }
  const opts = instr.map(i=>`<option value="${i.id}" ${existing?.instrumentId===i.id?"selected":""}>${escapeHtml(i.symbol)} • ${escapeHtml(i.type)}</option>`).join("");

  openModal(existing ? "Pozisyon Düzenle" : "Pozisyon Ekle", `
    <label>Enstrüman</label>
    <select id="posIns">${opts}</select>
    <div class="row">
      <div>
        <label>Miktar</label>
        <input id="posQty" inputmode="decimal" value="${existing?.qty ?? ""}" />
      </div>
      <div>
        <label>Ortalama Maliyet</label>
        <input id="posCost" inputmode="decimal" value="${existing?.avgCost ?? ""}" />
      </div>
    </div>
    <label>Güncel Değer (toplam)</label>
    <input id="posCurVal" inputmode="decimal" value="${existing?.currentValue ?? ""}" placeholder="Örn: 2500" />
    <label>Not</label>
    <textarea id="posNote">${escapeHtml(existing?.note||"")}</textarea>
  `, [
    btn("İptal", "btn", closeModal),
    btn("Kaydet", "btn primary", async ()=>{
      const v = {
        id: existing?.id || uid(),
        instrumentId: $("#posIns").value,
        qty: parseAmount($("#posQty").value),
        avgCost: parseAmount($("#posCost").value),
        currentValue: parseAmount($("#posCurVal").value),
        note: $("#posNote").value.trim(),
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      await idbPut("positions", v);
      closeModal();
      await render();
    })
  ]);
}

function confidencePresetToValue(p){
  if (p==="Kesin") return 95;
  if (p==="Muhtemel") return 70;
  if (p==="Şüpheli") return 40;
  if (p==="Umutsuz") return 10;
  const n = parseInt(p,10);
  return Number.isFinite(n) ? clamp(n,0,100) : 60;
}
function confidenceValueToPreset(v){
  if (v >= 90) return "Kesin";
  if (v >= 60) return "Muhtemel";
  if (v >= 30) return "Şüpheli";
  return "Umutsuz";
}

async function openDebtModal(id=null){
  const existing = id ? await idbGet("debts", id) : null;
  const confPreset = confidenceValueToPreset(existing?.confidence ?? 60);

  openModal(existing ? "Kayıt Düzenle" : "Borç/Alacak Ekle", `
    <div class="row">
      <div>
        <label>Tür</label>
        <select id="debtDir">
          <option value="receivable" ${existing?.direction==="receivable"?"selected":""}>Alacak</option>
          <option value="payable" ${existing?.direction==="payable"?"selected":""}>Borç</option>
        </select>
      </div>
      <div>
        <label>Durum</label>
        <select id="debtStatus">
          <option value="open" ${existing?.status==="open"?"selected":""}>Açık</option>
          <option value="closed" ${existing?.status==="closed"?"selected":""}>Kapalı</option>
          <option value="disputed" ${existing?.status==="disputed"?"selected":""}>İhtilaflı</option>
          <option value="writtenoff" ${existing?.status==="writtenoff"?"selected":""}>Silindi</option>
        </select>
      </div>
    </div>
    <label>Kişi / Şirket</label>
    <input id="debtPerson" value="${escapeHtml(existing?.person||"")}" placeholder="Örn: Serkan" />
    <div class="row">
      <div>
        <label>Tutar</label>
        <input id="debtAmt" inputmode="decimal" value="${existing?.amount ?? ""}" />
      </div>
      <div>
        <label>Vade</label>
        <input id="debtDue" type="date" value="${existing?.dueDate || ""}" />
      </div>
    </div>
    <div class="row">
      <div>
        <label>Güven seviyesi</label>
        <select id="debtConfPreset">
          ${["Kesin","Muhtemel","Şüpheli","Umutsuz"].map(x=>`<option ${confPreset===x?"selected":""}>${x}</option>`).join("")}
        </select>
      </div>
      <div>
        <label>Güven (0-100)</label>
        <input id="debtConf" inputmode="numeric" value="${existing?.confidence ?? 60}" />
      </div>
    </div>
    <label>Not</label>
    <textarea id="debtNote">${escapeHtml(existing?.note||"")}</textarea>
    <div class="mini">Not: “Kasaya girmeyen para senin değildir.” Bu yüzden alacaklar ayrı tutulur; sadece Expected/Risk-Adjusted kasaya yansır.</div>
  `, [
    btn("İptal", "btn", closeModal),
    btn("Kaydet", "btn primary", async ()=>{
      const preset = $("#debtConfPreset").value;
      const conf = clamp(parseInt($("#debtConf").value || confidencePresetToValue(preset),10) || confidencePresetToValue(preset), 0, 100);
      const v = {
        id: existing?.id || uid(),
        direction: $("#debtDir").value,
        status: $("#debtStatus").value,
        person: $("#debtPerson").value.trim(),
        amount: Math.abs(parseAmount($("#debtAmt").value)),
        currency: state.currency,
        dueDate: $("#debtDue").value || null,
        confidence: conf,
        note: $("#debtNote").value.trim(),
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      await idbPut("debts", v);
      closeModal();
      await render();
    })
  ]);

  $("#debtConfPreset").onchange = ()=>{
    $("#debtConf").value = confidencePresetToValue($("#debtConfPreset").value);
  };
}

async function markDebtClosed(id){
  const d = await idbGet("debts", id);
  if (!d) return;
  d.status = "closed";
  d.updatedAt = Date.now();
  await idbPut("debts", d);
  await render();
}

async function openTradeModal(id=null){
  const existing = id ? await idbGet("trades", id) : null;
  openModal(existing ? "Trade Düzenle" : "Trade Ekle", `
    <div class="row">
      <div>
        <label>Tarih</label>
        <input id="trdDate" type="date" value="${existing?.date || toISODate(new Date())}" />
      </div>
      <div>
        <label>Enstrüman</label>
        <input id="trdSym" value="${escapeHtml(existing?.symbol||"")}" placeholder="XAUUSD" />
      </div>
    </div>
    <div class="row">
      <div>
        <label>Yön</label>
        <select id="trdSide">
          ${["long","short"].map(x=>`<option ${existing?.side===x?"selected":""}>${x}</option>`).join("")}
        </select>
      </div>
      <div>
        <label>Sonuç</label>
        <select id="trdRes">
          ${["win","loss","be"].map(x=>`<option ${existing?.result===x?"selected":""}>${x}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="row">
      <div>
        <label>Entry</label>
        <input id="trdEntry" inputmode="decimal" value="${existing?.entry ?? ""}" />
      </div>
      <div>
        <label>Exit</label>
        <input id="trdExit" inputmode="decimal" value="${existing?.exit ?? ""}" />
      </div>
    </div>
    <div class="row">
      <div>
        <label>SL</label>
        <input id="trdSL" inputmode="decimal" value="${existing?.sl ?? ""}" />
      </div>
      <div>
        <label>TP</label>
        <input id="trdTP" inputmode="decimal" value="${existing?.tp ?? ""}" />
      </div>
    </div>
    <div class="row">
      <div>
        <label>Lot/Size</label>
        <input id="trdSize" inputmode="decimal" value="${existing?.size ?? ""}" />
      </div>
      <div>
        <label>R-multiple</label>
        <input id="trdR" inputmode="decimal" value="${existing?.rMultiple ?? ""}" placeholder="Örn: 1.5" />
      </div>
    </div>
    <label>Setup etiketi</label>
    <input id="trdTag" value="${escapeHtml(existing?.tag||"")}" placeholder="Örn: sweep+retest" />
    <label>Not</label>
    <textarea id="trdNote">${escapeHtml(existing?.note||"")}</textarea>
  `, [
    btn("İptal", "btn", closeModal),
    btn("Kaydet", "btn primary", async ()=>{
      const v = {
        id: existing?.id || uid(),
        date: $("#trdDate").value || toISODate(new Date()),
        symbol: $("#trdSym").value.trim().toUpperCase(),
        side: $("#trdSide").value,
        result: $("#trdRes").value,
        entry: parseAmount($("#trdEntry").value),
        exit: parseAmount($("#trdExit").value),
        sl: parseAmount($("#trdSL").value),
        tp: parseAmount($("#trdTP").value),
        size: parseAmount($("#trdSize").value),
        rMultiple: parseAmount($("#trdR").value),
        tag: $("#trdTag").value.trim(),
        note: $("#trdNote").value.trim(),
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      await idbPut("trades", v);
      closeModal();
      await render();
    })
  ]);
}

async function openGoalModal(id=null){
  const existing = id ? await idbGet("goals", id) : null;
  openModal(existing ? "Hedef Düzenle" : "Hedef Ekle", `
    <label>Hedef adı</label>
    <input id="gName" value="${escapeHtml(existing?.name||"")}" placeholder="Örn: 10k cash buffer" />
    <label>Tür</label>
    <select id="gType">
      ${[
        ["cashInBank","Bankada duran para (Banka hesapları toplamı)"],
        ["actualCash","Toplam kasa (tüm hesaplar)"],
        ["investments","Yatırım (portföy güncel değer)"],
        ["netWorth","Net Worth"],
        ["monthlyExpenseCap","Aylık gider limiti"]
      ].map(([v,l])=>`<option value="${v}" ${existing?.type===v?"selected":""}>${l}</option>`).join("")}
    </select>
    <div class="row">
      <div>
        <label>Hedef değer</label>
        <input id="gTarget" inputmode="decimal" value="${existing?.targetValue ?? ""}" />
      </div>
      <div>
        <label>Para birimi</label>
        <input id="gCur" value="${escapeHtml(existing?.currency||state.currency)}" />
      </div>
    </div>
    <div class="row">
      <div>
        <label>Başlangıç</label>
        <input id="gStart" type="date" value="${existing?.startDate || toISODate(new Date())}" />
      </div>
      <div>
        <label>Bitiş (opsiyon)</label>
        <input id="gEnd" type="date" value="${existing?.endDate || ""}" />
      </div>
    </div>
    <label>Açıklama</label>
    <textarea id="gDesc">${escapeHtml(existing?.description||"")}</textarea>
  `, [
    btn("İptal", "btn", closeModal),
    btn("Kaydet", "btn primary", async ()=>{
      const v = {
        id: existing?.id || uid(),
        name: $("#gName").value.trim(),
        type: $("#gType").value,
        targetValue: Math.abs(parseAmount($("#gTarget").value)),
        currency: $("#gCur").value.trim().toUpperCase() || state.currency,
        startDate: $("#gStart").value || toISODate(new Date()),
        endDate: $("#gEnd").value || null,
        description: $("#gDesc").value.trim(),
        status: "active",
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      await idbPut("goals", v);
      closeModal();
      await render();
    })
  ]);
}

async function openSnapshotModal(){
  const balances = await computeBalances();
  openModal("Snapshot Ekle", `
    <div class="mini">Snapshot, özellikle “manuel yatırım değeri” kullandığın için işe yarar. (Veri yoksa analiz de yok.)</div>
    <div style="height:10px"></div>
    <div class="row">
      <div>
        <label>Tarih</label>
        <input id="sDate" type="date" value="${toISODate(new Date())}" />
      </div>
      <div>
        <label>Net Worth</label>
        <input id="sNW" inputmode="decimal" value="${balances.netWorth.toFixed(2)}" />
      </div>
    </div>
    <div class="row">
      <div>
        <label>Kasa (Actual)</label>
        <input id="sCash" inputmode="decimal" value="${balances.actualCash.toFixed(2)}" />
      </div>
      <div>
        <label>Yatırım (Güncel)</label>
        <input id="sInv" inputmode="decimal" value="${balances.investmentsCurrent.toFixed(2)}" />
      </div>
    </div>
  `, [
    btn("İptal", "btn", closeModal),
    btn("Kaydet", "btn primary", async ()=>{
      const v = {
        id: uid(),
        date: $("#sDate").value || toISODate(new Date()),
        netWorth: parseAmount($("#sNW").value),
        cashTotal: parseAmount($("#sCash").value),
        investmentsValue: parseAmount($("#sInv").value),
        createdAt: Date.now()
      };
      await idbPut("snapshots", v);
      closeModal();
      await render();
    })
  ]);
}

async function openSettingsModal(){
  openModal("Yedek / Ayarlar", `
    <div class="row">
      <button class="btn block" id="btnExport">⬇️ Export (JSON)</button>
      <button class="btn block" id="btnImport">⬆️ Import (JSON)</button>
    </div>
    <div style="height:10px"></div>
    <div class="row">
      <button class="btn block" id="btnSetCur">💱 Ana Para Birimi</button>
      <button class="btn block danger" id="btnReset">🧨 Veriyi Sıfırla</button>
    </div>
    <hr>
    <div class="mini">
      Export al. Çünkü telefonlar ölümlü, insanlar daha da ölümlü.
    </div>
    <input type="file" id="importFile" accept="application/json" style="display:none" />
  `, [btn("Kapat", "btn", closeModal)]);

  $("#btnExport").onclick = async ()=>{
    const dump = await exportAll();
    downloadText(`ledgerzero-backup-${toISODate(new Date())}.json`, JSON.stringify(dump, null, 2));
  };
  $("#btnImport").onclick = ()=> $("#importFile").click();
  $("#importFile").onchange = async (e)=>{
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const data = JSON.parse(text);
    confirmDelete("Import tüm verinin üzerine yazar. Emin misin?", async ()=>{
      await importAll(data);
      closeModal();
      await render();
    }, "Evet, üzerine yaz");
  };
  $("#btnReset").onclick = ()=> confirmDelete("Tüm veriler silinecek. Emin misin?", async ()=>{
    await resetAll();
    closeModal();
    await render();
  }, "Evet, sil");

  $("#btnSetCur").onclick = async ()=>{
    openModal("Ana Para Birimi", `
      <label>Para birimi</label>
      <input id="baseCur" value="${escapeHtml(state.currency)}" placeholder="EUR" />
      <div class="mini">MVP: FX dönüşümü yok. Bu ayarı sadece gösterim için kullanıyoruz.</div>
    `, [
      btn("İptal", "btn", closeModal),
      btn("Kaydet", "btn primary", async ()=>{
        state.currency = $("#baseCur").value.trim().toUpperCase() || "EUR";
        await ensureCurrency();
        closeModal();
        await render();
      })
    ]);
  };
}

async function openDebtToTxHelp(){
  openModal("Tahsil/Ödeme Eşleştirme", `
    <div class="mini">
      Çifte sayım olmaması için iki seçenek:
      <ol>
        <li>Alacağı “Kapalı” yap ve ayrıca ilgili banka işlemine not ekle.</li>
        <li>İstersen manuel olarak “tahsilat/ödeme” işlemi ekleyip, borç/alacak kaydını kapat.</li>
      </ol>
      MVP’de otomatik eşleştirme yok. Çünkü önce veri düzeni otursun.
    </div>
  `, [btn("Kapat", "btn", closeModal)]);
}

// ---------- CSV Import ----------
async function openCsvImportModal(){
  const [accounts, cats] = await Promise.all([idbGetAll("accounts"), idbGetAll("categories")]);
  if (!accounts.length){
    alert("Önce hesap ekle.");
    return;
  }
  openModal("CSV Import (Banka)", `
    <div class="mini">CSV formatı her bankada farklı. Bu yüzden kolon eşleştirme var.</div>
    <div style="height:10px"></div>
    <input type="file" id="csvFile" accept=".csv,text/csv" />
    <div id="csvStage" style="margin-top:12px"></div>
  `, [btn("Kapat", "btn", closeModal)]);
  $("#csvFile").onchange = async (e)=>{
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const delim = detectDelimiter(text);
    const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
    const header = csvSplitLine(lines[0], delim);
    const sampleRows = lines.slice(1, 21).map(l=>csvSplitLine(l, delim));

    const colOptions = header.map((h,idx)=>`<option value="${idx}">${escapeHtml(h || ("Kolon "+(idx+1)))}</option>`).join("");
    const stage = $("#csvStage");
    stage.innerHTML = `
      <div class="card">
        <h2>Kolon Eşleştirme</h2>
        <div class="row">
          <div>
            <label>Tarih kolonu</label>
            <select id="mapDate">${colOptions}</select>
          </div>
          <div>
            <label>Açıklama kolonu</label>
            <select id="mapDesc">${colOptions}</select>
          </div>
        </div>
        <div class="row">
          <div>
            <label>Tutar kolonu</label>
            <select id="mapAmt">${colOptions}</select>
          </div>
          <div>
            <label>Para birimi kolonu (opsiyon)</label>
            <select id="mapCur"><option value="-1">Yok</option>${colOptions}</select>
          </div>
        </div>
        <div class="row">
          <div>
            <label>Hesap</label>
            <select id="mapAcc">
              ${accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.name)} (${a.type})</option>`).join("")}
            </select>
          </div>
          <div>
            <label>Varsayılan kategori</label>
            <select id="mapCat">
              ${cats.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
            </select>
          </div>
        </div>
        <label>Önizleme (ilk 10 satır)</label>
        <div style="overflow:auto; border:1px solid var(--line); border-radius:16px">
          <table class="table">
            <thead><tr>${header.slice(0,10).map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
            <tbody>
              ${sampleRows.slice(0,10).map(r=>`<tr>${r.slice(0,10).map(c=>`<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div style="height:12px"></div>
        <button class="btn primary block" id="btnDoImport">İçe Aktar</button>
        <div class="mini" id="importResult" style="margin-top:10px"></div>
      </div>
    `;

    // Guess mapping by header keywords
    const guess = (keys) => {
      const idx = header.findIndex(h=>{
        const t = (h||"").toLowerCase();
        return keys.some(k=>t.includes(k));
      });
      return idx >= 0 ? idx : 0;
    };
    $("#mapDate").value = guess(["date","tarih","datum"]);
    $("#mapDesc").value = guess(["desc","açıkl","omschrijving","name","label"]);
    $("#mapAmt").value = guess(["amount","tutar","bedrag","value","debit","credit"]);
    const curGuess = header.findIndex(h=> (h||"").toLowerCase().includes("curr") || (h||"").toLowerCase().includes("para"));
    if (curGuess >= 0) $("#mapCur").value = curGuess;

    $("#btnDoImport").onclick = async ()=>{
      const iDate = Number($("#mapDate").value);
      const iDesc = Number($("#mapDesc").value);
      const iAmt  = Number($("#mapAmt").value);
      const iCur  = Number($("#mapCur").value);
      const accId = $("#mapAcc").value;
      const catId = $("#mapCat").value;

      let added = 0, skipped = 0, bad = 0;
      const existingHashes = new Set((await idbGetAll("transactions")).map(t=>t.hash).filter(Boolean));

      for (const row of lines.slice(1)){
        const cols = csvSplitLine(row, delim);
        const date = parseDateLoose(cols[iDate]);
        const desc = (cols[iDesc] || "").trim();
        const amt = parseAmount(cols[iAmt]);
        if (!date || !desc && !amt){
          bad++;
          continue;
        }
        const cur = iCur >= 0 ? (cols[iCur]||state.currency).trim().toUpperCase() : state.currency;

        const hash = await hashString(`${date}|${amt}|${desc}|${accId}|${catId}|csv`);
        if (existingHashes.has(hash)){
          skipped++;
          continue;
        }
        const tx = {
          id: uid(),
          type: "normal",
          date,
          accountId: accId,
          categoryId: catId,
          description: desc,
          amount: amt,
          currency: cur,
          hash,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        await idbPut("transactions", tx);
        existingHashes.add(hash);
        added++;
      }

      $("#importResult").textContent = `Bitti: ${added} eklendi • ${skipped} duplicate • ${bad} hatalı satır.`;
      await render();
    };
  };
}

// ---------- Export/Import/Reset ----------
async function exportAll(){
  const stores = ["accounts","transactions","categories","instruments","positions","debts","trades","goals","snapshots","meta"];
  const out = {};
  for (const s of stores) out[s] = await idbGetAll(s);
  out._exportedAt = new Date().toISOString();
  out._version = DB_VERSION;
  return out;
}
async function importAll(data){
  const stores = ["accounts","transactions","categories","instruments","positions","debts","trades","goals","snapshots","meta"];
  for (const s of stores){
    await idbClear(s);
    const arr = data[s] || [];
    for (const item of arr){
      await idbPut(s, item);
    }
  }
  await loadCurrency();
}
async function resetAll(){
  const stores = ["accounts","transactions","categories","instruments","positions","debts","trades","goals","snapshots","meta"];
  for (const s of stores) await idbClear(s);
  await seedIfNeeded();
  await loadCurrency();
}

// ---------- Confirm delete ----------
function confirmDelete(message, onYes, yesText="Sil"){
  openModal("Onay", `<div>${escapeHtml(message)}</div>`, [
    btn("Vazgeç", "btn", closeModal),
    btn(yesText, "btn danger", async ()=>{ await onYes(); closeModal(); })
  ]);
}

// ---------- Hash ----------
async function hashString(str){
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = Array.from(new Uint8Array(buf));
  return bytes.map(b=>b.toString(16).padStart(2,"0")).join("");
}

// ---------- Navigation ----------
function setTab(tab){
  state.tab = tab;
  $$(".nav button").forEach(b=>b.classList.toggle("active", b.dataset.tab===tab));
  render();
}
$$(".nav button").forEach(b=>{
  b.addEventListener("click", ()=> setTab(b.dataset.tab));
});

// ---------- Init ----------
(async function init(){
  await openDB();
  await seedIfNeeded();
  await loadCurrency();
  await registerSW();
  await render();
})();
