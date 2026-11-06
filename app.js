'use strict';
// STR Rapoarte pe telefon: citește fișele direct din depozitul GitHub (cel în care urcă SSD-urile), fără PC.
// Cheia de citire stă în cheie.json, criptată cu parola aplicației (PBKDF2 + AES-GCM); parola se scrie o dată pe telefon.
// Fișele aduse se țin pe telefon (IndexedDB): se descarcă doar ce s-a schimbat, iar lista merge și fără semnal.
// Doar citire: aplicația de pe telefon nu poate schimba nimic pe GitHub (și cheia e oricum doar de citire).
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fara = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad = n => String(n).padStart(2, '0');
const TIP = { laptop: { i: '💻', t: 'Laptop', p: 'Laptopuri' }, pc: { i: '🖥️', t: 'Unitate PC', p: 'Unități PC' }, monitor: { i: '🖵', t: 'Monitor', p: 'Monitoare' } };
const RE_FISA = /^([^/]+)\/(Rapoarte|Arhiva rapoarte vechi)\/(?:.*\/)?([^/]+\.(?:html?|txt))$/i;
const RE_VECHI = /\(inlocuit [^)]*\)/i;          // variantă veche (înlocuită) a unei fișe, urcată de SSD
// testele șterse definitiv în aplicația de pe PC: fiecare PC pune lista lor în .str-comun/definitiv/<pc>.json (nu se
// arată nici aici). Cheia unui test e aceeași ca în aplicația de pe PC (biblioteca.js, construieste: kt): codul de pe
// fișă, nr., data de pe fișă, rezultatul, seria (a testului sau a fișei).
const RE_DEF = /^\.str-comun\/definitiv\/(pc-[0-9a-f]{8})\.json$/;
const cheieCod = c => String(c || '').trim().replace(/\s+/g, ' ').toLowerCase();
function ktTest(meta, t) {
  const id0 = meta.teste.find(x => x.marca || x.model || x.serie) || {};
  return [cheieCod(meta.cod || t.codEticheta), t.nr, t.dataKey, t.rezultat, fara(t.serie || id0.serie || '')].join('|');
}
// un test din lista celor șterse definitiv (aceeași cheie ca pe PC): nu se arată (incarca)
const esteSters = (sterse, meta, t) => sterse.size > 0 && sterse.has(ktTest(meta, t));
const PARSER_V = 1;                                // crește când se schimbă felul în care se citesc fișele

// ---------- memoria telefonului ----------
const mem = {
  get(k) { try { return JSON.parse(localStorage.getItem('str-tel-' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('str-tel-' + k, JSON.stringify(v)); } catch { /* fără memorie */ } },
  del(k) { try { localStorage.removeItem('str-tel-' + k); sessionStorage.removeItem('str-tel-' + k); } catch { /* nimic */ } },
};
const db = {
  _p: null,
  open() {
    return this._p ||= new Promise((res, rej) => {
      const r = indexedDB.open('str-rapoarte', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fise', { keyPath: 'path' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async tx(mod, fn) {
    const d = await this.open();
    return new Promise((res, rej) => { const t = d.transaction('fise', mod), s = t.objectStore('fise'); const out = fn(s); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); });
  },
  toate() { return this.tx('readonly', s => s.getAll()); },
  pune(o) { return this.tx('readwrite', s => { s.put(o); }); },
  goleste() { return this.tx('readwrite', s => { s.clear(); }); },
};

// ---------- cheia (criptată cu parola aplicației) ----------
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
let CFG = null, TOKEN = null;
async function deblocheaza(parola) {
  const k = await (await fetch('cheie.json', { cache: 'no-store' })).json();
  const baza = await crypto.subtle.importKey('raw', new TextEncoder().encode(parola), 'PBKDF2', false, ['deriveKey']);
  const cheie = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(k.salt), iterations: k.iter, hash: 'SHA-256' }, baza, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let clar;
  try { clar = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(k.iv) }, cheie, b64(k.data)); } catch { throw new Error('Parolă greșită.'); }
  const o = JSON.parse(new TextDecoder().decode(clar));
  return { repo: k.repo, ramura: k.ramura || 'main', api: k.api || 'https://api.github.com', token: o.token };
}

// ---------- GitHub ----------
async function gh(cale, accept) {
  let r;
  try { r = await fetch(CFG.api + cale, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store' }); }
  catch { throw new Error('fără internet (lista de pe telefon rămâne)'); }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('cheia GitHub nu mai merge (expirată?) — spune-i administratorului'), { cheie: true });
  if (r.status === 404) throw new Error('nu găsesc depozitul cu rapoarte');
  if (!r.ok) throw new Error('GitHub a răspuns ' + r.status);
  return r;
}
let lucreaza = false;
async function sincronizeaza(manual) {
  if (lucreaza || !TOKEN) return;
  lucreaza = true; $('#btnSync').classList.add('lucru');
  try {
    stare('Verific GitHub…');
    const arbore = await (await gh(`/repos/${CFG.repo}/git/trees/${encodeURIComponent(CFG.ramura)}?recursive=1`, 'application/vnd.github+json')).json();
    // întâi lista celor șterse definitiv (câte un fișier mic de la fiecare PC; se aduce doar când s-a schimbat): o
    // sincronizare întreruptă la fișe nu lasă pe telefon fișe noi fără lista lor
    const def = (arbore.tree || []).filter(e => e.type === 'blob' && RE_DEF.test(e.path) && !(e.size > 2e6));
    const sterse = mem.get('sterse') || {}, shaNou = Object.fromEntries(def.map(e => [e.path, e.sha]));
    let alteSterse = false, listaIntreaga = true;
    if (JSON.stringify(shaNou) !== JSON.stringify(sterse.sha || {})) {
      const kt = new Set();
      for (const e of def) {
        try {
          const j = await (await gh(`/repos/${CFG.repo}/git/blobs/${e.sha}`, 'application/vnd.github.raw+json')).json();
          if (j?.v !== 1 || j.pc !== RE_DEF.exec(e.path)[1]) continue;
          for (const x of Array.isArray(j.kt) ? j.kt : []) if (typeof x === 'string' && x.length < 400) kt.add(x);
        } catch (x) { if (x.cheie || /internet/.test(x.message)) throw x; listaIntreaga = false; }
      }
      // (un fișier care n-a putut fi citit: se încearcă din nou la sincronizarea următoare; până atunci rămân și cele știute)
      mem.set('sterse', { sha: listaIntreaga ? shaNou : {}, kt: listaIntreaga ? [...kt] : [...new Set([...(sterse.kt || []), ...kt])] });
      alteSterse = true;
      await incarca();
    }
    const avem = new Map((await db.toate()).map(f => [f.path, f]));
    const deAdus = (arbore.tree || []).filter(e => e.type === 'blob' && RE_FISA.test(e.path) && !e.path.split('/').some(p => p.startsWith('.'))
      && (avem.get(e.path)?.sha !== e.sha || avem.get(e.path)?.v !== PARSER_V));
    let gata = 0, erori = 0;
    const unu = async e => {
      try {
        const buf = await (await gh(`/repos/${CFG.repo}/git/blobs/${e.sha}`, 'application/vnd.github.raw+json')).arrayBuffer();
        const txt = new TextDecoder('utf-8').decode(buf), [, ssd, zonaDir, nume] = RE_FISA.exec(e.path);
        const meta = /\.txt$/i.test(nume) ? STRFisa.citesteFisaText(txt, nume) : STRFisa.citesteFisa(txt, nume);
        await db.pune({ path: e.path, sha: e.sha, v: PARSER_V, ssd, zona: /^arhiva/i.test(zonaDir) ? 'arhiva' : 'activ', vechi: RE_VECHI.test(nume), nume,
          meta: meta ? usuca(meta) : null, html: /\.html?$/i.test(nume) ? txt : null });
      } catch (x) { erori++; if (x.cheie || /internet/.test(x.message)) throw x; }
      gata++; stare(`Aduc fișele: ${gata} din ${deAdus.length}`, gata / deAdus.length);
    };
    for (let i = 0; i < deAdus.length; i += 4) await Promise.all(deAdus.slice(i, i + 4).map(unu));
    mem.set('ultimaSync', Date.now());
    if (deAdus.length) await incarca();
    stare(null);
    const faraLista = listaIntreaga ? '' : ' ⚠ Lista rapoartelor șterse pe PC n-a putut fi citită toată: reîncerc la sincronizarea următoare.';
    if (manual || deAdus.length || !listaIntreaga) toast(deAdus.length ? `✔ ${deAdus.length - erori} ${deAdus.length - erori === 1 ? 'fișă adusă' : 'fișe aduse'}${erori ? `, ${erori} nu s-au putut citi` : ''}.${faraLista}`
      : !listaIntreaga ? faraLista.trim() : alteSterse ? '✔ Lista rapoartelor șterse de pe PC e la zi.' : '✔ Nimic nou pe GitHub.', listaIntreaga ? 4000 : 7000);
  } catch (e) {
    stare(null, e.message); if (manual || e.cheie) toast('⚠ ' + esc(e.message), 7000);
  } finally { lucreaza = false; $('#btnSync').classList.remove('lucru'); }
}
// din fișă se păstrează doar ce trebuie pe telefon (fără textul întreg al fiecărui test)
function usuca(m) {
  return { cod: m.cod, tip: m.tip, teste: m.teste.map(t => ({ nr: t.nr, principal: t.principal, data: t.data, dataKey: t.dataKey, tip: t.tip, marca: t.marca, model: t.model,
    serie: t.serie, codEticheta: t.codEticheta, categorie: t.categorie, tehnician: t.tehnician || '', ssd: t.ssd || '', etapa1: t.etapa1, motivRespingere: t.motivRespingere,
    rezultat: t.rezultat, nefunctionale: t.nefunctionale, testeProgram: t.testeProgram, destinatie: t.destinatie, deFacut: t.deFacut,
    functii: t.functii, vizual: t.vizual, configuratie: t.configuratie, retestare: t.retestare,
    cauta: fara([t.marca, t.model, t.serie, t.nefunctionale, t.deFacut, t.destinatie, t.motivRespingere, t.tehnician, ...Object.values(t.configuratie || {})].join(' ')) })) };
}

// ---------- rândurile (un rând = un test) ----------
const S = { randuri: [], fise: new Map(), vedere: 'fise', arata: 100,
  f: Object.assign({ cauta: '', tip: '', rez: '', per: 'tot', ssd: '', ultim: true, arhiva: false }, mem.get('filtre') || {}) };
async function incarca() {
  const toate = await db.toate(), unice = new Map();
  // o dată din viitor sau de dinainte de 2015 vine de la ceasul greșit al aparatului: „fără dată” (ca pe PC, fără data fișierului)
  const m = new Date(Date.now() + 2 * 86400000), maxKey = +(m.getFullYear() + pad(m.getMonth() + 1) + pad(m.getDate()) + '2359'), minKey = 201501010000;
  const bunaData = k => k && k >= minKey && k <= maxKey ? k : 0;
  S.fise = new Map(toate.map(f => [f.path, f]));
  const sterse = new Set((mem.get('sterse') || {}).kt || []);     // șterse definitiv pe PC: nu se arată
  for (const f of toate) {
    if (!f.meta || f.vechi) continue;
    const cod = String(f.meta.cod || '').trim().replace(/\s*#+$/, '');   // fără „#”-ul pus de scanner: același aparat ca fără el
    for (const t of f.meta.teste) {
      if (esteSters(sterse, f.meta, t)) continue;
      const k = [f.zona, fara(cod), t.nr, t.dataKey, t.rezultat, fara(t.serie)].join('|');
      const r = unice.get(k);
      if (r) { if (!r.surse.includes(f.ssd)) r.surse.push(f.ssd); if (t.principal && !r.principal) Object.assign(r, { t, path: f.path, principal: true }); continue; }
      unice.set(k, { id: k, cod, codN: fara(cod), zona: f.zona, t, path: f.path, principal: t.principal, surse: [f.ssd], tip: t.tip || f.meta.tip || 'laptop',
        dataKey: bunaData(t.dataKey), dataGresita: t.dataKey && !bunaData(t.dataKey) ? t.data : '', cauta: fara(cod) + ' ' + t.cauta });
    }
  }
  S.randuri = [...unice.values()].sort((a, b) => b.dataKey - a.dataKey || b.t.nr - a.t.nr);
  const pe = new Map();
  for (const r of S.randuri) { const k = r.zona + '|' + r.codN; pe.set(k, (pe.get(k) || 0) + 1); }
  for (const r of S.randuri) r.nrTeste = pe.get(r.zona + '|' + r.codN);
  const ssd = [...new Set(toate.map(f => f.ssd))].sort((a, b) => a.localeCompare(b, 'ro', { numeric: true }));
  $('#fSsd').innerHTML = '<option value="">Toate SSD-urile</option>' + ssd.map(s => `<option${s === S.f.ssd ? ' selected' : ''}>${esc(s)}</option>`).join('');
  randeaza();
}
function perioada(p) {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const k = d => +(d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()));
  if (p === 'azi') return [k(a), k(a)];
  if (p === '7z') return [k(new Date(a.getFullYear(), a.getMonth(), a.getDate() - 6)), k(a)];
  if (p === 'luna') return [k(new Date(a.getFullYear(), a.getMonth(), 1)), k(a)];
  if (p === 'lunaTrecuta') return [k(new Date(a.getFullYear(), a.getMonth() - 1, 1)), k(new Date(a.getFullYear(), a.getMonth(), 0))];
  if (p === 'an') return [k(new Date(a.getFullYear(), 0, 1)), k(a)];
  return [0, 0];
}
function filtrate(ignoraRez) {
  const f = S.f, [de, pana] = perioada(f.per), cuv = fara(f.cauta).split(/\s+/).filter(Boolean);
  let rs = S.randuri.filter(r => r.zona === (f.arhiva ? 'arhiva' : 'activ') && (!f.ssd || r.surse.includes(f.ssd))
    && (!de || (Math.floor(r.dataKey / 1e4) >= de && Math.floor(r.dataKey / 1e4) <= pana)));
  if (f.ultim) {
    const best = new Map();
    for (const r of rs) { const b = best.get(r.codN); if (!b || r.dataKey > b.dataKey || (r.dataKey === b.dataKey && r.t.nr > b.t.nr)) best.set(r.codN, r); }
    rs = [...best.values()].sort((a, b) => b.dataKey - a.dataKey || b.t.nr - a.t.nr);
  }
  return rs.filter(r => (!f.tip || r.tip === f.tip) && (ignoraRez || !f.rez || (f.rez === '-' ? !r.t.rezultat : r.t.rezultat === f.rez))
    && cuv.every(w => r.cauta.includes(w)));
}
const kData = k => { const s = String(k); return `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}`; };
const kOra = k => { const s = String(k); return s.slice(8) === '0000' ? '' : `${s.slice(8, 10)}:${s.slice(10, 12)}`; };
const badge = r => r === 'EEER' ? '<span class="badge b-ok">✓ EEER</span>' : r === 'RESPINS' ? '<span class="badge b-bad">✗ RESPINS</span>' : '<span class="badge b-na">fără rezultat</span>';

// ---------- desenarea ----------
function randeaza() {
  if (S.vedere === 'fise') randeazaLista(); else if (S.vedere === 'totaluri') randeazaTotaluri(); else if (S.vedere === 'setari') randeazaSetari();
}
function randeazaLista() {
  const rs = filtrate(), e = rs.filter(r => r.t.rezultat === 'EEER').length, x = rs.filter(r => r.t.rezultat === 'RESPINS').length;
  $('#sumar').innerHTML = `<b>${rs.length}</b> ${S.f.ultim ? (rs.length === 1 ? 'aparat' : 'aparate') : (rs.length === 1 ? 'test' : 'teste')} ${badge('EEER')} ${e} ${badge('RESPINS')} ${x}`;
  const vazute = rs.slice(0, S.arata);
  $('#lista').innerHTML = vazute.map(r => {
    const t = r.t, tip = TIP[r.tip] || TIP.laptop;
    return `<button class="fisa" data-id="${esc(r.id)}"><div class="sus"><span class="cod">${tip.i} ${esc(r.cod || '—')}</span>
      <span class="data">${r.dataKey ? kData(r.dataKey) + (kOra(r.dataKey) ? ' ' + kOra(r.dataKey) : '') : '<span class="aprox">fără dată</span>'}</span></div>
      <div class="ap">${esc([t.marca, t.model].filter(Boolean).join(' · ') || '—')}</div>
      ${t.nefunctionale ? `<div class="defect">✘ ${esc(t.nefunctionale)}</div>` : ''}${t.deFacut ? `<div class="defacut">🔧 ${esc(t.deFacut)}</div>` : ''}
      <div class="jos">${badge(t.rezultat)}<span>${esc(r.surse.join(', '))}</span>${t.tehnician ? `<span>👤 ${esc(t.tehnician)}</span>` : ''}${r.nrTeste > 1 ? `<span>Test ${t.nr} din ${r.nrTeste}</span>` : ''}</div></button>`;
  }).join('') || `<div class="gol">${S.randuri.length ? 'Nicio fișă pentru filtrele alese.' : TOKEN ? 'Încă nicio fișă. Apasă ⟳ ca să le aduci de pe GitHub.' : ''}</div>`;
  $('#maiMult').hidden = rs.length <= S.arata;
}
function detalii(id) {
  const r = S.randuri.find(x => x.id === id);
  if (!r) return;
  const t = r.t, tip = TIP[r.tip] || TIP.laptop, kv = o => Object.entries(o || {}).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const istoric = S.randuri.filter(x => x.codN === r.codN && x.zona === r.zona).sort((a, b) => b.dataKey - a.dataKey || b.t.nr - a.t.nr);
  const el = $('#detalii');
  el.innerHTML = `<div class="foaie-sus"><button class="btn" id="detInchide">✕</button><span>${tip.i} ${esc(r.cod)}</span></div><div class="corp">
    <div class="card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center">${badge(t.rezultat)}
      <span>Test ${t.nr}${r.nrTeste > 1 ? ` din ${r.nrTeste}` : ''} · ${r.dataKey ? kData(r.dataKey) + (kOra(r.dataKey) ? ', ora ' + kOra(r.dataKey) : '') : 'fără dată'}</span></div>
      <div style="margin-top:6px">${esc([t.marca, t.model].filter(Boolean).join(' · ') || '—')}${t.serie ? ` · serie <b>${esc(t.serie)}</b>` : ''}</div>
      ${r.dataGresita ? `<div class="caseta c-galben" style="margin-top:8px">⚠ Pe fișă scrie ${esc(r.dataGresita)}: dată greșită, de la ceasul aparatului.</div>` : !r.dataKey ? '<div class="caseta c-galben" style="margin-top:8px">⚠ Fișa nu are dată (aparatul n-a avut internet).</div>' : ''}
      <div class="mic" style="margin-top:4px;display:block">de pe ${esc(r.surse.join(', '))}${r.zona === 'arhiva' ? ' · arhivă' : ''}</div>
      <button class="btn prim" id="detOriginal" style="margin-top:10px"${S.fise.get(r.path)?.html ? '' : ' disabled'}>📄 Fișa originală</button></div>
    <h3>Ce nu merge</h3>${t.nefunctionale ? `<div class="caseta c-rosu">✘ ${esc(t.nefunctionale)}</div>` : '<div class="caseta c-verde">Nicio funcție nefuncțională.</div>'}
    ${t.deFacut ? `<h3>🔧 De făcut</h3><div class="caseta c-galben">${esc(t.deFacut)}</div>` : ''}
    <h3>Rezultat</h3><table class="kv">
      <tr><th>Rezultat final</th><td>${badge(t.rezultat)}</td></tr>
      <tr><th>Inspecție vizuală</th><td>${esc(t.etapa1 || '—')}${t.motivRespingere ? ' — ' + esc(t.motivRespingere) : ''}</td></tr>
      <tr><th>Teste program</th><td>${esc(t.testeProgram || '—')}</td></tr>
      <tr><th>Destinație</th><td>${esc(t.destinatie || 'nealeasă')}</td></tr>
      <tr><th>Tehnician</th><td>${esc(t.tehnician || '—')}</td></tr></table>
    ${t.retestare ? `<h3>🔁 Retestare față de Test ${t.retestare.fataDe || ''}</h3><div class="card">${t.retestare.randuri.map(x => `<div class="functie"><span>${esc(x.ce)}</span><span>${esc(x.inainte)} → ${esc(x.acum)}</span></div>`).join('')}<p class="mic" style="display:block">${esc(t.retestare.sumar)}</p></div>` : ''}
    <h3>Funcții testate (${t.functii.length})</h3><div class="card" style="padding:0">${[...t.functii.filter(f => f.v === 'bad'), ...t.functii.filter(f => f.v !== 'bad')].map(f =>
      `<div class="functie"><span>${esc(f.nume)}</span><span class="${f.v === 'ok' ? 'v-ok' : f.v === 'bad' ? 'v-bad' : 'v-na'}">${f.v === 'ok' ? '✔' : f.v === 'bad' ? '✘' : f.v === 'skip' ? 'sărit' : '—'}</span></div>`).join('') || '<div class="functie">—</div>'}</div>
    <h3>Configurație</h3><table class="kv">${kv(t.configuratie) || '<tr><td>—</td></tr>'}</table>
    ${istoric.length > 1 ? `<h3>Istoricul aparatului (${istoric.length})</h3>${istoric.map(x => `<button class="fisa" data-id="${esc(x.id)}">${x.id === r.id ? '▶ ' : ''}Test ${x.t.nr} · ${x.dataKey ? kData(x.dataKey) : 'fără dată'} ${badge(x.t.rezultat)}</button>`).join('')}` : ''}
  </div>`;
  el.hidden = false; el.scrollTop = 0;
  history.pushState({ foaie: 'detalii' }, '');
  $('#detInchide').onclick = () => history.back();
  $('#detOriginal').onclick = () => original(r);
  el.querySelectorAll('[data-id]').forEach(b => { b.onclick = () => { history.back(); setTimeout(() => detalii(b.dataset.id), 50); }; });
}
function original(r) {
  const f = S.fise.get(r.path);
  if (!f?.html) return;
  // fără scripturi (sandbox fără allow-scripts + CSP): doar se afișează
  $('#origCadru').srcdoc = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; connect-src 'none'"><meta name="viewport" content="width=device-width, initial-scale=1">` + f.html;
  $('#origTitlu').textContent = r.cod;
  $('#original').hidden = false;
  history.pushState({ foaie: 'original' }, '');
}
$('#origInchide').onclick = () => history.back();
addEventListener('popstate', () => {
  if (!$('#original').hidden) { $('#original').hidden = true; $('#origCadru').srcdoc = ''; return; }
  if (!$('#detalii').hidden) $('#detalii').hidden = true;
});

function randeazaTotaluri() {
  const rs = filtrate(true), num = (k, rows = rs) => { const m = new Map(); for (const r of rows) { const v = k(r) || '—'; const o = m.get(v) || { n: 0, e: 0, x: 0 }; o.n++; if (r.t.rezultat === 'EEER') o.e++; if (r.t.rezultat === 'RESPINS') o.x++; m.set(v, o); } return [...m].sort((a, b) => b[1].n - a[1].n); };
  const bloc = (titlu, date) => { const max = Math.max(1, ...date.map(([, o]) => o.n)); return `<h3>${titlu}</h3><div class="card"><table class="tot">${date.map(([k, o]) => `<tr><td>${esc(k)}<span class="bara-mica" style="width:${Math.round(100 * o.n / max)}%"></span></td><td class="n">${o.n}</td><td class="n v-ok">${o.e}</td><td class="n v-bad">${o.x}</td></tr>`).join('') || '<tr><td>—</td></tr>'}</table></div>`; };
  const per = $('#fPer').selectedOptions[0]?.textContent || '';
  $('#v-totaluri').innerHTML = `<div class="sumar"><b>${esc(per)}</b><span>${S.f.ultim ? 'fiecare aparat o dată (ultimul test)' : 'toate testele'}${S.f.ssd ? ' · ' + esc(S.f.ssd) : ''}</span></div>
    <div class="carduri"><div class="card"><div class="v">${rs.length}</div><div class="t">${S.f.ultim ? 'aparate' : 'teste'}</div></div>
      <div class="card"><div class="v v-ok">${rs.filter(r => r.t.rezultat === 'EEER').length}</div><div class="t">EEER</div></div>
      <div class="card"><div class="v v-bad">${rs.filter(r => r.t.rezultat === 'RESPINS').length}</div><div class="t">RESPINS</div></div>
      <div class="card"><div class="v">${rs.filter(r => !r.t.rezultat).length}</div><div class="t">fără rezultat</div></div></div>
    <p class="mic" style="display:block;margin:8px 2px">Coloane: total · EEER · RESPINS. Filtrele (perioadă, SSD, tip, căutare) sunt cele din „Fișe”.</p>
    ${bloc('Pe tipuri', num(r => TIP[r.tip]?.p))}${bloc('Pe SSD-uri', num(r => r.surse.join(', ')))}${bloc('Pe cine a testat', num(r => r.t.tehnician))}
    ${bloc('Pe destinații', num(r => r.t.destinatie))}${bloc('Pe mărci', num(r => r.t.marca))}`;
}
function randeazaSetari() {
  const u = mem.get('ultimaSync');
  $('#v-setari').innerHTML = `<div class="card"><h3 style="margin-top:0">Rapoartele</h3>
      <p>Din depozitul GitHub <b>${esc(CFG?.repo || '—')}</b>, unde urcă SSD-urile. Doar citire: de aici nu se poate schimba nimic.</p>
      <p class="mic" style="display:block">Ultima verificare: ${u ? new Date(u).toLocaleString('ro-RO') : '—'} · ${S.fise.size} fișiere pe telefon · ${S.randuri.length} teste</p>
      <button class="btn lat" id="sAdu">⟳ Adu acum</button>
      <button class="btn lat" id="sGol">Șterge fișele de pe telefon (le aduce din nou)</button></div>
    <div class="card"><h3 style="margin-top:0">Ieșire</h3><p class="mic" style="display:block">Telefonul uită parola și cheia; la intrare se cere iar parola.</p>
      <button class="btn lat" id="sIesi">Ieșire de pe telefonul ăsta</button></div>
    <p class="mic" style="display:block;text-align:center">STR Rapoarte pentru telefon · fișele, căutarea și totalurile. Conturile, ștergerile și comenzile SSD sunt în aplicația de pe PC.</p>`;
  $('#sAdu').onclick = () => sincronizeaza(true);
  $('#sGol').onclick = async () => { if (!confirm('Ștergi fișele de pe telefon? Se aduc din nou de pe GitHub.')) return; await db.goleste(); await incarca(); sincronizeaza(true); };
  $('#sIesi').onclick = async () => { if (!confirm('Ieși? Telefonul uită parola; fișele de pe telefon se șterg.')) return; mem.del('cheie'); mem.del('sterse'); await db.goleste(); location.reload(); };
}

// ---------- legături ----------
let toastT;
function toast(t, ms = 4000) { const e = $('#toast'); e.innerHTML = t; e.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { e.hidden = true; }, ms); }
function stare(text, frac) {
  const el = $('#stare');
  if (text) { el.innerHTML = esc(text) + (frac != null ? `<span class="progres"><i style="width:${Math.round(frac * 100)}%"></i></span>` : ''); return; }
  const u = mem.get('ultimaSync');
  el.textContent = (frac ? '⚠ ' + frac + ' · ' : '') + (u ? `actualizat ${cand(u)}` : 'neactualizat');
}
const cand = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'acum' : m < 60 ? `acum ${m} min` : new Date(ms).toLocaleString('ro-RO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
const salveazaFiltre = () => mem.set('filtre', S.f);
function schimbat() { S.arata = 100; salveazaFiltre(); randeaza(); }
function umpleFiltre() {
  $('#fCauta').value = S.f.cauta; $('#fPer').value = S.f.per; $('#fUltim').checked = S.f.ultim; $('#fArhiva').checked = S.f.arhiva;
  for (const [id, k] of [['#fTip', 'tip'], ['#fRez', 'rez']]) $$(id + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === S.f[k]));
}
let tCauta;
$('#fCauta').addEventListener('input', e => { S.f.cauta = e.target.value; clearTimeout(tCauta); tCauta = setTimeout(schimbat, 200); });
for (const [id, k] of [['#fTip', 'tip'], ['#fRez', 'rez']]) $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.f[k] = b.dataset.v; umpleFiltre(); schimbat(); });
$('#fPer').onchange = e => { S.f.per = e.target.value; schimbat(); };
$('#fSsd').onchange = e => { S.f.ssd = e.target.value; schimbat(); };
$('#fUltim').onchange = e => { S.f.ultim = e.target.checked; schimbat(); };
$('#fArhiva').onchange = e => { S.f.arhiva = e.target.checked; schimbat(); };
$('#maiMult').onclick = () => { S.arata += 100; randeazaLista(); };
$('#lista').addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) detalii(b.dataset.id); });
$('#btnSync').onclick = () => sincronizeaza(true);
$('#nav').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.vedere = b.dataset.v;
  $$('#nav button').forEach(x => x.classList.toggle('on', x === b));
  for (const v of ['fise', 'totaluri', 'setari']) $('#v-' + v).hidden = v !== S.vedere;
  randeaza(); scrollTo(0, 0);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && TOKEN && Date.now() - (mem.get('ultimaSync') || 0) > 120000) sincronizeaza(); });

// ---------- pornire ----------
async function intra(cfg) {
  CFG = cfg; TOKEN = cfg.token;
  $('#v-intrare').hidden = true; $('#v-fise').hidden = false; $('#nav').hidden = false; $('#btnSync').hidden = false;
  umpleFiltre();
  await incarca();
  stare(null);
  sincronizeaza();
  setInterval(() => { if (!document.hidden) sincronizeaza(); }, 5 * 60000);
}
(async function porneste() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  let tinut = mem.get('cheie');
  try { tinut ||= JSON.parse(sessionStorage.getItem('str-tel-cheie')); } catch { /* nimic */ }
  if (tinut?.token) return intra(tinut);
  $('#v-intrare').hidden = false; $('#btnSync').hidden = true;
  $('#fIntrare').onsubmit = async ev => {
    ev.preventDefault();
    $('#iEroare').textContent = 'Verific…';
    try {
      const cfg = await deblocheaza($('#iParola').value);
      if ($('#iTine').checked) mem.set('cheie', cfg); else sessionStorage.setItem('str-tel-cheie', JSON.stringify(cfg));
      $('#iParola').value = ''; $('#iEroare').textContent = '';
      intra(cfg);
    } catch (e) { $('#iEroare').textContent = e.message === 'Parolă greșită.' ? 'Parolă greșită.' : 'Nu pot deschide cheia: ' + e.message; }
  };
})();
