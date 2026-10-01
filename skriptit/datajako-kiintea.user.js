// ==UserScript==
// @name         Kupla Datajako (ei automaattista paivitysta)
// @namespace    https://re-lab.local/kupla
// @updateURL    none
// @downloadURL none
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      0.16.0
// @description  Salattu chat + tiedostojako asun (figure) kautta. Vain samassa hotellihuoneessa. Ei palvelinmuutoksia.
// @kupla-oletus on
// @author       re-lab
// ==/UserScript==
/*
 * MÄÄRITTELY: userscriptit/datajako/MAARITTELY.md (kp 2026-10-01 15:44-16:01). Pelkkä client, EI yksityisviestejä.
 * KANAVA: lähettäjän asun ylimääräinen tuntematon osa  .q<tag4><base62-salattu>-0  (pelin renderöijä ohittaa, asu näkyy normaalina —
 *   mitattu pikselilleen sama, nitro/ASU-LAHETIN-SUUNNITELMA.md). Lähetys = clientin oma 2730 UserFigureComposer (sama tapa kuin asu.user.js).
 * HUONE = jaettava id. Id:stä johdetaan AES-GCM-avain (PBKDF2). Ilman id:tä ei näe sisältöä.
 * ⚠ Jokainen viesti = asunvaihto: palvelin kirjoittaa tietokantaan, lähettää koko hotellihuoneelle ja tikittää "change_figure"-palkintoseurantaa.
 * ⚠ Palvelimen purskeraja 10 samaa pakettia / 1-2 s -> lähetys max ~3/s (GAP). Puhdas asu palautetaan 3 s jonon tyhjenemisen jälkeen
 *   ja aina sivun latautuessa (jos edellinen lataus kuoli kesken).
 */
(() => {
  'use strict';
  const VW = window;
  if (VW.__kuplaDatajako) return; VW.__kuplaDatajako = true;

  // <<KOODEKKI  (puhdas logiikka; node-testi koodekki-testi.js ottaa tämän lohkon sellaisenaan)
  const A62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const A62I = (() => { const m = {}; for (let i = 0; i < 62; i++) m[A62[i]] = i; return m; })();
  // 4 tavua -> 6 merkkiä (62^6 > 2^32). Alussa 4 tavun pituuskenttä, loppu täytetään nollilla 4:n kerrannaiseksi.
  function b62e(u8) {
    const n = Math.ceil((4 + u8.length) / 4) * 4, buf = new Uint8Array(n);
    buf[0] = (u8.length >>> 24) & 255; buf[1] = (u8.length >>> 16) & 255; buf[2] = (u8.length >>> 8) & 255; buf[3] = u8.length & 255;
    buf.set(u8, 4); let out = '';
    for (let i = 0; i < n; i += 4) {
      let v = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0, s = '';
      for (let k = 0; k < 6; k++) { s = A62[v % 62] + s; v = Math.floor(v / 62); }
      out += s;
    }
    return out;
  }
  function b62d(str) {
    if (!str || str.length % 6 || str.length < 6) return null;
    const n = str.length / 6 * 4, buf = new Uint8Array(n);
    for (let i = 0, o = 0; i < str.length; i += 6, o += 4) {
      let v = 0;
      for (let k = 0; k < 6; k++) { const d = A62I[str[i + k]]; if (d === undefined) return null; v = v * 62 + d; }
      if (v > 0xffffffff) return null;
      buf[o] = (v >>> 24) & 255; buf[o + 1] = (v >>> 16) & 255; buf[o + 2] = (v >>> 8) & 255; buf[o + 3] = v & 255;
    }
    const len = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
    if (len > n - 4 || n - 4 - len > 3) return null;
    return buf.slice(4, 4 + len);
  }
  const VERSIO = '0.16.0';   /* pida sama kuin @version: kerrotaan kuplaDatajako.versio, jotta nakee kumpi versio kussakin clientissa pyorii */
  const TE = new TextEncoder(), TD = new TextDecoder();
  // kehys: [tyyppi u8][otsikon pituus u16][otsikko JSON][runko]
  const T = { TEKSTI: 1, PALA: 2, POISTA: 3, TARVITSEN: 4, TOIMINTO: 5, KUITTAUS: 6, LASNA: 7, KUTSU: 8, HISTORIA: 9, TARJOUS: 10, LISAOSAT: 11 };
  function pakkaa(tyyppi, otsikko, runko) {
    const h = TE.encode(JSON.stringify(otsikko)), b = runko || new Uint8Array(0), o = new Uint8Array(3 + h.length + b.length);
    o[0] = tyyppi; o[1] = h.length >> 8; o[2] = h.length & 255; o.set(h, 3); o.set(b, 3 + h.length); return o;
  }
  function pura(o) {
    if (!o || o.length < 3) return null;
    const hl = (o[1] << 8) | o[2]; if (3 + hl > o.length) return null;
    try { return { tyyppi: o[0], otsikko: JSON.parse(TD.decode(o.subarray(3, 3 + hl))), runko: o.subarray(3 + hl) }; } catch (e) { return null; }
  }
  // huoneen tag = 4 merkkiä SHA-256:n 4 ensimmäisestä tavusta (b62e antaa ensin 6 merkin pituuskentän -> data alkaa merkistä 6)
  const huoneTag = h4 => b62e(h4).slice(6, 10);
  const OSA_RE = /\.q([0-9A-Za-z]{10,})-0(?=\.|$)/;
  const OSA_RE_KAIKKI = /\.q[0-9A-Za-z]{10,}-0(?=\.|$)/g;
  const puhdasAsu = f => String(f || '').replace(OSA_RE_KAIKKI, '');
  // Toiminnot: vain JS (kp 1.10.: ei valmiita pakettivalintoja; kävely, komento, tyylit tehdään koodilla, esim. kuplaKomennot.aja(':nimi'), dj.tyyli(css)). osoita = osoitin-nappi.
  // js = mikä tahansa konsolikoodi. Kuvaus muodostetaan täällä, ei koskaan lähettäjän tekstistä; koodi näytetään aina ennen ajoa.
  const SMAX = 8000;
  const TOIMINNOT = {
    js: { vaarallinen: true, kuvaus: t => 'Aja koodi (' + String(t.s || '').length + ' merkkiä)' },
    osoita: { vaarallinen: false, kuvaus: t => 'Osoittaa: ' + kohdeTeksti(t.s) },
  };
  function kohdeJson(s) { try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } }
  function kohdeTeksti(s) {
    const o = kohdeJson(s); if (!o) return 'tuntematon kohde';
    if (o.k === 'ruutu') return 'ruutu ' + (o.x | 0) + ',' + (o.y | 0);
    if (o.k === 'furni') return 'esine ' + String(o.nimi || '#' + (o.id | 0)).slice(0, 40);
    if (o.k === 'hahmo') return 'hahmo ' + String(o.nimi || '?').slice(0, 40);
    if (o.k === 'ui') return 'käyttöliittymän kohta' + (o.teksti ? ' "' + String(o.teksti).slice(0, 40) + '"' : '');
    return 'tuntematon kohde';
  }
  const KUMOAA = { js: 1, komento: 1 };   // näihin voi liittää käsin kirjoitetun kumoa-koodin (t.u)
  const kumoaKoodi = t => t && KUMOAA[t.a] && typeof t.u === 'string' ? t.u.slice(0, SMAX) : '';
  const kuvaus = t => t && Object.prototype.hasOwnProperty.call(TOIMINNOT, t.a) ? TOIMINNOT[t.a].kuvaus(t) + (kumoaKoodi(t) ? ' · kumottavissa' : '') : null;
  // Kirjanpito (tallennetut) ja asetusten vienti/tuonti. Tuotu tiedosto on UKO DATAA: siivotaan kenttä kerrallaan, ei koskaan aseteta autoKoodia.
  const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
  function siivoaMerkinta(m) {
    if (!m || typeof m !== 'object') return null;
    const laji = m.laji || (m.t ? 'toiminto' : ''), nimi = str(m.nimi, 60), from = str(m.from, 40) || '?', ts = +m.ts > 0 ? +m.ts : 0;
    if (laji === 'toiminto') { const t = m.t; if (!t || !Object.prototype.hasOwnProperty.call(TOIMINNOT, t.a) || typeof t.s !== 'string') return null; const u = kumoaKoodi(t), tt = { a: t.a, x: t.x | 0, y: t.y | 0, s: t.s.slice(0, SMAX) }; if (u) tt.u = u; return { laji, nimi, from, ts, t: tt }; }
    if (laji === 'teksti') { const teksti = str(m.teksti, 2000); return teksti ? { laji, nimi, from, ts, teksti } : null; }
    if (laji === 'tiedosto') { const tnimi = str(m.tnimi, 120), sisalto = str(m.sisalto, 100000); return tnimi && sisalto ? { laji, nimi, from, ts, tnimi, mime: str(m.mime, 80) || 'text/plain', sisalto } : null; }
    return null;
  }
  const merkinnanAvain = m => m.laji + '|' + (m.nimi || '') + '|' + (m.t ? m.t.a + ':' + m.t.s + '|' + (m.t.u || '') : m.teksti || m.tnimi + ':' + m.sisalto);
  function huoneKoodiOk(s) { s = String(s || '').trim().toLowerCase().replace(/\s+/g, '-'); return s.length >= 6 && s.length <= 80 ? s : null; }
  function siivoaTuonti(o) {
    if (!o || typeof o !== 'object' || o.laji !== 'datajako-asetukset' || o.versio !== 1) return null;
    const ut = { laatu: null, maxSivu: null, tallennetut: [], huoneet: [], auto: [], hylatty: 0 };
    if (+o.laatu > 0) ut.laatu = Math.min(0.95, Math.max(0.2, +o.laatu));
    if ([256, 512, 800, 1024, 1600, 2048].includes(+o.maxSivu)) ut.maxSivu = +o.maxSivu;
    for (const m of Array.isArray(o.tallennetut) ? o.tallennetut.slice(0, 500) : []) { const s = siivoaMerkinta(m); if (s) ut.tallennetut.push(s); else ut.hylatty++; }
    for (const h of Array.isArray(o.huoneet) ? o.huoneet.slice(0, 50) : []) { const id = huoneKoodiOk(typeof h === 'string' ? h : h && h.id); if (id) ut.huoneet.push({ id, nimi: str(h && h.nimi, 60) || id }); else ut.hylatty++; }
    for (const a of Array.isArray(o.auto) ? o.auto.slice(0, 50) : []) if (typeof a === 'string' && a.trim() && a.length <= 40) ut.auto.push(a.trim());
    return ut;
  }
  // Komentokäsittelijä: "/nimi args [ ## kumoa]" ei lähde viestinä vaan ajaa komennon tai lähettää tallennetun asian. "//x" = kirjaimellinen "/x".
  const komentoNimi = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9åäö]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  function jasenna(rivi) {
    rivi = String(rivi || ''); if (rivi[0] !== '/') return null; if (rivi[1] === '/') return { kirjaimellinen: rivi.slice(1) };
    const m = /^\/(\S*)\s*([\s\S]*)$/.exec(rivi); if (!m || !komentoNimi(m[1])) return null;
    let args = m[2], kumoa = ''; const i = args.indexOf(' ## '); if (i >= 0) { kumoa = args.slice(i + 4).trim(); args = args.slice(0, i); }
    return { nimi: komentoNimi(m[1]), args: args.trim(), kumoa };
  }
  // Argumentit: tekstissä/komennossa/css:ssä $1..$9 ja $* korvataan sellaisenaan. JS:ssä $1..$9 ja $all ovat MUUTTUJIA (JSON-literaalina ennen koodia): ei tekstikorvausta, ei injektiota
  function sijoita(malli, args, js) {
    const a = String(args || '').split(/\s+/).filter(Boolean);
    if (js) { const d = []; for (let i = 1; i <= 9; i++) if (new RegExp('\\$' + i + '(?!\\d)').test(malli)) d.push('$' + i + ' = ' + JSON.stringify(a[i - 1] || ''));
      if (/\$all(?![\w$])/.test(malli)) d.push('$all = ' + JSON.stringify(String(args || ''))); return d.length ? 'const ' + d.join(', ') + ';\n' + malli : String(malli); }
    return String(malli).replace(/\$(\d|\*)/g, (_, k) => k === '*' ? String(args || '') : (a[+k - 1] || ''));
  }
  // KOODEKKI>>

  // ---------- asetukset ----------
  const CHUNK = 2400;          // tiedoston tavua / pala (salattuna+base62:ssa ~3,9 k merkkiä)
  const GAP = 330;             // ms lähetysten väli (purskeraja 10/1-2 s -> turvallinen)
  const RAJA = 150 * 1024;     // oletusraja tiedostolle (ohitettavissa varoituksella)
  const LS = 'kupla.datajako.v1';
  const dv = (o, k) => { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : undefined; };
  const ase = (() => { let s = {}; try { s = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) {} return Object.assign({ huoneet: [], valittu: null, auto: {}, laatu: 0.7, maxSivu: 1024 }, s); })();
  ase.maxSivu = [256, 512, 800, 1024, 1600, 2048].includes(+ase.maxSivu) ? +ase.maxSivu : 1024;
  ase.laatu = Math.min(0.95, Math.max(0.2, +ase.laatu || 0.7));
  if (!Array.isArray(ase.huoneet)) ase.huoneet = [];
  // 0.4.0: oletuksena yksi yhteinen chat ilman salasanaa (kiinteä koodi, salaus vain peitettä). Oma salasana on VALINNAINEN: valikosta voi luoda yksityisen chatin.
  const YHTEINEN = 'datajako-yhteinen'; ase.huoneet = ase.huoneet.filter(h => h && h.id && h.id !== YHTEINEN); ase.huoneet.unshift({ id: YHTEINEN, nimi: 'Yhteinen' }); if (!ase.valittu || !ase.huoneet.some(h => h.id === ase.valittu)) ase.valittu = YHTEINEN;
  ase.tallennetut = (Array.isArray(ase.tallennetut) ? ase.tallennetut : []).map(siivoaMerkinta).filter(Boolean);
  if (!ase.auto || typeof ase.auto !== 'object') ase.auto = {};
  const tallennaAse = () => { try { localStorage.setItem(LS, JSON.stringify(ase)); } catch (e) {} };

  // ---------- peliyhteys (asu.user.js:n tapa) ----------
  const RE = () => VW.NitroDevTools && VW.NitroDevTools.roomEngine;
  function yhteys() {
    const re = RE(); if (!re) return {};
    if (!VW.__nitroConn) {
      const seen = new Set(); let conn = null;
      const scan = (o, d) => { if (!o || conn || d > 4 || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
        if (Object.getOwnPropertyDescriptor(o, '_cryptoState')) { conn = o; return; }
        for (const k of Object.getOwnPropertyNames(o)) { const de = Object.getOwnPropertyDescriptor(o, k); if (de && !de.get && de.value && typeof de.value === 'object') scan(de.value, d + 1); } };
      scan(dv(re, '_roomSessionManager'), 0); VW.__nitroConn = conn;
    }
    return { c: VW.__nitroConn, sdm: dv(re, '_sessionDataManager') };
  }
  function omaNimi() { const { sdm } = yhteys(); const n = sdm && dv(sdm, '_name'); return n ? String(n) : null; }
  function omaAsu() {
    const { sdm } = yhteys(); if (!sdm) return null;
    return { figure: String(dv(sdm, '_figure') || ''), gender: String(dv(sdm, '_gender') || 'M').toUpperCase().startsWith('F') ? 'F' : 'M' };
  }
  function laheta2730(gender, figure) {
    const { c } = yhteys(); if (!c) return false;
    const map = dv(dv(c, '_messages'), '_messageIdByComposer'); let C = null;
    if (map) for (const [k, v] of map) if (v === 2730 && !C) C = k;
    if (!C) return false; c.send(new C(gender, figure)); return true;
  }
  function yksikot() {
    const re = RE(); if (!re) return [];
    const room = dv(re, '_activeRoomId'), rsm = dv(re, '_roomSessionManager'), ss = rsm && dv(rsm, '_sessions'); let sess = null;
    if (ss instanceof Map) for (const [, v] of ss) { if (dv(v, '_roomId') === room || !sess) sess = v; }
    const mgr = sess && (dv(sess, '_userData') || sess.userDataManager); if (!mgr || !mgr.getUserDataByIndex) return [];
    const out = [];
    for (const o of (re.getRoomObjects(room, 100) || [])) {
      const u = mgr.getUserDataByIndex(o.id); if (!u) continue;
      const name = u.name !== undefined ? u.name : dv(u, '_name'), fig = u.figure !== undefined ? u.figure : dv(u, '_figure');
      if (name) out.push({ name, figure: fig || '' });
    }
    return out;
  }

  // ---------- salaus ----------
  const avainCache = new Map();
  function avain(id) {
    if (avainCache.has(id)) return avainCache.get(id);
    const p = (async () => {
      const km = await crypto.subtle.importKey('raw', TE.encode(id), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: TE.encode('kupla-datajako-v1'), iterations: 150000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', TE.encode('tag:' + id)));
      return { key, tag: huoneTag(h.subarray(0, 4)) };
    })();
    avainCache.set(id, p); return p;
  }
  async function salaa(id, kehys) {
    const { key, tag } = await avain(id), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, kehys));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return '.q' + tag + b62e(out) + '-0';
  }
  async function pura2(id, hyoty) {
    const { key } = await avain(id), b = b62d(hyoty); if (!b || b.length < 29) return null;
    try { return pura(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12)))); } catch (e) { return null; }
  }

  // ---------- tila ----------
  const viestit = new Map();   // huone-id -> [viesti]
  const tiedostot = new Map(); // `${huone}|${id}` -> {pala:[], n, ...}  (vastaanotto)
  const lahetetyt = new Map(); // `${huone}|${id}` -> {tied, data} (uudelleenlähetystä varten)
  const kuuntelijat = new Set(); const paivita = () => kuuntelijat.forEach(f => { try { f(); } catch (e) {} });
  const lista = h => viestit.get(h) || (viestit.set(h, []), viestit.get(h));
  const uusiId = () => crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  const lisaa = (h, v) => { const l = lista(h); if (l.some(x => x.id === v.id && x.tyyppi === v.tyyppi)) return null; l.push(v); l.sort((a, b) => (a.ts || 0) - (b.ts || 0)); paivita(); return v; };   // historia ja uudelleenlahetys saapuvat jalkikateen -> lajittele aina ajan mukaan

  // ---------- lähetys (jono, GAP, puhdas asu palautetaan) ----------
  const jono = []; let viimeLahetys = 0, kesken = false, puhdas = null;
  const paalla = () => ase.paalla !== false;
  function jonoon(huone, tyyppi, otsikko, runko) { if (!paalla()) return; jono.push({ huone, tyyppi, otsikko, runko }); }
  async function laheteTick() {
    if (kesken) return; const nyt = Date.now();
    if (jono.length && nyt - viimeLahetys >= GAP) {
      kesken = true; viimeLahetys = nyt;
      try {
        const it = jono.shift(), oma = omaAsu();
        const takaisin = () => { it.yrit = (it.yrit || 0) + 1; if (it.yrit <= 20) { jono.unshift(it); viimeLahetys = nyt + 1500; } else tilasto.pudotettu++; tilasto.lahetysVirhe++; };   // ei yhteyttä/asua: yritä uudelleen, älä hävitä paketti hiljaa
        if (!oma) return takaisin();
        if (!puhdas) puhdas = { figure: puhdasAsu(oma.figure), gender: oma.gender };
        const osa = await salaa(it.huone, pakkaa(it.tyyppi, it.otsikko, it.runko));
        if (!laheta2730(puhdas.gender, puhdas.figure + osa)) return takaisin();
      } finally { kesken = false; }
    } else if (!jono.length && puhdas && nyt - viimeLahetys >= 3000) {
      const p = puhdas; puhdas = null; laheta2730(p.gender, p.figure);
    }
  }
  function aloitusSiivous() { const oma = omaAsu(); if (oma && OSA_RE.test(oma.figure)) laheta2730(oma.gender, puhdasAsu(oma.figure)); }

  // ---------- lähettäminen ----------
  // kuittaus: vastaanottaja kuittaa saamansa viestit (yksi paketti kerralla useasta), lähettäjä toistaa 2 kertaa ja näyttää sitten "ei kuittausta" + napin
  function lahetaKehys(huone, v) { if (!v || !v.kehys) return; v.laheti = Date.now(); v.yritykset = (v.yritykset || 0) + 1; v.eiKuittausta = false; jonoon(huone, v.kehys.tyyppi, v.kehys.otsikko); }
  function lahetaTeksti(huone, teksti) {
    if (!paalla()) return null;
    const id = uusiId(), v = lisaa(huone, { id, tyyppi: 'teksti', from: '(sinä)', oma: true, ts: Date.now(), teksti, kehys: { tyyppi: T.TEKSTI, otsikko: { id, x: teksti, s: Date.now() } }, kuitattu: [], yritykset: 0 });
    lahetaKehys(huone, v); return id;
  }
  // 0.12.0 CLICK TO RECEIVE: lahetys on pelkka TARJOUS. Tavut lahtevat vasta kun vastaanottaja painaa Hae,
  // ja ne lahtevat T.TARVITSEN-polkua, joka lukee lahetetyt-kartasta -> vain LAHETTAJA voi palvella tiedoston.
  // SYY (kp 1.10.): kanava on hidas (2400 tavua / 330 ms), eika kukaan halua kaikkia tiedostoja automaattisesti.
  // RAJA: kun lahettaja lataa sivun uudelleen tai poistuu, lahetetyt tyhjenee ja tarjous jaa roikkumaan - Hae
  // kertoo silloin "lahettaja ei ole huoneessa" tai "ei vastaa". Tiedosto EI siirry kolmannen kautta, mika on tarkoitus.
  const tarjousLista = () => (Array.isArray(ase.tiedostotarjoukset) ? ase.tiedostotarjoukset : (ase.tiedostotarjoukset = []));
  function muistaTarjous(huone, tied, url) {   /* vain OSOITE ja metatiedot, ei tavuja: ne noudetaan uudelleen vasta pyynnosta */
    if (!url) return; const x = { id: tied.id, huone, nimi: tied.nimi, mime: tied.mime, size: tied.size, n: tied.n, url: String(url).slice(0, 400), ts: Date.now() };
    ase.tiedostotarjoukset = tarjousLista().filter(y => y.id !== x.id).slice(-2); ase.tiedostotarjoukset.push(x); tallennaAse();
  }
  async function palautaLahetetty(huone, id) {   /* sivun lataus tyhjensi lahetetyt: haetaan lahteesta uudelleen */
    const x = tarjousLista().find(y => y.id === String(id) && y.huone === huone); if (!x) return null;
    try {
      const r = await fetch(x.url, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = new Uint8Array(await r.arrayBuffer());
      if (data.length !== (x.size | 0)) { tiedota(huone, 'Tarjottu tiedosto ' + x.nimi + ' on muuttunut lahteessa (' + data.length + ' vs ' + x.size + ' tavua), en palvele vanhaa tarjousta'); return null; }
      const tied = { id: x.id, nimi: x.nimi, mime: x.mime, size: data.length, n: Math.max(1, Math.ceil(data.length / CHUNK)) };
      lahetetyt.set(huone + '|' + x.id, { tied, data }); return { tied, data };
    } catch (e) { tiedota(huone, 'Tiedostoa ' + x.nimi + ' ei saatu lahteesta: ' + e.message); return null; }
  }
  function lahetaTiedosto(huone, blob, nimi, url) {
    if (!paalla()) return null;
    return blob.arrayBuffer().then(ab => {
      const data = new Uint8Array(ab), id = uusiId(), n = Math.max(1, Math.ceil(data.length / CHUNK));
      const tied = { id, nimi, mime: blob.type || 'application/octet-stream', size: data.length, n };
      lahetetyt.set(huone + '|' + id, { tied, data });
      muistaTarjous(huone, tied, url);
      const v = lisaa(huone, { id, tyyppi: 'tiedosto', from: '(sinä)', oma: true, ts: Date.now(), nimi, mime: tied.mime, size: data.length, blob, n, saatu: n, tarjottu: true, kehys: { tyyppi: T.TARJOUS, otsikko: Object.assign({ s: Date.now() }, tied) }, kuitattu: [], yritykset: 0 });
      lahetaKehys(huone, v);
      return id;
    });
  }
  function lahetaTiedostoUudelleen(huone, id) {   /* tarjous uudelleen, ei tavuja */
    const v = lista(huone).find(x => x.id === id && x.oma); if (!v || !v.kehys) return false;
    lahetaKehys(huone, v); return true;
  }
  function haeTiedosto(huone, id) {   /* vastaanottajan Hae: luo palakirjanpidon ja pyytaa KAIKKI palat siita, joka tarjosi */
    const v = lista(huone).find(x => x.id === id); if (!v || v.blob || (v.oma && !v.palautettu)) return false;
    const palvelija = v.palautettu ? (v.valitti || v.from) : v.from;   /* palautettu oma tiedosto tulee VALITTAJALTA, ei itselta */
    const av = huone + '|' + id; let t = tiedostot.get(av);
    if (!t) { t = { pala: [], saatu: 0, n: v.n, nimi: v.nimi, mime: v.mime, size: v.size, from: palvelija, viim: 0, pyynnot: 0 }; tiedostot.set(av, t); }
    t.viim = 0; t.pyynnot = 0; v.tila = ''; v.pyydetty = true;
    const puuttuu = []; for (let i = 0; i < t.n; i++) if (!t.pala[i]) puuttuu.push(i);
    jonoon(huone, T.TARVITSEN, { id, puuttuu }); paivita(); return true;
  }
  function lahetaToiminto(huone, a, x, y, koodi, kumoa) { if (!paalla()) return null; const id = uusiId(), t = { a, x: x | 0, y: y | 0, s: String(koodi || '').slice(0, SMAX) }; const u = kumoaKoodi({ a, u: kumoa }); if (u) t.u = u; const v = lisaa(huone, { id, tyyppi: 'toiminto', from: '(sinä)', oma: true, ts: Date.now(), t, kehys: { tyyppi: T.TOIMINTO, otsikko: Object.assign({ id }, t) }, kuitattu: [], yritykset: 0 }); lahetaKehys(huone, v); return id; }
  function poistaJaettu(huone, id) {
    const l = lista(huone), i = l.findIndex(v => v.id === id); if (i >= 0) { l.splice(i, 1); paivita(); }
    jonoon(huone, T.POISTA, { id }); setTimeout(() => jonoon(huone, T.POISTA, { id }), 3000);   // idempotentti: toinen kerta varmuuden vuoksi
  }
  function poistaOmasta(huone, id) { const l = lista(huone), i = l.findIndex(v => v.id === id); if (i >= 0) { l.splice(i, 1); paivita(); } }

  // ---------- vastaanotto ----------
  const nahty = new Map(); let lukee = false; const tilasto = { osia: 0, eiTagia: 0, eiAuki: 0, ok: 0, virhe: 0, viimeVirhe: '', lahetysVirhe: 0, pudotettu: 0, kuitattu: 0 };
  const kuittausJono = new Map();   // huone -> { ids:Set, t }
  // läsnäolo (0.4.0): "olen täällä" -kehys kun skripti käynnistyy tai huone vaihtuu; muut vastaavat kerran. Lista näyttää vain ne jotka ovat nyt samassa hotellihuoneessa.
  const lasna = new Map(), lasnaVastattu = new Map(); let lasnaHuone = null;   // chat -> Map(nimi -> ts)
  const tagiHuone = new Map(), omaTagi = new Map();   /* lasnaolo kertoo chatit wire-TAGILLA: tagi nakyy kehyksissa jo nyt, salasana ei lahde koskaan */
  function tagiTieto(id) { if (omaTagi.has(id)) return omaTagi.get(id); avain(id).then(({ tag }) => { omaTagi.set(id, tag); tagiHuone.set(tag, id); }).catch(() => {}); return null; }
  function tagilista() { ase.huoneet.forEach(x => tagiTieto(x.id)); return ase.huoneet.filter(x => !x.yv).map(x => omaTagi.get(x.id)).filter(Boolean).slice(0, 12); }   /* 1:1 chatin tagi EI mene yhteiseen kanavaan: se paljastaisi kenen kanssa puhut */
  const kutsut = new Map();   // koodi -> { n, c, from, ts }: huoneessa ilmoitetut chatit (yksi napsautus liittää)
  const ilmoitetut = new Set();   // omat chatit jotka on ilmoitettu huoneeseen: toistetaan kun joku kysyy tai saapuu
  async function ilmoitaChat(h) { const x = ase.huoneet.find(y => y.id === h); if (!x || h === YHTEINEN || x.yv) return false;   /* 1:1 chatin koodi ei mene huoneeseen */ ilmoitetut.add(h); if (!x.jaettu) { x.jaettu = true; tallennaAse(); }
    if (x.avoin) jonoon(YHTEINEN, T.KUTSU, { n: (x.nimi || h).slice(0, 60), c: h });
    else { const { tag } = await avain(h); jonoon(YHTEINEN, T.KUTSU, { n: (x.nimi || h).slice(0, 60), t: tag, l: 1 }); }   // salasanallinen: vain nimi ja tunniste, salasana EI lahde huoneeseen
    return true; }
  // ---------- Lisaosat (0.14.0): jakajan tarjoamat lisaosat, koodi vasta pyynnosta ----------
  const LISAOSA_PALA = 1600, LEVY = 'http://127.0.0.1:9245/';
  const lisaosatTarjotut = new Map();   // jakajan nimi -> { ts, v: [{k,n,d,z}] }
  const lisaosatAjossa = new Map();     // k -> { from, n, kumoa }
  const lisaosatPalat = new Map();      // 'from|k' -> { n, pala: [], nimi }
  const omatLisaosat = () => (Array.isArray(ase.lisaosat) ? ase.lisaosat : (ase.lisaosat = []));
  function lisaosaLista() { return omatLisaosat().slice(0, 8).map(x => ({ k: x.k, n: String(x.n || x.k).slice(0, 60), d: String(x.d || '').slice(0, 120), z: x.levy ? 0 : String(x.s || '').length })); }
  function ilmoitaLisaosat() { jonoon(YHTEINEN, T.LISAOSAT, { v: lisaosaLista() }); return lisaosaLista().length; }   /* tyhja lista on SALLITTU: se on alasotto */
  function jaaLisaosa(x) {
    if (!x || !x.k || (typeof x.s !== 'string' && !x.levy)) return false;
    const y = { k: String(x.k).slice(0, 40), n: String(x.n || x.k).slice(0, 60), d: String(x.d || '').slice(0, 120) };
    if (x.levy) y.levy = String(x.levy).slice(0, 120); else y.s = String(x.s).slice(0, 4 * SMAX);
    if (x.u) y.u = String(x.u).slice(0, SMAX);
    ase.lisaosat = omatLisaosat().filter(z => z.k !== y.k); ase.lisaosat.push(y);
    tallennaAse(); ilmoitaLisaosat(); paivita(); return y.k;
  }
  function poistaLisaosa(k) { const ennen = omatLisaosat().length; ase.lisaosat = omatLisaosat().filter(z => z.k !== String(k)); tallennaAse(); ilmoitaLisaosat(); paivita(); return omatLisaosat().length < ennen; }
  async function lisaosaKoodi(x) {   /* levylta VASTA pyynnosta: paikallinen userscript-palvelin, ei selaimen muistia sita ennen */
    if (typeof x.s === 'string' && x.s) return x.s;
    if (!x.levy) return null;
    const r = await fetch(LEVY + encodeURIComponent(x.levy), { cache: 'no-store' });
    if (!r.ok) throw new Error('levy vastasi ' + r.status);
    return await r.text();
  }
  async function vastaaLisaosa(kysyja, k) {
    const x = omatLisaosat().find(y => y.k === String(k)); if (!x) return false;
    let koodi; try { koodi = await lisaosaKoodi(x); } catch (e) { tiedota(YHTEINEN, 'Lisaosaa "' + (x.n || x.k) + '" ei saatu levylta: ' + e.message); return false; }
    if (!koodi) return false;
    const paketti = JSON.stringify({ s: String(koodi), u: String(x.u || ''), n: String(x.n || x.k) });
    const n = Math.max(1, Math.ceil(paketti.length / LISAOSA_PALA));
    for (let i = 0; i < n; i++) jonoon(YHTEINEN, T.LISAOSAT, { r: 2, to: kysyja, k: x.k, i, n, s: paketti.slice(i * LISAOSA_PALA, (i + 1) * LISAOSA_PALA) });
    return n;
  }
  function asennaLisaosa(from, k) { jonoon(YHTEINEN, T.LISAOSAT, { r: 1, to: from, k }); lisaosatPalat.set(from + '|' + k, { n: 0, pala: [], nimi: from, odottaa: true }); paivita(); return true; }
  function ajaLisaosa(k, nimi2, koodi, kumoa, from) {
    /* Robon kaltainen automaattinen client ei saa jumittua confirm-dialogiin: ase.lisaosatAja === false estaa ajon kokonaan. */
    if (ase.lisaosatAja === false) { tiedota(YHTEINEN, 'Lisaosa "' + nimi2 + '" saapui (' + from + ') mutta ajaminen on estetty tassa selaimessa'); paivita(); return 'ajaminen estetty'; }
    const nayta = String(koodi).slice(0, 1200) + (String(koodi).length > 1200 ? '\n…(' + String(koodi).length + ' merkkia)' : '');
    if (!confirm('Lisaosa "' + nimi2 + '" kayttajalta ' + from + '\n\n' + nayta + '\n\nAjetaanko tama koodi selaimessasi?')) return false;
    const ennen = new Set(Array.prototype.slice.call(document.body.children));   /* mika oli jo olemassa: nimen perusteella ei voi erottaa omaa kopiota kayttajan omasta */
    const v = {}; const tulos = ajaToiminto({ a: 'js', s: String(koodi), u: String(kumoa || '') }, from, false, v);
    const lisatyt = [];
    const kerays = setInterval(() => { for (const el2 of Array.prototype.slice.call(document.body.children)) if (!ennen.has(el2) && lisatyt.indexOf(el2) < 0) lisatyt.push(el2); }, 500);
    setTimeout(() => clearInterval(kerays), 8000);   /* 8 s ikkuna: myohemmin ilmestyvia elementteja ei poisteta, ja se on sanottu ulos */
    lisaosatAjossa.set(k, { from, n: nimi2, kumoa: () => { clearInterval(kerays); try { if (v.kumoa) v.kumoa(); } catch (e) {} for (const el2 of lisatyt) { try { el2.remove(); } catch (e) {} } } });
    tiedota(YHTEINEN, 'Lisaosa "' + nimi2 + '" ajettu (' + from + '): ' + tulos); paivita(); return tulos;
  }
  function kumoaLisaosa(k, syy) { const x = lisaosatAjossa.get(String(k)); if (!x) return false; x.kumoa(); lisaosatAjossa.delete(String(k)); tiedota(YHTEINEN, 'Lisaosa "' + x.n + '" kumottu: ' + (syy || 'otit sen pois')); paivita(); return true; }
  function lisaosaTarjoukset() {   /* vain ne jakajat jotka ovat NYT samassa huoneessa (kp: "if you are available in the same room, it appears") */
    const paikalla = new Set(yksikot().map(u => u.name)), oma = omaNimi(), ulos = [];
    for (const [nimi, t] of lisaosatTarjotut) { if (nimi === oma || !paikalla.has(nimi)) continue; for (const x of t.v) ulos.push(Object.assign({ from: nimi }, x)); }
    return ulos;
  }

  // ---------- 1:1 chat (0.11.0) ----------
  // Kumpikin julkaisee lasnaolossa ECDH P-256 -julkisen avaimen (kentta p). Chatin id = SHA-256('yv1:' + yhteinen salaisuus),
  // eli molemmat johtavat saman id:n itse eika sita lahetetaa koskaan. Kutsu kertoo vain KENELLE se on, ei id:ta.
  // RAJA: avainpari on selainkohtainen ja localStoragessa. Nimen voi vaihtaa toinen kayttaja, joten chat on sidottu
  // AVAIMEEN eika nimeen: jos vastapuoli vaihtaa selainta, 1:1 chat on uusi chat eika vanha historia seuraa.
  const yvAvaimet = new Map();   // nimi -> vastapuolen raaka julkinen avain (base64url)
  const b64 = u => btoa(String.fromCharCode.apply(null, u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64p = t2 => { const t = String(t2).replace(/-/g, '+').replace(/_/g, '/'); const r = atob(t + '='.repeat((4 - t.length % 4) % 4)); const u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u; };
  let yvPari = null;
  const omaJulkinen = () => (yvPari && yvPari.raaka) || null;
  async function omaPari() {
    if (yvPari) return yvPari;
    try { const t = ase.yvAvain; if (t && t.y && t.r) {
      const yks = await crypto.subtle.importKey('jwk', t.y, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      yvPari = { yksityinen: yks, raaka: t.r }; return yvPari; } } catch (e) {}
    const pari = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raaka = b64(new Uint8Array(await crypto.subtle.exportKey('raw', pari.publicKey)));
    try { ase.yvAvain = { y: await crypto.subtle.exportKey('jwk', pari.privateKey), r: raaka }; tallennaAse(); } catch (e) {}
    yvPari = { yksityinen: pari.privateKey, raaka }; return yvPari;
  }
  omaPari().catch(() => {});   /* lammitetaan heti, jotta ensimmainen lasnaolokehys ehtii kantaa julkisen avaimen */
  async function yvId(nimi) {
    const toinen = yvAvaimet.get(nimi); if (!toinen) return null;
    const pari = await omaPari();
    const jul = await crypto.subtle.importKey('raw', b64p(toinen), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: jul }, pari.yksityinen, 256));
    const syote = new Uint8Array(4 + bits.length); syote.set(TE.encode('yv1:'), 0); syote.set(bits, 4);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', syote));
    let x = ''; for (let i = 0; i < 24; i++) x += h[i].toString(16).padStart(2, '0'); return x;   /* 48 merkkia hexaa: normId ei muuta sita */
  }
  function yvChat(nimi) { return ase.huoneet.find(h => h.yv && h.vastapuoli === nimi) || null; }
  const yvHuone = h => !!(ase.huoneet.find(x => x.id === h) || {}).yv;   /* 1:1 chat: vain kaksi osapuolta, joten palautus ei voi karata kolmannelle */
  async function avaaYv(nimi) {
    const id = await yvId(nimi); if (!id) return null;
    liity(id, '1:1 ' + nimi);
    const x = ase.huoneet.find(h => h.id === id); if (x) { x.yv = true; x.vastapuoli = nimi; tallennaAse(); }
    jonoon(YHTEINEN, T.KUTSU, { yv: 1, to: nimi });   /* pelkka herate: id ei kulje, joten kolmas ei paase mukaan */
    return id;
  }
  // historia (0.8.0): liityin myohemmin. r0 = pyynto, r2 = tarjous ("minulla on N viestia"), r3 = valinta, r1 = viestit.
  // Jokainen paikalla oleva tarjoaa mita sen MUISTISSA on, ja pyytaja valitsee parhaan -> saa myos muiden kirjoittamat viestit,
  // ei vain vastaajan omia. Toisen kadun kautta tullut viesti merkitaan valittajalla, koska nimen voi silloin vaarentaa.
  const historiaVastattu = new Map(), tarjoukset = new Map(), historiaPyyntoAika = new Map(), historiaSaapuneet = new Map();
  function historiaViestit(h) {
    const yv = yvHuone(h);   /* huonechatissa vain omat tiedostot, 1:1:ssa myos vastapuolen - han sai ne minulta tai antoi ne minulle, eika kolmatta ole */
    return lista(h).filter(v => (v.tyyppi === 'teksti' && v.teksti && !v.jarj) || (v.tyyppi === 'toiminto' && v.t && String(v.t.s || '').length <= 600)
      || (v.tyyppi === 'tiedosto' && (v.oma ? lahetetyt.has(h + '|' + v.id) : yv && !!v.blob))).slice(-40);
  }   // kortit mukaan, mutta vain pienet (asukanava)
  function pyydaHistoria(h) {
    const aika = Date.now();
    historiaVastattu.set(h, aika); historiaPyyntoAika.set(h, aika); tarjoukset.set(h, []);
    jonoon(h, T.HISTORIA, { r: 0 });
    setTimeout(() => jaaPyynnot(h, 0), 5000);
  }
  function jaaPyynnot(h, kierros) {   // jokaiselta pyydetaan VAIN ne id:t joita ei viela ole eika kukaan aiempi lupaa
    const tarj = (tarjoukset.get(h) || []).filter(x => x.i && x.i.length); if (!tarj.length) return;
    const on = new Set(lista(h).map(v => String(v.id)));
    const luvattu = new Set(); let lahti = 0;
    for (const t of tarj.sort((a, b) => b.i.length - a.i.length)) {
      const pyyda = t.i.filter(id => !on.has(id) && !luvattu.has(id)); if (!pyyda.length) continue;
      pyyda.forEach(id => luvattu.add(id));
      setTimeout(() => jonoon(h, T.HISTORIA, { r: 3, to: t.nimi, i: pyyda.slice(0, 40) }), lahti * 1200); lahti++;
    }
    if (!lahti && kierros < 1) return; if (kierros < 1) setTimeout(() => jaaPyynnot(h, kierros + 1), 15000);   // toinen kierros: jos jotain jai saamatta, kysytaan uudelleen
  }
  function tarjoaHistoria(h) { if (ase.historia === false) return; const vs = historiaViestit(h); if (!vs.length) return; jonoon(h, T.HISTORIA, { r: 2, m: vs.length, v: (vs[0] && vs[0].ts) || Date.now(), i: vs.map(v => String(v.id).slice(0, 16)).slice(-40) }); }   // id:t mukaan: pyytaja nakee kenella on MITA, ei vain montako
  const historiaErat = new Map();   // huone -> { erat: [[...]], ts }: pidetaan 2 min, jotta puuttuva era voidaan lahettaa uudelleen
  function vastaaHistoria(h, vain) {
    if (ase.historia === false) return;
    const oma = omaNimi(), vs = historiaViestit(h).filter(v => !vain || vain.has(String(v.id)));
    if (!vs.length) return;
    const erat = []; let era = [], pit = 0;
    const sulje = () => { if (era.length) erat.push(era); era = []; pit = 0; };
    for (const v of vs) { const kuka = v.oma ? oma : v.from, e = { i: v.id, s: v.ts || Date.now() };
      if (v.tyyppi === 'toiminto') { e.k = { a: String(v.t.a), x: v.t.x | 0, y: v.t.y | 0, s: String(v.t.s || '').slice(0, 600) }; if (v.t.u) e.k.u = String(v.t.u).slice(0, 300); }
      else if (v.tyyppi === 'tiedosto') e.d = { nimi: String(v.nimi || '').slice(0, 120), mime: String(v.mime || '').slice(0, 80), size: v.size | 0, n: v.n | 0 };
      else e.t = String(v.teksti).slice(0, 400);
      if (kuka && kuka !== oma) e.f = String(kuka).slice(0, 40);
      const koko = (e.t ? e.t.length : e.d ? (e.d.nimi.length + 60) : (e.k.s.length + (e.k.u ? e.k.u.length : 0) + 30)) + (e.f ? e.f.length : 0) + 40; if (pit + koko > 900) sulje(); era.push(e); pit += koko; }
    sulje();
    historiaErat.set(h, { erat, ts: Date.now() });
    erat.forEach((x, i) => jonoon(h, T.HISTORIA, { r: 1, p: i, n: erat.length, v: x }));
  }
  function lahetaHistoriaErat(h, mitka) { const tallessa = historiaErat.get(h); if (!tallessa || Date.now() - tallessa.ts > 120000) return;
    for (const i of mitka.slice(0, 10)) { const x = tallessa.erat[i]; if (x) jonoon(h, T.HISTORIA, { r: 1, p: i, n: tallessa.erat.length, v: x }); } }
  function vastaaKutsuihin() { const omat = ase.huoneet.filter(x => x.id !== YHTEINEN && (x.avoin || x.jaettu || ilmoitetut.has(x.id))); omat.forEach((x, i) => setTimeout(() => ilmoitaChat(x.id), 700 + i * 1400 + Math.random() * 1200)); return omat.length; }
  function lasnaLista(h) { const m = lasna.get(h), paikalla = new Set(yksikot().map(u => u.name)); return m ? [...m.keys()].filter(n => paikalla.has(n)) : []; }
  const historiaHaettu = new Set();
  let tarjouksetToistettu = false;
  function toistaTarjoukset() {   /* vastaanottajan lista tyhjeni myos: tarjotaan muistetut uudelleen kerran per sivunlataus */
    if (tarjouksetToistettu) return; tarjouksetToistettu = true;
    const nyt = Date.now();
    for (const x of tarjousLista()) { if (nyt - (x.ts || 0) > 6 * 3600 * 1000) continue; if (!ase.huoneet.some(h => h.id === x.huone)) continue;
      if (lista(x.huone).some(v => v.id === x.id)) continue;
      lisaa(x.huone, { id: x.id, tyyppi: 'tiedosto', from: '(sinä)', oma: true, ts: x.ts || nyt, nimi: x.nimi, mime: x.mime, size: x.size, blob: null, n: x.n, saatu: 0, tarjottu: true, lahde: x.url, kuitattu: [], yritykset: 0,
        kehys: { tyyppi: T.TARJOUS, otsikko: { id: x.id, nimi: x.nimi, mime: x.mime, size: x.size, n: x.n, s: x.ts || nyt } } });
      const v = lista(x.huone).find(y => y.id === x.id); if (v) setTimeout(() => lahetaKehys(x.huone, v), 1500 + Math.random() * 1500);
    }
  }
  function lasnaTick() { const r = huoneId(); if (r !== lasnaHuone) { lasnaHuone = r; if (r) { lasna.clear(); toistaTarjoukset(); setTimeout(() => { if (huoneId() === r) { jonoon(YHTEINEN, T.LASNA, { r: 0, c: tagilista(), p: omaJulkinen() }); jonoon(YHTEINEN, T.LISAOSAT, { r: 0 }); if (omatLisaosat().length) ilmoitaLisaosat(); } }, 2500); 
    ase.huoneet.forEach((x, i) => { const av = r + '|' + x.id; if (historiaHaettu.has(av) || lista(x.id).length) return; historiaHaettu.add(av); setTimeout(() => { if (huoneId() === r && !lista(x.id).length) pyydaHistoria(x.id); }, 4000 + i * 2500); });   /* sivun lataus tyhjentaa viestit: pyyda ne niilta joilla ne ovat viela muistissa (kp 1.10.) */
  } } }
  function kuittaa(huone, id) { if (ase.kuittaus === false || !id) return; let q = kuittausJono.get(huone); if (!q) kuittausJono.set(huone, q = { ids: new Set(), t: Date.now() }); q.ids.add(String(id).slice(0, 16)); }
  async function kasittele(huone, nimi, k) {
    const o = k.otsikko;
    if (k.tyyppi === T.TEKSTI) { lisaa(huone, { id: o.id, tyyppi: 'teksti', from: nimi, ts: +o.s || Date.now(), teksti: String(o.x || '').slice(0, 2000) }); kuittaa(huone, o.id); }   // o.s = lahettajan aika: uudelleenlahetys ei hyppaa listan loppuun
    else if (k.tyyppi === T.PALA) {
      const av = huone + '|' + o.id; let t = tiedostot.get(av);
      if (!t) { t = { pala: [], saatu: 0, n: o.n, nimi: String(o.nimi || 'tiedosto').slice(0, 120), mime: String(o.mime || ''), size: o.size, from: nimi, viim: 0, pyynnot: 0 }; tiedostot.set(av, t);
        lisaa(huone, { id: o.id, tyyppi: 'tiedosto', from: nimi, ts: Date.now(), nimi: t.nimi, mime: t.mime, size: o.size, blob: null, n: o.n, saatu: 0 }); }   /* vanha suora lahetys (0.11.0 ja vanhemmat): palat ilman tarjousta */
      if (t.from !== nimi) return; if (t.pala[o.i]) { if (t.saatu === t.n) kuittaa(huone, o.id); return; }   // kaksoiskappale valmiista: kuittaa uudelleen (aiempi kuittaus on voinut kadota)
      t.pala[o.i] = new Uint8Array(k.runko); t.saatu++; t.viim = Date.now(); t.pyynnot = 0;
      const v = lista(huone).find(x => x.id === o.id); if (v) { v.saatu = t.saatu; v.tila = ''; if (t.saatu === t.n) { v.blob = new Blob(t.pala, { type: t.mime }); kuittaa(huone, o.id); } }
      paivita();
    } else if (k.tyyppi === T.TARJOUS) {
      const id = String(o.id || '').slice(0, 16); if (!id || lista(huone).some(x => x.id === id)) { kuittaa(huone, id); return; }   /* sama tarjous uudelleen: kuittaa, ala kaksoista */
      const n = Math.max(1, Math.min(4000, o.n | 0));
      lisaa(huone, { id, tyyppi: 'tiedosto', from: nimi, ts: +o.s || Date.now(), nimi: String(o.nimi || 'tiedosto').slice(0, 120), mime: String(o.mime || '').slice(0, 80), size: Math.max(0, o.size | 0), blob: null, n, saatu: 0, tarjous: true });
      kuittaa(huone, id);
    } else if (k.tyyppi === T.POISTA) {
      const l = lista(huone), v = l.find(x => x.id === o.id); if (v && v.from === nimi) { l.splice(l.indexOf(v), 1); tiedostot.delete(huone + '|' + o.id); paivita(); }
    } else if (k.tyyppi === T.HISTORIA) {
      if (o.r === 0) { if (Date.now() - (historiaVastattu.get(huone) || 0) > 8000) { historiaVastattu.set(huone, Date.now()); setTimeout(() => tarjoaHistoria(huone), 300 + Math.random() * 2000); } return; }   // tarjoa: "minulla on N viestia"
      if (o.r === 2) { if (Date.now() - (historiaPyyntoAika.get(huone) || 0) > 8000) return; const t = tarjoukset.get(huone) || []; t.push({ nimi, m: Math.min(+o.m || 0, 40), v: +o.v || Date.now(), i: Array.isArray(o.i) ? o.i.map(x => String(x).slice(0, 16)).slice(0, 40) : [] }); tarjoukset.set(huone, t); return; }
      if (o.r === 3) { if (o.to === omaNimi()) { const vain = Array.isArray(o.i) ? new Set(o.i.map(x => String(x))) : null; setTimeout(() => vastaaHistoria(huone, vain), 300 + Math.random() * 800); } return; }   // minulta pyydettiin naita
      if (o.r === 4) { if (o.to === omaNimi() && Array.isArray(o.p)) lahetaHistoriaErat(huone, o.p.map(x => x | 0)); return; }   // puuttuvat erat uudelleen
      if (!Array.isArray(o.v)) return;
      if (o.n > 1) {   // numeroitu era: merkitse saapuneet ja pyyda aukot uudelleen
        /* 0.14.2 kp 1.10. "en saanu kaikkii viestei ku refresh. tuli vaa osa": tila oli HUONEKOHTAINEN, joten kun
           kolme osapuolta vastaa (jaaPyynnot jakaa id:t kaikille), jokaisen eran saapuminen NOLLASI edellisen
           aukkolaskennan -> puuttuvia eria ei pyydetty uudelleen keneltakaan. Avain on nyt huone JA vastaaja. */
        const sav = huone + '|' + nimi;
        let st = historiaSaapuneet.get(sav); if (!st || st.n !== o.n) { st = { from: nimi, n: o.n, saatu: new Set(), ajastin: null }; historiaSaapuneet.set(sav, st); }
        st.saatu.add(o.p | 0); clearTimeout(st.ajastin);
        if (st.saatu.size < o.n) st.ajastin = setTimeout(() => { const puuttuu = []; for (let i = 0; i < o.n; i++) if (!st.saatu.has(i)) puuttuu.push(i);
          if (puuttuu.length && (st.pyynnot = (st.pyynnot || 0) + 1) <= 3) jonoon(huone, T.HISTORIA, { r: 4, to: nimi, p: puuttuu }); }, 5000);
      }
      for (const e of o.v.slice(0, 40)) { if (!e || !e.i) continue; const kuka = e.f ? String(e.f).slice(0, 40) : nimi, oma = omaNimi(), omaViesti = !!oma && kuka === oma;
        // oma vanha viesti otetaan takaisin (muuten tyhjentynyt paneeli ei palaudu, kp 1.10. "toimii huonosti vanhojen haku"),
        // mutta se merkitaan valittajalla: nimen voi periaatteessa vaarentaa, joten lahde on nakyva.
        const pohja = { id: String(e.i).slice(0, 16), from: omaViesti ? '(sinä)' : kuka, oma: omaViesti, ts: +e.s || Date.now(), historia: true, valitti: nimi };
        if (e.d && typeof e.d === 'object') {   /* tiedostotarjous historiasta: tavut haetaan vasta Hae-napista, ja vain lahettajalta */
          if (omaViesti && !yvHuone(huone)) continue;   /* huonechat: oma vanha tiedosto olisi kuollut tarjous, koska vain lahettaja palvelee */
          lisaa(huone, Object.assign(pohja, { tyyppi: 'tiedosto', nimi: String(e.d.nimi || 'tiedosto').slice(0, 120), mime: String(e.d.mime || '').slice(0, 80), size: Math.max(0, e.d.size | 0), n: Math.max(1, Math.min(4000, e.d.n | 0)), blob: null, saatu: 0, tarjous: true, palautettu: omaViesti })); continue; }
        if (e.k && typeof e.k === 'object') { if (ase.toiminnot === false) continue;   // kortti: sama tarkistus kuin suorassa vastaanotossa, ajaminen vaatii yha ▶ ja varmistuksen
          const a = String(e.k.a); if (!Object.prototype.hasOwnProperty.call(TOIMINNOT, a) || typeof e.k.s !== 'string') continue;
          const t = { a, x: Math.max(0, Math.min(255, e.k.x | 0)), y: Math.max(0, Math.min(255, e.k.y | 0)), s: String(e.k.s).slice(0, SMAX) }; const u = kumoaKoodi({ a, u: e.k.u }); if (u) t.u = u;
          lisaa(huone, Object.assign(pohja, { tyyppi: 'toiminto', t })); continue; }
        lisaa(huone, Object.assign(pohja, { tyyppi: 'teksti', teksti: String(e.t || '').slice(0, 400) })); }
    } else if (k.tyyppi === T.KUTSU) {
      if (o.yv) { if (o.to !== omaNimi() || yvChat(nimi)) return; kutsut.set('yv:' + nimi, { n: '1:1 ' + nimi, yv: true, from: nimi, ts: Date.now() }); paivita(); return; }   /* vain minulle, ja vain jos chattia ei jo ole */
      const nimiX = String(o.n || '').replace(/[<>]/g, '').slice(0, 60) || 'chat';
      if (o.l && o.t) { kutsut.set('lukko:' + o.t, { n: nimiX, tag: String(o.t).slice(0, 8), lukko: true, from: nimi, ts: Date.now() }); paivita(); return; }   // lukittu: liittyja syottaa salasanan, tunniste kertoo onko se oikea
      const c = normId(String(o.c || '')); if (c.length < 6 || c.length > 80 || c === YHTEINEN) return;
      kutsut.set(c, { n: nimiX, c, from: nimi, ts: Date.now() }); paivita();
    } else if (k.tyyppi === T.LASNA) {
      let m = lasna.get(huone); if (!m) lasna.set(huone, m = new Map()); m.set(nimi, Date.now());
      if (typeof o.p === 'string' && /^[A-Za-z0-9_-]{80,200}$/.test(o.p)) yvAvaimet.set(nimi, o.p);   /* vastapuolen julkinen avain: 1:1 chatin id johdetaan siita, ei nimesta */
      if (Array.isArray(o.c)) for (const t2 of o.c.slice(0, 12)) { const id2 = tagiHuone.get(String(t2).slice(0, 12)); if (!id2) continue; let mm = lasna.get(id2); if (!mm) lasna.set(id2, mm = new Map()); mm.set(nimi, Date.now()); }   /* chatkohtainen lasnaolo: vain omat tunnetut tagit tunnistetaan, muut ohitetaan */
      if (o.r === 0 && Date.now() - (lasnaVastattu.get(huone) || 0) > 6000) { lasnaVastattu.set(huone, Date.now()); setTimeout(() => jonoon(huone, T.LASNA, { r: 1, c: tagilista(), p: omaJulkinen() }), 300 + Math.random() * 2000); vastaaKutsuihin(); }   // kysyjälle: vastaa läsnäololla JA ilmoita kaikki omat avoimet chatit uudelleen
      paivita();
    } else if (k.tyyppi === T.LISAOSAT) {
      if (o.r === 0) { if (omatLisaosat().length) setTimeout(() => ilmoitaLisaosat(), 300 + Math.random() * 1500); return; }   // joku kysyi: kerro omat
      if (o.r === 1) { if (o.to === omaNimi()) vastaaLisaosa(nimi, String(o.k || '').slice(0, 40)); return; }   // koodipyynto: levylta vasta nyt
      if (o.r === 2) {
        if (o.to !== omaNimi()) return;
        const av = nimi + '|' + String(o.k || '').slice(0, 40), st = lisaosatPalat.get(av); if (!st || !st.odottaa) return;   /* vain se mita ITSE pyysin */
        st.n = Math.max(1, Math.min(40, o.n | 0)); st.pala[o.i | 0] = String(o.s || '');
        let kaikki = 0; for (let i = 0; i < st.n; i++) if (typeof st.pala[i] === 'string') kaikki++;
        if (kaikki < st.n) { paivita(); return; }
        lisaosatPalat.delete(av);
        let paketti = null; try { paketti = JSON.parse(st.pala.join('')); } catch (e) { tiedota(YHTEINEN, 'Lisaosan koodi tuli rikkinaisena, yrita uudelleen'); paivita(); return; }
        if (!paketti || typeof paketti.s !== 'string') { paivita(); return; }
        ajaLisaosa(String(o.k).slice(0, 40), String(paketti.n || o.k).slice(0, 60), paketti.s, paketti.u, nimi);
        return;
      }
      if (!Array.isArray(o.v)) return;
      const v2 = o.v.filter(x => x && x.k).slice(0, 8).map(x => ({ k: String(x.k).slice(0, 40), n: String(x.n || x.k).slice(0, 60), d: String(x.d || '').slice(0, 120), z: Math.max(0, x.z | 0) }));
      lisaosatTarjotut.set(nimi, { ts: Date.now(), v: v2 });
      for (const [kk, tila] of [...lisaosatAjossa]) if (tila.from === nimi && !v2.some(x => x.k === kk)) kumoaLisaosa(kk, 'jakaja otti sen alas');   /* kill switch */
      paivita();
    } else if (k.tyyppi === T.KUITTAUS) {
      if (!Array.isArray(o.k)) return; let muuttui = false;
      for (const id of o.k.slice(0, 40)) { const v = lista(huone).find(x => x.id === String(id) && x.oma); if (v && v.kuitattu && !v.kuitattu.includes(nimi)) { v.kuitattu.push(nimi); v.eiKuittausta = false; tilasto.kuitattu++; muuttui = true; } }
      if (muuttui) paivita();
    } else if (k.tyyppi === T.TARVITSEN) {
      if (!Array.isArray(o.puuttuu)) return;
      const l = lahetetyt.get(huone + '|' + o.id);
      if (l) { for (const i of o.puuttuu.slice(0, 40)) if (i >= 0 && i < l.tied.n) jonoon(huone, T.PALA, Object.assign({ i }, l.tied), l.data.subarray(i * CHUNK, (i + 1) * CHUNK)); return; }
      if (tarjousLista().some(y => y.id === String(o.id) && y.huone === huone)) {   /* tarjous selvisi latauksesta: nouda lahteesta ja palvele */
        const pyyd = o.puuttuu.slice(0, 40).map(x => x | 0);
        palautaLahetetty(huone, String(o.id)).then(pal => { if (!pal) return;
          for (const i of pyyd) if (i >= 0 && i < pal.tied.n) jonoon(huone, T.PALA, Object.assign({ i }, pal.tied), pal.data.subarray(i * CHUNK, (i + 1) * CHUNK)); });
        return;
      }
      if (!yvHuone(huone)) return;   /* HUONECHAT: en palvele tiedostoa jota en itse lahettanyt (kp: "ettei ne jää tahattomasti pyörii") */
      const vv = lista(huone).find(x => x.id === o.id); if (!vv || !vv.blob) return;   /* 1:1: palautan vastapuolelle sen mita han menetti */
      const pyyd = o.puuttuu.slice(0, 40).map(x => x | 0);
      vv.blob.arrayBuffer().then(ab => { const data = new Uint8Array(ab), n = Math.max(1, Math.ceil(data.length / CHUNK));
        const tied = { id: vv.id, nimi: vv.nimi, mime: vv.mime, size: data.length, n };
        for (const i of pyyd) if (i >= 0 && i < n) jonoon(huone, T.PALA, Object.assign({ i }, tied), data.subarray(i * CHUNK, (i + 1) * CHUNK)); }).catch(() => {});
    } else if (k.tyyppi === T.TOIMINTO) {
      if (ase.toiminnot === false) return;
      kuittaa(huone, o.id);
      const t = { a: String(o.a), x: Math.max(0, Math.min(255, o.x | 0)), y: Math.max(0, Math.min(255, o.y | 0)), s: String(o.s || '').slice(0, SMAX) }; const u = kumoaKoodi({ a: t.a, u: o.u }); if (u) t.u = u;
      const v = lisaa(huone, { id: o.id, tyyppi: 'toiminto', from: nimi, ts: Date.now(), t });
      if (v && t.a === 'osoita' && ase.osoittimet !== false && !VW.__datajakoPois) { v.tulos = ajaToiminto(t, nimi, false, v); paivita(); }
      else if (v && ase.auto[nimi] && TOIMINNOT[t.a] && (!TOIMINNOT[t.a].vaarallinen || ase.autoKoodi) && !VW.__datajakoPois) ajaToiminto(t, nimi, false, v);
    }
  }
  // ---------- osoitin: "katso tätä" -merkki ruudulla (vain paikallinen piirto, 0 pakettia). Geometria samalla tavalla kuin debug-nakyma.user.js ----------
  const peliCanvas = () => { let paras = null, ala = 0; for (const c of document.querySelectorAll('canvas')) { const r = c.getBoundingClientRect(); if (r.width * r.height > ala) { ala = r.width * r.height; paras = c; } } return paras; };
  const huoneId = () => { try { const id = RE().activeRoomId; return Number.isInteger(id) && id > 0 ? id : null; } catch (e) { return null; } };
  function kamera(rid) {
    const r = RE(); const cv = r && r.getRoomInstanceRenderingCanvas(rid, 1); if (!cv) return null;
    const g = cv.geometry, gc = peliCanvas(); if (!g || !gc) return null;
    const rect = gc.getBoundingClientRect(), kx = rect.width / (cv._width || rect.width), ky = rect.height / (cv._height || rect.height);
    const V = g.direction.constructor, sc = cv._scale || 1, w2 = (cv._width || 0) / 2, h2 = (cv._height || 0) / 2, ox = cv._screenOffsetX || 0, oy = cv._screenOffsetY || 0;
    const piste = (x, y, z) => { const p = g.getScreenPoint(new V(x, y, z)); return p ? { x: rect.left + (p.x * sc + w2 + ox) * kx, y: rect.top + (p.y * sc + h2 + oy) * ky } : null; };
    const laatikko = bb => bb && bb.width > 0 ? { x: rect.left + bb.x * kx, y: rect.top + bb.y * ky, w: bb.width * kx, h: bb.height * ky } : null;
    return { piste, laatikko, rect };
  }
  function ruutuZ(rid, x, y) { try { const sm = RE().getFurnitureStackingHeightMap(rid); const z = sm && sm.getTileHeight(x, y); return Number.isFinite(z) ? z : 0; } catch (e) { return 0; } }
  const nimeltaHahmo = (rid, nimi) => { const r = RE(), inst = r.getRoomInstance(rid), sm = r._roomSessionManager && r._roomSessionManager.getSession(rid), ud = sm && sm.userDataManager;
    for (const u of inst.getRoomObjectsForCategory(100)) { const d = ud && ud.getUserDataByIndex(u.id); if (d && (d.name === nimi)) return u; } return null; };
  // kohde -> {poly:[pisteet]} | {box:{x,y,w,h}} näytön pikseleinä
  function kohdeGeometria(o, rid) {
    const r = RE();
    if (o.k === 'ui') { let e = null; try { e = o.sel ? document.querySelector(o.sel) : null; } catch (x) {}
      if (!e && o.teksti) e = [...document.querySelectorAll('button,a,[aria-label],input,.nitro-toolbar-icon')].find(n => (n.getAttribute('aria-label') || n.title || n.innerText || n.value || '').trim().slice(0, 40) === o.teksti) || null;
      if (!e) return null; const b = e.getBoundingClientRect(); return b.width || b.height ? { box: { x: b.left, y: b.top, w: b.width, h: b.height } } : null; }
    if (!rid || !r) return null; const k = kamera(rid); if (!k) return null;
    if (o.k === 'ruutu') { const x = o.x | 0, y = o.y | 0, z = ruutuZ(rid, x, y); const p = [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]].map(([a, b]) => k.piste(x + a, y + b, z)); return p.every(Boolean) ? { poly: p } : null; }
    let u = null, cat = 10;
    if (o.k === 'hahmo') { u = nimeltaHahmo(rid, o.nimi); cat = 100; }
    else if (o.k === 'furni') { const inst = r.getRoomInstance(rid); for (const c of [10, 20]) for (const f of inst.getRoomObjectsForCategory(c)) if (f.id === (o.id | 0)) { u = f; cat = c; } }
    if (!u) return null; let bb = null; try { bb = k.laatikko(r.getRoomObjectBoundingRectangle(rid, u.id, cat, 1)); } catch (e) {}
    return bb ? { box: bb } : null;
  }
  const osoittimet = new Map(); let osoitinAjastin = 0, osoitinSvg = null;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, att) => { const e = document.createElementNS(SVGNS, tag); for (const k in att) e.setAttribute(k, att[k]); return e; };
  function piirraOsoittimet() {
    const nyt = Date.now(); for (const [k, o] of osoittimet) if (nyt > o.loppu) osoittimet.delete(k);
    if (!osoitinSvg) { osoitinSvg = sv('svg', { style: 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:403;overflow:visible' }); document.body.append(osoitinSvg); }
    osoitinSvg.replaceChildren();
    if (!osoittimet.size) { clearInterval(osoitinAjastin); osoitinAjastin = 0; return; }
    const rid = huoneId();
    for (const o of osoittimet.values()) {
      let g = null; try { g = kohdeGeometria(o.kohde, rid); } catch (e) {} if (!g) continue;
      const pulssi = 0.55 + 0.45 * Math.abs(Math.sin(nyt / 260)); let tx, ty;
      if (g.poly) { osoitinSvg.append(sv('polygon', { points: g.poly.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' '), fill: 'rgba(255,48,48,' + (0.18 + 0.25 * pulssi).toFixed(2) + ')', stroke: '#ff3030', 'stroke-width': '3', 'stroke-linejoin': 'round' })); tx = (g.poly[0].x + g.poly[2].x) / 2; ty = (g.poly[0].y + g.poly[2].y) / 2; }
      else { const b = g.box, m = 4 + 3 * pulssi; osoitinSvg.append(sv('rect', { x: b.x - m, y: b.y - m, width: b.w + 2 * m, height: b.h + 2 * m, rx: 6, fill: 'rgba(255,48,48,0.10)', stroke: '#ff3030', 'stroke-width': '3', opacity: pulssi.toFixed(2) })); tx = b.x + b.w / 2; ty = b.y - m; }
      // nuoli: kärki tarkalleen kohteen keskipisteessä (ruutu) tai yläreunan keskellä (laatikko); keinuu pulssin mukana
      const ny = ty - 3 * pulssi, d = 'M' + tx + ',' + ny + ' L' + (tx - 11) + ',' + (ny - 18) + ' L' + (tx - 4) + ',' + (ny - 18) + ' L' + (tx - 4) + ',' + (ny - 38) + ' L' + (tx + 4) + ',' + (ny - 38) + ' L' + (tx + 4) + ',' + (ny - 18) + ' L' + (tx + 11) + ',' + (ny - 18) + ' Z';
      osoitinSvg.append(sv('path', { d, fill: '#ff3030', stroke: '#fff', 'stroke-width': '2', 'stroke-linejoin': 'round' }));
      if (g.poly) osoitinSvg.append(sv('circle', { cx: tx, cy: ty, r: 3, fill: '#fff', stroke: '#ff3030', 'stroke-width': '1.5' }));
      const t = sv('text', { x: tx, y: ny - 44, 'text-anchor': 'middle', 'font-size': '14', 'font-family': 'sans-serif', 'font-weight': 'bold', fill: '#fff', stroke: '#000', 'stroke-width': '3', 'paint-order': 'stroke' });
      t.textContent = o.nimi; osoitinSvg.append(t);
    }
  }
  function osoita(kohde, nimi) {
    if (!kohde || typeof kohde !== 'object') return false;
    osoittimet.set(String(nimi), { kohde, nimi: String(nimi).slice(0, 30), loppu: Date.now() + 8000 });
    if (!osoitinAjastin) osoitinAjastin = setInterval(piirraOsoittimet, 60); piirraOsoittimet(); return true;
  }
  // klikkauksesta kohde (lähettäjän puoli): peli-canvasin päällä hahmo/esine/ruutu, muuten käyttöliittymän elementti
  function valitsin(e) {
    const n = e.closest('button,a,input,select,textarea,[role=button],label,.nitro-card,.nitro-toolbar-icon') || e;
    const teksti = (n.getAttribute('aria-label') || n.title || n.innerText || n.value || '').trim().slice(0, 40), polku = []; let x = n;
    for (let i = 0; x && x.nodeType === 1 && x !== document.body && i < 6; i++, x = x.parentElement) {
      if (x.id) { polku.unshift('#' + CSS.escape(x.id)); break; }
      let sel = x.tagName.toLowerCase(); const lk = [...x.classList].filter(c => !/^(visible|invisible|active|show|d-|gap-|w-|h-|dj-)/.test(c)).slice(0, 2); if (lk.length) sel += '.' + lk.map(c => CSS.escape(c)).join('.');
      const sis = x.parentElement ? [...x.parentElement.children].filter(c => c.tagName === x.tagName) : []; if (sis.length > 1) sel += ':nth-of-type(' + (sis.indexOf(x) + 1) + ')';
      polku.unshift(sel);
    }
    return { k: 'ui', sel: polku.join(' > '), teksti };
  }
  // Lähettäjän viimeiset käyttöliittymäklikkaukset: "avaus-polku", jotta vastaanottaja voi avata saman näkymän ennen osoitusta.
  const klikit = [];
  addEventListener('pointerdown', e => { const t = e.target; if (!t || !t.closest || t === peliCanvas() || t.closest('.dj-ikkuna')) return;
    try { const v = valitsin(t); klikit.push({ sel: v.sel, teksti: v.teksti, t: Date.now() }); if (klikit.length > 8) klikit.shift(); } catch (x) {} }, true);
  async function avaaPolku(avaa) {
    for (const a of avaa || []) {
      let e = null; try { e = a.sel ? document.querySelector(a.sel) : null; } catch (x) {}
      if (!e && a.teksti) e = [...document.querySelectorAll('button,a,[aria-label],.nitro-toolbar-icon')].find(n => (n.getAttribute('aria-label') || n.title || n.innerText || '').trim().slice(0, 40) === a.teksti) || null;
      if (e) e.click(); await new Promise(r => setTimeout(r, 500));
    }
  }
  function kohdeKlikista(e) {
    const rid = huoneId(), r = RE();
    if (rid && r && e.target === peliCanvas()) {
      const k = kamera(rid), inst = r.getRoomInstance(rid), cx = e.clientX, cy = e.clientY; let paras = null;
      if (k) {
        for (const cat of [100, 10, 20]) for (const u of inst.getRoomObjectsForCategory(cat)) {
          let bb = null; try { bb = k.laatikko(r.getRoomObjectBoundingRectangle(rid, u.id, cat, 1)); } catch (x) {}
          if (!bb || cx < bb.x || cx > bb.x + bb.w || cy < bb.y || cy > bb.y + bb.h) continue;
          const ala = bb.w * bb.h, hahmo = cat === 100;
          if (!paras || (hahmo && !paras.hahmo) || (hahmo === paras.hahmo && ala < paras.ala)) paras = { cat, u, ala, hahmo };
        }
        if (paras) { if (paras.hahmo) { const sm = r._roomSessionManager && r._roomSessionManager.getSession(rid), d = sm && sm.userDataManager && sm.userDataManager.getUserDataByIndex(paras.u.id); if (d && d.name) return { k: 'hahmo', nimi: d.name }; }
          else return { k: 'furni', id: paras.u.id, nimi: paras.u.type || '' }; }
        const lw = r.getLegacyWallGeometry(rid); let ruutu = null;
        if (lw) for (let y = 0; y < (lw._height || 0); y++) for (let x = 0; x < (lw._width || 0); x++) {
          if (!lw.isRoomTile(x, y)) continue; const z = ruutuZ(rid, x, y), c = k.piste(x, y, z), a = k.piste(x + 0.5, y, z), b = k.piste(x, y + 0.5, z); if (!c || !a || !b) continue;
          const ax = a.x - c.x, ay = a.y - c.y, bx = b.x - c.x, by = b.y - c.y, det = ax * by - ay * bx; if (!det) continue;
          const dx = cx - c.x, dy = cy - c.y, u = (dx * by - dy * bx) / det, v = (ax * dy - ay * dx) / det;
          if (Math.abs(u) <= 1 && Math.abs(v) <= 1) { const m = Math.max(Math.abs(u), Math.abs(v)) - z * 0.001; if (!ruutu || m < ruutu.m || z > ruutu.z) ruutu = { x, y, z, m }; }
        }
        if (ruutu) return { k: 'ruutu', x: ruutu.x, y: ruutu.y };
      }
      return null;
    }
    const u = valitsin(e.target), nyt = Date.now();
    u.avaa = klikit.filter(k => nyt - k.t < 25000 && k.sel !== u.sel).slice(-4).map(k => ({ sel: k.sel, teksti: k.teksti }));
    return u;
  }

  function ajaToiminto(t, from, avaa, v) {
    if (!t || !Object.prototype.hasOwnProperty.call(TOIMINNOT, t.a)) return 'tuntematon toiminto';
    try {
      if (t.a === 'osoita') {
        const o = kohdeJson(t.s); if (!o) return 'virheellinen kohde';
        if (avaa && o.avaa && o.avaa.length) { avaaPolku(o.avaa).then(() => osoita(o, from || '?')); return 'avataan…'; }
        osoita(o, from || '?');
        if (o.k === 'ui' && !kohdeGeometria(o, huoneId())) return 'kohde ei ole näkyvissä' + (o.avaa && o.avaa.length ? ' - paina "Avaa ja osoita"' : '');
        return 'ok';
      }
      if (t.a === 'js') { const AF = Object.getPrototypeOf(async function () {}).constructor;
        // dj = apuri: kaikki sen kautta tehty muutos palautuu ⏹ Kumoa -napilla automaattisesti (vanha arvo talletetaan). t.u = käsin kirjoitettu kumoa-koodi ajetaan perään.
        const pal = [], dj = {
          palauta: f => { if (typeof f === 'function') pal.push(f); },
          aseta: (obj, key, arvo) => { const oli = Object.prototype.hasOwnProperty.call(obj, key), d = oli ? Object.getOwnPropertyDescriptor(obj, key) : null; pal.push(() => { if (oli) Object.defineProperty(obj, key, d); else delete obj[key]; }); obj[key] = arvo; return arvo; },
          korvaa: (obj, key, tehdas) => { const vanha = obj[key]; return dj.aseta(obj, key, tehdas(vanha)); },
          tyyli: css => { const st = document.createElement('style'); st.textContent = String(css); document.head.append(st); pal.push(() => st.remove()); return st; },
          kuuntele: (kohde, tp, f, opt) => { kohde.addEventListener(tp, f, opt); pal.push(() => kohde.removeEventListener(tp, f, opt)); },
          lisaa: (vanhempi, elem) => { vanhempi.append(elem); pal.push(() => elem.remove()); return elem; },
        };
        const kumoaKaikki = async () => { const errs = []; for (const f of pal.splice(0).reverse()) { try { await f(); } catch (e) { errs.push(e.message); } }
          if (kumoaKoodi(t)) { try { await new AF('dj', kumoaKoodi(t))({ palauta() {}, aseta() {}, korvaa() {}, tyyli() {}, kuuntele() {}, lisaa() {} }); } catch (e) { errs.push(e.message); } } if (errs.length) console.warn('[datajako] kumoa:', errs.join('; ')); };
        const valmis = r => { if (typeof r === 'function') pal.push(r); if (v && (pal.length || kumoaKoodi(t))) { v.kumoa = kumoaKaikki; paivita(); try { VW.kuplaDatajakoUI && VW.kuplaDatajakoUI.piirra(); } catch (e) {} } };
        // konsoli: skriptin console.log/warn/error kulkee sekä selaimen omaan konsoliin että kortille (jotta tuloksen voi katsoa ja lähettää takaisin)
        const loki = v ? (v.loki = []) : [], muoto = a => { try { return typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a)); } catch (e) { return String(a); } };
        const kirjaa = (taso, args) => { if (loki.length < 60) loki.push({ taso, teksti: args.map(muoto).join(' ').slice(0, 600) }); if (v) paivita(); };
        const kons = {}; for (const k of ['log', 'info', 'warn', 'error', 'debug']) kons[k] = (...a) => { kirjaa(k, a); try { console[k](...a); } catch (e) {} };
        const valmis2 = r => { if (r !== undefined && typeof r !== 'function') kirjaa('return', [r]); valmis(r); };
        new AF('dj', 'console', String(t.s || ''))(dj, kons).then(valmis2, e => { kirjaa('error', [e]); console.warn('[datajako] js:', e); valmis(); }); return 'ok'; }   // async: console-koodi saa käyttää await:ia ja return:ia
    } catch (e) { return 'virhe: ' + e.message; }
    return 'tuntematon toiminto';
  }
  async function lue() {
    if (lukee || !paalla()) return; lukee = true; try { lasnaTick(); } catch (e) {}
    try {
      const oma = omaNimi();
      const tagit = await Promise.all(ase.huoneet.map(async h => ({ id: h.id, tag: (await avain(h.id)).tag })));
      for (const u of yksikot()) {
        if (nahty.get(u.name) === u.figure) continue; nahty.set(u.name, u.figure); if (u.name === oma) continue;
        const m = OSA_RE.exec(u.figure); if (!m) continue; tilasto.osia++;
        const ehdokkaat = tagit.filter(x => x.tag === m[1].slice(0, 4)); if (!ehdokkaat.length) { tilasto.eiTagia++; continue; }
        let k = null, huone = null; for (const t of ehdokkaat) { k = await pura2(t.id, m[1].slice(4)); if (k) { huone = t.id; break; } }   // tag on vihje, ei tunniste: kokeile kaikki täsmäävät huoneet
        if (!k) { tilasto.eiAuki++; continue; }
        try { await kasittele(huone, u.name, k); tilasto.ok++; } catch (e) { tilasto.virhe++; tilasto.viimeVirhe = String(e && e.message).slice(0, 120); }
      }
      const nyt = Date.now();   // puuttuvien palojen pyyntö
      const paikalla = new Set(yksikot().map(u => u.name));
      for (const [av, t] of tiedostot) if (t.saatu < t.n) {
        const [h, id] = av.split('|'), v = lista(h).find(x => x.id === id); let tila = '';
        if (!paikalla.has(t.from)) tila = 'lähettäjä ei ole huoneessa'; else if (t.pyynnot >= 30) tila = 'lähettäjä ei vastaa';
        else if (nyt - t.viim > 6000) { t.pyynnot++; t.viim = nyt; const puuttuu = []; for (let i = 0; i < t.n; i++) if (!t.pala[i]) puuttuu.push(i); jonoon(h, T.TARVITSEN, { id, puuttuu }); }   // pyydä puuttuvia 6 s välein kunnes lähettäjä on poissa tai 30 pyyntöä on käytetty
        if (v && v.tila !== tila) { v.tila = tila; paivita(); }
      }
      for (const [h, q] of kuittausJono) if (nyt - q.t >= 400) { const ids = [...q.ids].slice(0, 25); ids.forEach(i => q.ids.delete(i)); jonoon(h, T.KUITTAUS, { k: ids }); if (q.ids.size) q.t = nyt; else kuittausJono.delete(h); }
      for (const [h, l] of viestit) for (const v of l) if (v.oma && v.kuitattu && !v.kuitattu.length && !v.eiKuittausta && v.laheti) {   // oma viesti ilman kuittausta: toista kaksi kertaa, sitten merkitse
        const odotus = (v.tyyppi === 'tiedosto' && !v.tarjottu ? (v.n || 1) * GAP + 10000 : (jono.length + 1) * GAP + (v.yritykset <= 1 ? 5000 : 9000));
        if (nyt - v.laheti > odotus) { if (v.kehys && v.yritykset < 3) lahetaKehys(h, v); else { v.eiKuittausta = true; paivita(); } }
      }
    } finally { lukee = false; }
  }

  // ---------- huoneiden hallinta ----------
  // Huoneen koodi = salalause. Luettava: kolme sanaa + numero (kuu-sieni-tuli-427, ~32 bittiä: mukavuus, ei vahva salaus). Oma lause käy myös (pitkä = vahvempi).
  const SANAT = 'kuu aurinko tuuli sieni kissa koira puu lehti kivi joki jarvi meri lintu kala karhu susi kettu orava hiiri pilvi sade lumi jaa tuli savu kukka omena paaryna mansikka mustikka leipa juusto kahvi tee maito kello avain ovi ikkuna talo tie silta vene auto juna pyora kirja kyna paperi pallo lamppu peili tuoli poyta sanka kuppi lautanen lusikka veitsi haarukka kenka lakki takki hanska sukka huivi reppu laukku rahaa kolikko timantti kulta hopea rauta lasi muovi puuvilla villa kala rapu simpukka kaktus ruusu tulppaani kuusi manty koivu tammi paju metsa niitty vuori laakso saari ranta aalto hiekka multa savi kallio polku aukio katu kauppa koulu kirkko tori puisto sauna uima kuuma kylma iso pieni vihrea sininen punainen keltainen musta valkoinen harmaa ruskea oranssi violetti nopea hidas kirkas hiljainen utelias rohkea viisas'.split(' ');
  const uusiHuoneId = () => { const r = crypto.getRandomValues(new Uint32Array(4)); return [0, 1, 2].map(i => SANAT[r[i] % SANAT.length]).join('-') + '-' + (100 + r[3] % 900); };
  const normId = id => String(id || '').trim().toLowerCase().replace(/\s+/g, '-');
  function nimeaHuone(id, nimi) { const h = ase.huoneet.find(x => x.id === id); if (!h) return false; h.nimi = String(nimi || '').trim().slice(0, 60) || id; tallennaAse(); paivita(); return true; }
  function liity(id, nimi) { id = normId(id); if (id.length < 6 || id.length > 80) return false; const uusi = !ase.huoneet.some(h => h.id === id); if (uusi) { ase.huoneet.push({ id, nimi: nimi || id }); setTimeout(() => pyydaHistoria(id), 1500); } else if (nimi) nimeaHuone(id, nimi); /* juuri liityin: hae vanhat viestit itse (kp 1.10.) */ ase.valittu = id; ase.nakyma = 'chat'; tagiTieto(id); tallennaAse(); paivita(); return true; }
  function tyhjennaHuone(id) { viestit.delete(id); for (const m of [tiedostot, lahetetyt]) for (const k of [...m.keys()]) if (k.startsWith(id + '|')) m.delete(k); kuittausJono.delete(id); for (let i = jono.length - 1; i >= 0; i--) if (jono[i].huone === id) jono.splice(i, 1); paivita(); }   // vain oma muisti: ei paketteja, ei ilmoitusta muille
  function poistuHuoneesta(id) { if (id === YHTEINEN) return tyhjennaHuone(id); ilmoitetut.delete(id); kutsut.delete(id); tyhjennaHuone(id); ase.huoneet = ase.huoneet.filter(h => h.id !== id); if (ase.valittu === id) ase.valittu = (ase.huoneet[0] || {}).id || null; tallennaAse(); paivita(); }

  // ---------- kirjanpito, vienti, tuonti ----------
  function tallennaMerkinta(m, nimi) { const s = siivoaMerkinta(Object.assign({}, m, { nimi: String(nimi || '').trim(), ts: Date.now() })); if (!s) return null; ase.tallennetut.push(s); tallennaAse(); paivita(); return s; }
  function vieAsetukset(huonekoodit) {
    return { laji: 'datajako-asetukset', versio: 1, aika: new Date().toISOString(), laatu: ase.laatu, maxSivu: ase.maxSivu, auto: Object.keys(ase.auto).filter(k => ase.auto[k]), tallennetut: ase.tallennetut, huoneet: huonekoodit ? ase.huoneet : undefined };
  }
  // Tuonti yhdistää (ei korvaa) tallennetut ja huoneet; autoKoodia ei koskaan tuoda; etäohjauslista vain valinnalla.
  function tuoAsetukset(ut, valinnat) {
    valinnat = valinnat || {}; const r = { uusia: 0, kaksoisia: 0, huoneita: 0 };
    const olemassa = new Set(ase.tallennetut.map(merkinnanAvain));
    for (const m of ut.tallennetut) { const k = merkinnanAvain(m); if (olemassa.has(k)) r.kaksoisia++; else { olemassa.add(k); ase.tallennetut.push(m); r.uusia++; } }
    for (const h of ut.huoneet) if (!ase.huoneet.some(x => x.id === h.id)) { ase.huoneet.push(h); r.huoneita++; }
    if (ut.laatu != null) ase.laatu = ut.laatu; if (ut.maxSivu != null) ase.maxSivu = ut.maxSivu;
    if (valinnat.auto) for (const a of ut.auto) ase.auto[a] = true;
    tallennaAse(); paivita(); return r;
  }

  // ---------- komentokäsittelijä ----------
  // Komennot eivät lähde tavallisena viestinä. Omia voi rekisteröidä: kuplaDatajako.komennot.rekisteroi('nimi', 'ohje', (args, ctx) => {...})
  // ctx = { huone, args, kumoa, ase, tulosta(teksti) (vain omaan paneeliin), laheta: { teksti(t), toiminto(a, s, u, x, y), tiedosto(blob, nimi) } }
  const komennot = new Map();
  function rekisteroiKomento(nimi, ohje, aja) { const k = komentoNimi(nimi); if (!k || typeof aja !== 'function') return false; komennot.set(k, { ohje: String(ohje || '').slice(0, 140), aja }); return true; }
  function tiedota(huone, teksti) { lisaa(huone, { id: uusiId(), tyyppi: 'teksti', from: '(datajako)', oma: true, jarj: true, ts: Date.now(), teksti: String(teksti) }); }
  const HALLINTA = ['paalla', 'pois', 'ohje', 'maaraa', 'unohda', 'pienenna', 'uusi', 'liity'];
  function ajaKomento(h, j) {
    const ctx = { huone: h, args: j.args, kumoa: j.kumoa, ase, tulosta: t => tiedota(h, t), laheta: { teksti: t => lahetaTeksti(h, t), toiminto: (a, s, u, x, y) => lahetaToiminto(h, a, x | 0, y | 0, s, u), tiedosto: (b, n) => lahetaTiedosto(h, b, n) } };
    const k = komennot.get(j.nimi), x = k ? null : ase.tallennetut.find(m => komentoNimi(m.nimi) === j.nimi);
    if (!k && !x) return false;
    if (!paalla() && !(k && HALLINTA.includes(j.nimi))) { tiedota(h, 'Datajako on pois päältä: /paalla tai ⚙-asetukset.'); return true; }
    if (k) { try { k.aja(j.args, ctx); } catch (e) { tiedota(h, 'Komento /' + j.nimi + ' kaatui: ' + e.message); } return true; }
    if (x.laji === 'toiminto') { const sub = x.t.a === 'js', js = x.t.a === 'js';
      lahetaToiminto(h, x.t.a, x.t.x, x.t.y, sub ? sijoita(x.t.s, j.args, js) : x.t.s, x.t.u ? sijoita(x.t.u, j.args, js) : undefined); }
    else if (x.laji === 'teksti') lahetaTeksti(h, sijoita(x.teksti, j.args, false));
    else lahetaTiedosto(h, new Blob([x.sisalto], { type: x.mime }), x.tnimi);
    return true;
  }
  const kayt = (c, t) => c.tulosta('Käyttö: ' + t);
  rekisteroiKomento('ohje', 'luettelo komennoista', (a, c) => {
    const sis = [...komennot].map(([n, k]) => '/' + n + ' - ' + k.ohje), omat = ase.tallennetut.filter(m => komentoNimi(m.nimi)).map(m => '/' + komentoNimi(m.nimi) + ' - tallennettu ' + (m.laji === 'toiminto' ? (kuvaus(m.t) || '') : m.laji));
    c.tulosta('Komennot (eivät lähde viestinä):\n' + sis.concat(omat).join('\n') + '\n// alussa = kirjaimellinen /-viesti · " ## " erottaa kumoa-koodin · $1..$9 ja $* korvataan argumenteilla (js: muuttujina $1..$9 ja $all)');
  });
  rekisteroiKomento('js', 'lähetä JS-koodi: /js <koodi> [ ## kumoa-koodi]', (a, c) => a ? c.laheta.toiminto('js', a, c.kumoa) : kayt(c, '/js <koodi> [ ## kumoa-koodi]'));
  rekisteroiKomento('paalla', 'kytke Datajako päälle', (a, c) => { ase.paalla = true; tallennaAse(); paivita(); c.tulosta('Datajako on päällä.'); });
  rekisteroiKomento('pois', 'kytke Datajako pois (ei lähetystä eikä vastaanottoa)', (a, c) => { ase.paalla = false; jono.length = 0; tallennaAse(); paivita(); c.tulosta('Datajako on pois päältä. /paalla kytkee takaisin.'); });
  rekisteroiKomento('maaraa', 'tallenna oma komento: /maaraa <nimi> <js/komento/teksti> <sisältö> [ ## kumoa]', (a, c) => {
    const m = /^(\S+)\s+(js|komento|teksti)\s+([\s\S]+)$/.exec(a); if (!m) return kayt(c, '/maaraa <nimi> <js/komento/teksti> <sisältö> [ ## kumoa]');
    const nimi = komentoNimi(m[1]); if (komennot.has(nimi)) return c.tulosta('/' + nimi + ' on varattu sisäänrakennetulle komennolle.');
    const mm = m[2] === 'teksti' ? { laji: 'teksti', teksti: m[3], from: '(sinä)' } : { laji: 'toiminto', from: '(sinä)', t: { a: m[2], x: 0, y: 0, s: m[3], u: c.kumoa } };
    c.tulosta(tallennaMerkinta(mm, nimi) ? 'Tallennettu: /' + nimi + ' (kirjoita /' + nimi + ' lähettääksesi; $1..$9 = argumentit, js:ssä muuttujina)' : 'Ei kelpaa (sisältö tyhjä tai liian pitkä).'); });
  rekisteroiKomento('unohda', 'poista tallennettu: /unohda <nimi>', (a, c) => { const n = komentoNimi(a), i = ase.tallennetut.findIndex(m => komentoNimi(m.nimi) === n); if (i < 0) return c.tulosta('Ei tallennettua nimeltä /' + n); ase.tallennetut.splice(i, 1); tallennaAse(); paivita(); c.tulosta('Poistettu: /' + n); });

  // ---------- kuvanpakkaus ----------
  async function pakkaaKuva(file, laatu, maxSivu) {
    maxSivu = +maxSivu > 0 ? +maxSivu : 1024; laatu = +laatu > 0 ? +laatu : 0.7;
    const bmp = await createImageBitmap(file), s = Math.min(1, maxSivu / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise(r => c.toBlob(r, 'image/webp', laatu));
  }

  // 1:1 chatin sisaankaynti PELIN omassa hahmovalikossa (kp 1.10. "lisätään right click valikkoon lähetä viesti,
  // jos sillä on toi extensio ja on huoneessa"). Sopimus on klikkikavelyn dokumentoima jono: kohde 'hahmo' = joku muu
  // kuin sina, ctx.hahmo = { nimi, tyyppi, ... }. tyyppi 1 = kayttaja, ei lemmikki eika botti.
  // NAKYY-EHTO: yvAvaimet.has(nimi) tarkoittaa etta han on LAHETTANYT lasnaolossa julkisen avaimensa, eli hanella on
  // Datajako 0.11.0+ ja olemme olleet samassa huoneessa sen jalkeen. Huoneessa olo tulee siita etta klikkasit hanen
  // hahmoaan. RAJA: jos hanen Datajako on ASENNETTU mutta kytketty pois, rivi nakyy mutta kutsu ei tavoita ketaan.
  // MITATTU 1.10.: jokainen uudelleenasennus lisasi rivin uudelleen (2 rivia kp:n valikossa). Rivi tyontetaan
  // jonoon VAIN KERRAN ja se delegoi tahan apiin, jonka uusin skriptiversio ylikirjoittaa -> ei kaksoiskappaleita
  // eika vanhentuneita sulkeumia (vanha rivi olisi osoittanut edellisen latauksen yvAvaimet-karttaan).
  VW.__djValikkoApi = {
    nimi: ctx => yvChat(ctx && ctx.hahmo && ctx.hahmo.nimi) ? 'Avaa 1:1 chat' : 'L\u00e4het\u00e4 viesti',
    nakyy: ctx => !!(ctx && ctx.hahmo && ctx.hahmo.nimi && ctx.hahmo.tyyppi === 1 && paalla() && yvAvaimet.has(ctx.hahmo.nimi)),
    tee: async ctx => { const n = ctx.hahmo.nimi, id = await avaaYv(n); if (!id) return n + ': ei Datajakoa'; try { VW.kuplaDatajakoUI && VW.kuplaDatajakoUI.avaa(); } catch (e) {} return '1:1 chat: ' + n; } };
  if (!VW.__djValikkoRivi) { VW.__djValikkoRivi = true;
    (VW.kuplaValikkoJono = VW.kuplaValikkoJono || []).push({ kohde: 'hahmo', lisaosa: 'Datajako',
      nimi: ctx => VW.__djValikkoApi.nimi(ctx), nakyy: ctx => VW.__djValikkoApi.nakyy(ctx), tee: ctx => VW.__djValikkoApi.tee(ctx) }); }
  VW.kuplaDatajako = { versio: VERSIO, tagilista, tarjousLista, palautaLahetetty, toistaTarjoukset, jaaLisaosa, poistaLisaosa, asennaLisaosa, kumoaLisaosa, ilmoitaLisaosat, lisaosaTarjoukset, lisaosatAjossa, lisaosatTarjotut, omatLisaosat, avaaYv, yvId, yvChat, yvHuone, yvAvaimet, haeTiedosto, historiaViestit, lahetetyt, tiedostot, lasnaLista, ilmoitaChat, vastaaKutsuihin, kutsut, ilmoitetut, pyydaHistoria, tarjoukset, tilasto, osoita, kohdeKlikista, kohdeGeometria, ase, viestit, lista, liity, uusiHuoneId, lahetaTeksti, lahetaTiedosto, lahetaToiminto, lahetaTiedostoUudelleen, omaNimi, poistaJaettu, poistaOmasta, poistuHuoneesta, tyhjennaHuone, nimeaHuone, pakkaaKuva, ajaToiminto, kuvaus, puhdasAsu, kuuntelijat, tallennaAse, tallennaMerkinta, komennot: { rekisteroi: rekisteroiKomento, poista: n => komennot.delete(komentoNimi(n)), lista: () => [...komennot.keys()] }, ajaKomento, jasenna, vieAsetukset, tuoAsetukset, siivoaTuonti, siivoaMerkinta, jono, CHUNK, GAP, RAJA, lue, yksikot };

  // ---------- ajastin (Worker: piilotettu välilehti ei kuristu) ----------
  let n = 0;
  const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(1),25)'])));
  w.onmessage = () => { try { n++; if (n % 2 === 0) lue(); laheteTick(); } catch (e) {} };
  setTimeout(aloitusSiivous, 3000);

  // ---------- käyttöliittymä: pelin OMAT luokat (nitro-card ikkuna, chat-bubble puhekupla, btn, form-control) ----------
  function teeUI() {
    if (!ase.tallennetut) ase.tallennetut = [];
    const el = (tag, cls, txt, att) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; if (att) for (const k in att) e.setAttribute(k, att[k]); return e; };
    const NL = String.fromCharCode(10);
    const kopioi = (txt, n) => { const ok = () => { const o = n.textContent; n.textContent = '✓ kopioitu'; setTimeout(() => { n.textContent = o; }, 1200); };
      const vara = () => { const ta = el('textarea'); ta.value = txt; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.append(ta); ta.select(); try { document.execCommand('copy'); ok(); } catch (e) {} ta.remove(); };
      try { navigator.clipboard.writeText(txt).then(ok, vara); } catch (e) { vara(); } };
    const nfs = t => String(t).replace(/\u2014/g, '-');   // pelin fontti piirtää em-viivan nuottimerkkinä: vain näytössä, kopiointi ja lähetys säilyttävät alkuperäisen
    const kb = b => b < 1024 ? b + ' t' : (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' kt';
    const st = el('style', null, '.dj-pois{display:none!important} .dj-ikkuna .chat-content,.dj-ikkuna .chat-content *{user-select:text!important;-webkit-user-select:text!important;cursor:text} .dj-ikkuna .chat-content button{cursor:pointer;user-select:none!important} .dj-ikkuna .chat-content a{cursor:pointer!important;pointer-events:all!important;text-decoration:underline}'); document.head.append(st);   // pelin CSS estää tekstin valinnan -> sallitaan
    const nayta = (e, on) => e.classList.toggle('dj-pois', !on);
    const tauko = (f, ms) => { let t = 0; return () => { clearTimeout(t); t = setTimeout(f, ms); }; };

    // --- päänkuvat: pelin oma kuvantaja, sama URL jota chat-historia.user.js ja pelin kuplat käyttävät (headonly=1&size=l -> 58x92)
    const paaKuva = fig => fig ? location.origin + '/avatarimage?figure=' + encodeURIComponent(fig) + '&headonly=1&size=l' : '';
    const figureNimelle = nimi => { if (nimi === '(sinä)') { const o = omaAsu(); return o && puhdasAsu(o.figure); } const u = yksikot().find(x => x.name === nimi); return u && puhdasAsu(u.figure); };

    // --- tiedoston avaus/lataus (Avaa EI koskaan aja mitään sivulla: vain kuva/pdf omana tyyppinään, kaikki muu tekstinä)
    function avaa(v) {
      if (!v.blob) return; const mime = v.mime || '', turvallinen = /^image\/(png|jpeg|webp|gif)$/.test(mime) || mime === 'application/pdf';
      const u = URL.createObjectURL(turvallinen ? v.blob : new Blob([v.blob], { type: 'text/plain;charset=utf-8' }));
      window.open(u, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(u), 600000);
    }
    function lataa(v) { if (!v.blob) return; const u = URL.createObjectURL(v.blob), a = el('a'); a.href = u; a.download = v.nimi || 'tiedosto'; a.addEventListener('click', e => e.stopPropagation()); document.body.append(a); a.click(); a.remove();   // pelin oma linkkikäsittelijä kutsuu preventDefault kaikille a-klikeille (mitattu 1.10.): ilman stopPropagationia lataus ei koskaan käynnisty
     setTimeout(() => URL.revokeObjectURL(u), 600000); }   // Tallenna nimellä -ikkuna voi olla auki pitkään: blob-osoite elää 10 min (aiemmin 10 s -> lataus kuoli jos nimen kirjoitus kesti)

    // --- ikkunakehys
    const ikkuna = el('div', 'position-absolute draggable-window dj-ikkuna');
    Object.assign(ikkuna.style, { position: 'fixed', right: '24px', bottom: '90px', zIndex: '402', width: ((ase.ikkunaKoko && ase.ikkunaKoko.w) || 390) + 'px', display: 'none' });
    const kortti = el('div', 'd-flex flex-column nitro-card rounded theme-primary-slim');
    const otsikko = el('div', 'd-flex position-relative flex-column gap-2 align-items-center justify-content-center drag-handler container-fluid nitro-card-header');
    const orivi = el('div', 'd-flex w-100'); const sulje = el('button', 'd-flex align-items-center justify-content-center position-absolute end-2 nitro-card-header-close', '✕', { type: 'button', 'aria-label': 'Sulje ikkuna' });
    const otsikkoTeksti = el('span', 'nitro-card-header-text', 'Datajako');
    const piensi = el('button', 'd-flex align-items-center justify-content-center position-absolute btn btn-secondary btn-sm', '–', { type: 'button', 'aria-label': 'Pienennä ikkuna', title: 'Pienennä (tai kaksoisklikkaa otsikkoa)' });
    Object.assign(piensi.style, { right: '38px', top: '50%', transform: 'translateY(-50%)', width: '22px', height: '22px', padding: '0', lineHeight: '1', fontWeight: 'bold' });
    let pien = !!ase.pienennetty;
    orivi.append(otsikkoTeksti, piensi, sulje); otsikko.append(orivi);
    const runko = el('div', 'd-flex flex-column gap-2 container-fluid content-area'); runko.style.cssText = 'height:' + ((ase.ikkunaKoko && ase.ikkunaKoko.h) || 470) + 'px;overflow:hidden';
    kortti.append(otsikko, runko); ikkuna.append(kortti);
    // koon muutos: kahvat oikeassa alakulmassa (ja oikeassa/alareunassa); koko muistetaan (ase.ikkunaKoko)
    const kahva = (nimi, kursori, tyyli) => { const k = el('div', 'dj-kahva'); k.dataset.kahva = nimi; k.style.cssText = 'position:absolute;z-index:5;touch-action:none;cursor:' + kursori + ';' + tyyli; ikkuna.append(k); return k; };
    kahva('se', 'nwse-resize', 'right:0;bottom:0;width:18px;height:18px;background:linear-gradient(135deg,transparent 50%,rgba(0,0,0,.45) 50%,rgba(0,0,0,.45) 58%,transparent 58%,transparent 70%,rgba(0,0,0,.45) 70%,rgba(0,0,0,.45) 78%,transparent 78%)');
    kahva('e', 'ew-resize', 'right:0;top:34px;bottom:18px;width:6px'); kahva('s', 'ns-resize', 'left:0;right:18px;bottom:0;height:6px');
    ikkuna.querySelectorAll('.dj-kahva').forEach(k => k.addEventListener('pointerdown', e => { if (pien) return; e.preventDefault(); e.stopPropagation();
      const r = ikkuna.getBoundingClientRect(), w0 = r.width, h0 = runko.getBoundingClientRect().height, x0 = e.clientX, y0 = e.clientY, n = k.dataset.kahva;
      ikkuna.style.left = r.left + 'px'; ikkuna.style.top = r.top + 'px'; ikkuna.style.right = 'auto'; ikkuna.style.bottom = 'auto';   // ankkuri vasen-ylä, jotta koko kasvaa kursorin suuntaan
      const liiku = ev => { if (n !== 's') ikkuna.style.width = Math.min(Math.max(300, w0 + ev.clientX - x0), innerWidth - r.left - 2) + 'px'; if (n !== 'e') runko.style.height = Math.min(Math.max(260, h0 + ev.clientY - y0), innerHeight - r.top - (r.height - h0) - 2) + 'px'; };
      const loppu = () => { removeEventListener('pointermove', liiku); removeEventListener('pointerup', loppu); ase.ikkunaKoko = { w: Math.round(ikkuna.getBoundingClientRect().width), h: Math.round(runko.getBoundingClientRect().height) }; tallennaAse(); };
      addEventListener('pointermove', liiku); addEventListener('pointerup', loppu); }));
    // raahaus
    otsikko.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; const r = ikkuna.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      let siirtyi = false; const x0 = e.clientX, y0 = e.clientY;
      const liiku = ev => { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 3) siirtyi = true; ikkuna.style.left = Math.max(0, ev.clientX - dx) + 'px'; ikkuna.style.top = Math.max(0, ev.clientY - dy) + 'px'; ikkuna.style.right = 'auto'; ikkuna.style.bottom = 'auto'; };
      const loppu = () => { removeEventListener('pointermove', liiku); removeEventListener('pointerup', loppu); if (pien && !siirtyi) asetaPien(false); }; addEventListener('pointermove', liiku); addEventListener('pointerup', loppu); });
    otsikko.addEventListener('dblclick', e => { if (!e.target.closest('button')) asetaPien(!pien); });
    piensi.onclick = () => asetaPien(!pien);
    for (const t of ['keydown', 'keyup', 'keypress']) ikkuna.addEventListener(t, ev => ev.stopPropagation());

    // --- yläpalkki: chat-valinta + asetukset
    const ylarivi = el('div', 'd-flex gap-1 align-items-center');
    const valinta = el('select', 'form-select form-select-sm'); valinta.style.flex = '1';
    const asetusNappi = el('button', 'btn btn-secondary btn-sm', '⚙', { type: 'button', title: 'Asetukset' });
    const takaisin = el('button', 'btn btn-secondary btn-sm', '‹', { type: 'button', title: 'Takaisin chattilistaan' });
    takaisin.style.cssText = 'padding:0 7px'; takaisin.onclick = () => { ase.nakyma = 'lista'; tallennaAse(); piirra(); };
    ylarivi.append(takaisin, valinta, asetusNappi);
    const liityRivi = el('div', 'd-flex gap-1 align-items-center flex-wrap'); liityRivi.classList.add('dj-pois');
    const nimiKentta = el('input', 'form-control form-control-sm', null, { type: 'text', placeholder: 'chatin nimi, esim. Res ja minä', maxlength: '60', style: 'flex:1 1 140px' });
    const liityNappi = el('button', 'btn btn-success btn-sm', 'Luo', { type: 'button' });
    const peruLiity = el('button', 'btn btn-secondary btn-sm', 'Peru', { type: 'button' });
    const liityKentta = el('input', 'form-control form-control-sm', null, { type: 'text', placeholder: 'salasana (tyhjä = ei salasanaa)', maxlength: '80', style: 'flex:1 1 140px', title: 'Tyhjä: chat ilmoitetaan huoneeseen ja muut liittyvät napilla. Salasana: chat on yksityinen, ja ilmoitus kertoo vain nimen – salasanaa ei lähetetä koskaan.' });
    for (const b of [liityNappi, peruLiity]) b.style.cssText = 'padding:0 8px;font-size:11px';
    peruLiity.onclick = () => { nimiKentta.value = ''; liityKentta.value = ''; liityKentta.style.outline = ''; nayta(liityRivi, false); };
    liityRivi.append(nimiKentta, liityKentta, liityNappi, peruLiity);
    const info = el('div', 'text-black nitro-small-size-text'); info.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
    const viestiLaatikko = el('div', 'd-flex flex-column chat-history-list'); viestiLaatikko.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;padding:4px 2px;min-height:80px';
    const listaLaatikko = el('div', 'd-flex flex-column gap-1 text-black'); listaLaatikko.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;padding:4px 2px;min-height:80px';
    const lisaLaatikko = el('div', 'd-flex flex-column gap-1 text-black'); lisaLaatikko.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;padding:4px 2px;min-height:80px';

    // --- valmis tiedosto (liitetty/pudotettu): pakkaaja + raja
    const prep = el('div', 'd-flex flex-column gap-1'); prep.style.cssText = 'border-top:1px solid rgba(0,0,0,.2);padding-top:4px'; prep.classList.add('dj-pois');
    const esikatselu = el('img'); esikatselu.style.cssText = 'max-width:100%;max-height:90px;object-fit:contain;align-self:flex-start;display:none';
    const nimiRivi = el('div', 'text-black nitro-small-size-text');
    const kuvaSaato = el('div', 'd-flex gap-1 align-items-center text-black nitro-small-size-text');
    const laatuIn = el('input', null, null, { type: 'range', min: '0.2', max: '0.95', step: '0.05' }); laatuIn.style.flex = '1';
    const laatuT = el('span'); const maxSel = el('select', 'form-select form-select-sm'); maxSel.style.width = '124px';
    for (const s of [256, 512, 800, 1024, 1600, 2048]) maxSel.append(el('option', null, s + ' px', { value: String(s) }));
    kuvaSaato.append(el('span', null, 'laatu'), laatuIn, laatuT, maxSel);
    const yhteenveto = el('div', 'text-black fw-bold nitro-small-size-text');
    const varoitus = el('label', 'text-danger nitro-small-size-text'); varoitus.style.cssText = 'display:none;gap:4px;align-items:flex-start';
    const ohita = el('input', null, null, { type: 'checkbox' }); const varoitusT = el('span'); varoitus.append(ohita, varoitusT);
    const peruNappi = el('button', 'btn btn-secondary btn-sm', 'Peru', { type: 'button', title: 'Hylkää valittu tiedosto' }), lahetaTiedNappi = el('button', 'btn btn-success btn-sm flex-grow-1', '📤 Lähetä tiedosto', { type: 'button' }), peruRivi = el('div', 'd-flex gap-1'); peruRivi.append(lahetaTiedNappi, peruNappi);   // Lähetä tiedosto on pääpainike, Peru pieni (kp 1.10.: valitsi tiedoston ja painoi vain Peru)
    prep.append(esikatselu, nimiRivi, kuvaSaato, yhteenveto, varoitus);

    // --- kirjoitus
    const kirjoitus = el('div', 'd-flex flex-column gap-1');
    const ehdotukset = el('div', 'd-flex flex-wrap gap-1'); ehdotukset.classList.add('dj-pois');
    const teksti = el('textarea', 'form-control form-control-sm', null, { rows: '2', placeholder: 'kirjoita… (Enter lähettää · liitä kuva Ctrl+V · raahaa tiedosto)', maxlength: '2000' }); teksti.style.resize = 'none';
    const tiedostoIn = el('input', null, null, { type: 'file' }); tiedostoIn.style.display = 'none';
    const liiteNappi = el('button', 'btn btn-secondary btn-sm', '📎 Liite', { type: 'button', title: 'Liitä tiedosto (tai Ctrl+V / raahaa)' });
    const lahetaNappi = el('button', 'btn btn-success btn-sm', 'Lähetä', { type: 'button' });
    const toimNappi = el('button', 'btn btn-secondary btn-sm', '⚡ Toiminto', { type: 'button', title: 'Lähetä toiminto muille: kävely, chat-komento, JS-koodi tai CSS (+ valinnainen kumoa-koodi)' }); toimNappi.onclick = () => nayta(toimintoRivi, toimintoRivi.classList.contains('dj-pois'));
    const osoitaNappi = el('button', 'btn btn-secondary btn-sm', '👉 Osoita', { type: 'button', title: 'Osoita kohde muille: ruutu, esine, hahmo tai käyttöliittymän kohta' });
    const nappiRivi = el('div', 'd-flex gap-1 align-items-center'); lahetaNappi.style.marginLeft = 'auto'; nappiRivi.append(liiteNappi, osoitaNappi, toimNappi, lahetaNappi);
    kirjoitus.append(ehdotukset, teksti, nappiRivi, tiedostoIn);
    let valinnassa = false; const banneri = el('div', 'btn btn-danger btn-sm dj-ikkuna', '👉 Klikkaa kohdetta (Esc = peru)'); Object.assign(banneri.style, { position: 'fixed', left: '50%', top: '12px', transform: 'translateX(-50%)', zIndex: '410', display: 'none' }); document.body.append(banneri);
    const lopetaValinta = () => { valinnassa = false; banneri.style.display = 'none'; document.documentElement.style.cursor = ''; };
    osoitaNappi.onclick = () => { if (!ase.valittu) return; valinnassa = true; banneri.style.display = ''; document.documentElement.style.cursor = 'crosshair'; };
    const nielaise = e => { if (valinnassa) { e.preventDefault(); e.stopImmediatePropagation(); } };
    for (const tp of ['mousedown', 'mouseup', 'click', 'pointerup']) addEventListener(tp, nielaise, true);
    addEventListener('pointerdown', e => { if (!valinnassa) return; e.preventDefault(); e.stopImmediatePropagation();
      if (e.target === banneri || e.target === osoitaNappi || ikkuna.contains(e.target)) { lopetaValinta(); return; }
      let kohde = null; try { kohde = kohdeKlikista(e); } catch (x) { kohde = null; } lopetaValinta();
      if (kohde) { lahetaToiminto(ase.valittu, 'osoita', 0, 0, JSON.stringify(kohde)); osoita(kohde, '(sinä)'); } }, true);
    addEventListener('keydown', e => { if (valinnassa && e.key === 'Escape') { e.stopImmediatePropagation(); lopetaValinta(); } }, true);

    // --- asetukset
    const toimintoRivi = el('div', 'd-flex flex-column gap-1'); toimintoRivi.classList.add('dj-pois');
    const toimSel = el('select', 'form-select form-select-sm'); toimSel.append(el('option', null, 'JS-koodi (konsoli)', { value: 'js' })); toimSel.style.display = 'none';   // CSS-tyylit: js:n dj.tyyli(css) hoitaa (kumoaa itse); vastaanotto tukee vanhoja css-kortteja
    const koodiKentta = el('textarea', 'form-control form-control-sm', null, { rows: '4', placeholder: 'JS-koodi vastaanottajan konsolissa. dj.aseta/dj.korvaa/dj.tyyli(css)/dj.kuuntele kumoutuvat itsestään. Esim. kuplaKomennot.aja(":omakuva nappi"). Max ' + SMAX + ' merkkiä', maxlength: String(SMAX) }); koodiKentta.style.cssText = 'font-family:monospace;font-size:11px;resize:vertical'; 
    const toimLahetaNappi = el('button', 'btn btn-success btn-sm', 'Lähetä', { type: 'button' });
    const toimYla = el('div', 'd-flex gap-1 align-items-center'); toimYla.append(toimSel, toimLahetaNappi);
    const kumoaKentta = el('textarea', 'form-control form-control-sm', null, { rows: '2', placeholder: 'Kumoa-koodi (valinnainen): ajetaan ⏹ Kumoa -napista. dj.aseta(obj,"avain",arvo) / dj.korvaa / dj.tyyli / dj.kuuntele kumoutuvat ilman tätä.', maxlength: String(SMAX) }); kumoaKentta.style.cssText = 'font-family:monospace;font-size:11px;resize:vertical';
    toimintoRivi.append(toimYla, koodiKentta, kumoaKentta);
    toimLahetaNappi.onclick = () => { const h = ase.valittu; if (!h) return; const a = toimSel.value;
      { const k = koodiKentta.value.trim(); if (!k) return; lahetaToiminto(h, a, 0, 0, k, kumoaKentta.value.trim()); koodiKentta.value = kumoaKentta.value = ''; }
      nayta(toimintoRivi, false); };
    const asetukset = el('div', 'd-flex flex-column gap-1 text-black nitro-small-size-text'); asetukset.style.cssText = 'overflow-y:auto;flex:1'; asetukset.classList.add('dj-pois');
    runko.append(ylarivi, liityRivi, info, listaLaatikko, lisaLaatikko, viestiLaatikko, asetukset, prep, peruRivi, toimintoRivi, kirjoitus);
    peruRivi.classList.add('dj-pois');

    // --- pienennys: vain otsikkopalkki jää (240 px), lukematta-määrä otsikossa, klikkaus/kaksoisklikkaus/– palauttaa; tila säilyy
    function asetaPien(p, tallenna) { pien = !!p; ase.pienennetty = pien; if (tallenna !== false) tallennaAse();
      if (pien) { lukemattomat.delete(ase.valittu); lukematta = [...lukemattomat.values()].reduce((a, b) => a + b, 0); }
      if (pien) for (const [h2, l2] of viestit) maara.set(h2, l2.filter(v2 => !v2.oma).length);   // vain pienennyksen JÄLKEEN tulleet lasketaan
      nayta(runko, !pien); ikkuna.querySelectorAll('.dj-kahva').forEach(k => nayta(k, !pien)); ikkuna.style.width = pien ? '240px' : ((ase.ikkunaKoko && ase.ikkunaKoko.w) || 390) + 'px'; piensi.textContent = pien ? '▢' : '–'; piensi.title = pien ? 'Palauta ikkuna' : 'Pienennä (tai kaksoisklikkaa otsikkoa)';
      if (!pien) { lukemattomat.delete(ase.valittu); lukematta = [...lukemattomat.values()].reduce((a, b) => a + b, 0); piirra(); } merkki(); }
    // --- avaaja
    const avaaja = el('button', 'btn btn-primary btn-sm dj-ikkuna', '💬', { type: 'button', title: 'Datajako' });   // kp 1.10. "ois kiva jos ei olis noin ruma": pelkkä kuplakuvake, nimi hiiren alle
    Object.assign(avaaja.style, { position: 'fixed', left: '12px', top: '110px', zIndex: '450', width: '34px', height: '34px', padding: '0', borderRadius: '50%', fontSize: '16px', lineHeight: '34px', textAlign: 'center', boxShadow: '0 2px 6px rgba(0,0,0,.35)' });   // ylävasen: alavasemmalla nappi jäi huoneen omistaja-/sisustuspainikkeiden alle (kp ei löytänyt 1.10.)
    const lukemattomat = new Map(); let lukematta = 0; const merkki = () => { const n = !paalla() ? ' (pois)' : lukematta ? ' (' + lukematta + ')' : ''; avaaja.textContent = !paalla() ? '💬' : lukematta ? String(lukematta) : '💬'; avaaja.title = 'Datajako' + n + (lukematta ? ' - ' + [...lukemattomat].filter(([, m]) => m).map(([h, m]) => ((ase.huoneet.find(x => x.id === h) || {}).nimi || h) + ': ' + m).join(', ') : ''); avaaja.style.opacity = paalla() ? '1' : '.55'; avaaja.style.background = lukematta ? '#d33' : ''; otsikkoTeksti.textContent = 'Datajako' + (paalla() ? '' : ' (pois)'); };   /* pienennetyssa palkissa ei laskuria: kp 1.10. */
    avaaja.onclick = () => { ikkuna.style.display = ikkuna.style.display === 'none' ? '' : 'none'; if (ikkuna.style.display !== 'none') { lukemattomat.delete(ase.valittu); lukematta = [...lukemattomat.values()].reduce((a, b) => a + b, 0); merkki(); piirra(); } };
    sulje.onclick = () => { ikkuna.style.display = 'none'; };
    // avausnappi on raahattava ja muistaa paikkansa (ase.avaajaPaikka); raahaus ei laukaise avausta
    const rajaa = (x, y) => ({ x: Math.min(Math.max(0, x), innerWidth - avaaja.offsetWidth - 2), y: Math.min(Math.max(0, y), innerHeight - avaaja.offsetHeight - 2) });
    const asetaAvaaja = (x, y) => { const q = rajaa(x, y); avaaja.style.left = q.x + 'px'; avaaja.style.top = q.y + 'px'; avaaja.style.bottom = 'auto'; return q; };
    if (ase.avaajaPaikka && Number.isFinite(ase.avaajaPaikka.x)) asetaAvaaja(ase.avaajaPaikka.x, ase.avaajaPaikka.y);
    addEventListener('resize', () => { const r = avaaja.getBoundingClientRect(); asetaAvaaja(r.left, r.top); });
    let raahattu = false; avaaja.style.touchAction = 'none'; avaaja.title = 'Raahaa siirtääksesi · Alt+Shift+D avaa/sulkee';
    avaaja.addEventListener('pointerdown', e => { const r = avaaja.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top, x0 = e.clientX, y0 = e.clientY; raahattu = false;
      const liiku = ev => { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 4) raahattu = true; if (raahattu) asetaAvaaja(ev.clientX - dx, ev.clientY - dy); };
      const loppu = () => { removeEventListener('pointermove', liiku); removeEventListener('pointerup', loppu); if (raahattu) { const q = avaaja.getBoundingClientRect(); ase.avaajaPaikka = { x: Math.round(q.left), y: Math.round(q.top) }; tallennaAse(); } };
      addEventListener('pointermove', liiku); addEventListener('pointerup', loppu); });
    const avausVanha = avaaja.onclick; avaaja.onclick = ev => { if (raahattu) { raahattu = false; return; } avausVanha(ev); };
    if (!VW.__djNappain) { VW.__djNappain = true; document.addEventListener('keydown', e => { if (e.altKey && e.shiftKey && e.code === 'KeyD') { const u = VW.kuplaDatajakoUI; if (u) { e.preventDefault(); u.avaaja.onclick(); } } }); }   // Alt+Shift+D avaa/sulkee, jos nappi ei löydy

    // --- puhekupla (pelin chat-bubble-rakenne)
    function kupla(h, v) {
      const w = el('div', 'chat-history-entry d-flex'); w.style.cssText = 'margin:4px 0;max-width:100%' + (v.oma ? ';justify-content:flex-end' : '');   /* Res 1.10.: omat viestit oikealle */
      const c = el('div', 'bubble-container visible');
      const bg = el('div', 'user-container-bg'); bg.style.backgroundColor = '#fff';
      const b = el('div', 'chat-bubble bubble-0 type-0'); b.style.cssText = 'max-width:100%;box-sizing:border-box';   /* ei overflow:hidden: se leikkasi kuplan alareunan ja jatti raon */
      const uc = el('div', 'user-container'), ui = el('div', 'user-image'); const p = paaKuva(figureNimelle(v.from));
      if (p) { ui.style.backgroundImage = 'url("' + p + '")'; ui.style.backgroundSize = 'contain'; ui.style.backgroundPosition = 'center top'; ui.style.backgroundRepeat = 'no-repeat'; }
      uc.append(ui); const cc = el('div', 'chat-content'); cc.style.cssText = 'max-width:100%;min-width:0;overflow-wrap:anywhere;word-break:break-word'; cc.append(el('b', 'username mr-1', v.from + ': '));
      const rivi2 = el('div', 'd-flex gap-1 align-items-center'); rivi2.style.cssText = 'margin-top:3px;flex-wrap:wrap;row-gap:3px;max-width:100%';   // kp 1.10. "menee usealle riville noi napit": kupla kutistui tekstin levyiseksi ja napit kaartuivat
      /* kp 1.10. "korjaa ettei linkkei voi painaa siin": URLit tehdaan oikeiksi linkeiksi. Rakennetaan DOM-solmuina
         (createTextNode + <a>), EI innerHTML:lla, joten toisen kayttajan teksti ei voi injektoida mitaan. rel estaa
         window.opener-paasyn. Pelin CSS asettaa .chat-content *:lle cursor:text, joten linkille palautetaan osoitin. */
      const linkita = (sailio, teksti) => {
        const re = /https?:\/\/[^\s<>"')]+/g; let i = 0, m2;
        while ((m2 = re.exec(teksti))) {
          if (m2.index > i) sailio.append(document.createTextNode(teksti.slice(i, m2.index)));
          const a = el('a', null, m2[0], { href: m2[0], target: '_blank', rel: 'noopener noreferrer', title: m2[0] });
          a.style.cssText = 'text-decoration:underline;word-break:break-all;cursor:pointer;pointer-events:all';
          sailio.append(a); i = m2.index + m2[0].length;
        }
        if (i < teksti.length) sailio.append(document.createTextNode(teksti.slice(i)));
      };
      const nappi = (txt, f, cls) => { const m = /^(\P{L}\S*)\s+(.+)$/u.exec(txt), n = el('button', 'btn btn-sm ' + (cls || 'btn-primary'), m ? m[2] : txt, { type: 'button' });   /* sana, ei kuvaketta: pelin fontti piirtaa osan emojeista vaarin (kp 1.10. kuvakaappaus) */ n.style.cssText = 'padding:0 5px;font-size:12px;line-height:18px'; n.onclick = f; rivi2.append(n); return n; };   // kuvake riittää: selitys on title, muuten rivi katkeaa
      if (v.tyyppi === 'teksti') { const tx = el('span', 'message'); linkita(tx, nfs(v.teksti)); tx.style.whiteSpace = 'pre-wrap'; tx.style.overflowWrap = 'anywhere'; tx.style.maxWidth = '100%'; if (v.jarj) { tx.style.opacity = '.8'; tx.style.fontStyle = 'italic'; } if (v.historia) { tx.style.opacity = '.85'; const mk = el('span', 'message', v.valitti ? '⏱↪ ' : '⏱ '); mk.title = v.valitti ? 'Vanha viesti, jonka välitti ' + v.valitti + ' (ei suoraan lähettäjältä)' : 'Vanha viesti, haettu liityttäessä'; cc.append(mk); } cc.append(tx);
        if (v.jarj) { /* järjestelmäviesti: ei jaettu */ } else {
        const kn = nappi('📋 Kopioi', () => kopioi(v.teksti, kn), 'btn-secondary');
        nappi('🔖 Talteen', () => { const n = prompt('Anna tallennetulle viestille nimi (Datajaon omaan listaan, ei lataa mitään koneelle):', v.teksti.slice(0, 40)); if (n === null) return; tallennaMerkinta({ laji: 'teksti', teksti: v.teksti, from: v.from }, n); piirra(); }, 'btn-secondary').title = 'Tallenna nimellä (löytyy ⚙-asetuksista)'; } }
      else if (v.tyyppi === 'tiedosto') {
        cc.append(el('span', 'message', '📎 ' + v.nimi + ' (' + kb(v.size) + ')'));
        if (!v.blob && (!v.oma || v.palautettu) && !v.pyydetty && !tiedostot.has(h + '|' + v.id)) {   /* 0.12.0 click to receive: tavut lahtevat vasta tasta. 0.13.0: myos oma palautettu tiedosto */
          nappi('⬇ Hae (' + kb(v.size) + ')', () => { haeTiedosto(h, v.id); piirra(); }).title = 'Pyytää tiedoston lähettäjältä. Mitään ei siirry ennen tätä, ja vain lähettäjä voi lähettää sen.'; }
        else if (!v.blob && (!v.oma || v.palautettu)) { cc.append(el('span', 'message', ' · ladataan ' + v.saatu + '/' + v.n + (v.tila ? ' · ' + v.tila : ''))); nappi('↻ pyydä uudelleen', () => { const t = tiedostot.get(h + '|' + v.id); if (t) { t.pyynnot = 0; t.viim = 0; } v.tila = ''; piirra(); }, 'btn-secondary').title = 'Pyydä puuttuvia paloja lähettäjältä heti (toimii kun lähettäjä on huoneessa eikä ole ladannut sivua uudelleen)'; }
        else if (!v.blob && v.oma && v.lahde) cc.append(el('span', 'message', ' · tarjolla lahteesta (selviaa sivun latauksesta)'));
        else if (!v.blob) cc.append(el('span', 'message', ' · ladataan ' + v.saatu + '/' + v.n));
        else {
          if (/^image\/(png|jpeg|webp|gif)$/.test(v.mime) && v.nayta) { const im = el('img'); im.style.cssText = 'display:block;width:auto;height:auto;max-width:100%;max-height:200px;object-fit:contain;margin-top:3px'; v.url = v.url || URL.createObjectURL(v.blob); im.src = v.url; cc.append(im); }
          else if (/^image\//.test(v.mime) && !v.nayta) nappi('näytä', () => { v.nayta = true; piirra(); }, 'btn-secondary');
          const tekstia = /^text\/|json|javascript|xml/.test(v.mime) || /\.(js|json|txt|md|css|html|xml|csv|log)$/i.test(v.nimi);
          if (tekstia && v.size <= 200000) nappi(v.koodi ? '📄 Piilota' : '📄 Koodi', () => { if (v.koodi) { v.koodi = null; piirra(); } else v.blob.text().then(t => { v.koodi = t.slice(0, 60000); piirra(); }); }, 'btn-secondary');
          nappi('⬇ Lataa', () => lataa(v)).title = 'Tallentaa tiedoston koneellesi (Chromen lataus)'; nappi('🔗 Avaa', () => avaa(v), 'btn-secondary').title = 'Avaa uudelle välilehdelle';
          if (tekstia && v.size <= 200000) { const kf = nappi('📋 Kopioi', () => v.blob.text().then(t => kopioi(t, kf)), 'btn-secondary'); }
          if (tekstia && v.size <= 100000) nappi('🔖 Talteen', () => v.blob.text().then(t => { const n = prompt('Anna tallennetulle tiedostolle nimi:', v.nimi); if (n === null) return; tallennaMerkinta({ laji: 'tiedosto', tnimi: v.nimi, mime: v.mime, sisalto: t, from: v.from }, n); piirra(); }), 'btn-secondary').title = 'Tallenna tekstitiedosto nimellä (max 100 kt)';
          if (v.koodi) { const pre = el('pre', null, v.koodi); pre.style.cssText = 'max-height:220px;overflow:auto;margin:3px 0 0;padding:3px 5px;font-size:11px;white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.08);border-radius:3px;user-select:text;width:100%'; cc.append(pre); }
        }
      } else if (v.tyyppi === 'toiminto') {
        cc.append(el('span', 'message', '⚙ ' + (kuvaus(v.t) || 'tuntematon toiminto (ei sallittu)')));
        const oso = v.t.a === 'osoita' ? kohdeJson(v.t.s) : null;
        if (oso && oso.k === 'ui') { const rivit = [oso.sel || ''].concat(oso.avaa && oso.avaa.length ? ['avaus: ' + oso.avaa.map(a => a.teksti || a.sel).join(' → ')] : []);
          const pre = el('pre', null, rivit.join(NL)); pre.style.cssText = 'max-height:90px;overflow:auto;margin:3px 0 0;padding:3px 5px;font-size:11px;white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.08);border-radius:3px;user-select:text'; cc.append(pre); }
        if (kuvaus(v.t) && v.t.a !== 'walk' && v.t.a !== 'osoita') { const pre = el('pre', null, v.t.s); pre.style.cssText = 'max-height:110px;overflow:auto;margin:3px 0 0;padding:3px 5px;font-size:11px;white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.08);border-radius:3px;user-select:text'; cc.append(pre); }
        if (kumoaKoodi(v.t)) { cc.append(el('span', 'message', '↩ Kumoa-koodi:')); const pu = el('pre', null, kumoaKoodi(v.t)); pu.style.cssText = 'max-height:70px;overflow:auto;margin:3px 0 0;padding:3px 5px;font-size:11px;white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.08);border-radius:3px;user-select:text'; cc.append(pu); }
        if (kuvaus(v.t)) {
          if (oso && oso.k === 'ui' && oso.avaa && oso.avaa.length) nappi('Avaa ja osoita', () => { if (!confirm(v.from + ' klikkaisi puolestasi näitä (SINUN clientissäsi):' + NL + NL + oso.avaa.map((a, i) => (i + 1) + '. ' + (a.teksti || a.sel)).join(NL) + NL + NL + 'Jatketaanko?')) return; v.tulos = ajaToiminto(v.t, v.from, true, v); piirra(); });
          if (v.t.s && v.t.a !== 'walk' && v.t.a !== 'osoita') { const kk = nappi('📋 Kopioi koodi', () => kopioi(v.t.s, kk), 'btn-secondary'); }
          if (oso && oso.k === 'ui') nappi('kopioi valitsin', () => { try { navigator.clipboard.writeText(oso.sel || ''); } catch (x) {} }, 'btn-secondary');
          if (!v.kumoa) nappi('▶', () => { if (TOIMINNOT[v.t.a].vaarallinen && !v.oma && !confirm(v.from + ' haluaa ajaa tämän SINUN clientissäsi:' + NL + NL + v.t.s.slice(0, 600) + (v.t.s.length > 600 ? NL + '…' : '') + (kumoaKoodi(v.t) ? NL + NL + 'Kumoa-koodi:' + NL + kumoaKoodi(v.t).slice(0, 300) : NL + NL + 'Kumoa-koodia ei ole: muutos kumoutuu vain jos koodi käyttää dj-apuria tai palauttaa funktion; muuten sivun uudelleenlataus.') + NL + NL + 'Ajetaanko? Aja vain jos luotat lähettäjään ja ymmärrät koodin.')) return; v.tulos = ajaToiminto(v.t, v.from, false, v); piirra(); });
          nappi('🔖 Talteen', () => { const n = prompt('Anna tallennetulle toiminnolle nimi:', kuvaus(v.t)); if (n === null) return; tallennaMerkinta({ laji: 'toiminto', t: v.t, from: v.from }, n); piirra(); }, 'btn-secondary').title = 'Tallenna nimellä (löytyy ⚙-asetuksista)';
          if (v.loki && v.loki.length) { const rivit = v.loki.map(l => (l.taso === 'log' ? '' : '[' + l.taso + '] ') + l.teksti).join('\n');
            const pl = el('pre', null, nfs(rivit)); pl.style.cssText = 'max-height:100px;overflow:auto;margin:3px 0 0;padding:3px 5px;font-size:11px;white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.08);border-radius:3px;user-select:text;width:100%;border-left:3px solid #2a7'; cc.append(el('span', 'message', '▸ Tulos / konsoli:'), pl);
            const kt = nappi('📋 Kopioi tulos', () => kopioi(rivit, kt), 'btn-secondary'); nappi('📤 Lähetä tulos', () => { lahetaTeksti(h, 'Tulos (' + (kuvaus(v.t) || '') + '):\n' + rivit.slice(0, 1500)); }, 'btn-secondary').title = 'Lähetä tulos takaisin chattiin'; }
          if (v.kumoa) nappi('⏹ Kumoa toiminto', () => { try { v.kumoa(); } catch (x) {} v.kumoa = null; v.tulos = 'kumottu'; piirra(); }, 'btn-danger');
          if (v.tulos) cc.append(el('span', 'message', ' → ' + v.tulos));
        }
      }
      if (v.oma && v.kuitattu && ase.kuittaus !== false) {
        const st = el('span', 'message', v.kuitattu.length ? '✓' : v.eiKuittausta ? '⚠' : '…'); st.title = v.kuitattu.length ? 'Perillä: ' + v.kuitattu.join(', ') : v.eiKuittausta ? 'Ei kuittausta' : 'Odottaa kuittausta'; st.style.cssText = 'font-size:11px;opacity:.75;order:99;margin-left:auto'; if (v.eiKuittausta) st.style.color = '#b00'; rivi2.append(st);
        if (v.eiKuittausta) nappi('↻ lähetä uudelleen', () => { if (v.tyyppi === 'tiedosto') lahetaTiedostoUudelleen(h, v.id); else { v.yritykset = 0; lahetaKehys(h, v); } piirra(); }, 'btn-secondary').title = 'Vastaanottaja ei kuitannut: ei huoneessa, välilehti jäässä tai paketti hukkui. Lähetetään uudelleen (kaksoiskappaleet suodatetaan)';
      }
      nappi('🗑 Poista', () => { if (v.oma) poistaJaettu(h, v.id); else poistaOmasta(h, v.id); }, 'btn-secondary').title = v.oma ? 'Poista myös heidän paneelistaan (kohteliaisuus: ei peru jo nähtyä)' : 'Poista omasta paneelistasi';
      if (rivi2.childNodes.length) cc.append(rivi2);
      b.append(uc, cc, el('div', 'pointer')); c.append(bg, b); w.append(c); return w;
    }

    // --- piirto
    const chatNakyma = () => ase.nakyma === 'chat' && !!ase.valittu;
    function piirra() {
      const hs = ase.huoneet; if (!ase.valittu && hs.length) ase.valittu = hs[0].id;
      if (ase.nakyma === 'lisaosat') return piirraLisaosat();
      if (!chatNakyma()) return piirraLista();
      nayta(lisaLaatikko, false);
      const asAuki = !asetukset.classList.contains('dj-pois');
      nayta(listaLaatikko, false); nayta(viestiLaatikko, !asAuki); for (const e of [info, valinta, takaisin]) nayta(e, true);
      nayta(prep, !!valmis); nayta(peruRivi, !!valmis);
      valinta.replaceChildren(); if (!ase.valittu) valinta.append(el('option', null, '(valitse chat)', { value: '', selected: 'selected' })); for (const h of hs) { const lk = lukemattomat.get(h.id) || 0; const o = el('option', null, '# ' + (h.nimi === h.id ? h.id : h.nimi) + (lk ? '  (' + lk + ' uutta)' : ''), { value: h.id }); if (h.id === ase.valittu) o.selected = true; valinta.append(o); }
      valinta.append(el('option', null, '+ uusi chat…', { value: '__liity' }));
      if (ase.valittu && ase.valittu !== YHTEINEN) valinta.append(el('option', null, '✏ nimeä tämä chat', { value: '__nimea' }));
      if (ase.valittu) valinta.append(el('option', null, '🧹 tyhjennä viestit (vain omasta paneelistasi)', { value: '__tyhjenna' }));
      if (ase.valittu && ase.valittu !== YHTEINEN) valinta.append(el('option', null, '🗑 poista tämä chat listalta', { value: '__poista' }));
      if (!hs.length) { const o = valinta.querySelector('option'); }
      info.replaceChildren(); const h = hs.find(x => x.id === ase.valittu);
      const pikku = b => { b.style.cssText = 'padding:0 6px;font-size:11px'; return b; };
      if (h && h.id === YHTEINEN) info.append(el('span', null, 'Yhteinen chat: kaikki tässä hotellihuoneessa, joilla on Datajako.'));
      else if (h && h.avoin) info.append(el('span', null, 'Huoneen chat, ei salasanaa: muut liittyvät napilla.'));
      else if (h) { info.append(el('span', null, 'Yksityinen, salasana: '), el('b', null, h.id)); const k = pikku(el('button', 'btn btn-secondary btn-sm', '📋', { type: 'button', title: 'Kopioi salasana' })); k.onclick = () => { try { navigator.clipboard.writeText(h.id); k.textContent = '✓'; } catch (e) {} }; info.append(k); }
      /* "Hae chatit" ja ilmoituskortit ovat nyt paanakymassa, eivat chatin ylla (kp 1.10. "noi tsatit vaa kasaantuu tonne ylos") */
      if (h) { const vb = pikku(el('button', 'btn btn-secondary btn-sm', '⏱ Vanhat viestit', { type: 'button', title: 'Pyytaa taman chatin vanhoja viesteja muilta, jotka ovat nyt huoneessa. Jokainen vastaa vain omilla viesteillaan, enintaan 20 viimeisella. Tiedostoja ei laheteta uudelleen.' })); vb.onclick = () => { pyydaHistoria(h.id); vb.textContent = '… pyydetty'; setTimeout(() => { vb.textContent = '⏱ Vanhat viestit'; }, 6000); }; info.append(vb); }
      if (h && h.id !== YHTEINEN) { const ib = pikku(el('button', 'btn btn-secondary btn-sm', h.avoin ? '📣 Ilmoita uudelleen' : '📣 Jaa huoneeseen', { type: 'button', title: h.avoin ? 'Ilmoittaa chatin uudelleen huoneeseen (ilmoitus menee myös automaattisesti sille joka painaa Hae chatit).' : 'Kertoo huoneelle vain chatin NIMEN ja lukkokuvakkeen. Salasanaa ei lähetetä: liittyjän pitää kysyä se sinulta.' })); ib.onclick = () => { ilmoitaChat(h.id); ib.textContent = '✓ ilmoitettu'; setTimeout(() => piirra(), 4000); }; info.append(ib); }
      { const ln = lasnaLista(ase.valittu); const rivi = el('div', null, ln.length ? '● Täällä nyt: ' + ln.join(', ') : '○ Ei muita tämän chatin käyttäjiä huoneessa'); rivi.style.cssText = 'flex-basis:100%;font-size:11px;opacity:.8'; info.append(rivi); }
      viestiLaatikko.replaceChildren(); if (h) for (const v of lista(h.id)) viestiLaatikko.append(kupla(h.id, v)); viestiLaatikko.scrollTop = viestiLaatikko.scrollHeight;
      nayta(kirjoitus, !!h); piirraAsetukset();
    }
    function piirraKutsut(sailio, pikku) {
      { const paikalla = new Set(yksikot().map(u => u.name));
        for (const [avain2, kt] of kutsut) {
          if (!paikalla.has(kt.from)) continue;
          if (kt.yv ? !!yvChat(kt.from) : kt.lukko ? ase.huoneet.some(x => x.tag === kt.tag) : ase.huoneet.some(x => x.id === avain2)) continue;
          const r = el('div', null, null); r.style.cssText = 'flex-basis:100%;display:flex;gap:6px;align-items:center;font-size:12px';
          const j = pikku(el('button', 'btn btn-success btn-sm', 'Liity', { type: 'button' }));
          j.onclick = async () => {
            if (kt.yv) { const id = await avaaYv(kt.from); if (!id) alert('1:1 chat ei onnistu: ' + kt.from + ' ei ole lahettanyt julkista avaintaan. Paina 🔍 Hae ja yrita uudelleen.'); return piirra(); }
            if (!kt.lukko) { if (liity(kt.c, kt.n)) { const x = ase.huoneet.find(y => y.id === normId(kt.c)); if (x) { x.avoin = true; tallennaAse(); } } return piirra(); }
            const pw = prompt('Chat "' + kt.n + '" vaatii salasanan. Kysy se käyttäjältä ' + kt.from + ':'); if (pw === null) return;
            const id = normId(pw); if (id.length < 6) return alert('Salasana on vähintään 6 merkkiä.');
            const { tag } = await avain(id); if (tag !== kt.tag) return alert('Väärä salasana.');
            if (liity(id, kt.n)) { const x = ase.huoneet.find(y => y.id === id); if (x) { x.tag = tag; tallennaAse(); } } piirra();
          };
          r.append(el('span', null, (kt.yv ? '✉ ' : '📣 ') + kt.from + ': ' + kt.n + (kt.lukko ? ' 🔒' : '')), j); sailio.append(r);
        } }
    }
    const esikatseluTeksti = v => v.tyyppi === 'tiedosto' ? '📎 ' + String(v.nimi || 'tiedosto') : v.tyyppi === 'toiminto' ? '⚡ toimintokortti' : String(v.teksti || '').replace(/\s+/g, ' ').slice(0, 70) || 'viesti';
    const kello = ts => { const d = new Date(ts || Date.now()); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    function piirraLista() {   /* paanakyma: chatit, viestimaarat, lukemattomat ja ketka ovat paikalla. Ilmoitukset ovat TAALLA, eivat chatin ylla (kp 1.10.) */
      const asAuki = !asetukset.classList.contains('dj-pois');
      nayta(listaLaatikko, !asAuki); nayta(lisaLaatikko, false);
      for (const e of [viestiLaatikko, info, kirjoitus, prep, peruRivi, toimintoRivi, valinta, takaisin]) nayta(e, false);
      listaLaatikko.replaceChildren();
      const pikku = b => { b.style.cssText = 'padding:0 6px;font-size:11px'; return b; };
      const yla = el('div', null, null); yla.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px';
      const ln = lasnaLista(YHTEINEN);
      yla.append(el('span', null, ln.length ? '● Huoneessa nyt:' : '○ Ei muita Datajako-käyttäjiä tässä huoneessa'));
      for (const n of ln) {   /* 1:1 chat suoraan nimesta; sama toiminto kuin pelin hahmovalikon "Lähetä viesti" */
        const on = yvAvaimet.has(n), b = pikku(el('button', 'btn btn-secondary btn-sm', n + (yvChat(n) ? ' 1:1' : ' ✉'), { type: 'button' }));
        b.title = on ? (yvChat(n) ? 'Avaa 1:1 chat: ' + n : 'Aloita 1:1 chat kayttajan ' + n + ' kanssa') : n + ' kayttaa vanhempaa Datajakoa: 1:1 vaatii 0.11.0 molemmilta';
        if (!on) b.disabled = true;
        b.onclick = async () => { b.disabled = true; const id = await avaaYv(n); if (!id) b.textContent = n + ' ei tue 1:1'; piirra(); };
        yla.append(b);
      }
      const hb = pikku(el('button', 'btn btn-secondary btn-sm', '🔍 Hae', { type: 'button', title: 'Kysyy ketkä huoneessa käyttävät Datajakoa ja mitä chatteja on jaettu. Vastaukset tulevat muutamassa sekunnissa.' }));
      hb.onclick = () => { kutsut.clear(); jonoon(YHTEINEN, T.LASNA, { r: 0, c: tagilista() }); vastaaKutsuihin(); hb.textContent = '…'; setTimeout(() => piirra(), 6000); };
      const ub = pikku(el('button', 'btn btn-success btn-sm', '+ Uusi chat', { type: 'button' }));
      ub.onclick = () => { nayta(liityRivi, true); nimiKentta.focus(); };
      yla.append(hb, ub); listaLaatikko.append(yla);
      piirraKutsut(listaLaatikko, pikku);
      for (const h of ase.huoneet) {
        const l = lista(h.id), lk = lukemattomat.get(h.id) || 0, vi = l[l.length - 1], mukana = lasnaLista(h.id);
        const rb = el('button', 'btn btn-secondary btn-sm', null, { type: 'button' });
        rb.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:2px;text-align:left;width:100%;padding:5px 7px';
        const r1 = el('div', null, null); r1.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px';
        const nimiOs = el('span', null, (h.nimi === h.id ? h.id : h.nimi) + (h.yv ? ' 👤' : (h.id !== YHTEINEN && !h.avoin ? ' 🔒' : '')));
        nimiOs.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600';
        r1.append(nimiOs);
        if (mukana.length) { const o = el('span', null, '● ' + mukana.length); o.style.cssText = 'font-size:10px;opacity:.75'; o.title = 'paikalla: ' + mukana.join(', '); r1.append(o); }
        { const c = el('span', null, String(l.length)); c.style.cssText = 'font-size:10px;opacity:.7'; c.title = l.length + ' viestiä muistissa'; r1.append(c); }
        if (lk) { const b = el('span', null, String(lk)); b.style.cssText = 'font-size:10px;font-weight:700;background:#d33;color:#fff;border-radius:9px;padding:0 6px'; b.title = lk + ' lukematta'; r1.append(b); }
        const r2 = el('div', null, vi ? (vi.oma ? 'sinä: ' : (vi.from || '') + ': ') + esikatseluTeksti(vi) : 'ei viestejä');
        r2.style.cssText = 'font-size:10px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        if (vi) { const t2 = el('span', null, '  ' + kello(vi.ts)); t2.style.opacity = '.6'; r2.append(t2); }
        rb.append(r1, r2);
        rb.onclick = () => { ase.valittu = h.id; ase.nakyma = 'chat'; lukemattomat.delete(h.id); lukematta = [...lukemattomat.values()].reduce((a, b) => a + b, 0); merkki(); tallennaAse(); piirra(); setTimeout(() => { try { teksti.focus(); } catch (e) {} }, 50); };
        listaLaatikko.append(rb);
      }
      if (!ase.huoneet.length) listaLaatikko.append(el('div', null, 'Ei chatteja. Paina "+ Uusi chat" tai "Hae".'));
      { const tarj = lisaosaTarjoukset(), omat = omatLisaosat();   /* valilehti ILMESTYY kun jakaja on samassa huoneessa (kp 1.10.) */
        if (tarj.length || omat.length) {
          const b = el('button', 'btn btn-secondary btn-sm', null, { type: 'button' });
          b.style.cssText = 'display:flex;gap:6px;align-items:center;text-align:left;width:100%;padding:5px 7px;font-size:12px';
          const t1 = el('span', null, '🧩 Lisäosat'); t1.style.cssText = 'flex:1;font-weight:600';
          b.append(t1, el('span', null, (tarj.length ? tarj.length + ' tarjolla' : '') + (omat.length ? (tarj.length ? ' · ' : '') + omat.length + ' jaossa' : '')));
          if (lisaosatAjossa.size) { const a = el('span', null, lisaosatAjossa.size + ' ajossa'); a.style.cssText = 'font-size:10px;font-weight:700;background:#2a7;color:#fff;border-radius:9px;padding:0 6px'; b.append(a); }
          b.onclick = () => { ase.nakyma = 'lisaosat'; tallennaAse(); piirra(); };
          listaLaatikko.append(b);
        } }
      piirraAsetukset();
    }
    function piirraLisaosat() {   /* jakajan tarjoamat lisaosat: koodi tulee vasta Asenna-napista ja ajo vaatii varmistuksen */
      const asAuki = !asetukset.classList.contains('dj-pois');
      nayta(lisaLaatikko, !asAuki); nayta(listaLaatikko, false);
      for (const e of [viestiLaatikko, info, kirjoitus, prep, peruRivi, toimintoRivi, valinta]) nayta(e, false);
      nayta(takaisin, true);
      lisaLaatikko.replaceChildren();
      const pikku = b => { b.style.cssText = 'padding:0 6px;font-size:11px'; return b; };
      const yla = el('div', null, null); yla.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px';
      yla.append(el('span', null, 'Lisäosat näkyvät vain jakajilta, jotka ovat nyt tässä huoneessa.'));
      const hb = pikku(el('button', 'btn btn-secondary btn-sm', '🔍 Hae', { type: 'button', title: 'Kysy huoneelta mitä lisäosia on jaossa' }));
      hb.onclick = () => { jonoon(YHTEINEN, T.LISAOSAT, { r: 0 }); hb.textContent = '…'; setTimeout(() => piirra(), 5000); };
      yla.append(hb); lisaLaatikko.append(yla);
      const tarj = lisaosaTarjoukset();
      if (!tarj.length) lisaLaatikko.append(el('div', null, 'Ei tarjolla juuri nyt.'));
      for (const x of tarj) {
        const rivi = el('div', 'chat-bubble'); rivi.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:5px 7px;font-size:12px';
        const r1 = el('div', null, null); r1.style.cssText = 'display:flex;gap:6px;align-items:center';
        const n1 = el('span', null, x.n); n1.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600';
        r1.append(n1);
        const ajossa = lisaosatAjossa.has(x.k);
        if (ajossa) { const a = el('span', null, 'ajossa'); a.style.cssText = 'font-size:10px;font-weight:700;background:#2a7;color:#fff;border-radius:9px;padding:0 6px'; r1.append(a); }
        const nappi2 = pikku(el('button', 'btn ' + (ajossa ? 'btn-secondary' : 'btn-success') + ' btn-sm', ajossa ? '⏹ Kumoa' : '⬇ Asenna', { type: 'button' }));
        nappi2.title = ajossa ? 'Kumoaa lisäosan muutokset tässä selaimessa' : 'Pyytää koodin käyttäjältä ' + x.from + '. Koodi näytetään sinulle ennen ajoa.';
        nappi2.onclick = () => { if (ajossa) kumoaLisaosa(x.k); else { asennaLisaosa(x.from, x.k); nappi2.textContent = '… pyydetty'; nappi2.disabled = true; } piirra(); };
        r1.append(nappi2);
        const r2 = el('div', null, (x.d || '') + '  · ' + x.from + (x.z ? ' · ' + x.z + ' merkkiä' : ' · levyltä'));
        r2.style.cssText = 'font-size:10px;opacity:.8';
        rivi.append(r1, r2); lisaLaatikko.append(rivi);
      }
      const omat = omatLisaosat();
      if (omat.length) {
        const otsake = el('div', null, 'Jaat näitä:'); otsake.style.cssText = 'font-size:11px;font-weight:600;margin-top:4px'; lisaLaatikko.append(otsake);
        for (const x of omat) {
          const rivi = el('div', null, null); rivi.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:11px';
          const n1 = el('span', null, x.n + (x.levy ? ' (levyltä: ' + x.levy + ')' : '')); n1.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          const pb = pikku(el('button', 'btn btn-danger btn-sm', '🗑 Ota alas', { type: 'button', title: 'Poistaa lisäosan KAIKKIEN listalta ja kumoaa sen heiltä, jotka ajoivat sen' }));
          pb.onclick = () => { poistaLisaosa(x.k); piirra(); };
          rivi.append(n1, pb); lisaLaatikko.append(rivi);
        }
      }
      piirraAsetukset();
    }
    const piirraTauko = tauko(() => { if (ikkuna.style.display !== 'none' && !pien) piirra(); }, 120);
    const ajoTila = new WeakMap();   // tallennetun merkinnän ajonaikainen tila (kumoa-funktio) - ei talleteta
    function piirraAsetukset() {
      asetukset.replaceChildren();
      const kytkin = (otsikko, selite, onko, aseta) => { const l = el('label', 'd-flex gap-2 align-items-start'); const c = el('input', null, null, { type: 'checkbox' }); c.checked = onko(); c.onchange = () => { aseta(c.checked); tallennaAse(); merkki(); piirraAsetukset(); };
        l.append(c, el('span', null, otsikko + ' - ' + selite)); return l; };
      asetukset.append(el('b', null, 'Päälle / pois'),
        kytkin('Datajako päällä', 'pois = ei lähetystä eikä vastaanottoa; asu pysyy puhtaana (komento /pois ja /paalla)', paalla, v => { ase.paalla = v; if (!v) jono.length = 0; }),
        kytkin('Näytä muiden osoittimet', 'pois = 👉-osoitukset eivät piirry sinulle', () => ase.osoittimet !== false, v => { ase.osoittimet = v; }),
        kytkin('Jaa vanhat viestit pyydettaessa', 'pois = et vastaa historiapyyntoihin (omat viestisi eivat nay myohemmin liittyneille)', () => ase.historia !== false, v => { ase.historia = v; }),
        kytkin('Kuittaa saadut viestit', 'pois = et lähetä kuittauksia (lähettäjä ei näe perillemenoa, mutta saa silti viestisi)', () => ase.kuittaus !== false, v => { ase.kuittaus = v; }),
        kytkin('Ota vastaan toimintoja', 'pois = ▶-kortteja ei tule sinulle (viestit ja tiedostot silti)', () => ase.toiminnot !== false, v => { ase.toiminnot = v; }));
      asetukset.append(el('b', null, 'Etäohjaus'),
        el('span', null, 'Toiminto ajetaan itsestään vain jos lähettäjä on tässä listassa (kävely). Komennot ja koodi tarvitsevat lisäksi alla olevan ruksin. Oletus: tyhjä = aina ▶-nappi.'));
      const nimet = el('input', 'form-control form-control-sm', null, { type: 'text', placeholder: 'esim. Res, kurkkupomo (pilkulla)' }); nimet.value = Object.keys(ase.auto).filter(k => ase.auto[k]).join(', ');
      nimet.onchange = () => { ase.auto = {}; nimet.value.split(',').map(s => s.trim()).filter(Boolean).forEach(s => ase.auto[s] = true); tallennaAse(); };
      const stop = el('button', 'btn btn-danger btn-sm', VW.__datajakoPois ? '▶ Salli etäohjaus uudelleen' : '⛔ Pysäytä etäohjaus heti', { type: 'button' }); stop.onclick = () => { VW.__datajakoPois = !VW.__datajakoPois; piirraAsetukset(); };
      const ak = el('label', 'd-flex gap-1 align-items-start text-danger'); const akc = el('input', null, null, { type: 'checkbox' }); akc.checked = !!ase.autoKoodi; akc.onchange = () => { ase.autoKoodi = akc.checked; tallennaAse(); };
      ak.append(akc, el('span', null, '⚠ Salli listatuilta myös chat-komentojen ja JS-koodin ajo ILMAN ▶:ta. VAARALLINEN: koodi voi tehdä mitä tahansa sinun nimissäsi. Oletus pois.'));
      asetukset.append(nimet, ak, stop);
      asetukset.append(el('b', null, 'Tallennetut (' + ase.tallennetut.length + ')'));
      if (!ase.tallennetut.length) asetukset.append(el('span', null, 'Tyhjä. Paina viestin 🔖 Muistiin -nappia ja anna nimi (se tallentaa Datajaon omaan listaan, ei lataa tiedostoa koneelle).'));
      ase.tallennetut.forEach((x, i) => {
        const r = el('div', 'd-flex gap-1 align-items-center flex-wrap'), pn = (txt, f, title, cls) => { const b = el('button', 'btn ' + (cls || 'btn-secondary') + ' btn-sm', txt, { type: 'button', title: title || '' }); b.style.cssText = 'padding:0 6px;font-size:11px;line-height:18px'; b.onclick = f; return b; };
        const laheta = () => { if (!ase.valittu) return alert('Valitse ensin chat.'); if (x.laji === 'toiminto') lahetaToiminto(ase.valittu, x.t.a, x.t.x, x.t.y, x.t.s, x.t.u); else if (x.laji === 'teksti') lahetaTeksti(ase.valittu, x.teksti); else lahetaTiedosto(ase.valittu, new Blob([x.sisalto], { type: x.mime }), x.tnimi); };
        if (x.laji === 'toiminto') { const tila = ajoTila.get(x) || (ajoTila.set(x, {}), ajoTila.get(x));
          if (tila.kumoa) r.append(pn('⏹ Kumoa', () => { try { tila.kumoa(); } catch (e) {} tila.kumoa = null; piirraAsetukset(); }, 'Kumoa tämän ajon muutokset', 'btn-danger'));
          else r.append(pn('▶', () => { if (TOIMINNOT[x.t.a].vaarallinen && !confirm('Aja tallennettu ' + (x.t.a === 'js' ? 'koodi' : x.t.a === 'css' ? 'tyyli' : 'komento') + ' "' + (x.nimi || kuvaus(x.t)) + '":' + NL + NL + x.t.s.slice(0, 600) + (kumoaKoodi(x.t) ? NL + NL + 'Kumoa-koodi:' + NL + kumoaKoodi(x.t).slice(0, 300) : ''))) return; ajaToiminto(x.t, x.from, false, tila); piirraAsetukset(); }, 'Aja', 'btn-primary')); }
        else if (x.laji === 'teksti') r.append(pn('📋', () => { try { navigator.clipboard.writeText(x.teksti); } catch (e) {} }, 'Kopioi leikepöydälle'));
        else r.append(pn('⬇', () => lataa({ blob: new Blob([x.sisalto], { type: x.mime }), nimi: x.tnimi }), 'Lataa tiedostona'));
        const nimiEl = el('b', null, x.nimi || kuvaus(x.t) || x.tnimi || (x.teksti || '').slice(0, 40)); nimiEl.style.flex = '1';
        const kn = komentoNimi(x.nimi), knEl = el('span', null, kn ? '/' + kn : ''); knEl.style.cssText = 'opacity:.65;font-family:monospace'; knEl.title = 'Kirjoita tämä komento lähettääksesi tämän chattiin kirjoittamatta uudelleen';
        r.append(nimiEl, knEl, el('span', null, '(' + x.from + ')'),
          pn('✏', () => { const n = prompt('Uusi nimi:', x.nimi || ''); if (n === null) return; x.nimi = n.trim().slice(0, 60); tallennaAse(); piirraAsetukset(); }, 'Nimeä uudelleen'),
          pn('📤', laheta, 'Lähetä valittuun chattiin'),
          pn('🗑', () => { ase.tallennetut.splice(i, 1); tallennaAse(); piirraAsetukset(); }, 'Poista tallennetuista'));
        asetukset.append(r); });
      // asetusten vienti / tuonti
      asetukset.append(el('b', null, 'Vie / tuo asetukset'));
      const koodit = el('label', 'd-flex gap-1 align-items-start'); const kc = el('input', null, null, { type: 'checkbox' }); koodit.append(kc, el('span', null, 'Vie myös huonekoodit (SALAISIA: jokainen koodin tunteva lukee huoneen)'));
      const vie = el('button', 'btn btn-secondary btn-sm', '📤 Vie asetukset', { type: 'button' }); vie.onclick = () => lataa({ blob: new Blob([JSON.stringify(vieAsetukset(kc.checked), null, 1)], { type: 'application/json' }), nimi: 'datajako-asetukset.json' });
      const tuoTied = el('input', null, null, { type: 'file', accept: '.json,application/json' }); tuoTied.style.display = 'none';
      const tuo = el('button', 'btn btn-secondary btn-sm', '📥 Tuo asetukset', { type: 'button' }); tuo.onclick = () => tuoTied.click();
      tuoTied.onchange = async () => { const f = tuoTied.files && tuoTied.files[0]; tuoTied.value = ''; if (!f) return; let ut = null;
        if (f.size <= 2e6) try { ut = siivoaTuonti(JSON.parse(await f.text())); } catch (e) {}
        if (!ut) return alert('Ei kelpaa: tämä ei ole Datajaon asetustiedosto (tai se on liian iso).');
        if (!confirm('Tuodaan: ' + ut.tallennetut.length + ' tallennettua, ' + ut.huoneet.length + ' huonetta' + (ut.laatu != null ? ', pakkausasetukset' : '') + (ut.hylatty ? ' (' + ut.hylatty + ' kelvotonta ohitettu)' : '') + '.' + NL + 'Yhdistetään nykyisiin. Etäohjauksen automaattiajoa (ruksi) EI koskaan tuoda.' + NL + NL + 'Jatketaanko?')) return;
        const auto = ut.auto.length > 0 && confirm('Tiedostossa on etäohjauslista: ' + ut.auto.join(', ') + NL + 'Sallitaanko heidän ▶-vapaa kävely/osoitus?' + NL + '(Koodin automaattiajo pysyy silti pois.)');
        const r = tuoAsetukset(ut, { auto }); alert('Tuotu: ' + r.uusia + ' uutta, ' + r.kaksoisia + ' oli jo, ' + r.huoneita + ' uutta huonetta.'); piirraAsetukset(); };
      const vt = el('div', 'd-flex gap-1 flex-wrap'); vt.append(vie, tuo, tuoTied); asetukset.append(koodit, vt);
      asetukset.append(el('b', null, 'Huoneet'));
      for (const h of ase.huoneet) { const r = el('div', 'd-flex gap-1 align-items-center'); const p = el('button', 'btn btn-secondary btn-sm', 'poistu', { type: 'button', title: 'Poistaa huoneen listaltasi ja tyhjentää sen viestit muististasi. Muille ei lähde mitään.' }); p.onclick = () => poistuHuoneesta(h.id); const ty = el('button', 'btn btn-secondary btn-sm', 'tyhjennä', { type: 'button', title: 'Tyhjentää tämän chatin viestit vain omasta paneelistasi (huone jää listalle, muille ei lähde mitään)' }); ty.onclick = () => { if (confirm('Tyhjennetäänkö chatin ' + (h.nimi || h.id) + ' viestit omasta paneelistasi? Muiden paneeleihin ei tapahdu mitään.')) tyhjennaHuone(h.id); }; const nm = el('button', 'btn btn-secondary btn-sm', '✏', { type: 'button', title: 'Nimeä chat (vain sinulle)' }); nm.onclick = () => { const n = prompt('Chatin nimi (näkyy vain sinulle, koodi pysyy samana):', h.nimi === h.id ? '' : h.nimi); if (n !== null) { nimeaHuone(h.id, n); piirraAsetukset(); piirra(); } }; r.append(el('span', null, '# ' + (h.nimi === h.id ? h.id : h.nimi + ' · ' + h.id)), nm, ty, p); asetukset.append(r); }
      asetukset.append(el('b', null, 'Tietoa'),
        el('span', null, 'Viestit kulkevat asusi mukana: jokainen on asunvaihto (palvelin tallentaa sen ja lähettää koko hotellihuoneelle; tikittää "change_figure"-palkintoseurantaa). Yhteisessä chatissa ei ole salasanaa: viestit on salattu kiinteällä avaimella, joten ne näkee jokainen jolla on Datajako. Uusi chat (valikko): pelkällä nimellä se ilmoitetaan huoneeseen ja muut liittyvät napilla. Salasana tekee siitä yksityisen: vain ne joille kerrot salasanan pääsevät mukaan. Älä lähetä mitään arkaluontoista yhteisessä. Poisto toisen paneelista on kohteliaisuus: nähtyä ei saa pois. Puhdas asu palautetaan 3 s lähetyksen jälkeen.'));
    }
    asetusNappi.onclick = () => { const auki = asetukset.classList.contains('dj-pois'); nayta(asetukset, auki); nayta(chatNakyma() ? viestiLaatikko : listaLaatikko, !auki); };
    valinta.onchange = () => {
      const v = valinta.value;
      if (v === '') return;
      if (v === '__liity') { nayta(liityRivi, true); liityKentta.focus(); valinta.value = ase.valittu || ''; }
      else if (v === '__nimea') { const id = ase.valittu, h = ase.huoneet.find(x => x.id === id); valinta.value = id || ''; if (!h) return; const n = prompt('Chatin nimi (näkyy vain sinulle, salasana pysyy samana):', h.nimi === h.id ? '' : h.nimi); if (n !== null) { nimeaHuone(id, n); piirra(); } }
      else if (v === '__poista') { const id = ase.valittu, h = ase.huoneet.find(x => x.id === id); valinta.value = id || ''; if (id && id !== YHTEINEN && confirm('Poistetaanko chat ' + ((h && h.nimi) || id) + ' listaltasi? Viestit poistuvat muististasi, muille ei tapahdu mitään. Voit liittyä uudelleen samalla salasanalla.')) { poistuHuoneesta(id); piirra(); } }
      else if (v === '__tyhjenna') { const id = ase.valittu, h = ase.huoneet.find(x => x.id === id); valinta.value = id || ''; if (!id) return;
        if (v === '__tyhjenna') { if (confirm('Tyhjennetäänkö chatin ' + ((h && h.nimi) || id) + ' viestit omasta paneelistasi? Muiden paneeleihin ei tapahdu mitään.')) { tyhjennaHuone(id); piirra(); } }
      }
      else { ase.valittu = v; lukemattomat.delete(v); lukematta = [...lukemattomat.values()].reduce((a, b) => a + b, 0); merkki(); tallennaAse(); piirra(); }
    };
    liityNappi.onclick = () => {
      const sala = liityKentta.value.trim();
      if (sala.length && normId(sala).length < 6) { liityKentta.style.outline = '2px solid #c00'; liityKentta.placeholder = 'salasana: väh. 6 merkkiä'; setTimeout(() => { liityKentta.style.outline = ''; liityKentta.placeholder = 'salasana (tyhjä = ei salasanaa)'; }, 3000); return; }
      const avoin = !sala.length, koodi = avoin ? uusiHuoneId() : sala, nimi = nimiKentta.value.trim() || (avoin ? 'Huoneen chat' : 'Yksityinen chat');   // avoin: koodi arvotaan eikä sitä tarvitse nähdä
      if (!liity(koodi, nimi)) { liityKentta.style.outline = '2px solid #c00'; return; }
      const x = ase.huoneet.find(y => y.id === normId(koodi)); if (x) { x.avoin = avoin; tallennaAse(); if (!avoin) avain(x.id).then(({ tag }) => { x.tag = tag; tallennaAse(); }); }
      peruLiity.onclick(); if (avoin) setTimeout(() => ilmoitaChat(normId(koodi)), 300);   // avoin chat ilmoitetaan huoneeseen heti: muut liittyvät napilla
      piirra();
    };

    // --- liite: tiedosto -> valmis (kuva pakataan)
    let valmis = null;
    const paivitaValmis = tauko(async () => {
      if (!valmis) { nayta(prep, false); nayta(peruRivi, false); return; }
      nayta(prep, true); nayta(peruRivi, true);
      let blob = valmis.file, nimi = valmis.file.name || 'liite';
      if (valmis.kuva) { try { blob = await pakkaaKuva(valmis.file, ase.laatu, ase.maxSivu); nimi = nimi.replace(/\.[^.]+$/, '') + '.webp'; } catch (e) { blob = valmis.file; } }
      if (!valmis) return;
      valmis.blob = blob; valmis.nimi = nimi; nayta(kuvaSaato, valmis.kuva);
      if (valmis.kuva) { valmis.url && URL.revokeObjectURL(valmis.url); valmis.url = URL.createObjectURL(blob); esikatselu.src = valmis.url; esikatselu.style.display = ''; } else esikatselu.style.display = 'none';
      nimiRivi.textContent = '📎 ' + nimi + (valmis.kuva ? ' (alkuperäinen ' + kb(valmis.file.size) + ')' : '');
      const n = Math.max(1, Math.ceil(blob.size / CHUNK)), s = n * GAP / 1000, yli = blob.size > RAJA;
      yhteenveto.textContent = kb(blob.size) + ' · ' + n + ' asunvaihtoa · ~' + (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';
      varoitus.style.display = yli ? 'flex' : 'none'; varoitusT.textContent = '⚠ Yli rajan (' + kb(RAJA) + '): ' + n + ' asunvaihtoa, ~' + Math.round(s) + ' s. Jokainen on tietokantakirjoitus ja näkyy koko hotellihuoneelle. Ohita varoitus ja lähetä silti.';
      lahetaNappi.disabled = lahetaTiedNappi.disabled = yli && !ohita.checked;
    }, 150);
    function asetaTiedosto(f) { if (!f) return; if (valmis && valmis.url) URL.revokeObjectURL(valmis.url); ohita.checked = false;
      valmis = { file: f, kuva: /^image\/(png|jpeg|webp|bmp)$/.test(f.type) }; laatuIn.value = ase.laatu; laatuT.textContent = Math.round(ase.laatu * 100) + ' %'; maxSel.value = String(ase.maxSivu); paivitaValmis(); }
    laatuIn.oninput = () => { ase.laatu = +laatuIn.value; laatuT.textContent = Math.round(ase.laatu * 100) + ' %'; tallennaAse(); paivitaValmis(); };
    maxSel.onchange = () => { ase.maxSivu = +maxSel.value; tallennaAse(); paivitaValmis(); };
    ohita.onchange = () => { lahetaNappi.disabled = lahetaTiedNappi.disabled = !ohita.checked && valmis && valmis.blob && valmis.blob.size > RAJA; };
    peruNappi.onclick = () => { valmis = null; paivitaValmis(); };
    liiteNappi.onclick = () => tiedostoIn.click();
    tiedostoIn.onchange = () => { asetaTiedosto(tiedostoIn.files[0]); tiedostoIn.value = ''; };
    ikkuna.addEventListener('paste', e => { const fs = e.clipboardData && e.clipboardData.files; if (fs && fs.length) { e.preventDefault(); asetaTiedosto(fs[0]); } });
    ikkuna.addEventListener('dragover', e => e.preventDefault());
    ikkuna.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) asetaTiedosto(f); });
    async function laheta() {
      const h = ase.valittu; if (!h) return;
      let t = teksti.value.trim(); const j = t ? jasenna(t) : null;   // /komento ei lähde viestinä
      if (j && !j.kirjaimellinen) { if (ajaKomento(h, j)) teksti.value = ''; else tiedota(h, 'Tuntematon komento /' + j.nimi + ' - /ohje listaa komennot. (Alkuun // = kirjaimellinen /-viesti.)'); ehdota(); return; }
      if (j) t = j.kirjaimellinen;
      if (!paalla()) { tiedota(h, 'Datajako on pois päältä: /paalla tai ⚙-asetukset.'); return; }
      if (valmis && !valmis.blob) { const t0 = Date.now(); while (valmis && !valmis.blob && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 120)); }   /* kuva pakataan taustalla: odota se valmiiksi, muuten liite katoaa ja vain teksti lahtee (kp 1.10. "kuva + viesti combo oli hajal") */
      if (valmis && valmis.blob) { if (valmis.blob.size > RAJA && !ohita.checked) { tiedota(h, 'Tiedosto on yli ' + kb(RAJA) + ' - rastita "lahetä silti" tai pienennä laatua.'); return; } await lahetaTiedosto(h, valmis.blob, valmis.nimi); valmis = null; paivitaValmis(); }
      if (t) { lahetaTeksti(h, t); teksti.value = ''; }
    }
    function ehdota() { const m = /^\/(\S*)$/.exec(teksti.value); ehdotukset.replaceChildren(); if (!m) return nayta(ehdotukset, false);
      const q = komentoNimi(m[1]), nimet = [...new Set([...komennot.keys(), ...ase.tallennetut.map(x => komentoNimi(x.nimi)).filter(Boolean)])].filter(n => n.startsWith(q)).slice(0, 10);
      if (!nimet.length) return nayta(ehdotukset, false);
      for (const n of nimet) { const b = el('button', 'btn btn-secondary btn-sm', '/' + n, { type: 'button' }); b.style.cssText = 'padding:0 6px;font-size:11px;line-height:18px'; b.onclick = () => { teksti.value = '/' + n + ' '; teksti.focus(); ehdota(); }; ehdotukset.append(b); }
      nayta(ehdotukset, true); }
    teksti.addEventListener('input', ehdota);
    rekisteroiKomento('osoita', 'valitse kohde ruudulta ja osoita sitä muille', () => osoitaNappi.click());
    rekisteroiKomento('pienenna', 'pienennä / palauta ikkuna', () => asetaPien(!pien));
    lahetaNappi.onclick = laheta; lahetaTiedNappi.onclick = laheta;
    teksti.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); laheta(); } });

    // --- päivitys viesteistä + lukematta-merkki
    const maara = new Map();
    kuuntelijat.add(() => {
      const piilossa = ikkuna.style.display === 'none' || pien;
      for (const [h, l] of viestit) { const e = maara.get(h) || 0, m = l.filter(v => !v.oma && !v.historia).length; maara.set(h, m);   /* historiana saapuneet vanhat viestit eivat ole uusia (kp 1.10. "counter nayttaa iha omiaan") */
        if (m > e && (piilossa || h !== ase.valittu)) lukemattomat.set(h, (lukemattomat.get(h) || 0) + (m - e)); }   // avoin ja valittu chat ei kerryta lukemattomia
      if (!piilossa) lukemattomat.delete(ase.valittu);
      lukematta = [...lukemattomat.values()].reduce((a, b) => a + b, 0);
      merkki(); piirraTauko();
    });
    document.body.append(ikkuna, avaaja); asetaPien(pien, false); if (!pien) piirra();
    VW.kuplaDatajakoUI = { ikkuna, avaaja, piirra, asetaTiedosto, avaa: () => { ikkuna.style.display = ''; lukemattomat.delete(ase.valittu); lukematta = [...lukemattomat.values()].reduce((a, b) => a + b, 0); if (pien) asetaPien(false); else { merkki(); piirra(); } }, pienenna: p => asetaPien(p), onPien: () => pien };
  }
  try { teeUI(); } catch (e) { console.warn('[datajako] UI:', e); }
})();
