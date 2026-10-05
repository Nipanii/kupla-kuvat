// ==UserScript==
// @name         Kupla Kuvakupla-korjaus
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      0.3.24
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/kuvakupla-korjaus.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/kuvakupla-korjaus.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Gif/kuvakuplat eivät jää päällekkäin livechatissa eivätkä yläveto-historiassa, ja historian tekstikuplat pinoutuvat ilman päällekkäisyyksiä. GIF korkeintaan 100 px, kuvan klikkaus avaa sen isona.
// @kupla-oletus on
// @author       re-lab
// ==/UserScript==
(() => {
  'use strict';
  const VW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  VW.__kuplaKuvakupla = true;
  const kkTyyli = document.createElement('style'); kkTyyli.id = 'kuvakupla-maxh';
  kkTyyli.textContent = '.nitro-chat-widget .message img[alt="GIF"],.chat-pulldown-bubble .message img[alt="GIF"]{max-height:100px}'
    + '.kuplafix-chat-image-preview.revealed img{cursor:zoom-in}'
    + '#kuvakupla-iso{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.85);cursor:zoom-out}'
    + '#kuvakupla-iso img{max-width:95vw;max-height:95vh;object-fit:contain;box-shadow:0 0 24px #000}';
  (document.head || document.documentElement).appendChild(kkTyyli);
  let isoKuva = null;
  const isoKiinni = () => { if (isoKuva) { isoKuva.remove(); isoKuva = null; document.removeEventListener('keydown', isoEsc, true); } };
  const isoEsc = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); isoKiinni(); } };
  const isoAuki = e => {
    const img = e.target && e.target.closest && e.target.closest('.kuplafix-chat-image-preview.revealed img');
    if (!img || !img.src) return;
    e.preventDefault(); e.stopPropagation(); isoKiinni();
    isoKuva = document.createElement('div'); isoKuva.id = 'kuvakupla-iso';
    const k = document.createElement('img'); k.src = img.src; k.alt = ''; k.referrerPolicy = 'no-referrer'; isoKuva.appendChild(k);
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'wheel']) isoKuva.addEventListener(t, ev => ev.stopPropagation());
    isoKuva.addEventListener('click', ev => { ev.stopPropagation(); isoKiinni(); });
    document.body.appendChild(isoKuva); document.addEventListener('keydown', isoEsc, true);
  };
  document.addEventListener('click', isoAuki, true);
  const fiberProp = (el, key) => {
    const k = Object.keys(el).find(x => x.startsWith('__reactFiber$')); let f = k && el[k];
    for (let i = 0; i < 10 && f; i++) { const v = f.memoizedProps && f.memoizedProps[key]; if (v) return v; f = f.return; }
    return null;
  };

  const seurattu = new WeakSet();
  const chatOf = el => { const c = fiberProp(el, 'chat'); return c && typeof c.id === 'number' ? c : null; };
  const kuplat = () => [...document.querySelectorAll('.nitro-chat-widget > .bubble-container')];
  const tila = VW.__kuvakuplaTila = { versio: '0.3.24', korjauksia: 0, keskitetty: 0, ro: 0, seurattu: 0, erotettu: 0, viimeisin: null, historia: 0 };
  const jarjesta = (c, aika, top, aseta, kork, osuu, kiintea) => {
    const raja = (a, b) => !!(a && b && Math.floor(b / 6000) > Math.floor(a / 6000));
    let n = 0;
    for (let k = c.length - 2; k >= 0; k--) {
      const it = c[k];
      if (kiintea && kiintea(it)) continue;
      let ylin = Infinity;
      for (let j = k + 1; j < c.length; j++) { const w = c[j]; ylin = Math.min(ylin, raja(aika(it), aika(w)) ? top(w) : top(w) + kork(w)); }
      if (top(it) + kork(it) > ylin) { aseta(it, ylin - kork(it)); n++; }
      if (osuu) for (let g = 0; g <= c.length; g++) {
        const w = c.slice(k + 1).find(w => osuu(it, w) && top(it) + kork(it) > top(w) && top(it) < top(w) + kork(w)); if (!w) break; aseta(it, top(w) - kork(it)); }
    }
    tila.jarjestetty = (tila.jarjestetty || 0) + n; return n;
  };
  let asennettu = false;
  const saapui = new WeakMap();

  const NN = s => String(s || '').replace(/<[^>]*>/g, '').trim().slice(0, 200);
  const LP_KEY = 'kuvakupla-livepaikat-v1', LP_MAX = 900;
  let paikat = [];
  try { const v = JSON.parse(localStorage.getItem(LP_KEY) || '[]'); if (Array.isArray(v)) paikat = v.filter(r => r && typeof r.y === 'number' && r.t > Date.now() - 864e5).map(r => Object.assign(r, { v: 1 })); } catch (e) {}
  const KK_KEY = 'kuvakupla-korkeudet-v1';
  let korkeudet = {}; try { const v = JSON.parse(localStorage.getItem(KK_KEY) || '{}'); if (v && typeof v === 'object') korkeudet = v; } catch (e) {}
  let korkMuuttui = false;
  const tallenna = () => { try { localStorage.setItem(LP_KEY, JSON.stringify(paikat.filter(r => typeof r.y === 'number').slice(-LP_MAX).map(r => ({ n: r.n, x: r.x, t: r.t, y: r.y, s: r.s, i: r.i, d: r.d, h: r.h, p: r.p, ank: r.ank, rel: r.rel })))); } catch (e) {}
    if (korkMuuttui) { const k = Object.keys(korkeudet); if (k.length > 600) for (const x of k.slice(0, k.length - 600)) delete korkeudet[x];
      try { localStorage.setItem(KK_KEY, JSON.stringify(korkeudet)); korkMuuttui = false; } catch (e) {} } };
  const rek = new WeakMap(), kuplanChat = new WeakMap();
  let F = 0, jakso = 0, tunnetaan = false, kesken = false, wH = 0, askelia = 0, kWorker = null, kAlku = null, viim = 0, valiMs = 6000;
  const elavat = () => kuplat().map(el => ({ el, c: chatOf(el) })).filter(x => x.c && typeof x.c.top === 'number');
  const tietue = (el, c) => {
    let r = rek.get(c); if (r) return r; if (!tunnetaan) return null;
    r = paikat.find(p => p.s === jakso && p.i === c.id) || null;
    if (!r) { if (!saapui.has(el)) return null;
      r = { n: String(c.username || ''), x: NN(c.formattedText), t: saapui.get(el), s: jakso, i: c.id, d: 1, y: null, a: askelia };
      paikat.push(r); if (paikat.length > LP_MAX * 1.2) paikat = paikat.slice(-LP_MAX); }
    rek.set(c, r); return r;
  };
  const kirjaa = (c, r) => { r.y = c.top + F; r.d = c.duplicateCount || 1;
    if (!r.v && (c.skipMovement || askelia !== r.a || Date.now() - r.t > 150)) r.v = 1; };
  const vahti = { tila: null };
  const vahtiTila = () => ({ n: paikat.length, k: tila.korjauksia, e: tila.erotettu, j: tila.liveJarj || 0, H: widget ? parseFloat(widget.style.height) || 0 : 0 });
  const valvo = () => {
    const ed = vahti.tila; if (!ed || !tunnetaan || kesken || !widget) return; const t = vahtiTila();
    if (ed.n !== t.n || ed.k !== t.k || ed.e !== t.e || ed.j !== t.j || ed.H !== t.H) return;
    const v = []; for (const { el, c } of elavat()) { if (c.elementRef !== el) continue; const r = rek.get(c); if (!r || !r.v || typeof r.y !== 'number') continue;
      const d = Math.round(c.top + F - r.y); if (d) v.push([c.id, d]); }
    if (v.length) { const p = tila.poikkeamat = tila.poikkeamat || []; p.push([new Date().toTimeString().slice(0, 8), F, v]); if (p.length > 20) p.shift(); }
  };
  const nayte = () => {
    if (!tunnetaan || kesken || !widget) return 0;
    const H = parseFloat(widget.style.height) || 0; if (wH && H && H !== wH) F += wH - H; if (H) wH = H;
    let n = 0;
    for (const { el, c } of elavat()) { if (c.elementRef !== el) continue; const r = tietue(el, c); if (!r) continue; kirjaa(c, r); r.h = el.offsetHeight; n++; }
    tila.paikkoja = paikat.length; tila.F = F; return n;
  };
  const kiinni = (w, uusi) => {
    const f = w.onmessage; if (typeof f !== 'function') return false;
    kWorker = w; kAlku = f;
    if (uusi) { jakso = Date.now(); F = 0; wH = 0; viim = Date.now(); }
    tunnetaan = true; kesken = false; tila.tunnetaan = true; tila.jakso = jakso;
    w.onmessage = function (e) {
      kesken = false; let ref = null, ennen = 0, skipit = []; const ennenTop = new Map();
      try { valvo(); nayte(); puraSkip(); const L = elavat(); const v = L.find(x => !x.c.skipMovement); if (v) { ref = v.c; ennen = ref.top; }
        for (const x of L) ennenTop.set(x.c, x.c.top);
        skipit = L.filter(x => x.c.skipMovement).map(x => rek.get(x.c)).filter(r => r && typeof r.y === 'number'); } catch (x) {}
      const tulos = f.call(this, e);
      F += TICK_PX; askelia++; tila.askeleet = askelia; viim = Date.now();
      for (const r of skipit) r.y += TICK_PX;
      vahti.tila = vahtiTila();
      if (ref && ref.top !== ennen - TICK_PX) { kesken = true; tila.kesken = (tila.kesken || 0) + 1; }
      if (!kesken) try { const lahtevat = elavat().map(x => x.c).filter(c => c.height > 0 && !(c.top > -c.height * 2));
        if (lahtevat.length) ankkuroi(lahtevat, c => ennenTop.has(c) ? ennenTop.get(c) : c.top, askelia); } catch (x) {}
      if (askelia % 10 === 0) tallenna();
      return tulos;
    };
    return true;
  };
  const WP = VW.Worker && VW.Worker.prototype, alkuPM = WP && WP.postMessage;
  const omaPM = function (msg) {
    try {
      if (msg && msg.action === 'START' && typeof msg.content === 'number' && this !== kWorker) { tila.startit = (tila.startit || 0) + 1;
        valiMs = msg.content; if (kiinni(this, true)) kiinnita(); }
      else if (msg && msg.action === 'STOP' && this === kWorker) { tunnetaan = false; tila.tunnetaan = false; tallenna(); }
    } catch (e) {}
    return alkuPM.apply(this, arguments);
  };
  if (WP && typeof alkuPM === 'function') WP.postMessage = omaPM;
  { const ed = VW.__kuvakuplaWorker; VW.__kuvakuplaWorker = null;
    if (ed && ed.w && ed.w.onmessage === ed.f) { valiMs = ed.valiMs || 6000; askelia = ed.askelia || 0;
      if (Date.now() - (ed.viim || 0) < valiMs - 50) { jakso = ed.jakso; F = ed.F; wH = ed.wH; viim = ed.viim; kiinni(ed.w, false); } else { kiinni(ed.w, true); tila.jaksoUusi = 1; } } }
  const erota = () => {
    const L = kuplat().map(el => ({ el, c: chatOf(el), r: el.getBoundingClientRect() })).filter(x => x.c && typeof x.c.top === 'number').sort((a, b) => b.c.id - a.c.id);
    for (let i = 1; i < L.length; i++) {
      const x = L[i], h = x.el.offsetHeight;
      for (let n = 0; n < L.length; n++) {
        const este = L.slice(0, i).find(y => x.r.left < y.r.right && x.r.right > y.r.left && x.c.top + h > y.c.top && x.c.top < y.c.top + y.el.offsetHeight);
        if (!este) break;
        x.c.top = este.c.top - h; x.c.skipMovement = !!este.c.skipMovement; tila.erotettu++;
      }
    }
  };
  const tK = (t, e, r) => !(t.left + t.width < e.left || t.left > e.left + e.width || t.top + t.height < e.top + r || t.top > e.top + r + e.height);
  const tyonna = m => {
    const E = kuplat().map(el => chatOf(el)).filter(c => c && typeof c.top === 'number').sort((a, b) => a.id - b.id);
    const I = (m, h) => { for (let k = E.indexOf(m) - 1; k >= 0; k--) { const N = E[k];
      if (!(!N || m === N || h.indexOf(N) >= 0 || N.top + N.height > m.top + m.height) && tK(m, N, 0)) {
        const w = Math.abs(N.top + N.height - m.top); h.push(N); N.top -= w; N.skipMovement = !!m.skipMovement; tila.tyonnetty = (tila.tyonnetty || 0) + 1; I(N, h); } } };
    I(m, [m]);
  };
  const puraSkip = () => {
    const L = kuplat().map(el => ({ el, c: chatOf(el), r: el.getBoundingClientRect() })).filter(x => x.c && typeof x.c.top === 'number');
    let n = 0, muuttui = true;
    while (muuttui) { muuttui = false;
      for (const a of L) { if (!a.c.skipMovement) continue; const ala = a.c.top + a.el.offsetHeight;
        if (L.some(b => b !== a && !b.c.skipMovement && b.r.left < a.r.right && b.r.right > a.r.left && b.c.top >= a.c.top && b.c.top - ala < TICK_PX)) {
          a.c.skipMovement = false; n++; muuttui = true; } } }
    if (n) tila.skipPurettu = (tila.skipPurettu || 0) + n;
    return n;
  };
  VW.__kuvakuplaErota = erota;
  VW.__kuvakuplaDebug = () => ({ F, jakso, kesken, askelia, tunnetaan, paikat: paikat.slice(-30), elavat: elavat().map(({ el, c }) => ({ id: c.id, top: c.top, skip: c.skipMovement, ref: c.elementRef === el, h: el.offsetHeight, r: rek.get(c) || null })) });
  let erotaVaraus = 0;
  const erotaPian = () => { if (!erotaVaraus) erotaVaraus = setTimeout(() => { erotaVaraus = 0; erota(); }, 30); };
  const ro = new ResizeObserver(entries => {
    tila.ro++;
    for (const en of entries) {
      const el = en.target; if (!el.isConnected) { ro.unobserve(el); continue; }
      const c = chatOf(el); if (!c || c.elementRef !== el) continue;
      const lev = el.offsetWidth;
      if (c.width && lev && lev !== c.width) { c.left = Math.round(c.left - (lev - c.width) / 2); tila.keskitetty++; }
      if (lev) c.width = lev;
      const uusi = el.offsetHeight, delta = uusi - c.height;
      if (!(delta > 0) || !c.height) { if (!c.height) c.height = uusi; continue; }
      c.height = uusi;
      c.top = c.top - delta; tyonna(c);
      tila.korjauksia++; tila.viimeisin = { id: c.id, delta, t: Date.now() };
    }
    erotaPian();
  });
  const seuraa = img => { const b = img.closest('.nitro-chat-widget > .bubble-container'); if (b && !seurattu.has(b)) { seurattu.add(b); ro.observe(b); tila.seurattu++; } };

  const TICK_MS = 6000, TICK_PX = 15, MAX_TICKS = 4, MIN_GAP = 13, TOP_OFFSET = 42;
  const overlaps = (a, b) => !((a.left + a.width) < b.left || a.left > (b.left + b.width) || (a.top + a.height) <= b.top || a.top >= (b.top + b.height));
  let kirjoitan = false, ajastettu = 0;
  const avain = el => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  let liveKuva = null;
  const muokatut = new Set();
  const otaLiveKuva = () => kuplat().map(el => { const r = el.getBoundingClientRect(); return { key: avain(el), top: r.top, h: r.height }; }).filter(x => x.h > 0 && x.key);
  const asettele = () => {
    ajastettu = 0;
    const canvas = document.querySelector('.chat-pulldown-canvas'); if (!canvas) return;
    const els = [...canvas.querySelectorAll('.chat-pulldown-bubble:not(.chat-pulldown-measure)')]; if (!els.length) return;
    uudetKuplat(); nayte();
    const kaikki = els.map(el => { const e = fiberProp(el, 'entry'); return { el, e, n: e ? String(e.name || '') : '', x: e ? NN(e.message) : '', top: 0, at: e && Number.isFinite(e.cachedAt) ? e.cachedAt : 0 }; });
    const K = (n, x) => n + '\u0001' + x, avaimet = new Map(), kaytetty = new Set();
    for (const r of paikat) { let a = avaimet.get(K(r.n, r.x)); if (!a) avaimet.set(K(r.n, r.x), a = []); a.push(r); }
    for (const it of kaikki) { if (!it.at) continue; const a = avaimet.get(K(it.n, it.x)); if (!a) continue;
      let best = null, bd = 2500; for (const r of a) { if (kaytetty.has(r)) continue; const d = Math.abs(r.t - it.at); if (d < bd) { bd = d; best = r; } }
      if (best) { it.r = best; kaytetty.add(best); } }
    const putki = new Map();
    for (const it of kaikki) { const k = K(it.n, it.x), p = putki.get(k);
      if (p && !(it.r && it.r.v) && p.m < (p.r.d || 1) - 1 && it.at && it.at <= p.loppu + 300) { it.piilo = true; p.m++; p.loppu = it.at + 3000; continue; }
      if (it.r && it.r.v) putki.set(k, { r: it.r, m: 0, loppu: it.at + 3000 }); else putki.delete(k); }
    const nyt = Date.now();
    kirjoitan = true;
    for (const it of kaikki) {
      it.odota = !it.piilo && tunnetaan && it.at > nyt - 1500 && !(it.r && it.r.v);
      const disp = it.piilo ? 'none' : '', vis = it.odota ? 'hidden' : '';
      if (it.el.style.display !== disp) it.el.style.display = disp;
      if (it.el.style.visibility !== vis) it.el.style.visibility = vis;
      if (disp || vis) muokatut.add(it.el);
      const cc = it.el.querySelector('.chat-content'); if (!cc) continue;
      let sp = cc.querySelector(':scope > .kuvakupla-dup'); const d = it.r && !it.piilo ? (it.r.d || 1) : 1;
      if (d > 1) { if (!sp) { sp = document.createElement('span'); sp.className = 'duplicate-count kuvakupla-dup'; sp.style.cssText = 'color:red;margin-left:6px;font-weight:bold'; cc.appendChild(sp); muokatut.add(it.el); }
        if (sp.textContent !== 'x' + d) sp.textContent = 'x' + d; }
      else if (sp) sp.remove();
    }
    tila.piilossa = kaikki.filter(x => x.piilo).length; tila.odottaa = kaikki.filter(x => x.odota).length; tila.osui = kaikki.filter(x => x.r && x.r.v).length;
    const items = kaikki.filter(it => !it.piilo && !it.odota);
    if (!items.length) { kanvaasiMo.takeRecords(); kirjoitan = false; if (tila.odottaa) ajasta(); return; }
    for (const it of items) { it.left = parseFloat(it.el.style.left) || 0; it.width = it.el.offsetWidth; it.height = it.el.offsetHeight;
      const kuvat = [...it.el.querySelectorAll('img')].filter(i => !i.classList.contains('twemoji-chat')); if (!kuvat.length) continue;
      const ka = it.n + '\u0001' + String(it.e && it.e.message || '').slice(0, 400);
      if (kuvat.every(i => i.complete && i.naturalHeight > 0)) { if (korkeudet[ka] !== it.height) { korkeudet[ka] = it.height; korkMuuttui = true; } continue; }
      if (kuvat.some(i => i.complete && !i.naturalHeight)) continue;
      const v = Math.max(korkeudet[ka] || 0, it.r && it.r.v && it.r.h || 0); if (v > it.height) { tila.varattu = (tila.varattu || 0) + 1; it.height = v; } }
    const G3 = (t, e, r) => !(t.left + t.width < e.left || t.left > e.left + e.width || t.top + t.height < e.top + r || t.top > e.top + r + e.height);
    const c = items;
    const nakyvaH = (widget && widget.offsetHeight) || 600;
    const g = (m, b, h) => { const E = c[m]; for (let N = m - 1; N >= 0; N--) { const w = c[N];
      if (!(h.includes(N) || w.top + w.height - b > E.top + E.height) && G3(E, w, -b)) { const k = Math.abs(w.top + w.height - E.top); h.push(N); w.top -= k; w.skip = true; g(N, k, h); } } };
    for (let m = 0; m < c.length; m++) {
      if (m > 0) { let n = c[m].at && c[m - 1].at ? Math.max(0, Math.floor(c[m].at / TICK_MS) - Math.floor(c[m - 1].at / TICK_MS)) : 0;
        if (n * TICK_PX > nakyvaH) n = MAX_TICKS;
        for (let t = 0; t < n; t++) for (let E = 0; E < m; E++) { if (c[E].skip) c[E].skip = false; else c[E].top -= TICK_PX; } }
      c[m].top = -c[m].height; c[m].skip = true; g(m, 0, [m]);
      if (m > 0) c[m - 1].rel = c[m - 1].top - c[m].top;
    }
    if (!VW.__kuvakuplaEiAnkkuria) {
      if (liveKuva && liveKuva.length) { const vapaat = liveKuva.slice();
        for (let k = c.length - 1; k >= Math.max(0, c.length - liveKuva.length - 3); k--) { if (c[k].r && c[k].r.v) continue; const key = avain(c[k].el); if (!key) continue;
          const j = vapaat.map(v => v.key).lastIndexOf(key); if (j >= 0) { c[k].lk = { y: vapaat[j].top, s: 'L' }; vapaat.splice(j, 1); } } }
      const lohkot = new Map();
      for (const it of c) { const r = it.r; if (!(r && r.v && typeof r.y === 'number')) continue;
        let z = lohkot.get(r.s); if (!z) lohkot.set(r.s, z = { maxP: null, n: 0 });
        if (z.maxP !== null && z.maxP < r.t) z.n++;
        it.lohko = r.s + ':' + z.n; z.maxP = Math.max(z.maxP === null ? -Infinity : z.maxP, r.p || Infinity); }
      const T = c.map(x => x.top), base = new Map(); let n = 0;
      const rI = new Map(); for (const r of paikat) rI.set(r.s + ':' + r.i, r);
      const yOf = (r, syv) => { if (!r.ank || syv > 60) return r.y; const b = rI.get(r.ank[0] + ':' + r.ank[1]);
        return b && b.v && typeof b.y === 'number' && typeof r.rel === 'number' ? yOf(b, syv + 1) + r.rel : r.y; };
      const asetettu = new Map();
      const wYla = widget ? widget.getBoundingClientRect().top : 0;
      for (let k = c.length - 1; k >= 0; k--) { const it = c[k], p = it.lohko ? { y: yOf(it.r, 0), s: it.lohko } : it.lk;
        if (p && base.has(p.s)) { const ak = it.lohko && it.r.ank && typeof it.r.rel === 'number' ? asetettu.get(it.r.ank[0] + ':' + it.r.ank[1]) : null;
          it.top = ak ? ak.top + it.r.rel : p.y + base.get(p.s); it.kiinni = true; n++;
          const liikkuva = it.r && (it.r.p || (typeof it.r.h === 'number' && wYla + it.r.y - F + it.r.h <= 0));
          if (liikkuva) for (let q = 0; q <= c.length; q++) {
            const este = c.slice(k + 1).find(w => G3(it, w, 0) && it.top + it.height > w.top && it.top < w.top + w.height);
            if (!este) break; it.top = este.top - it.height; tila.haamu = (tila.haamu || 0) + 1; if (!it.r.p) tila.haamuElossa = (tila.haamuElossa || 0) + 1; }
          if (it.lohko) asetettu.set(it.r.s + ':' + it.r.i, it);
          continue; }
        it.top = k < c.length - 1 ? c[k + 1].top + (typeof it.rel === 'number' ? it.rel : T[k] - T[k + 1]) : T[k];
        for (let q = 0; q <= c.length; q++) { const este = c.slice(k + 1).find(w => G3(it, w, 0) && it.top + it.height > w.top); if (!este) break; it.top = este.top - it.height; }
        if (p) { base.set(p.s, it.top - p.y); it.kiinni = true; n++; if (it.lohko) asetettu.set(it.r.s + ':' + it.r.i, it); } }
      tila.ankkuroitu = n; tila.jaksoja = base.size;
    }
    jarjesta(c, x => x.at, x => x.top, (x, v) => { x.top = v; }, x => x.height, (a, b) => !(a.left + a.width < b.left || a.left > b.left + b.width), x => !!x.kiinni);
    const newest = items[items.length - 1];
    const minTop = Math.min(...items.map(x => x.top));
    const pad = Math.max(MIN_GAP, TOP_OFFSET - newest.height);
    const newestBottom = newest.top + newest.height;
    const list = canvas.closest('.chat-pulldown-list');
    const pohjassa = list && (list.scrollHeight - list.scrollTop - list.clientHeight) < 4;
    const keep = list ? list.scrollHeight - list.scrollTop : 0;
    kirjoitan = true;
    for (const it of items) { const b = (pad + newestBottom - (it.top + it.height)) + 'px'; if (it.el.style.bottom !== b) it.el.style.bottom = b; }
    const h = ((newestBottom - minTop) + pad + 8) + 'px'; if (canvas.style.height !== h) canvas.style.height = h;
    if (list) list.scrollTop = pohjassa ? list.scrollHeight : list.scrollHeight - keep;
    kanvaasiMo.takeRecords();
    kirjoitan = false; tila.historia++;
    if (tila.odottaa) ajasta();
  };
  const ajasta = () => { if (!kirjoitan && !ajastettu) ajastettu = document.hidden ? -setTimeout(asettele, 50) : requestAnimationFrame(asettele); };
  const onLoad = e => { const t = e.target; if (!(t instanceof HTMLImageElement) || t.classList.contains('twemoji-chat')) return;
    if (t.closest('.chat-pulldown-canvas')) ajasta();
    else if (t.closest('.nitro-chat-widget')) { tila.kuvia = (tila.kuvia || 0) + 1; seuraa(t); erotaPian(); } };
  document.addEventListener('load', onLoad, true);
  const kanvaasiMo = new MutationObserver(() => { if (kirjoitan) return; if (ajastettu > 0) cancelAnimationFrame(ajastettu); else if (ajastettu) clearTimeout(-ajastettu); asettele(); });
  let widget = null;
  let yrita = 0;
  let kanvas = null, pdEl = null;
  const avoin = () => { tila.auki = !!(widget && widget.classList.contains('chat-pulldown-open'));
    const c = document.querySelector('.chat-pulldown-canvas');
    if (c === kanvas) { if (c) ajasta(); return; }
    kanvaasiMo.disconnect(); if (!c && kanvas) tallenna();
    kanvas = c; muokatut.clear(); liveKuva = c ? otaLiveKuva() : null; if (!c) return;
    kanvaasiMo.observe(c, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    if (ajastettu > 0) cancelAnimationFrame(ajastettu); else if (ajastettu) clearTimeout(-ajastettu);
    asettele(); };
  const pdMo = new MutationObserver(() => { const pd = widget && widget.parentElement && widget.parentElement.querySelector(':scope > .nitro-chat-pulldown');
    if (pd !== pdEl) { pdEl = pd; if (pd) pdMo.observe(pd, { childList: true, subtree: true }); } avoin(); });
  const uudetKuplat = () => { if (!widget) return; for (const b of widget.querySelectorAll(':scope > .bubble-container')) if (!seurattu.has(b)) { seurattu.add(b); if (asennettu) saapui.set(b, Date.now()); ro.observe(b); tila.seurattu++; }
    for (const b of widget.querySelectorAll(':scope > .bubble-container')) if (!kuplanChat.has(b)) { const c = chatOf(b); if (c) { kuplanChat.set(b, c); tietue(b, c); } } };
  const ankkuroi = (pois, topOf = c => c.top, askel = 0) => {
    const ehdokkaat = elavat().map(x => x.c); for (const c of pois) if (!ehdokkaat.includes(c)) ehdokkaat.push(c);
    for (const A of pois) { const rA = rek.get(A); if (!rA || !rA.v) continue; if (!askel && rA.ankAskel === askelia) continue;
      let B = null; const tA = topOf(A);
      for (const c of ehdokkaat) { if (c === A || !(topOf(c) > tA) || c.left + c.width < A.left || c.left > A.left + A.width) continue;
        const rc = rek.get(c); if (!rc || !rc.v) continue; if (!B || topOf(c) < topOf(B)) B = c; }
      if (B) { const rB = rek.get(B); rA.ank = [rB.s, rB.i]; rA.rel = Math.round(tA - topOf(B)); tila.ankkuri = (tila.ankkuri || 0) + 1; }
      else { delete rA.ank; delete rA.rel; }
      if (askel) rA.ankAskel = askel; } };
  const widgetMo = new MutationObserver(muts => { let attr = false, lapset = false;
    for (const m of muts) { if (m.type === 'attributes') attr = true; else { lapset = true;
      if (tunnetaan) { const pois = [];
        for (const n of m.removedNodes) { const c = n.nodeType === 1 && kuplanChat.get(n); const r = c && rek.get(c); if (!r) continue;
          r.p = Date.now(); if (r.v && !kesken) { r.y = c.top + F; pois.push(c); } }
        if (pois.length) ankkuroi(pois); } } }
    if (lapset) uudetKuplat(); if (attr) avoin(); });
  const kiinnita = () => { const w = document.querySelector('.nitro-chat-widget'); if (w === widget) return; widget = w; widgetMo.disconnect(); pdMo.disconnect(); pdEl = null;
    if (w) { widgetMo.observe(w, { attributes: true, attributeFilter: ['class'], childList: true }); if (w.parentElement) pdMo.observe(w.parentElement, { childList: true }); uudetKuplat(); avoin(); } };
  const onPointer = () => { if (!widget || !widget.isConnected) kiinnita(); };
  document.addEventListener('pointerdown', onPointer, true);
  kiinnita();
  asennettu = true;
  for (const img of document.querySelectorAll('.nitro-chat-widget img:not(.twemoji-chat)')) seuraa(img);
  window.addEventListener('pagehide', tallenna);
})();
