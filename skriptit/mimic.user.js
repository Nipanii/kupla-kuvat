// ==UserScript==
// @name         Kupla Mimic
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      1.0.0
// @description  :mimic <nimi> [m|f] (tai :matki) = kopioi kenen tahansa asun itsellesi: huoneesta (myös botin) tai haulla toisesta huoneesta. Toimii yksinään, ei tarvitse komennot-lisäosaa eikä loaderia.
// @author       re-lab
// ==/UserScript==
// 1.0.0 (kp 2026-09-30 16:11 "ettei jennil oo command handlerii tai extension loaderii, tee standalone"): sama :mimic kuin
//   komennot 1.7.0:ssa, mutta omalla Enter-kuuntelijalla. Jos komennot-lisäosa on jo ladattu ja siinä on :mimic, tämä väistyy.
//   Asu vaihdetaan 2730 UPDATE_FIGURE (sama kuin pelin oma vaatekaappi). Toisesta huoneesta haku 1210 -> 973 (vain haku lähtee).
(() => {
  'use strict';
  const W = window;
  if (W.__kuplaMimic) return; W.__kuplaMimic = true;
  const dv = (o, k) => { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : undefined; };

  function huone() {
    const RE = W.NitroDevTools && W.NitroDevTools.roomEngine; if (!RE) return null;
    const id = dv(RE, '_activeRoomId'), rsm = dv(RE, '_roomSessionManager'), ss = rsm && dv(rsm, '_sessions');
    let s = null; if (ss instanceof Map) for (const [, v] of ss) if (dv(v, '_roomId') === id) s = v;
    return s ? { RE, id, rsm, s, ud: dv(s, '_userData'), oma: dv(s, '_ownRoomIndex') } : null;
  }
  function yhteys(rsm) {
    const seen = new Set(); let c = null;
    const sc = (o, d) => { if (!o || c || d > 4 || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
      if (Object.getOwnPropertyDescriptor(o, '_cryptoState')) { c = o; return; }
      for (const k of Object.getOwnPropertyNames(o)) { const e = Object.getOwnPropertyDescriptor(o, k); if (e && !e.get && e.value && typeof e.value === 'object') sc(e.value, d + 1); } };
    sc(rsm, 0); return c;
  }
  const hahmot = h => { const m = h && h.ud && dv(h.ud, '_userDataByRoomIndex'); return m instanceof Map ? [...m.values()] : []; };
  function etsi(h, nimi) {
    const n = nimi.toLowerCase(), kaikki = hahmot(h).filter(u => u && u.name);
    const alku = kaikki.filter(u => u.name.toLowerCase().startsWith(n));
    return kaikki.find(u => u.name.toLowerCase() === n) || (alku.length === 1 ? alku[0] : null);
  }
  function haeHaulla(c, nimi) {
    return new Promise((ok, ei) => {
      if (typeof c.subscribePacketTrace !== 'function') return ei(new Error('client ei tarjoa pakettiseurantaa'));
      let off = () => {};
      const aika = setTimeout(() => { off(); ei(new Error('"' + nimi + '" ei löytynyt haulla')); }, 4000);
      off = c.subscribePacketTrace(e => {
        if (!e || e.direction === 'OUTGOING' || e.header !== 973 || !(e.buffer instanceof ArrayBuffer)) return;
        const d = new DataView(e.buffer); let o = 0;
        const i32 = () => { const v = d.getInt32(o); o += 4; return v; }, b = () => d.getUint8(o++);
        const s = () => { const l = d.getUint16(o); o += 2; const t = new TextDecoder().decode(new Uint8Array(e.buffer, o, l)); o += l; return t; };
        const loydot = [];
        try { for (let lista = 0; lista < 2 && o < d.byteLength; lista++) { const n = i32();
          for (let k = 0; k < n; k++) { i32(); const nm = s(); s(); b(); b(); s(); i32(); const fig = s(); s(); loydot.push({ name: nm, figure: fig.replace(/\.0$/, '') }); } }
        } catch (x) { /* osittainenkin lista kelpaa */ }
        const u = loydot.find(x => x.name.toLowerCase() === nimi.toLowerCase());
        if (!u) return;
        clearTimeout(aika); off(); ok(u);
      });
      c.sendRawPacket(1210, [nimi], 'kupla-mimic-haku');
    });
  }
  const omaSukupuoli = h => { const u = hahmot(h).find(x => x && x.roomIndex === h.oma); return u && String(u.sex || '').toUpperCase().startsWith('F') ? 'F' : 'M'; };

  async function mimic(teksti) {
    teksti = (teksti || '').trim();
    if (!teksti) return ':mimic <nimi> [m|f] - kopioi hahmon asun sinulle (huoneesta tai haulla mistä tahansa)';
    const h = huone(); if (!h) return 'et ole huoneessa';
    let pakko = null; const mm = /^(.*\S)\s+([mf])$/i.exec(teksti); if (mm) { teksti = mm[1]; pakko = mm[2].toUpperCase(); }
    const c = yhteys(h.rsm); if (!c || typeof c.sendRawPacket !== 'function') return 'yhteyttä peliin ei löytynyt';
    const pue = (u, mista) => {
      const fig = String(u.figure || '').replace(/\.0$/, ''), sp = pakko || (String(u.sex || 'M').toUpperCase().startsWith('F') ? 'F' : 'M');
      if (!fig) return u.name + ': ei asua luettavissa';
      c.sendRawPacket(2730, [sp, fig], 'kupla-mimic');
      return 'asu kopioitu: ' + u.name + mista;
    };
    const u = etsi(h, teksti);
    if (u) return pue(u, '');
    try { const x = await haeHaulla(c, teksti); x.sex = pakko || omaSukupuoli(h); return pue(x, ' (haettu toisesta huoneesta)'); }
    catch (e) { return e.message; }
  }
  W.kuplaMimic = { mimic };

  document.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (W.kuplaKomennot && W.kuplaKomennot.__versio >= '1.7.0') return;   // komennot hoitaa :mimicin itse
    const t = e.target; if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
    const m = /^\s*:(mimic|matki)(?=\s|$)\s*(.*)$/i.exec(t.value || ''); if (!m) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    try { const st = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), 'value').set; st.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); } catch (x) { t.value = ''; }
    const vastaus = await mimic(m[2]);
    try { console.log('[mimic]', vastaus); } catch (x) {}
    const d = document.createElement('div'); d.textContent = vastaus;
    d.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:#1b1f2a;color:#fff;padding:6px 10px;border-radius:4px;font:12px sans-serif;z-index:99999';
    document.body.appendChild(d); setTimeout(() => d.remove(), 5000);
  }, true);
})();
