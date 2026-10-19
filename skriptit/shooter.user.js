// ==UserScript==
// @name         Kupla Shooter (prototyyppi)
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      0.9.4
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/shooter.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/shooter.user.js
// @description  Ammuskelupeli Datajaon pelikanavan (asu, paketti 2730) kautta. Välilyönti ampuu katseen suuntaan. Vain samassa huoneessa olevat Datajako 0.22+ -pelaajat.
// @kupla-oletus off
// @author       re-lab
// ==/UserScript==
/*
 * kp 2026-10-19 09:45: "tehää eka shooter prototyyppi. toimii datajaon eli asun kautta". Idea 16.10. (RES-PYYNNOT.md:256):
 *   space ampuu, luodit katseen suuntaan, health barit, ammukset myöhemmin.
 * KANAVA: window.kuplaDatajakoPeli (Datajako 0.22.0) — ~3 kehystä/s, monta tapahtumaa per kehys, ei kuittausta.
 * MALLI: tapahtumapohjainen. Liike = pelin oma kävely (palvelin). Laukaus = yksi tapahtuma {a:'s', i, x, y, d};
 *   jokainen client simuloi luodin itse. OSUMAN PÄÄTTÄÄ UHRIN OMA CLIENT (ainoa joka tietää oman paikkansa tarkasti),
 *   ja se kertoo uuden HP:n {a:'o', i, by, hp}. Siksi luodit voivat näyttää eri clienteissa vähän eri paikoissa (viive ~0,3-0,6 s).
 * TAPAHTUMAT: j = liityin/olen mukana (hp) · s = laukaus · o = osuma minuun (hp, by) · q = lähdin pelistä.
 * ASEET 0.2.0: valitsin (pistooli/kivääri/laser/haulikko = hitscan, jousi = nuoli). Uhrin client päättää osuman molemmissa.
 * KAMERA 0.3.0: kameralukko mukana (🎥-nappi tai Alt+K), toimii vain pelin ollessa päällä.
 * KÄSI 0.4.0: valittu ase piirretään hahmon käteen (vain shooterin kankaalle, ei palvelimen handitem).
 * VÄLÄHDYS 0.5.0: osuman ottanut hahmo välähtää punaisena 450 ms (soikio hahmon rajauslaatikon päällä).
 * 0.6.0 (kp 10:04-10:08): aseina vain ne joille on oikea käsiesine — Pyssy = :handitem 1126, Jousi = :handitem 1128 (VIP-komento,
 *   lähetetään chat-paketilla 1314; kaikki näkevät sen, myös ilman shooteria). Emoji-käsiase poistettu. Välähdys tehdään nyt pelin
 *   rendererissä: hahmon spritejen väri (sprite.color = tint) punaiseksi, sama keino kuin noppa-GUI:n hohteen varareitti.
 *   Uusi paneeli: liity/lopeta, HP, ase-napit, kamera- ja game mode -kytkimet. Game mode = kuplafixin oma asetus
 *   (localStorage 'kuplafix.gameMode' + storage-tapahtuma, jota clientin asetusvarasto kuuntelee), sama kuin .settings-valikossa.
 * 0.7.0 (kp 10:15 "wasd on huono"): oma WASD pelin ajaksi: pidetyt näppäimet, vinot, maali 3 ruutua edellä, 3320 UNIT_WALK.
 * 0.7.2: luotiviiru + suuliekki laserin tilalle, kuollut makaa (paikallinen lay), kameralukon kääre seuraa uusinta asennusta.
 * 0.8.0: hiirellä tähtäys: hahmo kääntyy hiiren suuntaan (3301 UNIT_LOOK) ja välilyönti ampuu sinne.
 * 0.8.1: vapaa tähtäys (ux/uy). 0.8.2: M1-ammunta poistettu (kp 10:32), irrotus ei lähetä pysäytystä (askel taaksepäin), katse odottaa 600 ms.
 * 0.9.0: klikkausammunta pelin aikana (kp 10:34), klikit eivät mene peliin (ei valikoita, ei kävelyä).
 * 0.9.1: kävellessä (WASD) ei voi ampua taaksepäin, yli 120° kävelysuunnasta (kp 10:35).
 * 0.9.3: liike- ja chat-tila (Enter avaa chatin, Enter/Esc/klikkaus muualle palauttaa liikkeeseen).
 * RAJA (prototyyppi): luoti/säde ei pysähdy seiniin/huonekaluihin eikä ensimmäiseen pelaajaan, vain kantama. Ei ammuksia.
 *   Jos :handitem ei ole käytössä (ei VIP), ase ei näy kädessä, mutta peli toimii.
 */
(() => {
  'use strict';
  const VW = window;
  if (VW.__kuplaShooter) return; VW.__kuplaShooter = true;

  const NOPEUS = 8, KANTAMA = 12, VAHINKO = 25, COOLDOWN = 400, HERATYS_MS = 3000, OSUMA_SADE = 0.55;
  const dv = (o, k) => { try { return o ? o[k] : undefined; } catch (e) { return undefined; } };
  const RE = () => VW.NitroDevTools && VW.NitroDevTools.roomEngine;
  const peli = () => VW.kuplaDatajakoPeli;
  const huoneId = () => { try { const id = RE().activeRoomId; return Number.isInteger(id) && id > 0 ? id : null; } catch (e) { return null; } };
  const omaNimi = () => { try { return peli() && peli().omaNimi(); } catch (e) { return null; } };

  // ---------- huoneen hahmot: nimi -> {x,y,z,suunta} ----------
  function hahmot(rid) {
    const out = new Map(), r = RE(); if (!r || !rid) return out;
    const inst = r.getRoomInstance(rid), sm = r._roomSessionManager && r._roomSessionManager.getSession(rid), ud = sm && sm.userDataManager;
    if (!inst || !ud) return out;
    for (const o of inst.getRoomObjectsForCategory(100)) {
      const d = ud.getUserDataByIndex(o.id); if (!d || !d.name || d.type !== 1) continue;
      const l = o.getLocation(), s = o.getDirection();
      out.set(d.name, { id: o.id, x: l.x, y: l.y, z: l.z, suunta: s ? s.x : 0 });
    }
    return out;
  }
  const suuntaVektori = a => { const r = (Math.round(a / 45) * 45) * Math.PI / 180; return { dx: Math.round(Math.sin(r)), dy: -Math.round(Math.cos(r)) }; };

  // ---------- kamera (sama kuin datajako.user.js osoittimessa) ----------
  // 0.9.2 (kp 10:37 'performance ongelmia'): profiilissa querySelectorAll 3,4 % + getBoundingClientRect 3,9 % = tämä haku joka ruudulla.
  //   Nyt kangas ja sen rect välimuistissa 500 ms (koko muuttuu vain ikkunan koon muuttuessa).
  let pcMuisti = null, pcAika = 0;
  const peliCanvas = () => {
    const nyt = performance.now(); if (pcMuisti && nyt - pcAika < 500 && pcMuisti.c.isConnected) return pcMuisti;
    let paras = null, ala = 0, rect = null; for (const c of document.querySelectorAll('canvas')) { if (c.id === 'kupla-shooter') continue; const b = c.getBoundingClientRect(); if (b.width * b.height > ala) { ala = b.width * b.height; paras = c; rect = b; } }
    pcMuisti = paras ? { c: paras, rect } : null; pcAika = nyt; return pcMuisti;
  };
  function kamera(rid) {
    const r = RE(); const cv = r && r.getRoomInstanceRenderingCanvas(rid, 1); if (!cv) return null;
    const g = cv.geometry, gc = peliCanvas(); if (!g || !gc) return null;
    const rect = gc.rect, kx = rect.width / (cv._width || rect.width), ky = rect.height / (cv._height || rect.height);
    const V = g.direction.constructor, sc = cv._scale || 1, w2 = (cv._width || 0) / 2, h2 = (cv._height || 0) / 2, ox = cv._screenOffsetX || 0, oy = cv._screenOffsetY || 0;
    const f = (x, y, z) => { const p = g.getScreenPoint(new V(x, y, z)); return p ? { x: rect.left + (p.x * sc + w2 + ox) * kx, y: rect.top + (p.y * sc + h2 + oy) * ky } : null; };
    f.laatikko = bb => bb && bb.width > 0 ? { x: rect.left + bb.x * kx, y: rect.top + bb.y * ky, w: bb.width * kx, h: bb.height * ky } : null;
    return f;
  }

  // ---------- tila ----------
  // ASEET (kp 19.10. 09:57 "valinta ase vai bow. bow on projektiili" · "arrow shaped" · "tee pyssy selector kans vaikka on vaa
  //   visuaalinen ero"): m 'h' = hitscan (osuma heti, näkyy lyhyt säde), 'p' = projektiili (nuoli lentää NOPEUS ruutua/s).
  //   Aseen id kulkee laukauksen mukana (w), joten muut piirtävät sen samannäköisenä. Vahinko on kaikilla sama.
  //   0.6.0 kp 10:06 "poista aseet mihi ei oo handitem": vain ne joille on käsiesine (ExternalTexts handitem1126/1128).
  //   id 'pistooli' pidetään, jotta vanhemmat clientit (0.2-0.5) ymmärtävät laukauksen.
  const ASEET = {
    pistooli: { ikoni: '🔫', nimi: 'Pyssy', m: 'h', vari: '#ffd23f', leveys: 3, kasi: 1126 },
    jousi: { ikoni: '🏹', nimi: 'Jousi', m: 'p', vari: '#c9c9c9', kasi: 1128 },
  };
  let paalla = false, hp = 100, kuollutAsti = 0, viimeLaukaus = 0, tapot = 0, kuolemat = 0, rid0 = null;
  let ase = 'jousi'; try { const a = localStorage.getItem('kupla-shooter-ase'); if (ASEET[a]) ase = a; } catch (e) {}
  const pelaajat = new Map();   // nimi -> {hp, t, kuoliAsti, herasi}
  const luodit = new Map();     // id -> {from, x, y, dx, dy, z, t0, w}  (projektiilit)
  const jaljet = [];            // hitscan-säteet {x, y, dx, dy, z, pituus, t0, oma, w}
  const viesti = [];            // ruudun tapahtumarivit
  const valahdys = new Map();   // nimi -> osuman aika (punainen välähdys 450 ms)
  const ilmoita = t => { viesti.push({ t, ts: Date.now() }); if (viesti.length > 5) viesti.shift(); };
  const uusiId = () => crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  const laheta = e => { const p = peli(); return !!(p && p.laheta(e)); };
  const aseOf = w => ASEET[w] || ASEET.pistooli;

  // chat-rivi palvelimelle (1314 UNIT_CHAT). Yhteys on Datajaon löytämä (VW.__nitroConn). Mitattu robolla 19.10. 10:12:
  //   ':handitem 1126' -> oman hahmon figure_carry_object = 1126.
  function lahetaPaketti(id, ...args) {
    try {
      const c = VW.__nitroConn, map = c && dv(dv(c, '_messages'), '_messageIdByComposer'); let C = null;
      if (map) for (const [k, v] of map) if (v === id && !C) C = k;
      if (!C) return false; c.send(new C(...args)); return true;
    } catch (e) { return false; }
  }
  const chatKomento = teksti => lahetaPaketti(1314, teksti);
  const kasiin = id => chatKomento(':handitem ' + (id | 0));

  function liity() {
    if (!peli()) { ilmoita('Datajako 0.22+ puuttuu'); return; }
    paalla = true; hp = 100; kuollutAsti = 0; rid0 = huoneId(); gmPelinAjaksi(); laheta({ a: 'j', hp, w: ase }); kasiin(ASEET[ase].kasi);
    ilmoita('Mukana pelissä (' + ASEET[ase].nimi + '). Välilyönti ampuu.'); piirraNappi();
  }
  function poistu() { if (paalla) { laheta({ a: 'q' }); kasiin(0); } paalla = false; pidetyt.clear(); gmPelinAjaksi(); luodit.clear(); pelaajat.clear(); jaljet.length = 0; valahdys.clear();
    for (const [id] of savytetyt) savyta(huoneId(), id, 0xffffff); savytetyt.clear(); piirraNappi(); }
  function valitseAse(a) {
    if (!ASEET[a]) return; ase = a; try { localStorage.setItem('kupla-shooter-ase', ase); } catch (e) {}
    if (paalla) { laheta({ a: 'j', hp, w: ase }); if (!kuollutAsti) kasiin(ASEET[ase].kasi); } piirraNappi();
  }

  // osuma minuun: OMA client päättää (vain se tietää oman paikkansa tarkasti)
  function osuin(id, from) {
    const nyt = Date.now(); hp = Math.max(0, hp - VAHINKO); valahdys.set(omaNimi(), nyt);
    if (hp <= 0) { kuolemat++; kuollutAsti = nyt + HERATYS_MS; kasiin(0); ilmoita(from + ' kaatoi sinut'); } else ilmoita(from + ' osui (' + hp + ')');
    laheta({ a: 'o', i: id, by: from, hp });
  }
  // hitscan: osuu jos sivuetäisyys säteestä < OSUMA_SADE ja 0.3 < matka <= KANTAMA. Palauttaa matkan tai null.
  function sateella(x, y, dx, dy, mx, my) {
    const l2 = dx * dx + dy * dy; if (!l2) return null;
    const s = ((mx - x) * dx + (my - y) * dy) / l2, matka = s * Math.sqrt(l2);
    if (matka < 0.3 || matka > KANTAMA) return null;
    return Math.hypot(x + dx * s - mx, y + dy * s - my) < OSUMA_SADE ? matka : null;
  }

  function ammu(px, py) {
    const nyt = Date.now(); if (!paalla || nyt < kuollutAsti || nyt - viimeLaukaus < COOLDOWN) return;
    const rid = huoneId(), minä = hahmot(rid).get(omaNimi()); if (!minä) return;
    const hv = hiirenVektori(px, py), kulma = hv ? ((Math.round(Math.atan2(hv.dx, -hv.dy) * 180 / Math.PI / 45) * 45) % 360 + 360) % 360 : minä.suunta;
    const { dx, dy } = suuntaVektori(kulma), x = Math.round(minä.x)   /* 0.8.2 kp 10:32: suunta hiirestä suhteessa omaan ruutuun, 8 suuntaa */, y = Math.round(minä.y), i = uusiId(), A = ASEET[ase];
    // 0.9.1 kp 10:35 'ettei voi ampuu taaksepäin jos selvästi kävelee poispäin': WASD-kävelyn aikana yli 120° kävelysuunnasta = ei laukausta
    if (pidetyt.size) { const [mx, my] = wasdSuunta, ml = Math.hypot(mx, my), dl = Math.hypot(dx, dy); if (ml && dl && (mx * dx + my * dy) / (ml * dl) < -0.5) return; }
    viimeLaukaus = nyt;
    if (A.m === 'h') jaljet.push({ x, y, dx, dy, z: minä.z, pituus: KANTAMA, t0: nyt, oma: true, w: ase });
    else luodit.set(i, { from: omaNimi(), x, y, dx, dy, z: minä.z, t0: nyt, w: ase });
    laheta({ a: 's', i, x, y, d: Math.round(kulma), ux: Math.round(dx * 1000) / 1000, uy: Math.round(dy * 1000) / 1000, m: A.m, w: ase });   // d vanhoille clienteille
  }

  // ---------- vastaanotto ----------
  function kasittele(nimi, e) {
    if (!paalla || nimi === omaNimi()) return;
    const nyt = Date.now();
    if (e.a === 'j') {
      const p = pelaajat.get(nimi), uusi = !p, arvo = +e.hp || 100;
      if (p && p.kuoliAsti && nyt < p.kuoliAsti) p.herasi = arvo;   // herätys ei ohita kuolinaikaa: palkki pysyy nollassa koko HERATYS_MS
      else pelaajat.set(nimi, { hp: arvo, t: nyt });
      if (ASEET[e.w]) (pelaajat.get(nimi) || {}).w = e.w;
      if (uusi) { ilmoita(nimi + ' liittyi'); laheta({ a: 'j', hp, w: ase }); }
    }
    else if (e.a === 'q') { pelaajat.delete(nimi); ilmoita(nimi + ' lähti pelistä'); }
    else if (e.a === 's') {
      if (!pelaajat.has(nimi)) pelaajat.set(nimi, { hp: 100, t: nyt });
      const id = String(e.i || '').slice(0, 12); if (!id || luodit.has(id)) return;
      const uL = Math.hypot(+e.ux, +e.uy), { dx, dy } = uL > 0.5 && uL < 1.5 ? { dx: +e.ux / uL, dy: +e.uy / uL } : suuntaVektori(+e.d || 0), kaikki = hahmot(huoneId()), h = kaikki.get(nimi), x = +e.x | 0, y = +e.y | 0, z = h ? h.z : 0;
      const w = ASEET[e.w] ? e.w : (e.m === 'h' ? 'pistooli' : 'jousi'); pelaajat.get(nimi).w = w;
      if (e.m === 'h') {
        const minä = kaikki.get(omaNimi()), osuma = minä && !kuollutAsti ? sateella(x, y, dx, dy, minä.x, minä.y) : null;
        jaljet.push({ x, y, dx, dy, z, pituus: osuma || KANTAMA, t0: nyt, oma: false, w });
        if (osuma) osuin(id, nimi);
      } else luodit.set(id, { from: nimi, x, y, dx, dy, z, t0: nyt, w });
    } else if (e.a === 'o') {
      const p = pelaajat.get(nimi) || {}; p.hp = Math.max(0, +e.hp | 0); p.t = nyt; valahdys.set(nimi, nyt);
      if (p.hp <= 0) { p.kuoliAsti = nyt + HERATYS_MS; p.herasi = null; }
      pelaajat.set(nimi, p); luodit.delete(String(e.i || ''));
      if (p.hp <= 0) { if (e.by === omaNimi()) { tapot++; ilmoita('Kaadoit: ' + nimi); } else ilmoita(e.by + ' kaatoi: ' + nimi); }
    }
  }

  // ---------- simulointi (Worker-ajastin: toimii myös piilotetussa välilehdessä, rAF ei) ----------
  // 0.1.0:ssa osumat tarkistettiin rAF:ssä -> piilotettu välilehti ei huomannut osumaa ajallaan, ja kp näki robon palkin
  //   hyppäävän ohi nollan ja "resettaa liian aikasin" (kp 09:56). Nyt simulointi 30 ms ajastimella, piirto rAF:ssä.
  function simuloi() {
    if (!paalla) return;
    const rid = huoneId(); if (rid !== rid0) { poistu(); ilmoita('Huone vaihtui, peli suljettu'); return; }
    const nyt = Date.now(), minä = hahmot(rid).get(omaNimi());
    if (kuollutAsti && nyt >= kuollutAsti) { kuollutAsti = 0; hp = 100; laheta({ a: 'j', hp, w: ase }); kasiin(ASEET[ase].kasi); ilmoita('Heräsit henkiin'); }
    for (const [, p] of pelaajat) if (p.kuoliAsti && nyt >= p.kuoliAsti) { p.kuoliAsti = 0; p.hp = p.herasi != null ? p.herasi : 100; p.herasi = null; }
    for (const [id, b] of luodit) {
      const matka = (nyt - b.t0) / 1000 * NOPEUS; if (matka > KANTAMA) { luodit.delete(id); continue; }
      if (minä && b.from !== omaNimi() && !kuollutAsti && matka > 0.5 && Math.hypot(b.x + b.dx * matka - minä.x, b.y + b.dy * matka - minä.y) < OSUMA_SADE) { luodit.delete(id); osuin(id, b.from); }
    }
    while (jaljet.length && nyt - jaljet[0].t0 > 450) jaljet.shift();
  }
  try { if (typeof VW.__shooterSammuta === 'function') VW.__shooterSammuta(); } catch (e) {}
  const ajastin = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(1),30)'])));
  ajastin.onmessage = () => { try { simuloi(); } catch (e) {} };
  VW.__shooterSammuta = () => { try { ajastin.terminate(); } catch (e) {} };

  // ---------- piirto ----------
  const cv = document.createElement('canvas'); cv.id = 'kupla-shooter';
  Object.assign(cv.style, { position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 60 });
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');

  function nuoli(a, b, karki) {   // a = kärki, b = piste nuolen takana (ruudulla)
    const kulma = Math.atan2(a.y - b.y, a.x - b.x), L = 22, K = 7, c = Math.cos(kulma), s = Math.sin(kulma);
    const hx = a.x - c * L, hy = a.y - s * L;
    ctx.lineCap = 'round'; ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(a.x, a.y); ctx.stroke();
    ctx.strokeStyle = '#8b5a2b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(a.x, a.y); ctx.stroke();
    ctx.fillStyle = karki; ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(a.x + c * 3, a.y + s * 3);
    ctx.lineTo(a.x - Math.cos(kulma - 0.5) * K, a.y - Math.sin(kulma - 0.5) * K); ctx.lineTo(a.x - Math.cos(kulma + 0.5) * K, a.y - Math.sin(kulma + 0.5) * K); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#eee'; ctx.lineWidth = 2;
    for (const sivu of [-0.6, 0.6]) { ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - Math.cos(kulma + sivu) * 6, hy - Math.sin(kulma + sivu) * 6); ctx.stroke(); }
  }
  function sade(a, b, A, alfa) {
    ctx.globalAlpha = alfa; ctx.lineCap = 'round';
    const viiva = (x1, y1, x2, y2) => { ctx.strokeStyle = '#000'; ctx.lineWidth = A.leveys + 2; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.strokeStyle = A.vari; ctx.lineWidth = A.leveys; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    if (A.haja) { const kulma = Math.atan2(b.y - a.y, b.x - a.x), L = Math.hypot(b.x - a.x, b.y - a.y);
      for (const d of [-0.06, 0, 0.06]) viiva(a.x, a.y, a.x + Math.cos(kulma + d) * L, a.y + Math.sin(kulma + d) * L); }
    else viiva(a.x, a.y, b.x, b.y);
    ctx.globalAlpha = 1;
  }

  // 0.7.1 kp 10:25 "pyssy efekti ... näyttää joltai laaserilt": pysyvä säde pois. Nyt suuliekki + lyhyt luotiviiru joka lentää maaliin ~120 ms.
  function luoti(a, b, A, ika) {
    if (ika < 90) { const r = 7 * (1 - ika / 90) + 2; ctx.globalAlpha = 1 - ika / 90; ctx.fillStyle = '#ffd27a';
      ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(a.x, a.y, r * 0.45, 0, Math.PI * 2); ctx.fill(); }
    const t = ika / 120; if (t <= 1) {
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, hx = a.x + (b.x - a.x) * t, hy = a.y + (b.y - a.y) * t, pit = Math.min(22, L * t);
      ctx.globalAlpha = 1; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,200,80,.55)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(hx - ux * pit, hy - uy * pit); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.strokeStyle = '#fff6d0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(hx - ux * pit * 0.6, hy - uy * pit * 0.6); ctx.lineTo(hx, hy); ctx.stroke();
    } else if (ika < 220) { ctx.globalAlpha = 1 - (ika - 120) / 100; ctx.fillStyle = '#ffe9a8'; ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  function piirra() {
    requestAnimationFrame(piirra);
    const W = innerWidth, H = innerHeight; if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    ctx.clearRect(0, 0, W, H);
    if (!paalla) return;
    const rid = huoneId(), nyt = Date.now(), kaikki = hahmot(rid), p = kamera(rid); if (!p) return;
    for (const [, b] of luodit) {
      const matka = (nyt - b.t0) / 1000 * NOPEUS, bx = b.x + b.dx * matka, by = b.y + b.dy * matka;
      const a = p(bx, by, b.z + 1.0), t = p(bx - b.dx * 0.3, by - b.dy * 0.3, b.z + 1.0); if (a && t) nuoli(a, t, aseOf(b.w).vari);
    }
    for (const j of jaljet) {
      const a = p(j.x, j.y, j.z + 1.0), b = p(j.x + j.dx * j.pituus, j.y + j.dy * j.pituus, j.z + 1.0); if (!a || !b) continue;
      luoti(a, b, aseOf(j.w), nyt - j.t0);
    }
    const palkki = (nimi, arvo) => { const h = kaikki.get(nimi); const s = h && p(h.x, h.y, h.z + 2.9); if (!s) return;
      const w = 40; ctx.fillStyle = '#000a'; ctx.fillRect(s.x - w / 2 - 1, s.y - 1, w + 2, 7);
      ctx.fillStyle = arvo > 50 ? '#3ddc5a' : arvo > 25 ? '#f5c542' : '#e5484d'; ctx.fillRect(s.x - w / 2, s.y, w * Math.max(0, arvo) / 100, 5);
      if (arvo <= 0) { ctx.font = '16px sans-serif'; ctx.fillText('💀', s.x - 8, s.y - 4); } };
    for (const [n, t] of valahdys) {
      const ika = nyt - t, h = kaikki.get(n); if (h) savytetyt.set(h.id, n);
      if (ika > 450) { valahdys.delete(n); continue; }
      if (h) savyta(rid, h.id, Math.floor(ika / 90) % 2 ? 0xff9090 : 0xff2a2a);
    }
    for (const [id, n] of savytetyt) if (!valahdys.has(n)) { savyta(rid, id, 0xffffff); savytetyt.delete(id); }
    for (const [n, x] of pelaajat) palkki(n, x.hp);
    palkki(omaNimi(), hp);
  }   // 0.9.2: paneeli päivittyy 250 ms ajastimella, ei joka ruudulla
  // välähdys pelin rendererissä (kp 10:05 "värjättii tarkasti pelin rendererin kautta"): hahmon spritejen tint.
  //   Varjo (alpha < 255) ja additiiviset spritet ohitetaan, kuten noppa-GUI:n hohdeAseta(). Mitattu 19.10. 10:11:
  //   asetettu väri pysyy spritessä seuraaviin ruutuihin, palautus = 0xffffff.
  const savytetyt = new Map();   // objId -> nimi
  function savyta(rid, id, vari) {
    try {
      const o = RE().getRoomObject(rid, id, 100), sp = (o && o.visualization && o.visualization.sprites) || [];
      for (const s of sp) { if (s.alpha !== 255 || s.blendMode === 'add') continue;
        if (s.color !== vari) { s.color = vari; if (s.increaseUpdateCounter) s.increaseUpdateCounter(); } }
    } catch (e) {}
  }
  requestAnimationFrame(piirra);

  // ---------- ohjaus ----------
  document.addEventListener('keydown', e => {
    if (!paalla || e.code !== 'Space' || e.repeat) return;
    if (chatTila) return;
    e.preventDefault(); e.stopPropagation(); ammu();
  }, true);


  // ---------- kameralukko (kp 19.10. 09:59 "yhdistää tohon shootterii … yhdessä skriptissä … toggleable") ----------
  // Kopio userscriptit/kameralukko/kameralukko.user.js 1.8.0:n ytimestä (hahmon jalkapiste ruudun keskelle, ajo moottorin
  //   päivityksessä ennen piirtoa, pelin oma kameraseuranta ohi kun lukko on päällä). Oma lippu (rm.__shooterKamera2), joten
  //   ei kääri samaa funktiota kahdesti. RAJA: jos erillinen Kameralukko on myös päällä, molemmat siirtävät kameraa: pidä yksi.
  //   Chat-kerroksen pystysiirto (kameralukko 1.7.0) jätetty pois tästä versiosta.
  let kameraPaalla = true; try { kameraPaalla = localStorage.getItem('kupla-shooter-kamera') !== 'off'; } catch (e) {}
  const kameraOpittu = {};
  const kameraAktiivinen = () => kameraPaalla && paalla;
  function kameraLukitse() {
    if (!kameraAktiivinen()) return;
    try {
      const r = RE(); if (!r) return; const rid = r.activeRoomId; if (rid == null || rid < 0) return;
      const s = r._roomSessionManager && r._roomSessionManager.getSession(rid), oma = s ? (s._ownRoomIndex != null ? s._ownRoomIndex : s.ownRoomIndex) : null;
      if (oma == null || oma < 0) return;
      const kangas = r.getRoomInstanceRenderingCanvas(rid, 1); if (!kangas) return;
      const S = r.getRoomObjectScreenLocation(rid, oma, 100, 1); if (!S) return;
      const sk = kangas.scale || 1, cx = kangas.width / sk / 2, cy = kangas.height / sk / 2, avain = rid + ':' + sk;
      if (!kameraOpittu[avain]) { const b = r.getRoomObjectBoundingRectangle(rid, oma, 100, 1); if (b && b.width > 0) kameraOpittu[avain] = [S.x - (b.x + b.width / 2), S.y - (b.y + b.height / 2)]; }
      const k = kameraOpittu[avain]; if (!k) return;
      const dx = Math.round(cx + k[0] - S.x), dy = Math.round(cy + k[1] - S.y); if (!dx && !dy) return;
      const o = r.getRoomInstanceRenderingCanvasOffset(rid, 1); if (!o) return;
      o.x += dx; o.y += dy; r.setRoomInstanceRenderingCanvasOffset(rid, 1, o);
    } catch (e) {}
  }
  let kameraKaaritty = false;
  function kameraKaari() {
    const r = RE(), rm = r && r._roomManager; if (!rm || typeof rm.update !== 'function') return false;
    // 0.7.1: kääre kutsuu AINA uusinta asennusta (kp 10:25 'kameralukko ei toimi': uudelleenasennus jätti kääreen vanhaan kopioon)
    VW.__shooterKameraFn = kameraLukitse; VW.__shooterKameraAkt = kameraAktiivinen;
    if (rm.__shooterKamera2) return true;
    const alkup = rm.update; rm.__shooterKamera2 = true;
    rm.update = function () { try { VW.__shooterKameraFn(); } catch (e) {} return alkup.apply(this, arguments); };
    if (typeof r.updateRoomCameras === 'function' && !r.__shooterKameraCam2) {
      const alkupCam = r.updateRoomCameras; r.__shooterKameraCam2 = true;
      r.updateRoomCameras = function () { if (VW.__shooterKameraAkt && VW.__shooterKameraAkt()) return; return alkupCam.apply(this, arguments); };
    }
    return true;
  }
  (function kameraRuutu() { requestAnimationFrame(kameraRuutu); if (!kameraKaaritty) kameraKaaritty = kameraKaari(); if (!kameraKaaritty) kameraLukitse(); })();
  const kameraVaihda = () => { kameraPaalla = !kameraPaalla; try { localStorage.setItem('kupla-shooter-kamera', kameraPaalla ? 'on' : 'off'); } catch (e) {} piirraNappi(); };
  document.addEventListener('keydown', e => { if (e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); kameraVaihda(); } });

  // ---------- WASD 0.7.0 (kp 10:15 "wasd on huono, liian epä-responsiivinen" · "modaa vähä"; Res 10:08 "diagonal ikkuna on aika pitkä") ----------
  // Clientin game mode (live-App rL): YKSI ruutu per keydown, 100 ms throttle, maali = nykyinen ruutu + 1. Siksi liike odottaa
  //   käyttöjärjestelmän näppäintoistoa (~0,5 s ennen ensimmäistä toistoa), nykii joka ruudulla ja vinoon menee vain viimeisin näppäin.
  // Tämä: pidetyt näppäimet joukkona, suunta = niiden summa (W+D = vino), 50 ms silmukka, maali 1 ruutu edellä (0.7.1: kp 10:24 "miks toi liikkuu noin paljoin kerral", 3 ruutua ylitti; uusi maali kun hahmo ohittaa puolivälin)
  //   (huoneen reunaan asti, heightmapin ei-huone-ruudut ~64 rajaavat), uusi maali heti kun suunta vaihtuu. Irrotus pysäyttää ruutuun johon hahmo
  //   on jo menossa. Paketti 3320 UNIT_WALK(x, y), sama kuin klikkaus lattiaan. Clientin oma game mode kytketään pois pelin ajaksi
  //   (muuten molemmat liikuttaisivat) ja palautetaan kun lopetat.
  // RAJA: huonekaluja ei katsota; palvelin kiertää esteen tai jättää liikkeen tekemättä. Ei toimi kun chat-kenttä on aktiivinen.
  const WASD_SUUNNAT = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0], arrowup: [0, -1], arrowleft: [-1, 0], arrowdown: [0, 1], arrowright: [1, 0] };
  let wasdPaalla = true; try { wasdPaalla = localStorage.getItem('kupla-shooter-wasd') !== 'off'; } catch (e) {}
  const pidetyt = new Set(); let wasdIrti = 0, wasdMaali = null, wasdAika = 0, wasdSuunta = [0, 0], gmPalautus = null;
  const wasdAktiivinen = () => wasdPaalla && paalla;
  const kirjoittaa = t => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const kuljettava = (r, rid, x, y) => { try { const h = r.getFurnitureStackingHeightMap(rid); return !!h && h.validPosition(x, y) && h.getTileHeight(x, y) < 60; } catch (e) { return false; } };
  function wasdTick() {
    if (!wasdAktiivinen()) { pidetyt.clear(); wasdMaali = null; return; }
    let dx = 0, dy = 0; for (const k of pidetyt) { dx += WASD_SUUNNAT[k][0]; dy += WASD_SUUNNAT[k][1]; }
    dx = Math.sign(dx); dy = Math.sign(dy);
    const r = RE(), rid = huoneId(), minä = rid && hahmot(rid).get(omaNimi()); if (!r || !minä) return;
    if (!dx && !dy) {
      if (wasdMaali && false) {   // 0.8.2 pois: kp 10:33 'tekee askeleen taaksepäin' — clientin sijainti laahaa palvelinta, joten pysäytysruutu jäi taakse. Maali on vain 1 ruutu edellä, hahmo pysähtyy siihen itse.
        const sx = Math.round(minä.x + wasdSuunta[0] * 0.45), sy = Math.round(minä.y + wasdSuunta[1] * 0.45);
        const pysahdys = kuljettava(r, rid, sx, sy) ? sx + ',' + sy : Math.round(minä.x) + ',' + Math.round(minä.y);
        if (pysahdys !== wasdMaali) { const [px, py] = pysahdys.split(',').map(Number); lahetaPaketti(3320, px, py); }   // napautus: maali on jo tämä ruutu -> ei turhaa pakettia
      }
      if (wasdMaali) { wasdMaali = null; wasdIrti = Date.now(); }
      return;
    }
    const bx = Math.round(minä.x), by = Math.round(minä.y); let tx = bx, ty = by;
    for (let k = 1; k <= 1; k++) { const x = bx + dx * k, y = by + dy * k; if (!kuljettava(r, rid, x, y)) break; tx = x; ty = y; }
    wasdSuunta = [dx, dy];
    if (tx === bx && ty === by) return;
    const avain = tx + ',' + ty, nyt = Date.now();
    if (avain !== wasdMaali || nyt - wasdAika > 600) { lahetaPaketti(3320, tx, ty); wasdMaali = avain; wasdAika = nyt; }
  }
  addEventListener('keydown', e => {
    if (!wasdAktiivinen() || e.altKey || e.ctrlKey || e.metaKey || chatTila) return;
    const k = (e.key || '').toLowerCase(); if (!WASD_SUUNNAT[k]) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!pidetyt.has(k)) { pidetyt.add(k); wasdTick(); }
  }, true);
  addEventListener('keyup', e => { const k = (e.key || '').toLowerCase(); if (pidetyt.delete(k)) { e.preventDefault(); e.stopImmediatePropagation(); wasdTick(); } }, true);
  addEventListener('blur', () => { if (pidetyt.size) { pidetyt.clear(); wasdTick(); } });
  setInterval(() => { if (pidetyt.size) wasdTick(); }, 50);
  // clientin game mode pois pelin ajaksi, takaisin lopussa (kutsutaan liity/poistu/kytkimestä)
  function gmPelinAjaksi() {
    if (wasdAktiivinen()) { if (gmPalautus === null && gmLue()) { gmPalautus = true; gmAseta(false); } }
    else if (gmPalautus) { gmPalautus = null; gmAseta(true); }
  }
  const wasdVaihda = () => { wasdPaalla = !wasdPaalla; try { localStorage.setItem('kupla-shooter-wasd', wasdPaalla ? 'on' : 'off'); } catch (e) {} pidetyt.clear(); gmPelinAjaksi(); piirraNappi(); };

  // ---------- kuollut makaa (0.7.2, kp 10:26 "hahmo menee :lay jos kuolee" · "ei tarvii olla oikee lay mut simuloitu") ----------
  // Paikallinen asento (RoomEngine.updateRoomObjectUserPosture, sama jota client käyttää palvelimen tilapäivityksistä): näkyy vain
  //   shooteria käyttäville, palvelimelle ei lähde mitään. Heräämisessä 'std'; palvelimen seuraava tilapäivitys korjaa loput.
  const makaavat = new Map();   // objId -> nimi
  function asento(rid, id, a) {
    try { const r = RE(), o = r.getRoomObject(rid, id, 100); if (o && o.model.getValue('figure_posture') !== a) r.updateRoomObjectUserPosture(rid, id, a, ''); } catch (e) {}
  }
  setInterval(() => {
    const rid = huoneId(); if (!rid) return;
    const nyt = Date.now(), kuolleet = new Set();
    if (paalla) { if (kuollutAsti && nyt < kuollutAsti) kuolleet.add(omaNimi()); for (const [n, p] of pelaajat) if (p.kuoliAsti && nyt < p.kuoliAsti) kuolleet.add(n); }
    const kaikki = kuolleet.size || makaavat.size ? hahmot(rid) : null; if (!kaikki) return;
    for (const n of kuolleet) { const h = kaikki.get(n); if (h) { asento(rid, h.id, 'lay'); makaavat.set(h.id, n); } }
    for (const [id, n] of makaavat) if (!kuolleet.has(n)) { asento(rid, id, 'std'); makaavat.delete(id); }
  }, 100);

  // ---------- hiirellä tähtäys (0.8.0, kp 10:29 "hahmon suunta seuraa hiirtä" · "ja ampuu sinne") ----------
  // Hiiren ruutupiste -> ruutuavaruuden kulma omasta hahmosta: kamera() antaa hahmon jalkapisteen ja yksikkövektorit x+1 / y+1
  //   ruudulla, 2x2-yhtälö ratkaisee hiiren (u, v). Pyöristys 45°:een (pelin 8 suuntaa). Hahmo käännetään palvelimella
  //   paketilla 3301 UNIT_LOOK(x, y) (näkyy kaikille), vain kun suunta vaihtuu ja ei kesken WASD-kävelyn. Välilyönti ampuu tähän suuntaan.
  let hiiriX = null, hiiriY = null, viimeKatse = null, viimeKatseAika = 0;
  addEventListener('mousemove', e => { hiiriX = e.clientX; hiiriY = e.clientY; }, true);
  // 0.8.1 vapaa tähtäys (kp 10:31 "minne click"): tarkka yksikkövektori ruutuavaruudessa, ei pyöristystä
  function hiirenVektori(px, py) {
    if (px == null) { px = hiiriX; py = hiiriY; } if (px == null) return null;
    const rid = huoneId(), minä = rid && hahmot(rid).get(omaNimi()), p = rid && kamera(rid); if (!minä || !p) return null;
    const o = p(minä.x, minä.y, minä.z), ex = p(minä.x + 1, minä.y, minä.z), ey = p(minä.x, minä.y + 1, minä.z); if (!o || !ex || !ey) return null;
    const ax = ex.x - o.x, ay = ex.y - o.y, bx = ey.x - o.x, by = ey.y - o.y, det = ax * by - bx * ay; if (!det) return null;
    const mx = px - o.x, my = py - o.y, u = (mx * by - bx * my) / det, v = (ax * my - mx * ay) / det, L = Math.hypot(u, v);
    return L < 0.35 ? null : { dx: u / L, dy: v / L };
  }
  function hiirenKulma() { const h = hiirenVektori(); return h ? ((Math.round(Math.atan2(h.dx, -h.dy) * 180 / Math.PI / 45) * 45) % 360 + 360) % 360 : null; }
  setInterval(() => {
    if (!paalla || kuollutAsti || pidetyt.size || Date.now() - wasdIrti < 350) return;   // 0.8.2: ei käännöstä kesken viimeistä askelta (kp 10:33)
    const k = hiirenKulma(); if (k == null || k === viimeKatse || Date.now() - viimeKatseAika < 50) return;
    const rid = huoneId(), minä = hahmot(rid).get(omaNimi()); if (!minä) return;
    const { dx, dy } = suuntaVektori(k);
    if (lahetaPaketti(3301, Math.round(minä.x) + dx * 3, Math.round(minä.y) + dy * 3)) { viimeKatse = k; viimeKatseAika = Date.now();
      // 0.9.2 kp 10:38 'kääntymisestä responsiivisemman': käännetään oma hahmo heti paikallisesti, palvelin vahvistaa saman suunnan
      try { const o = RE().getRoomObject(rid, minä.id, 100), d = o.getDirection(); o.setDirection(new d.constructor(k, d.y, d.z)); o.model.setValue('head_direction', k); } catch (e) {} }
  }, 30);

  // 0.9.0 klikkausammunta (kp 10:34 "ois kiva jos vois ampuu kliksuttelemalla" · "klikit menee pelaajan läpi eli ei avaa valikkoo"
  //   · "eikä painele shittii vahingos" · "koskee niitä jotka mukana pelis"). Pelin aikana vasen klikkaus pelikankaalle ampuu
  //   hiiren suuntaan (8 suuntaa, kuten välilyönti) eikä mene peliin: ei kävelyä, ei hahmo- eikä huonekaluvalikkoa.
  //   Paneeli ja muu käyttöliittymä toimivat normaalisti. Spämmäys sallittu, COOLDOWN rajaa tahdin.
  const pelikankaalle = e => paalla && e.button === 0 && e.target && e.target.tagName === 'CANVAS' && e.target.id !== 'kupla-shooter';
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) addEventListener(t, e => {
    if (!pelikankaalle(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (t === 'pointerdown') {   /* 0.9.4: pointerdownin preventDefault estää selaimen mousedownin -> ammutaan tästä (kp 10:41 'mul ei ammu click') */ if (chatTila || onChatKentta(document.activeElement)) liikkeeseen(); hiiriX = e.clientX; hiiriY = e.clientY; ammu(e.clientX, e.clientY); }
  }, true);

  // ---------- liike vai chat (0.9.3, kp 10:39 "järkevä system et liikuttaako pelaajaa vai chat input" · "ei voi de-select chat input"
  //   · "painamal ulos chat input alueelt") ----------
  // Pelin aikana kaksi tilaa: LIIKE (oletus: WASD liikkuu ja välilyönti ampuu vaikka chat-kenttä olisi valittuna) ja CHAT
  //   (Enter tai klikkaus chat-kenttään -> kirjoitus menee chattiin). Enter lähettää ja palaa liikkeeseen, Esc palaa ilman
  //   lähetystä, klikkaus chat-alueen ulkopuolelle palaa myös (valinta poistuu).
  let chatTila = false;
  const onChatKentta = el => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  const chatKentta = () => document.querySelector('.nitro-chat-input-container input, .nitro-chat-input-container textarea');
  const liikkeeseen = () => { chatTila = false; const a = document.activeElement; if (onChatKentta(a)) a.blur(); piirraNappi(); };
  addEventListener('keydown', e => {
    if (!paalla) return;
    if (e.key === 'Enter' && !e.isComposing) {
      if (!chatTila) { const c = chatKentta(); if (c) { e.preventDefault(); e.stopImmediatePropagation(); chatTila = true; c.focus(); piirraNappi(); } }
      else setTimeout(liikkeeseen, 0);   // Enter menee clientille (lähettää), sitten takaisin liikkeeseen
      return;
    }
    if (e.key === 'Escape' && chatTila) { e.preventDefault(); liikkeeseen(); return; }
    // liiketilassa kirjaimet eivät valu valittuun chat-kenttään (WASD/välilyönti hoidetaan omissa kuuntelijoissaan)
    if (!chatTila && onChatKentta(e.target) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
  }, true);
  addEventListener('mousedown', e => {
    if (!paalla) return;
    if (onChatKentta(e.target)) { chatTila = true; piirraNappi(); return; }
    if (!(e.target && e.target.closest && e.target.closest('.nitro-chat-input-container'))) { if (chatTila || onChatKentta(document.activeElement)) liikkeeseen(); }
  }, true);

  // ---------- paneeli 0.6.0 (kp 10:08 "laita siihen GUI toi game mode enable/disable" · "panosta vähän tohon GUI ulkoasuun") ----------
  // Game mode on kuplafixin oma asetus: client lukee sen localStoragesta ('kuplafix.gameMode', JSON true/false) ja kuuntelee
  //   'storage'-tapahtumaa (live-App: mx() -> addEventListener("storage", L8) -> Ax() lukee uudelleen). Kirjoitus + synteettinen
  //   StorageEvent päivittää siis saman tilan kuin .settings-valikon ruksi. WASD-käytös ja kytkinnäppäin jäävät clientin asetuksiin.
  const GM_AVAIN = 'kuplafix.gameMode';
  const gmLue = () => { try { return JSON.parse(localStorage.getItem(GM_AVAIN)) === true; } catch (e) { return false; } };
  function gmAseta(v) {
    try { localStorage.setItem(GM_AVAIN, JSON.stringify(!!v)); VW.dispatchEvent(new StorageEvent('storage', { key: GM_AVAIN })); } catch (e) {}
    piirraNappi();
  }

  const tyyli = document.createElement('style');
  tyyli.textContent = `
#kupla-shooter-nappi{position:fixed;left:12px;top:44px;z-index:61;width:212px;box-sizing:border-box;padding:8px 10px 10px;border-radius:12px;
 background:linear-gradient(180deg,rgba(40,44,60,.97),rgba(20,22,30,.97));border:2px solid #07080b;
 box-shadow:0 6px 16px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.08);font:12px Ubuntu,sans-serif;color:#e8ecf4;user-select:none}
#kupla-shooter-nappi *{box-sizing:border-box;font-family:inherit}
#kupla-shooter-nappi .ks-ots{display:flex;align-items:center;gap:6px;cursor:move}
#kupla-shooter-nappi .ks-ots b{font-size:13px;letter-spacing:.4px;flex:1;text-shadow:0 1px 0 #000}
#kupla-shooter-nappi .ks-kd{color:#9aa3b5;font-size:11px}
#kupla-shooter-nappi .ks-pien{border:0;background:transparent;color:#9aa3b5;cursor:pointer;font-size:13px;padding:0 2px}
#kupla-shooter-nappi .ks-runko{margin-top:8px;display:flex;flex-direction:column;gap:8px}
#kupla-shooter-nappi.ks-kiinni .ks-runko{display:none}
#kupla-shooter-nappi .ks-iso{width:100%;padding:7px 0;border-radius:8px;border:1px solid #000;font-weight:bold;font-size:13px;color:#fff;cursor:pointer;
 box-shadow:inset 0 -3px 0 rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.2)}
#kupla-shooter-nappi .ks-iso:active{transform:translateY(1px)}
#kupla-shooter-nappi .ks-hp{position:relative;height:16px;border-radius:8px;background:#0c0d12;border:1px solid #000;overflow:hidden}
#kupla-shooter-nappi .ks-hp i{position:absolute;left:0;top:0;bottom:0;transition:width .15s}
#kupla-shooter-nappi .ks-hp span{position:absolute;inset:0;text-align:center;line-height:14px;font-size:11px;font-weight:bold;text-shadow:0 1px 1px #000}
#kupla-shooter-nappi .ks-otsake{color:#9aa3b5;font-size:10px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:-4px}
#kupla-shooter-nappi .ks-aseet{display:flex;gap:6px}
#kupla-shooter-nappi .ks-ase{flex:1;padding:6px 0 5px;border-radius:8px;border:1px solid #000;background:#2c3142;color:#cfd5e2;cursor:pointer;
 display:flex;flex-direction:column;align-items:center;gap:1px;font-size:11px}
#kupla-shooter-nappi .ks-ase em{font-style:normal;font-size:18px;line-height:20px}
#kupla-shooter-nappi .ks-ase small{color:#8b93a6;font-size:9px}
#kupla-shooter-nappi .ks-ase.on{background:linear-gradient(180deg,#3d7be0,#2a5db5);color:#fff;box-shadow:0 0 0 1px #8fb6ff inset}
#kupla-shooter-nappi .ks-ase.on small{color:#d5e3ff}
#kupla-shooter-nappi .ks-rivi{display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:2px 0}
#kupla-shooter-nappi .ks-rivi small{display:block;color:#8b93a6;font-size:9px}
#kupla-shooter-nappi .ks-kytkin{width:34px;height:18px;border-radius:9px;background:#3a3f4f;border:1px solid #000;position:relative;flex:none;transition:background .15s}
#kupla-shooter-nappi .ks-kytkin::after{content:"";position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:#cfd5e2;transition:left .15s}
#kupla-shooter-nappi .ks-kytkin.on{background:#2fa35c}
#kupla-shooter-nappi .ks-kytkin.on::after{left:17px;background:#fff}
#kupla-shooter-nappi .ks-loki{min-height:0;display:flex;flex-direction:column;gap:2px;font-size:11px;color:#dfe5f0}
#kupla-shooter-nappi .ks-loki div{background:rgba(255,255,255,.06);border-radius:5px;padding:2px 6px}
#kupla-shooter-nappi .ks-vihje{color:#7d8598;font-size:10px;text-align:center}
`;
  document.head.appendChild(tyyli);

  const napit = document.createElement('div'); napit.id = 'kupla-shooter-nappi';
  napit.innerHTML = `
<div class="ks-ots"><b>🎯 Shooter</b><span class="ks-kd"></span><button class="ks-pien" title="Pienennä">▾</button></div>
<div class="ks-runko">
 <button class="ks-iso"></button>
 <div class="ks-hp"><i></i><span></span></div>
 <div class="ks-otsake">Ase</div>
 <div class="ks-aseet"></div>
 <div class="ks-otsake">Asetukset</div>
 <div class="ks-rivi" data-k="kamera"><div>🎥 Kameralukko<small>kamera seuraa sinua pelin aikana · Alt+K</small></div><div class="ks-kytkin"></div></div>
 <div class="ks-rivi" data-k="gm"><div>🎮 WASD-liike<small>pidä pohjassa, W+D = vino · clientin game mode on pois pelin ajan</small></div><div class="ks-kytkin"></div></div>
 <div class="ks-loki"></div>
 <div class="ks-vihje">Hiiri tähtää · klikkaus/välilyönti ampuu · WASD liikkuu<br>Enter = chat, Enter/Esc = takaisin peliin</div>
</div>`;
  const $ = s => napit.querySelector(s), nappi = $('.ks-iso'), asePaikka = $('.ks-aseet');
  const aseNapit = {};
  for (const [id, A] of Object.entries(ASEET)) {
    const b = document.createElement('button'); b.className = 'ks-ase';
    b.innerHTML = '<em>' + A.ikoni + '</em>' + A.nimi + '<small>' + (A.m === 'h' ? 'osuu heti' : 'nuoli lentää') + '</small>';
    b.onclick = e => { e.stopPropagation(); valitseAse(id); b.blur(); };
    asePaikka.append(b); aseNapit[id] = b;
  }
  nappi.onclick = e => { e.stopPropagation(); paalla ? poistu() : liity(); nappi.blur(); };
  $('.ks-rivi[data-k="kamera"]').onclick = e => { e.stopPropagation(); kameraVaihda(); };
  $('.ks-rivi[data-k="gm"]').onclick = e => { e.stopPropagation(); wasdVaihda(); };
  let kiinniTila = false; try { kiinniTila = localStorage.getItem('kupla-shooter-kiinni') === '1'; } catch (e) {}
  $('.ks-pien').onclick = e => { e.stopPropagation(); kiinniTila = !kiinniTila; try { localStorage.setItem('kupla-shooter-kiinni', kiinniTila ? '1' : '0'); } catch (e2) {} piirraNappi(); };
  // raahaus otsikosta, paikka muistiin
  try { const p = JSON.parse(localStorage.getItem('kupla-shooter-paikka') || 'null'); if (p && p.x >= 0 && p.y >= 0) { napit.style.left = Math.min(p.x, innerWidth - 60) + 'px'; napit.style.top = Math.min(p.y, innerHeight - 30) + 'px'; } } catch (e) {}
  $('.ks-ots').addEventListener('mousedown', e => {
    if (e.target.closest('.ks-pien')) return;
    const r = napit.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top; e.preventDefault();
    const liiku = m => { if (!m.buttons) return irti(); napit.style.left = Math.max(0, Math.min(innerWidth - 60, m.clientX - ox)) + 'px'; napit.style.top = Math.max(0, Math.min(innerHeight - 30, m.clientY - oy)) + 'px'; };
    const irti = () => { removeEventListener('mousemove', liiku, true); removeEventListener('mouseup', irti, true); removeEventListener('blur', irti);
      try { localStorage.setItem('kupla-shooter-paikka', JSON.stringify({ x: parseInt(napit.style.left), y: parseInt(napit.style.top) })); } catch (e2) {} };
    // capture: paneelin oma stopPropagation nieli bubble-vaiheen mouseupin ja ikkuna jäi hiireen (kp 10:14)
    addEventListener('mousemove', liiku, true); addEventListener('mouseup', irti, true); addEventListener('blur', irti);
  });
  // estä paneelin klikkausten valuminen huoneeseen (kävely)
  for (const t of ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']) napit.addEventListener(t, e => e.stopPropagation());

  let paneeliAllekirjoitus = '';
  function paivitaPaneeli(nyt) {
    nyt = nyt || Date.now();
    const loki = viesti.filter(v => nyt - v.ts < 6000).map(v => v.t);
    const herää = kuollutAsti ? Math.max(0, Math.ceil((kuollutAsti - nyt) / 1000)) : 0;
    const sig = [chatTila, paalla, hp, herää, tapot, kuolemat, ase, kameraPaalla, wasdPaalla, kiinniTila, loki.join('|')].join(',');
    if (sig === paneeliAllekirjoitus) return; paneeliAllekirjoitus = sig;
    napit.classList.toggle('ks-kiinni', kiinniTila); $('.ks-pien').textContent = kiinniTila ? '▸' : '▾';
    $('.ks-kd').textContent = paalla ? (chatTila ? '💬 chat · ' : '🎮 · ') + 'K ' + tapot + ' · D ' + kuolemat : '';
    nappi.textContent = paalla ? 'Lopeta peli' : 'Liity peliin';
    nappi.style.background = paalla ? 'linear-gradient(180deg,#f0565b,#c93a3f)' : 'linear-gradient(180deg,#43c46e,#2c9a52)';
    const hpEl = $('.ks-hp'); hpEl.style.display = paalla ? '' : 'none';
    const fill = hpEl.querySelector('i'); fill.style.width = Math.max(0, hp) + '%';
    fill.style.background = hp > 50 ? 'linear-gradient(180deg,#5ee37c,#2fb34f)' : hp > 25 ? 'linear-gradient(180deg,#ffd75e,#e0a91e)' : 'linear-gradient(180deg,#ff6b6f,#d83a3f)';
    hpEl.querySelector('span').textContent = herää ? '💀 herää ' + herää + ' s' : 'HP ' + hp;
    for (const [id, b] of Object.entries(aseNapit)) b.classList.toggle('on', id === ase);
    $('.ks-rivi[data-k="kamera"] .ks-kytkin').classList.toggle('on', kameraPaalla);
    $('.ks-rivi[data-k="gm"] .ks-kytkin').classList.toggle('on', wasdPaalla);
    $('.ks-loki').innerHTML = ''; for (const t of loki) { const d = document.createElement('div'); d.textContent = t; $('.ks-loki').append(d); }
  }
  function piirraNappi() { paneeliAllekirjoitus = ''; paivitaPaneeli(); }
  setInterval(() => paivitaPaneeli(), 250);
  document.body.appendChild(napit); piirraNappi();

  // kuuntelija kiinni kun Datajako on latautunut
  const kiinni = setInterval(() => { const p = peli(); if (!p) return; clearInterval(kiinni); p.kuuntele(kasittele); }, 500);
  VW.kuplaShooter = { versio: '0.9.4', liity, poistu, ammu, valitseAse, ASEET, tila: () => ({ paalla, ase, hp, tapot, kuolemat, pelaajat: [...pelaajat], luodit: luodit.size }) };
})();
