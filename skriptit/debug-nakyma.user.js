// ==UserScript==
// @name         Kupla Debug-näkymä
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      1.9.1
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/debug-nakyma.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/debug-nakyma.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Päälle/pois kytkettävä overlay huoneen päälle: ruutujen koordinaatit, esine-id:t, hahmojen indeksi/id/nimi, huone-id + hiiren ruutu. Alt+klikkaus esineeseen/hahmoon = furnidata-speksit (kopioitavissa). F8 = päälle/pois. Vain paikallinen näkymä, ei lähetä palvelimelle mitään.
// @author       re-lab
// ==/UserScript==
//
// kp 2026-09-27 18:32: "debug view joka näyttää joka tulen coords tai item id's tai hahmo id's ja room ID ofc. Overlay.
// Toggleable." + "kunnon furni data specs kans, halutessa".
//
// Mekanismi (lähde D:/kupla-lahde/kupla-cc/client/Nitro_Render_V3):
//   ruutu -> näyttö: RoomEngine.getRoomObjectScreenLocation (RoomEngine.ts:2844) = geometry.getScreenPoint(p)*scale
//                    + canvas.width/2 + screenOffsetX (sama y:lle). Tehdään samoin jokaiselle ruudulle, ei vain objekteille.
//   ruudut:          getLegacyWallGeometry(rid).isRoomTile(x,y) / getHeight(x,y), koko _width x _height (LegacyWallGeometry.ts:105,318)
//   esineet:         getRoomObjectsForCategory(10 lattia, 20 seinä, 100 hahmot); sprite-laatikko getRoomObjectBoundingRectangle
//   speksit:         _sessionDataManager.getFloorItemData(typeId) / getWallItemData (IFurnitureData) + objektin mallin arvot
//   hahmot:          _roomSessionManager.getSession(rid).userDataManager.getUserDataByIndex(i)
// Kamera (zoom/raahaus/kääntö) luetaan joka freimi, joten overlay seuraa sitä. Mitään ei kirjoiteta peliin.
// 1.8.0 (kp 2026-09-28 03:40 #669 "lisää se path juttu debug työkaluu · se joka näyttää mist menny ja mihin menos" · 04:34
//   "laita manual ja auto refresh eriksee" · 04:38 "ei em dasheja valikoihin niist tulee nuottiavain"): valinta 'polut'
//   (hahmojen viimeiset ruudut + pelin tuntema seuraava askel, ks. POLUT), speksi-ikkunaan erillinen 'päivitä'-nappi ja
//   'auto'-ruksi, paikkamerkit '-' ajatusviivan sijaan (pelin fontti piirtää ajatusviivan nuottiavaimena).
(function () {
  'use strict';
  const VW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  if (VW.__kuplaDebugNakyma) return;
  VW.__kuplaDebugNakyma = true;

  const AVAIN = 'kupla.debugNakyma.v1';
  const OLETUS = { paalla: false, ruudut: true, esineet: true, seina: false, hahmot: true, korkeus: false, vainHiiri: false, sade: 0, hiiriRuutu: false, pintaRuutu: true, pinnalla: true, kaikki: false, kaikkiEsineet: false, polku: true, polkuAlt: false, polkuKaikki: true };
  const VARIT = { ruudut: '#ffff78', hahmot: '#ff8a8a', lattia: '#77ffff', seina: '#ff99ff' };
  let A = Object.assign({}, OLETUS);
  try { Object.assign(A, JSON.parse(localStorage.getItem(AVAIN) || '{}')); } catch (e) {}
  A.varit = Object.assign({}, VARIT, A.varit || {});
  const tallenna = () => { try { localStorage.setItem(AVAIN, JSON.stringify(A)); } catch (e) {} };

  const RE = () => VW.NitroDevTools && VW.NitroDevTools.roomEngine;
  const huone = () => { try { const r = RE(); const id = r && r.activeRoomId; return Number.isInteger(id) && id > 0 ? id : null; } catch (e) { return null; } };
  const peliCanvas = () => { let paras = null, ala = 0; for (const c of document.querySelectorAll('canvas')) { if (c === ov) continue; const r = c.getBoundingClientRect(); if (r.width * r.height > ala) { ala = r.width * r.height; paras = c; } } return paras; };

  // ---------------------------------------------------------------- overlay-canvas
  const ov = document.createElement('canvas');
  ov.id = 'kupla-debug-overlay';
  ov.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:5;display:none;';
  let liitetty = false;
  const liita = () => { const g = peliCanvas(); if (!g || !g.parentElement) return false; if (ov.parentElement !== g.parentElement) g.parentElement.insertBefore(ov, g.nextSibling); liitetty = true; return true; };

  let hiiri = null; // {x,y} CSS-pikseleinä
  VW.addEventListener('mousemove', e => { hiiri = { x: e.clientX, y: e.clientY }; }, { passive: true });

  // kamera: huoneen koordinaatti -> CSS-pikseli
  function kamera(rid) {
    const r = RE(); const cv = r.getRoomInstanceRenderingCanvas(rid, 1); if (!cv) return null;
    const g = cv.geometry; const gc = peliCanvas(); if (!g || !gc) return null;
    const rect = gc.getBoundingClientRect(); const kx = rect.width / (cv._width || rect.width), ky = rect.height / (cv._height || rect.height);
    const V = g.direction.constructor, s = cv._scale || 1, w2 = (cv._width || 0) / 2, h2 = (cv._height || 0) / 2, ox = cv._screenOffsetX || 0, oy = cv._screenOffsetY || 0;
    const piste = (x, y, z) => { const p = g.getScreenPoint(new V(x, y, z)); return p ? { x: rect.left + (p.x * s + w2 + ox) * kx, y: rect.top + (p.y * s + h2 + oy) * ky } : null; };
    // sprite-laatikko on canvasin koordinaateissa -> CSS
    const laatikko = bb => bb && bb.width > 0 ? { x: rect.left + bb.x * kx, y: rect.top + bb.y * ky, w: bb.width * kx, h: bb.height * ky } : null;
    return { cv, g, piste, laatikko, s, rect, dir: g.direction.x };
  }

  // ruutu = [x, y, z, lattia?]. z = PINON PÄÄLLYS (FurnitureStackingHeightMap.getTileHeight) kun 'pinnalla' on päällä:
  // palikoista korkealle rakennetussa huoneessa lattiakorkeus on maan tasossa näkyvän pinnan alla, ja koordinaatti hukkui sinne.
  function ruudut(rid) {
    const r = RE(), lw = r.getLegacyWallGeometry(rid); if (!lw) return { lista: [], w: 0, h: 0, lattiaa: 0 };
    let sm = null; try { sm = r.getFurnitureStackingHeightMap(rid); } catch (e) {}
    const w = lw._width || 0, h = lw._height || 0, lista = []; let lattiaa = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const on = lw.isRoomTile(x, y); if (on) lattiaa++;
      if (!on && !A.kaikki) continue;
      let z = on ? (lw.getHeight(x, y) || 0) : 0; const lz = z;
      if (A.pinnalla && sm) { const t = sm.getTileHeight(x, y); if (t > z) z = t; }
      lista.push([x, y, z, on, lz]);
    }
    return { lista, w, h, lattiaa };
  }

  // hiiren ruutu: lähin ruutu jonka vinoneliön sisällä hiiri on (toimii myös käännetyllä kameralla)
  function hiirenRuutu(k, rl) {
    if (!hiiri) return null; let paras = null;
    for (const [x, y, z, , lz] of rl) {
      const c = k.piste(x, y, z); if (!c) continue;
      const a = k.piste(x + 0.5, y, z), b = k.piste(x, y + 0.5, z); if (!a || !b) continue;
      // hiiren sijainti ruudun omassa (x,y)-kannassa
      const ax = a.x - c.x, ay = a.y - c.y, bx = b.x - c.x, by = b.y - c.y, det = ax * by - ay * bx; if (!det) continue;
      const dx = hiiri.x - c.x, dy = hiiri.y - c.y, u = (dx * by - dy * bx) / det, v = (ax * dy - ay * dx) / det;
      if (Math.abs(u) <= 1 && Math.abs(v) <= 1) { const m = Math.max(Math.abs(u), Math.abs(v)) - z * 0.001; if (!paras || m < paras.m || z > paras.z) paras = { x, y, z, m, lz: lz || 0 }; }
    }
    return paras;
  }

  function tekstiLaatikko(ctx, t, x, y, vari, tausta) {
    const w = ctx.measureText(t).width + 4, h = parseInt(ctx.font, 10) + 3;
    ctx.fillStyle = tausta || 'rgba(0,0,0,.62)'; ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = vari; ctx.fillText(t, x, y + 0.5);
  }

  function kayttaja(rid, i) { try { const s = RE()._roomSessionManager.getSession(rid); return s && s.userDataManager && s.userDataManager.getUserDataByIndex(i); } catch (e) { return null; } }

  // 1.8.0 POLUT (kp 2026-09-28 03:40 #669 "lisää se path juttu debug työkaluu · se joka näyttää mist menny ja mihin menos"):
  //   MISTÄ = jokaisen hahmon viimeiset POLKU_N ruutua: kirjataan tässä selaimessa kun overlay on päällä, aina kun hahmon
  //   pyöristetty ruutu vaihtuu; yli POLKU_MS vanhat putoavat (paikallaan seisovalta jää vain nykyinen ruutu). Viiva himmenee
  //   vanhempaan päin. MINNE = pelin oma seuraava askel: hahmon logiikka (Nitro_Render_V3 MovingObjectLogic.ts
  //   processMoveMessage) liikuttaa hahmoa _location -> _location + _locationDelta, ja palvelin antaa sen 1640-päivityksen
  //   "mv x,y,z" -tilassa YKSI ASKEL kerrallaan; jonossa odottavat askeleet (_queuedMoveMessages[].targetLocation) jatkavat
  //   nuolta. Vihreä nuoli + neliö = tunnettu seuraava ruutu. LOPULLISTA MÄÄRÄNPÄÄTÄ EI OLE CLIENTILLA (reitti lasketaan
  //   palvelimella, muille lähetetään vain seuraava askel) -> sitä ei piirretä. Kentät mitattu robolla 2026-09-28 05:0x:
  //   hahmon logic = "Rs" (minifioitu luokka), avaimet _location/_locationDelta/_queuedMoveMessages olemassa. Ei paketteja.
  let altPohjassa = false;
  const POLKU_N = 10, POLKU_MS = 60000, polut = new Map(); let polkuHuone = null;   // hahmon id (roomIndex) -> [{x, y, z, t}]
  function paivitaPolut(rid, inst) {
    if (polkuHuone !== rid) { polut.clear(); polkuHuone = rid; }
    const nyt = performance.now(), elossa = new Set();
    for (const u of inst.getRoomObjectsForCategory(100)) {
      elossa.add(u.id); const l = u.getLocation(), x = Math.round(l.x), y = Math.round(l.y);
      let p = polut.get(u.id); if (!p) polut.set(u.id, p = []);
      const v = p[p.length - 1];
      // t = milloin hahmo LÄHTI ruudusta (nykyiselle: nyt). Mitattu robolla 05:1x: saapumisaikaan sidottu ikä pudotti
      //   lähtöruudun heti kun yli minuutin paikallaan seissyt hahmo lähti liikkeelle.
      if (!v || v.x !== x || v.y !== y) { if (v) v.t = nyt; p.push({ x, y, z: l.z, t: nyt }); if (p.length > POLKU_N) p.shift(); }
      else v.t = nyt;
      while (p.length > 1 && nyt - p[0].t > POLKU_MS) p.shift();   // viimeinen (nykyinen ruutu) jää aina
    }
    for (const id of [...polut.keys()]) if (!elossa.has(id)) polut.delete(id);
  }
  function seuraavat(u) {   // pelin tuntemat tulevat askeleet: käynnissä olevan askeleen kohde + jono
    const lg = u.logic || u._logic, out = []; if (!lg) return out;
    const o = lg._location, d = lg._locationDelta;
    if (o && d && Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z) > 0.01) out.push({ x: o.x + d.x, y: o.y + d.y, z: o.z + d.z });
    for (const m of lg._queuedMoveMessages || []) { const t = m && m.targetLocation; if (t) out.push({ x: t.x, y: t.y, z: t.z }); }
    return out;
  }
  function piirraPolut(ctx, k, inst, lahella, W, H) {
    const ulkona = q => !q || q.x < -60 || q.y < -60 || q.x > W + 60 || q.y > H + 60;
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const u of inst.getRoomObjectsForCategory(100)) {
      // 1.9.1 kp 06:28 "polut ei näy ellei hoveraa, tähän pitäs olla valinnat": polkuKaikki = kaikkien hahmojen polut hiirestä riippumatta
      const l = u.getLocation(); if (!A.polkuKaikki && !lahella(Math.round(l.x), Math.round(l.y))) continue;
      const nyk = k.piste(l.x, l.y, l.z); if (ulkona(nyk)) continue;
      const p = polut.get(u.id) || [];
      if (p.length > 1) {   // MISTÄ: vanhimmasta nykyiseen, viimeinen piste = hahmon todellinen (liukuva) paikka
        const pts = p.slice(0, -1).map(q => k.piste(q.x, q.y, q.z)); pts.push(nyk);
        for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; if (!a || !b) continue;
          ctx.globalAlpha = 0.2 + 0.7 * i / (pts.length - 1); ctx.strokeStyle = A.varit.hahmot; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.fillStyle = A.varit.hahmot; ctx.beginPath(); ctx.arc(a.x, a.y, 2.5, 0, Math.PI * 2); ctx.fill(); }
      }
      const s = seuraavat(u);   // MINNE: katkoviiva seuraavien askelten läpi, nuolenkärki + neliö viimeiseen tunnettuun
      if (s.length) {
        const pts = [nyk, ...s.map(q => k.piste(q.x, q.y, q.z))].filter(Boolean);
        ctx.globalAlpha = 0.95; ctx.strokeStyle = '#7dff9a'; ctx.lineWidth = 2.5; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.setLineDash([]);
        const b = pts[pts.length - 1], a = pts[pts.length - 2] || nyk, kulma = Math.atan2(b.y - a.y, b.x - a.x);
        if (pts.length > 1) { ctx.fillStyle = '#7dff9a'; ctx.beginPath(); ctx.moveTo(b.x, b.y);
          ctx.lineTo(b.x - 9 * Math.cos(kulma - 0.45), b.y - 9 * Math.sin(kulma - 0.45)); ctx.lineTo(b.x - 9 * Math.cos(kulma + 0.45), b.y - 9 * Math.sin(kulma + 0.45)); ctx.closePath(); ctx.fill(); }
        const loppu = s[s.length - 1], c = [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]].map(([dx, dy]) => k.piste(loppu.x + dx, loppu.y + dy, loppu.z));
        if (c.every(Boolean)) { ctx.strokeStyle = '#7dff9a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (const q of c.slice(1)) ctx.lineTo(q.x, q.y); ctx.closePath(); ctx.stroke(); }
      }
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }
  VW.__kuplaDebugPolut = () => [...polut].map(([id, p]) => ({ id, polku: p.map(q => q.x + ',' + q.y), seuraavat: (() => { try { const r = RE(), u = r && r.getRoomObject(r.activeRoomId, id, 100); return u ? seuraavat(u).map(q => q.x + ',' + q.y) : []; } catch (e) { return []; } })() }));

  let viimeisinHiiriRuutu = null;
  function piirra() {
    requestAnimationFrame(piirra);
    if (!A.paalla) { if (ov.style.display !== 'none') ov.style.display = 'none'; return; }
    if (!liitetty || !ov.parentElement) liita();
    const rid = huone(); const r = RE(); if (!rid || !r) { ov.style.display = 'none'; hud(null); return; }
    const k = kamera(rid); if (!k) return;
    const dpr = VW.devicePixelRatio || 1, W = VW.innerWidth, H = VW.innerHeight;
    if (ov.width !== Math.round(W * dpr) || ov.height !== Math.round(H * dpr)) { ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr); ov.style.width = W + 'px'; ov.style.height = H + 'px'; }
    ov.style.display = 'block';
    const ctx = ov.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fs = Math.max(8, Math.min(14, Math.round(9 * k.s)));
    ctx.font = fs + 'px monospace';

    const R = ruudut(rid); const hr = hiirenRuutu(k, R.lista); viimeisinHiiriRuutu = hr;
    const sade = Math.max(0, A.sade | 0);   // kp 2026-09-28 00:28 "range selector. alkaen yhdestä tilestä. ja sit voi kasvattaa sitä aoe"
    const lahella = (x, y) => !A.vainHiiri || (hr && Math.abs(x - hr.x) <= sade && Math.abs(y - hr.y) <= sade);

    // ruudut
    if (A.ruudut) for (const [x, y, z, on] of R.lista) {
      if (!lahella(x, y)) continue;
      const c = k.piste(x, y, z); if (!c || c.x < -40 || c.y < -20 || c.x > W + 40 || c.y > H + 20) continue;
      ctx.fillStyle = A.varit.ruudut; ctx.globalAlpha = on ? 1 : 0.5;
      const t = A.korkeus && z ? x + ',' + y + ' h' + (+z.toFixed(2)) : x + ',' + y;
      ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.lineWidth = 2.5; ctx.strokeText(t, c.x, c.y); ctx.fillText(t, c.x, c.y); ctx.globalAlpha = 1;
    }
    // hiiren ruudun reunat
    // kp 00:30 "tarviiko sitä sinistä ruutuu olla ku on pelin oma" -> oletus pois. kp 00:43 "ei näy ruutuu palikoiden pääl
    // … paitsi lattial": pelin oma kursori näkyy vain lattialla -> 'pintaRuutu' (oletus päällä) piirtää vain kun hiiri on
    // kalusteen/palikan päällä (pinta > lattia); 'hiiriRuutu' piirtää aina, myös lattialla.
    if (hr && (A.hiiriRuutu || (A.pintaRuutu && hr.z > hr.lz + 0.01))) {
      const p = [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]].map(([a, b]) => k.piste(hr.x + a, hr.y + b, hr.z));
      if (p.every(Boolean)) { ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y); for (const q of p.slice(1)) ctx.lineTo(q.x, q.y); ctx.closePath(); ctx.strokeStyle = '#0ff'; ctx.lineWidth = 2; ctx.stroke(); }
    }
    // esineet ja hahmot
    const inst = r.getRoomInstance(rid);
    // 1.9.0 kp 06:26 "alt pohjassa näkee sen pathin · ja valinta et koko aja": historia kertyy aina, piirto joko aina tai vain Alt pohjassa
    if (A.polku) { paivitaPolut(rid, inst); if (!A.polkuAlt || altPohjassa) piirraPolut(ctx, k, inst, lahella, W, H); } else if (polut.size) polut.clear();
    const kat = []; if (A.esineet) kat.push(10); if (A.seina) kat.push(20); if (A.hahmot) kat.push(100);
    for (const cat of kat) for (const u of inst.getRoomObjectsForCategory(cat)) {
      const l = u.getLocation(); if (cat !== 20 && !lahella(Math.round(l.x), Math.round(l.y))) continue;
      let bb = null; try { bb = k.laatikko(r.getRoomObjectBoundingRectangle(rid, u.id, cat, 1)); } catch (e) {}
      if (cat === 100) {
        const ud = kayttaja(rid, u.id);
        const p = bb ? { x: bb.x + bb.w / 2, y: bb.y - fs } : k.piste(l.x, l.y, l.z + 2.2); if (!p) continue;
        const tyyppi = ud ? ({ 1: '', 2: 'lemmikki ', 3: 'botti ', 4: 'botti ' }[ud.type] || '') : '';
        tekstiLaatikko(ctx, tyyppi + (ud ? ud.name : '?') + ' i' + u.id + (ud && ud.webID ? ' u' + ud.webID : ''), p.x, p.y, A.varit.hahmot);
      } else {
        const p = bb ? { x: bb.x + bb.w / 2, y: bb.y + Math.min(bb.h / 2, 12 + bb.h / 4) } : k.piste(l.x, l.y, l.z + 0.3); if (!p) continue;
        tekstiLaatikko(ctx, '#' + u.id, p.x, p.y, cat === 10 ? A.varit.lattia : A.varit.seina);
      }
    }
    hud({ rid, R, hr, k, maara: [10, 20, 100].map(c => inst.getRoomObjectsForCategory(c).length) });
  }

  // ---------------------------------------------------------------- raahaus
  // 1.4.0 kp 2026-09-27 23:39 "debug tool ei oo myöskää draggable eikä sen ala-ikkunat": ikkuna raahataan otsikostaan
  // (.menu-header) kuten huonekierrossa, ja paikka muistetaan ikkunakohtaisesti (localStorage, vain tämä selain).
  // Raahaus alkaa vasta RAAHAUSRAJA px:n liikkeen jälkeen, joten otsikon napit (ON/OFF, kopioi, ×) toimivat klikkauksella;
  // raahauksen päättävä click niellään, ettei ON/OFF vaihdu siirron lopuksi. Kuuntelija on ikkunassa eikä otsikossa,
  // koska speksi-ikkunan otsikko rakennetaan uudelleen joka näytöllä.
  const RAAHAUSRAJA = 4;
  function raahattava(ikkuna, avain) {
    try {
      const p = JSON.parse(localStorage.getItem(avain) || 'null');
      if (p && p.x >= 0 && p.y >= 0 && p.x < innerWidth - 40 && p.y < innerHeight - 20) Object.assign(ikkuna.style, { left: p.x + 'px', top: p.y + 'px', right: 'auto', bottom: 'auto' });
    } catch (e) {}
    ikkuna.addEventListener('mousedown', e => {
      if (e.button !== 0 || !e.target.closest) return;
      const kahva = e.target.closest('.menu-header'); if (!kahva || !ikkuna.contains(kahva) || e.target.closest('input,select,textarea')) return;
      const r0 = ikkuna.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY; let raahaa = false;
      const liiku = ev => {
        if (!raahaa) { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < RAAHAUSRAJA) return; raahaa = true; }
        ev.preventDefault();
        const x = Math.max(0, Math.min(innerWidth - 40, r0.left + ev.clientX - x0)), y = Math.max(0, Math.min(innerHeight - 20, r0.top + ev.clientY - y0));
        Object.assign(ikkuna.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
      };
      const irti = () => {
        document.removeEventListener('mousemove', liiku, true); document.removeEventListener('mouseup', irti, true);
        if (!raahaa) return;
        const niele = ev => { ev.stopPropagation(); ev.preventDefault(); };
        document.addEventListener('click', niele, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', niele, true), 0);
        const r = ikkuna.getBoundingClientRect();
        try { localStorage.setItem(avain, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (e) {}
      };
      document.addEventListener('mousemove', liiku, true); document.addEventListener('mouseup', irti, true);
    });
  }

  // ---------------------------------------------------------------- paneeli
  const paneeli = document.createElement('div');
  // 1.3.0 kp 2026-09-27 23:15 "robo siisti toi debug GUI": pelin oman valikon luokat (DarkUI ContextMenu.scss) kuten
  // klikkikävelyn valikossa -> tausta rgb(0 0 0/71%), 2px vaalea reuna, oranssi .menu-header, rivit #0000007d / hover #ee5a49.
  // Valikon alanuoli (:after) kuuluu hahmovalikolle -> piiloon. Numerot pysyvät monospacena, muu pelin fontilla.
  const tyyli = document.createElement('style');
  tyyli.textContent = '#kupla-debug-paneeli:after,#kupla-debug-speksi:after{display:none!important}'
    + '#kupla-debug-paneeli,#kupla-debug-speksi{color:#fff;font-size:12px}'
    + '#kupla-debug-paneeli .menu-header,#kupla-debug-speksi .menu-header{padding:0 8px;cursor:move;gap:6px;user-select:none}'
    + '#kupla-debug-paneeli .menu-header.pois{background:#5a5a5a}'
    + '.kdb-laatikko{font:11px monospace;background:#0000007d;border-radius:5px;padding:3px 6px;margin-top:2px}'
    + '#kupla-debug-paneeli input[type=checkbox]{accent-color:#f27f46}'
    + '.kdb-nappi{background:#0000007d;color:#fff;border:0;border-radius:5px;padding:1px 7px;cursor:pointer;font-size:12px}'
    + '.kdb-nappi:hover{background:#ee5a49}';
  document.head.appendChild(tyyli);
  paneeli.id = 'kupla-debug-paneeli';
  paneeli.className = 'nitro-context-menu';
  paneeli.style.cssText = 'position:fixed;left:8px;top:64px;z-index:99998;min-width:190px;user-select:text;';
  const otsikko = document.createElement('div');
  const nappi = document.createElement('div');
  nappi.className = 'menu-header d-flex justify-content-center align-items-center';
  nappi.title = 'klikkaa tai F8 = päälle/pois · raahaa = siirrä';
  const tila = document.createElement('div'); tila.className = 'kdb-laatikko'; tila.style.cssText = 'white-space:pre;line-height:1.35;';
  const valinnat = document.createElement('div'); valinnat.className = 'kdb-laatikko'; valinnat.style.cssText = 'font-family:inherit;font-size:12px;display:grid;grid-template-columns:1fr 1fr;gap:1px 8px;';
  // kp 18:42: erilliset valinnat hahmoille, lattia-, seinä- ja kaikille esineille + värivalinta jokaiseen
  const cbt = {};
  const valintaRivi = (avain, nimi, variAvain) => {
    const l = document.createElement('label'); l.style.cssText = 'cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:3px;';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!A[avain]; cb.style.cssText = 'margin:0;';
    cb.onchange = () => { A[avain] = cb.checked; if (avain === 'kaikkiEsineet') { A.esineet = A.seina = cb.checked; cbt.esineet.checked = cbt.seina.checked = cb.checked; } else if (avain === 'esineet' || avain === 'seina') { A.kaikkiEsineet = A.esineet && A.seina; cbt.kaikkiEsineet.checked = A.kaikkiEsineet; } tallenna(); };
    cbt[avain] = cb; l.appendChild(cb); l.appendChild(document.createTextNode(nimi));
    if (variAvain) {
      const vi = document.createElement('input'); vi.type = 'color'; vi.value = A.varit[variAvain]; vi.title = 'väri';
      vi.style.cssText = 'width:18px;height:14px;padding:0;border:0;background:none;cursor:pointer;margin-left:auto;';
      vi.oninput = () => { A.varit[variAvain] = vi.value; tallenna(); };
      l.appendChild(vi);
    }
    valinnat.appendChild(l);
  };
  valintaRivi('ruudut', 'ruudut', 'ruudut');
  valintaRivi('hahmot', 'hahmot', 'hahmot');
  valintaRivi('esineet', 'lattiaesineet', 'lattia');
  valintaRivi('seina', 'seinäesineet', 'seina');
  valintaRivi('kaikkiEsineet', 'kaikki esineet');
  valintaRivi('korkeus', 'korkeus');
  valintaRivi('pinnalla', 'pinon päällä');
  valintaRivi('kaikki', 'myös ei-lattia');
  valintaRivi('vainHiiri', 'vain hiiri');
  valintaRivi('pintaRuutu', 'oma ruutu pinnoilla');
  valintaRivi('hiiriRuutu', 'oma ruutu myös lattialla');
  valintaRivi('polku', 'polut (mistä, minne)');   // 1.8.0 #669, ks. POLUT
  valintaRivi('polkuAlt', 'polut vain Alt pohjassa');
  valintaRivi('polkuKaikki', 'polut kaikille (ei vain hiiren alla)');
  cbt.polku.parentElement.title = 'hahmojen viimeiset ruudut (himmenevä viiva) ja seuraava askel (vihreä nuoli); lopullinen määränpää on vain palvelimella';
  // alueen koko hiiren ympärillä: 0 = vain hiiren ruutu (1×1), 1 = 3×3, 2 = 5×5 … (kp 00:28 "yks ruutu kerrallaa")
  const alue = document.createElement('div'); alue.style.cssText = 'display:flex;align-items:center;gap:4px;white-space:nowrap;';
  const alueTeksti = document.createElement('span');
  const alueNappi = (t, d) => { const b = document.createElement('span'); b.className = 'kdb-nappi'; b.textContent = t; b.style.cssText = 'cursor:pointer;padding:0 6px;border:1px solid #fff5;border-radius:3px;';
    b.onclick = () => { A.sade = Math.max(0, Math.min(15, (A.sade | 0) + d)); tallenna(); paivitaAlue(); }; return b; };
  const paivitaAlue = () => { const k = 2 * (A.sade | 0) + 1; alueTeksti.textContent = 'alue ' + k + '×' + k; };
  alue.append(alueNappi('−', -1), alueTeksti, alueNappi('+', 1)); alue.title = 'vain hiiri -tilan alue hiiren ruudun ympärillä';
  paivitaAlue(); valinnat.appendChild(alue);
  const vihje = document.createElement('div'); vihje.style.cssText = 'margin:3px 4px 1px;opacity:.7;font-size:11px;';
  vihje.textContent = 'Alt+klikkaus = speksit (hahmo ensin, +Shift = päällimmäinen) · F8 päälle/pois';
  otsikko.appendChild(nappi); paneeli.appendChild(otsikko); paneeli.appendChild(tila); paneeli.appendChild(valinnat); paneeli.appendChild(vihje);
  const paivitaNappi = () => {
    nappi.textContent = '🐞 Debug: ' + (A.paalla ? 'ON' : 'OFF'); nappi.classList.toggle('pois', !A.paalla);
    for (const el of [tila, valinnat, vihje]) el.style.display = A.paalla ? '' : 'none';
  };
  const vaihda = () => { A.paalla = !A.paalla; tallenna(); paivitaNappi(); if (!A.paalla) speksi.style.display = 'none'; };
  nappi.onclick = vaihda;
  VW.addEventListener('keydown', e => { if (e.key === 'F8') { e.preventDefault(); vaihda(); } }, true);
  VW.addEventListener('keydown', e => { if (e.key === 'Alt') altPohjassa = true; }, true);
  VW.addEventListener('keyup', e => { if (e.key === 'Alt') altPohjassa = false; }, true);
  VW.addEventListener('blur', () => { altPohjassa = false; });

  let hudViim = '';
  function hud(d) {
    let t;
    if (!d) t = 'ei huonetta';
    else {
      const hr = d.hr ? d.hr.x + ',' + d.hr.y + (d.hr.z ? ' h' + d.hr.z : '') : '-';
      t = 'huone  ' + d.rid + '\nkoko   ' + d.R.w + '×' + d.R.h + ' (' + d.R.lista.length + ' ruutua)\nhiiri  ' + hr +
        '\nzoom   ' + d.k.s + '   kamera ' + Math.round(d.k.dir) + '°\nlattia ' + d.maara[0] + '  seinä ' + d.maara[1] + '  hahmot ' + d.maara[2];
    }
    if (t !== hudViim) { tila.textContent = t; hudViim = t; }
  }

  // ---------------------------------------------------------------- speksit (Alt+klikkaus)
  const speksi = document.createElement('div');
  speksi.id = 'kupla-debug-speksi';
  speksi.className = 'nitro-context-menu';
  speksi.style.cssText = 'position:fixed;right:12px;top:64px;z-index:99998;max-width:380px;max-height:70vh;overflow:auto;display:none;user-select:text;';
  document.body.appendChild(speksi);
  raahattava(speksi, 'kupla.debugNakyma.paikka.speksi');

  // 1.4.0 kp 23:39 "debug alt menussa ei ole ääkkösiä": speksi-ikkunan rivien NIMET ovat alla olevien olioiden avaimia
  // sellaisenaan (nayta: k.padEnd), ja ne oli kirjoitettu ilman ä/ö:tä (ymparisto, varit, kaytto, kasiesine). Ei
  // dekoodausvika: palvelin 9245 lähettää charset=utf-8 ja paneelin "seinäesineet" näkyy oikein samaa reittiä.
  // Avaimet nyt oikealla suomella; ne päätyvät myös kopioi-napin JSONiin.
  const arvo = (u, k) => { try { const v = u.model.getValue(k); return v === undefined || v === null || v === '' ? undefined : v; } catch (e) { return undefined; } };
  function furnidata(r, cat, u) {
    const tid = arvo(u, 'furniture_type_id'); let fd = null;
    try { const sdm = r._sessionDataManager; fd = cat === 20 ? sdm.getWallItemData(tid) : sdm.getFloorItemData(tid); } catch (e) {}
    const o = { objekti: '#' + u.id, typeId: tid, luokka: u.type };
    if (fd) Object.assign(o, {
      nimi: fd.name, kuvaus: fd.description, kategoria: fd.category, linja: fd.furniLine, 'ympäristö': fd.environment,
      koko_furnidata: [fd.tileSizeX, fd.tileSizeY, fd.tileSizeZ].join('×'), pino: fd.allowStack, seiso: fd.canStandOn, istu: fd.canSitOn, makaa: fd.canLayOn,
      interaktio: fd.interactionType, interaktioId: fd.interactionTypeId, tiloja: fd.interactionModesCount, logiikka: fd.logicType,
      tarjous: fd.purchaseOfferId, vuokra: fd.rentOfferId, harvinainen: fd.rare, erikoistyyppi: fd.specialType, parametrit: fd.customParams,
      revisio: fd.revision, 'värit': (fd.colors || []).join(',') || undefined, tagit: (fd.tags || []).join(',') || undefined, ulkoinenKuva: fd.isExternalImage || undefined
    });
    const l = u.getLocation(), d = u.getDirection();
    let suunnat; try { const sd = u.visualization && u.visualization._data && u.visualization._data.getSizeData && u.visualization._data.getSizeData(64); suunnat = sd && sd._directions ? [...sd._directions.keys()].join(',') : undefined; } catch (e) {}
    Object.assign(o, {
      sijainti: l.x + ',' + l.y + ' z ' + (+l.z.toFixed(3)), suunta: d.x + '° (indeksi ' + Math.round(d.x / 45) % 8 + ')', piirtosuunta: u.visualization ? u.visualization._direction : undefined, suunnat,
      koko_malli: [arvo(u, 'furniture_size_x'), arvo(u, 'furniture_size_y'), arvo(u, 'furniture_size_z')].map(v => v === undefined ? '?' : v).join('×'),
      tila: (() => { try { return u.getState(0); } catch (e) { return undefined; } })(),
      data: (() => { const v = arvo(u, 'furniture_data'); try { return v && typeof v === 'object' ? (v.getLegacyString ? v.getLegacyString() : JSON.stringify(v)) : v; } catch (e) { return String(v); } })(),
      extrat: arvo(u, 'furniture_extras'), omistaja: [arvo(u, 'furniture_owner_name'), arvo(u, 'furniture_owner_id')].filter(v => v !== undefined).join(' / ') || undefined,
      sarja: arvo(u, 'furniture_unique_serial_number') ? arvo(u, 'furniture_unique_serial_number') + '/' + arvo(u, 'furniture_unique_edition_size') : undefined,
      vanhenee: arvo(u, 'furniture_expiry_time'), 'käyttö': arvo(u, 'furniture_usage_policy')
    });
    return o;
  }
  function hahmodata(rid, u) {
    const ud = kayttaja(rid, u.id) || {}; const l = u.getLocation(), d = u.getDirection(); const v = u.visualization || {};
    return {
      hahmo: 'i' + u.id, nimi: ud.name, userId: ud.webID, tyyppi: { 1: 'käyttäjä', 2: 'lemmikki', 3: 'botti', 4: 'vuokrabotti' }[ud.type] || ud.type,
      motto: ud.custom, sukupuoli: ud.sex, figure: ud.figure, omistaja: ud.ownerName, taso: ud.petLevel,
      sijainti: l.x + ',' + l.y + ' z ' + (+l.z.toFixed(3)), suunta: d.x + '°', asento: v._posture,
      'käsiesine': arvo(u, 'figure_carry_object'), efekti: arvo(u, 'figure_effect'), tanssi: arvo(u, 'figure_dance'), nukkuu: arvo(u, 'figure_sleep'), kyltti: arvo(u, 'figure_sign')
    };
  }
  // 1.7.0 kp 2026-09-28 04:32 "oisko autoupdate speksi ikkunaan togle? · jos itemi voi päivittyä · niin sit se tunnistaa et
  //   jos päivittyy": nayta(o, lahde) — lahde() lukee saman objektin uudelleen. 'päivitä'-valinta (localStorage) lukee sen
  //   500 ms välein; muuttunut rivi välähtää keltaisena 1,5 s ja otsikko näyttää viimeisimmän muutoksen kellonajan.
  //   Objekti poistui huoneesta -> "(poistui)" ja päivitys pysähtyy. Vain oma näkymä, ei paketteja.
  const PAIV_AVAIN = 'kupla.debugNakyma.speksiPaivita';
  let paivitaPaalla = true; try { paivitaPaalla = localStorage.getItem(PAIV_AVAIN) !== '0'; } catch (e) {}
  let speksiLahde = null, speksiEdel = null, speksiAjastin = 0;
  const riviTeksti = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, k.padEnd(13) + ' ' + v]);
  function nayta(o, lahde) {
    speksiLahde = lahde || null; speksiEdel = null;
    speksi.textContent = '';
    const yla = document.createElement('div'); yla.className = 'menu-header d-flex align-items-center'; yla.title = 'raahaa = siirrä';
    const nimi = document.createElement('span'); nimi.textContent = 'Speksit'; nimi.style.cssText = 'flex:1;';
    yla.appendChild(nimi);
    // 1.8.0 (kp 2026-09-28 04:34 "laita manual ja auto refresh eriksee"): 'auto'-ruksi (0,5 s välein, muistetaan) ja erillinen
    //   'päivitä'-nappi joka lukee kerran heti, myös auton ollessa pois. Otsikko kertoo luettiinko muutoksia.
    const paiv = document.createElement('label'); paiv.style.cssText = 'font-size:11px;margin-right:6px;cursor:pointer;' + (lahde ? '' : 'display:none;');
    paiv.title = 'auto: lue objekti uudelleen 0,5 s välein; muuttuneet rivit välähtää';
    const ruksi = document.createElement('input'); ruksi.type = 'checkbox'; ruksi.checked = paivitaPaalla; ruksi.style.cssText = 'margin-right:3px;vertical-align:middle;';
    ruksi.onchange = () => { paivitaPaalla = ruksi.checked; try { localStorage.setItem(PAIV_AVAIN, paivitaPaalla ? '1' : '0'); } catch (e) {} };
    paiv.appendChild(ruksi); paiv.appendChild(document.createTextNode('auto'));
    const kasin = document.createElement('button'); kasin.textContent = 'päivitä'; kasin.title = 'lue objekti uudelleen nyt (kerran)';
    if (!lahde) kasin.style.display = 'none';
    const kop = document.createElement('button'); kop.textContent = 'kopioi'; const sulje = document.createElement('button'); sulje.textContent = '×';
    for (const b of [kasin, kop, sulje]) b.className = 'kdb-nappi';
    kasin.style.marginRight = '4px';
    let nykyinen = o;
    kop.onclick = () => { try { navigator.clipboard.writeText(JSON.stringify(nykyinen, null, 1)); kop.textContent = 'kopioitu'; } catch (e) { kop.textContent = 'ei onnistunut'; } };
    sulje.onclick = () => { speksi.style.display = 'none'; speksiLahde = null; };
    yla.appendChild(paiv); yla.appendChild(kasin); yla.appendChild(kop); yla.appendChild(sulje); speksi.appendChild(yla);
    const runko = document.createElement('div'); runko.className = 'kdb-laatikko'; runko.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
    speksi.appendChild(runko);
    const piirra = (uusi, muuttui) => {
      nykyinen = uusi; runko.textContent = '';
      for (const [k, t] of riviTeksti(uusi)) { const d = document.createElement('div'); d.textContent = t;
        if (muuttui && muuttui.has(k)) { d.style.cssText = 'background:#b8860b;transition:background 1.5s;'; setTimeout(() => { d.style.background = 'transparent'; }, 60); }
        runko.appendChild(d); }
    };
    piirra(o, null); speksiEdel = o;
    speksi.style.display = 'block';
    clearInterval(speksiAjastin);
    const kello = () => { const t = new Date(); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0'); };
    // yksi lukukerta: palauttaa muuttuneiden rivien määrän, tai -1 kun objekti on poistunut huoneesta
    const lue = () => {
      let uusi = null; try { uusi = lahde(); } catch (e) {}
      if (!uusi) { nimi.textContent = 'Speksit (poistui)'; clearInterval(speksiAjastin); return -1; }
      const muuttui = new Set(); for (const k of new Set([...Object.keys(uusi), ...Object.keys(speksiEdel)])) if (k !== 'osuma' && String(uusi[k]) !== String(speksiEdel[k])) muuttui.add(k);
      if (speksiEdel.osuma && !uusi.osuma) uusi.osuma = speksiEdel.osuma;
      if (!muuttui.size) return 0;
      speksiEdel = uusi; piirra(uusi, muuttui);
      nimi.textContent = 'Speksit · muuttui ' + kello();
      return muuttui.size;
    };
    if (lahde) kasin.onclick = () => { if (speksiLahde !== lahde) return; const n = lue(); if (n === 0) nimi.textContent = 'Speksit · luettu ' + kello() + ', ei muutoksia'; };
    if (lahde) speksiAjastin = setInterval(() => {
      if (speksi.style.display === 'none' || speksiLahde !== lahde) { clearInterval(speksiAjastin); return; }
      if (!paivitaPaalla) return;
      lue();
    }, 500);
  }
  // 1.4.0 kp 23:40 "en saa painettua hahmoa altin kaa" / "painaa objektia hahmon läpi". SYY: vanha valinta vertasi
  // sprite-LAATIKOIDEN pinta-aloja (hahmo ×0.5). Hahmon laatikko on 90×130 = 11 700 px -> 5 850, joten mikä tahansa
  // pienempi esinelaatikko samassa kohdassa voitti. Mitattu robolla 2026-09-27 (huone 396): 9/9 hahmon pisteessä esine.
  // NYT pelin oma osumajärjestys: RoomSpriteCanvas.checkMouseHits (Nitro_Render_V3 RoomSpriteCanvas.ts:890) käy aktiiviset
  // spritet päältä alas ja testaa PIKSELIN (ExtendedSprite.containsPoint, läpinäkyvyyskartta); sprite.label = objektin
  // instanceId (RoomSpriteCanvas.ts:452). Hiiri -> canvas samoin kuin handleMouseEvent: (x - screenOffset) / scale.
  // Pinosta valitaan ensimmäinen HAHMO jos hiiren alla on hahmon pikseli ollenkaan (myös esineen takana), muuten päällimmäinen.
  // Alt+Shift = päällimmäinen objekti sellaisenaan. Palauttaa null jos spritejä ei saada -> vanha laatikkovalinta varalla.
  function osumaPino(r, rid, k, cx, cy) {
    const cv = k.cv; if (!cv || typeof cv.getExtendedSprite !== 'function' || !(cv._activeSpriteCount > 0)) return null;
    const kx = k.rect.width / (cv._width || k.rect.width), ky = k.rect.height / (cv._height || k.rect.height), s = cv._scale || 1;
    const x = Math.trunc(((cx - k.rect.left) / kx - (cv._screenOffsetX || 0)) / s), y = Math.trunc(((cy - k.rect.top) / ky - (cv._screenOffsetY || 0)) / s);
    const inst = r.getRoomInstance(rid), kartta = new Map();
    for (const cat of [100, 10, 20]) for (const u of inst.getRoomObjectsForCategory(cat)) kartta.set(String(u.instanceId), { cat, u });
    const pino = [], nahty = new Set();
    for (let i = cv._activeSpriteCount - 1; i >= 0; i--) {
      const sp = cv.getExtendedSprite(i); if (!sp || sp.skipMouseHandling || nahty.has(sp.label)) continue;
      let osuu = false; try { osuu = sp.containsPoint({ x: x - sp.x, y: y - sp.y }); } catch (err) {}
      if (!osuu) continue;
      nahty.add(sp.label); const o = kartta.get(sp.label); if (o) pino.push(o);
    }
    return pino;
  }
  // varatapa: sprite-laatikot, mutta hahmo voittaa aina kun hiiri on sen laatikossa; muuten pienin esinelaatikko
  function laatikkoValinta(r, rid, k, cx, cy) {
    const inst = r.getRoomInstance(rid); let paras = null;
    for (const cat of [100, 10, 20]) for (const u of inst.getRoomObjectsForCategory(cat)) {
      let bb = null; try { bb = k.laatikko(r.getRoomObjectBoundingRectangle(rid, u.id, cat, 1)); } catch (err) {}
      if (!bb || cx < bb.x || cx > bb.x + bb.w || cy < bb.y || cy > bb.y + bb.h) continue;
      const ala = bb.w * bb.h, hahmo = cat === 100;
      if (!paras || (hahmo && !paras.hahmo) || (hahmo === paras.hahmo && ala < paras.ala)) paras = { cat, u, ala, hahmo };
    }
    return paras;
  }
  // pointerdownin preventDefault estää Chromessa mousedown/mouseupin mutta EI clickiä, ja peli kuuntelee canvas.onclick
  // (DarkUI RoomView.tsx:20) -> Alt+klikkaus meni myös pelille. Niellään saman eleen Alt-click.
  let nieleKlikki = 0;
  VW.addEventListener('click', e => { if (nieleKlikki && e.altKey && performance.now() - nieleKlikki < 1500) { nieleKlikki = 0; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  VW.addEventListener('pointerdown', e => {
    if (!A.paalla || !e.altKey || e.button !== 0) return;
    const rid = huone(), r = RE(); if (!rid || !r) return; const k = kamera(rid); if (!k) return;
    const t = e.target; if (t !== peliCanvas() && t !== ov) return;
    e.preventDefault(); e.stopPropagation(); nieleKlikki = performance.now();
    let pino = null; try { pino = osumaPino(r, rid, k, e.clientX, e.clientY); } catch (err) { pino = null; }
    let paras, osuma;
    if (pino) { paras = (e.shiftKey ? pino[0] : (pino.find(o => o.cat === 100) || pino[0])) || null; osuma = 'pikseli, ' + pino.length + ' päällekkäin' + (e.shiftKey ? ', päällimmäinen' : ''); }
    else { paras = laatikkoValinta(r, rid, k, e.clientX, e.clientY); osuma = 'laatikko (varatapa)'; }
    if (!paras) { const hr = viimeisinHiiriRuutu; nayta({ ruutu: hr ? hr.x + ',' + hr.y : '-', korkeus: hr ? hr.z : undefined, huone: rid, huom: 'ei esinettä tässä', osuma }); return; }
    const o = paras.cat === 100 ? hahmodata(rid, paras.u) : furnidata(r, paras.cat, paras.u); o.osuma = osuma;
    const pc = paras.cat, pid = paras.u.id;
    nayta(o, () => { const rr = RE(), u = rr && rr.getRoomObject(rid, pid, pc); return u ? (pc === 100 ? hahmodata(rid, u) : furnidata(rr, pc, u)) : null; });
  }, true);

  // 1.6.0 kp 2026-09-28 02:59 "joo hei ois kiva jos se debug data sais tommosee valikkoo · right click ja alt nii näkee kaikki
  //   datat · pelaaja, item": oikean klikkauksen valikkoon (klikkikävely 1.10.0+) rivi Tiedot, joka avaa saman speksi-ikkunan
  //   kuin Alt+klikkaus. Toimii vaikka paneeli olisi pois (F8) — rivi ei piirrä mitään huoneeseen.
  const tiedot = (d, virhe, lahde) => { try { if (d) { nayta(d, lahde); return ''; } } catch (e) {} return virhe; };
  (VW.kuplaValikkoJono = VW.kuplaValikkoJono || []).push(
    { kohde: ['hahmo', 'oma'], nimi: 'Tiedot', lisaosa: 'Debug-näkymä',
      tee: ctx => { const lue = () => { const r = RE(), u = r && r.getRoomObject(ctx.roomId, ctx.hahmo.roomIndex, 100); return u ? hahmodata(ctx.roomId, u) : null; };
        return tiedot(lue(), 'hahmoa ei löytynyt', lue); } },
    { kohde: 'esine', nimi: 'Tiedot', lisaosa: 'Debug-näkymä',
      tee: ctx => { const lue = () => { const r = RE(), u = r && r.getRoomObject(ctx.roomId, ctx.esine.id, ctx.esine.cat); return u ? furnidata(r, ctx.esine.cat, u) : null; };
        return tiedot(lue(), 'esinettä ei löytynyt', lue); } });

  document.body.appendChild(paneeli);
  raahattava(paneeli, 'kupla.debugNakyma.paikka.paneeli');
  paivitaNappi();
  requestAnimationFrame(piirra);
})();
