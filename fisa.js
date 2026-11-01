// copiat automat din app\fisa.js de fa-telefon.js — nu se schimbă aici
(function () {
'use strict';
// Citește o fișă de testare F-TEST-04 (.html scrisă de programul de test pe partiția DATE), la fel ca prevTests() și
// testResults() din Demo/index.html, dar fără browser: fișele au mereu aceeași structură (titlu h2 + câte un tabel).
//  - primul rând: <!-- RAPORT NR. <cod> — TEST <LAPTOP|UNITATE PC|MONITOR> -->
//  - fișele cu retestare: câte un <section class="str-test" data-nr="N" data-data="..."> pe test (până la 31.10.2026
//    „aff-test”), testul de acum primul, cele de dinainte dedesubt (str-vechi / aff-vechi); fișele vechi = un singur test.
//  - fișele STR mai au în secțiunea 1 rândurile „SSD” și „Tehnician” și subsolul „Generat cu STR <versiune> · <firma>”.
// Nimic nu e obligatoriu: ce lipsește rămâne gol (de ex. rândul „De făcut” din secțiunea 6, care apare doar în fișele noi).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  }
  return ENT[e.toLowerCase()] ?? m;
});
// textul unei bucăți de HTML; <br>, sfârșit de paragraf / element de listă = rând nou
const text = h => decode(h.replace(/<br\s*\/?>|<\/(p|li|div|tr)>/gi, '\n').replace(/<[^>]*>/g, ''))
  .split('\n').map(l => l.replace(/[\s ]+/g, ' ').trim()).filter(Boolean).join('\n');
const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : '';
};

// „28.10.2026, ora 16:30” -> 202610281630 (ca dateKey din index.html); fără dată = 0
const RE_DATA = /(\d{2})\.(\d{2})\.(\d{4})(?:,? (?:ora|at) (\d{2}):(\d{2}))?/;
const dataKey = s => { const m = RE_DATA.exec(s || ''); return m ? +(m[3] + m[2] + m[1] + (m[4] || '00') + (m[5] || '00')) : 0; };

const TIPURI = { LAPTOP: 'laptop', 'UNITATE PC': 'pc', 'PC UNIT': 'pc', MONITOR: 'monitor' };
const tipDin = s => {
  const u = (s || '').toUpperCase();
  return /UNITATE PC|PC UNIT/.test(u) ? 'pc' : /MONITOR/.test(u) ? 'monitor' : /LAPTOP/.test(u) ? 'laptop' : '';
};

// ✔ / ✘ / sărit / nu are, ca val() din testResults()
const val = s => s.includes('✔') ? 'ok' : s.includes('✘') ? 'bad' : /sărit|skipped/i.test(s) ? 'skip' : /nu are|none/i.test(s) ? 'na' : '';
const bifat = (s, re) => new RegExp(`☒\\s*(?:${re.source})`, 'i').test(s);

function randuri(tableHtml) {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r =>
    [...r[1].matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map(c => ({ th: c[1].toLowerCase() === 'th', text: text(c[3]) })));
}
// tabel „cheie | valoare” (secțiunile 1, 5, 6)
const kv = rows => {
  const o = {};
  for (const r of rows) if (r.length === 2 && r[0].th) o[r[0].text] = r[1].text;
  return o;
};
const cheie = (o, re) => { for (const k of Object.keys(o)) if (re.test(k)) return o[k]; return ''; };

// un test (secțiunea lui sau toată fișa veche)
function citesteTest(html) {
  const t = {
    data: '', marca: '', model: '', serie: '', codEticheta: '', categorie: '', tipTitlu: '',
    ssd: '', tehnician: '', etapa1: '', motivRespingere: '', rezultat: '', nefunctionale: '', testeProgram: '', destinatie: '', deFacut: '',
    functii: [], vizual: [], configuratie: {}, retestare: null,
  };
  const hd = /<table\b[^>]*class="hd"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (hd) {
    const h = text(hd[1]);
    const dupa = /Data test[ăa]rii|Test date/i.exec(h);
    const m = RE_DATA.exec(dupa ? h.slice(dupa.index) : '');
    if (m) t.data = m[0].replace(/,? (?:ora|at) /, ', ora ');
    t.tipTitlu = tipDin((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(hd[1]) || [])[1]);
  }
  for (const s of html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>\s*<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const titlu = text(s[1]), rows = randuri(s[2]);
    if (/Identificarea echipamentului|Equipment identification/i.test(titlu)) {
      const o = kv(rows);
      t.marca = cheie(o, /^(Marcă|Marca|Brand)/i);
      t.model = cheie(o, /^Model/i);
      t.serie = cheie(o, /^(Nr\. serie|Serial)/i);
      t.codEticheta = cheie(o, /^(Cod etichetă|Cod eticheta|Label code)/i);
      t.categorie = cheie(o, /^(Categorie|Category)/i);
      t.ssd = cheie(o, /^SSD$/i);
      t.tehnician = cheie(o, /^(Tehnician|Technician)$/i);
    } else if (/Inspecție vizuală|Inspectie vizuala|Visual inspection/i.test(titlu)) {
      for (const r of rows) {
        if (r.length === 3 && !r[0].th) t.vizual.push({ nume: r[1].text, v: val(r[2].text) });
        else if (r.length === 2 && /Rezultat etapa 1|Stage 1 result/i.test(r[0].text))
          t.etapa1 = bifat(r[1].text, /PASS/) ? 'PASS' : bifat(r[1].text, /RESPINS|REJECTED/) ? 'RESPINS' : '';
        else if (r.length === 2 && /Motiv respingere|Reason for rejection/i.test(r[0].text)) t.motivRespingere = r[1].text;
      }
    } else if (/Funcții testate|Functii testate|Functions tested/i.test(titlu)) {
      for (const r of rows) if (r.length === 3 && !r[0].th) t.functii.push({ nume: r[0].text, v: val(r[1].text), nota: r[2].text });
    } else if (/Configurație|Configuratie|Configuration/i.test(titlu)) {
      t.configuratie = kv(rows);
    } else if (/Rezultat final|Final result/i.test(titlu)) {
      for (const r of rows) {
        if (r.length < 2 || !r[0].th) continue;
        const k = r[0].text, v = r.slice(1).map(c => c.text).join(' ');
        if (/^(Rezultat|Result)$/i.test(k)) t.rezultat = bifat(v, /EEER/) ? 'EEER' : bifat(v, /RESPINS|REJECTED/) ? 'RESPINS' : '';
        else if (/nefuncționale|nefunctionale|Non-working/i.test(k)) t.nefunctionale = /^(niciuna|none)$/i.test(v) ? '' : v;
        else if (/Teste program|Program tests/i.test(k)) t.testeProgram = v;
        else if (/Destinație|Destinatie|Destination/i.test(k))
          t.destinatie = v.split(/(?=[☒☐])/).filter(x => x.startsWith('☒')).map(x => x.slice(1).trim()).join(', ');
        else if (/^(De f[aă]cut|To do)/i.test(k)) t.deFacut = /^(nimic|niciuna|—|-|–)$/i.test(v.trim()) ? '' : v;
      }
    } else if (/Retestare|Retest/i.test(titlu)) {
      const fata = /Test\s+(\d+)/i.exec(titlu);
      const rez = rows.length ? rows[rows.length - 1] : [];
      t.retestare = {
        fataDe: fata ? +fata[1] : 0,
        sumar: rez.length ? rez[rez.length - 1].text : '',
        randuri: rows.filter(r => r.length === 4 && !r[0].th).map(r => ({ ce: r[0].text, inainte: r[1].text, acum: r[2].text, concluzie: r[3].text })),
      };
    }
  }
  // fișele fără rândul „Funcții nefuncționale”: din funcțiile marcate ✘
  if (!t.nefunctionale && t.functii.some(f => f.v === 'bad')) t.nefunctionale = t.functii.filter(f => f.v === 'bad').map(f => f.nume).join('; ');
  t.dataKey = dataKey(t.data);
  t.text = text(html).replace(/\n/g, ' ');
  return t;
}

// html = conținutul fișei; numeFisier ajută doar dacă lipsește primul rând
function citesteFisa(html, numeFisier = '') {
  const first = /^﻿?\s*<!--\s*RAPORT NR\.\s*([\s\S]*?)\s*-->/i.exec(html);
  if (!first && !/F-TEST-04/.test(html)) return null;            // nu e o fișă de testare
  let cod = '', tip = '';
  if (first) {
    const m = /^([\s\S]*?)\s*[—–-]+\s*TEST\s+([A-Z ]+?)\s*$/i.exec(first[1].trim());
    if (m) { cod = m[1].trim(); tip = TIPURI[m[2].trim().toUpperCase()] || tipDin(m[2]); } else cod = first[1].trim();
  }
  // fără script / style / imagini (sigla din antet e o imagine data: mare)
  const corp = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<img\b[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const secs = [...corp.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)].filter(m => /\b(str|aff)-test\b/.test(attr(m[1], 'class')));
  const brute = secs.length
    ? secs.map(m => ({ nr: +attr(m[1], 'data-nr') || 0, data: attr(m[1], 'data-data'), vechi: /\b(str|aff)-vechi\b/.test(attr(m[1], 'class')),
        html: m[2].replace(/<div\b[^>]*class="(?:str|aff)-titlu"[^>]*>[\s\S]*?<\/div>/i, '') }))
    : [{ nr: 1, data: '', vechi: false, html: corp }];
  const teste = brute.map((b, i) => {
    const t = citesteTest(b.html);
    if (b.data && RE_DATA.test(b.data)) { t.data = b.data; t.dataKey = dataKey(b.data); }
    t.nr = b.nr || (secs.length ? i + 1 : 1);
    t.principal = !b.vechi && i === 0;
    t.tip = (t.principal && tip) || t.tipTitlu || tipDin(t.categorie) || tip;
    delete t.tipTitlu;
    return t;
  });
  // testul de acum primul, apoi cele de dinainte, de la cel mai nou
  teste.sort((a, b) => (b.principal - a.principal) || (b.nr - a.nr));
  if (!cod) cod = teste[0]?.codEticheta || (/^raport_cod_(.+?)_[^_]*\.html?$/i.exec(numeFisier) || [])[1] || '';
  const ft = /<p\b[^>]*class="ft"[^>]*>([\s\S]*?)<\/p>/i.exec(corp), gen = ft ? /Generat cu STR\s*([\d.]+)?\s*(?:·\s*(.*))?/i.exec(text(ft[1])) : null;
  return { cod, tip: tip || teste[0]?.tip || '', format: secs.length ? 'nou' : 'vechi', teste, program: gen ? `STR ${gen[1] || ''}`.trim() : '', firma: gen?.[2]?.trim() || '' };
}

// fișele foarte vechi, salvate ca text (raport_cod_….txt): doar codul, tipul și data, dacă se găsesc
function citesteFisaText(txt, numeFisier = '') {
  const first = /RAPORT NR\.\s*(.*?)\s*[—–-]+\s*TEST\s+([A-Z ]+)/i.exec(txt.slice(0, 400));
  const cod = first ? first[1].trim() : (/^raport_cod_(.+?)(?:_[^_]*)?\.txt$/i.exec(numeFisier) || [])[1] || '';
  const m = RE_DATA.exec(txt);
  const t = { nr: 1, principal: true, data: m ? m[0] : '', dataKey: m ? dataKey(m[0]) : 0, tip: tipDin(first?.[2]) || 'laptop',
    marca: '', model: '', serie: '', codEticheta: cod, categorie: '', etapa1: '', motivRespingere: '', rezultat: '',
    nefunctionale: '', testeProgram: '', destinatie: '', deFacut: '', functii: [], vizual: [], configuratie: {}, retestare: null,
    text: txt.replace(/\s+/g, ' ').slice(0, 20000) };
  return { cod, tip: t.tip, format: 'text', teste: [t] };
}

// numele fișierelor de pe SSD conțin codul așa (server.py fs_code): ce nu e voie în nume (și non-ASCII) devine „_”
const fsCode = code => code.replace(/[\\/:*?"<>|\x00-\x1f\x7f-￿]/g, '_').replace(/[. ]+$/, '') || '_';

window.STRFisa = { citesteFisa, citesteFisaText, dataKey, fsCode, text };

})();
