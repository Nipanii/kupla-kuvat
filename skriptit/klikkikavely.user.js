// ==UserScript==
// @name         Kupla Klikkikävely
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      1.13.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/klikkikavely.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/klikkikavely.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Klikkaus korotetulle pinnalle (palikkalattia, lentokone) kävelyttää sinne eikä maahan pinnan takana. Pinta valitaan pinokorkeuskartasta: hiiren alla lähimpänä kameraa oleva ruudun päällys. Lähettää saman kävelypaketin kuin peli itse.
// @kupla-oletus on
// @author       re-lab
// ==/UserScript==
//
// kp 2026-09-27 18:40: "jos tekee korkealle esim sen lentokoneen, lentokoneen lattian painaminen ei ohjaa hahmoa sinne".
//
// SYY (lähde D:/kupla-lahde/kupla-cc/client/Nitro_Render_V3/packages/room/src/RoomObjectEventHandler.ts):
//   esineen klikkaus -> handleMoveTargetFurni -> getActiveSurfaceLocation, joka palauttaa null jos furnidatassa
//   EI ole canStandOn/canSitOn/canLayOn. Kuplan FurnitureData.json:ssa ne ovat lähes kaikki false -> ei kävelyä.
//   Mitattu 2026-09-27 19:05 huone 357: klikkaus lavan päälle (21,17 korkeus 3) -> 0 kävelypakettia; kontrolli
//   lattiaruutuun 16,21 -> "Nm [16,21]" ja robo liikkui.
// KORJAUS: jos pelin oma polku ei kävelytä, lasketaan SAMA pintaruutu kuin pelin getActiveSurfaceLocation mutta ilman
//   lippuporttia, ja kävelytetään vain jos palvelimen korkeuskartta ei sano ruutua estetyksi (<40).
//   Estetty = Daybreak RoomTile.relativeHeight():88-95 -> 64*256 kun ruutu BLOCKED/SIT eikä pinottava (kasvi, tuoli
//   ilman pinoa, ovi) -> ei muutosta, klikkaus vain valitsee kuten ennen. Kattaa myös lattiatason matot (samat false-liput).
//   RAJA: pinottava mutta ei-käveltävä (pöytä: BLOCKED + allowStack) näkyy kartassa pöydän korkeutena -> lähtee
//   kävelypyyntö jonka palvelimen reitinhaku ratkaisee; client ei erota sitä palikasta.
//   🔴 KORJAUS 2026-09-27 20:50 (negatiivinen kontrolli, kasvi plant_bulrush 216930 @14,21, huone 357): "estetty = 64*256"
//   EI PIDÄ kuplassa — clientin pinokartta näyttää kasviruudulle 0.398 eikä _isNotStackable ole päällä, joten klikkaus
//   kasviin LÄHETTI "Nm [14,21]". Palvelin hylkäsi: robo pysyi 18,20. Eli portti ei estä mitään mitä client ei näe;
//   käytännössä: klikkaus esteeseen = yksi palvelimen hylkäämä kävelypyyntö, ei liikettä (sama kuin pöytä-raja).
//   Client ei voi erottaa estettyä ruutua: tieto on vain palvelimella. Positiivinen kontrolli (lava 21,17 -> z 3) ✅ samalla ajolla.
//   Hylätty 1. versio: pinokartan "kylkipylväät" -- ruutu 23,19 korkeus 63.996 peitti lavan (mitattu 19:20).
(function () {
  'use strict';
  const VW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  if (VW.__kuplaKlikkikavely) return;

  const RE = () => VW.NitroDevTools && VW.NitroDevTools.roomEngine;
  // 1.13.0 socket-yhteys roomEnginen session managerin alta (sama haku kuin supervoimat getConn: olio jolla oma _cryptoState)
  let _yhteys = null;
  const yhteys = () => {
    if (_yhteys) return _yhteys; const r = RE(); if (!r) return null; const seen = new Set();
    const scan = (o, d) => { if (!o || _yhteys || d > 4 || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
      if (Object.getOwnPropertyDescriptor(o, '_cryptoState')) { _yhteys = o; return; }
      for (const k of Object.getOwnPropertyNames(o)) { const de = Object.getOwnPropertyDescriptor(o, k); if (de && !de.get && de.value && typeof de.value === 'object') scan(de.value, d + 1); } };
    scan(r._roomSessionManager, 0); return _yhteys;
  };

  // 1.9.0 LISÄOSIEN RIVIT OIKEAN KLIKKAUKSEN VALIKKOON (kp 2026-09-28 00:44 "right clickaamal pelaajaa siel on mimic ja info
  //   … eli omat extensioni optionit tulee sielt", 00:45 tp, 00:48 "omaa hahmoo … se rotaatio juttu", "piilotetaa ne optiot
  //   mitä ei voi tehä", "joudut tekee alavalikkoi"; Res #570 "ei palvele sit jos right clickkaa jotain muuta"). Sama malli
  //   kuin komennoissa — lisäosa lisää omat rivinsä, latausjärjestyksellä ei väliä:
  //   (window.kuplaValikkoJono = window.kuplaValikkoJono || []).push({ kohde: 'hahmo' | 'oma' | 'ruutu' (tai taulukko),
  //     nimi: 'teksti' | ctx => 'teksti', nakyy: ctx => bool, tee: ctx => 'ilmoitus' | Promise, ala: ctx => [{ nimi, tee }],
  //     lisaosa: 'Nimi' });
  //   ctx = { hahmo: { roomIndex, id, nimi, tyyppi, oma, x, y } | null, esine: { id, cat (10 lattia / 20 seinä), luokka, nimi,
  //     tiloja, interaktio, x, y, z, tila } | null, ruutu: { x, y, h } | null, roomId }.
  //   'hahmo' = joku muu kuin sinä, 'oma' = oma hahmo, 'esine' = päällimmäinen esine pikselitarkasti (1.10.0),
  //   'ruutu' = päällimmäinen pinta kursorin alla. nakyy false -> rivi piiloon.
  const valikkoRivit = [];
  if (!VW.kuplaValikko) {
    const lisaaRivi = x => { if (x && x.nimi != null && x.kohde) valikkoRivit.push(x); };
    const vj = VW.kuplaValikkoJono = VW.kuplaValikkoJono || [];
    for (const x of vj.splice(0)) lisaaRivi(x);
    vj.push = (...xs) => { xs.forEach(lisaaRivi); return 0; };
    VW.kuplaValikko = { __versio: '1.10.0', lisaa: lisaaRivi, rivit: () => valikkoRivit.slice() };
  }

  // Hahmo kursorin alla: hahmon sprite-laatikko (sama getRoomObjectBoundingRectangle kuin debug-näkymässä), useammasta
  // se jonka alareuna on alimpana = lähimpänä kameraa. Laatikko on väljä (läpinäkyvät reunat mukana), ei pikselitarkka.
  function hahmoPisteessa(r, roomId, canvasEl, cx, cy) {
    const cv = r.getRoomInstanceRenderingCanvas(roomId, 1), inst = r.getRoomInstance(roomId); if (!cv || !inst) return null;
    const rect = canvasEl.getBoundingClientRect(), kx = rect.width / (cv._width || rect.width), ky = rect.height / (cv._height || rect.height);
    let paras = null;
    for (const o of inst.getRoomObjectsForCategory(100)) {
      let bb = null; try { bb = r.getRoomObjectBoundingRectangle(roomId, o.id, 100, 1); } catch (e) {}
      if (!bb || !(bb.width > 0)) continue;
      const x0 = rect.left + bb.x * kx, y0 = rect.top + bb.y * ky, x1 = x0 + bb.width * kx, y1 = y0 + bb.height * ky;
      if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
      if (!paras || y1 > paras.ala) paras = { o, ala: y1 };
    }
    if (!paras) return null;
    const s = r._roomSessionManager && r._roomSessionManager.getSession(roomId);
    const ud = s && s.userDataManager && s.userDataManager.getUserDataByIndex(paras.o.id); if (!ud) return null;
    const oma = (s._ownRoomIndex != null ? s._ownRoomIndex : s.ownRoomIndex) === ud.roomIndex, l = paras.o.getLocation();
    return { roomIndex: ud.roomIndex, id: ud.webID, nimi: ud.name, tyyppi: ud.type, oma, x: Math.round(l.x), y: Math.round(l.y) };
  }
  // 1.10.0 ESINE kursorin alla (kp 2026-09-28 02:57 "käytä tavaraa sen sijaa et double click", 02:59 "right click ja alt nii
  //   näkee kaikki datat · pelaaja, item"; Res "ei noppa specific"). Pelin oma osumajärjestys kuten debug-näkymä 1.4.0:
  //   RoomSpriteCanvas.checkMouseHits (RoomSpriteCanvas.ts:890) — aktiiviset spritet päältä alas, PIKSELItesti
  //   (containsPoint), sprite.label = objektin instanceId (:452). Päällimmäinen lattia- tai seinäesine; hahmot ohitetaan.
  function esinePisteessa(r, roomId, canvasEl, cx, cy) {
    const cv = r.getRoomInstanceRenderingCanvas(roomId, 1), inst = r.getRoomInstance(roomId);
    if (!cv || !inst || typeof cv.getExtendedSprite !== 'function' || !(cv._activeSpriteCount > 0)) return null;
    const rect = canvasEl.getBoundingClientRect(), kx = rect.width / (cv._width || rect.width), ky = rect.height / (cv._height || rect.height), s = cv._scale || 1;
    const x = Math.trunc(((cx - rect.left) / kx - (cv._screenOffsetX || 0)) / s), y = Math.trunc(((cy - rect.top) / ky - (cv._screenOffsetY || 0)) / s);
    const kartta = new Map(); for (const cat of [10, 20]) for (const u of inst.getRoomObjectsForCategory(cat)) kartta.set(String(u.instanceId), { cat, u });
    for (let i = cv._activeSpriteCount - 1; i >= 0; i--) {
      const sp = cv.getExtendedSprite(i); if (!sp || sp.skipMouseHandling) continue;
      const o = kartta.get(sp.label); if (!o) continue;
      let osuu = false; try { osuu = sp.containsPoint({ x: x - sp.x, y: y - sp.y }); } catch (e) {}
      if (!osuu) continue;
      const u = o.u, l = u.getLocation(); let tid, fd = null, tila;
      try { tid = u.model.getValue('furniture_type_id'); const sdm = r._sessionDataManager; fd = o.cat === 20 ? sdm.getWallItemData(tid) : sdm.getFloorItemData(tid); } catch (e) {}
      try { tila = u.getState(0); } catch (e) {}
      return { id: u.id, cat: o.cat, luokka: u.type, nimi: (fd && fd.name) || u.type, tiloja: fd ? fd.interactionModesCount : undefined,
        interaktio: fd ? fd.interactionType : undefined, x: Math.round(l.x), y: Math.round(l.y), z: +l.z.toFixed(2), tila };
    }
    return null;
  }
  const ESTETTY = 40; // palvelimen pinoraja (SetCustomStackingHeight clamp 40); 63.996 = "ei pinota/kävellä" -merkki

  // Pelin oma getActiveSurfaceLocation (RoomObjectEventHandler.ts:1631) ILMAN furnidata-lippuporttia, canSitOn=false:
  // klikatun esineen jalanjäljestä se ruutu jonka päällystä klikattiin. null = kylki tai jalanjäljen ulkopuolella.
  function pintaRuutu(r, roomId, event) {
    const o = r.getRoomObject(roomId, event.objectId, 10); if (!o || !o.model) return null; // 10 = RoomObjectCategory.FLOOR
    const loc = o.getLocation(), dir = o.getDirection();
    let sx = o.model.getValue('furniture_size_x'), sy = o.model.getValue('furniture_size_y'); const sz = o.model.getValue('furniture_size_z');
    if (dir.x === 90 || dir.x === 270) [sx, sy] = [sy, sx];
    if (!(sx >= 1)) sx = 1; if (!(sy >= 1)) sy = 1;
    const cv = r.getActiveRoomInstanceRenderingCanvas(); if (!cv) return null;
    const scale = cv.geometry.scale;
    const offX = ((scale / 2) + event.spriteOffsetX + event.localX) / (scale / 4);
    const offY = (event.spriteOffsetY + event.localY + (sz * scale) / 2) / (scale / 4);
    const tx = Math.floor(loc.x + (offX + 2 * offY) / 4), ty = Math.floor(loc.y - (offX - 2 * offY) / 4 + 1);
    if (tx < loc.x || tx >= loc.x + sx || ty < loc.y || ty >= loc.y + sy) return null;
    return { x: tx, y: ty, esine: event.objectId, esineZ: loc.z, kokoZ: sz };
  }

  // palvelimen korkeuskartan mukaan: korotettu, ei estetty -> sinne voi yrittää kävellä
  function kaveltava(r, roomId, x, y) {
    const sm = r.getFurnitureStackingHeightMap(roomId), lw = r.getLegacyWallGeometry(roomId); if (!sm || !lw) return null;
    const h = sm.getTileHeight(x, y), lattia = lw.getHeight(x, y) || 0;
    const esto = sm._isNotStackable ? sm._isNotStackable[y * sm.width + x] : false;
    return { h, lattia, ok: lw.isRoomTile(x, y) && !esto && h < ESTETTY };
  }

  // 1.1.0 kp 2026-09-27 21:33: "jos painaisin nyt tota etuseinää joka peittää nii script tunnistaa et se on liian korkee mut
  //   takana on valid ruutu ja valitsee sen takaata". Seinä joka peittää sisätilan (lentokoneen kylki) on joko kylki (pintaRuutu
  //   null) tai päällys johon ei pääse (seinän harja 3 korkeampi kuin kumpikaan puoli). Molemmissa: säde hiiren alta TAAKSE
  //   korkeuskartan läpi, ja ensimmäinen ruutu jonka päällyksen säde leikkaa JA johon oma hahmo pääsee kävellen.
  const ASKEL = 1.1; // Daybreak PluginManager.java:104 pathfinder.step.maximum.height 1.1; :105 allow.falling true (pudotus ok)
  const dv = (o, k) => { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : undefined; };

  // Säde: korkeudella H sama näyttöpiste on ruudussa (x-t, y-t) kun H laskee t:llä (Nitro: sx=(x-y)*32, sy=(x+y)*16-z*32).
  // Palauttaa ruudut joiden PÄÄLLYKSEN säde ylittää (ei kylkiä), edestä taakse.
  function sadePinnat(r, roomId, event) {
    const o = r.getRoomObject(roomId, event.objectId, 10); if (!o) return [];
    const loc = o.getLocation(), cv = r.getActiveRoomInstanceRenderingCanvas(); if (!cv) return [];
    const sm = r.getFurnitureStackingHeightMap(roomId), lw = r.getLegacyWallGeometry(roomId); if (!sm || !lw) return [];
    const scale = cv.geometry.scale, offX = ((scale / 2) + event.spriteOffsetX + event.localX) / (scale / 4);
    const offY0 = (event.spriteOffsetY + event.localY) / (scale / 4);
    let maxH = 0; for (let y = 0; y < sm.height; y++) for (let x = 0; x < sm.width; x++) { const h = sm.getTileHeight(x, y); if (h < ESTETTY && h > maxH) maxH = h; }
    const osumat = []; let ed = null;
    for (let H = maxH + 1; H >= -0.5; H -= 0.02) {
      const offY = offY0 + 2 * (H - loc.z), x = Math.floor(loc.x + (offX + 2 * offY) / 4), y = Math.floor(loc.y - (offX - 2 * offY) / 4 + 1);
      if (x < 0 || y < 0 || x >= sm.width || y >= sm.height || !lw.isRoomTile(x, y)) { ed = null; continue; }
      const top = sm.getTileHeight(x, y);
      if (ed && ed.x === x && ed.y === y && ed.H > top && H <= top) osumat.push({ x, y, h: top });
      ed = { x, y, H };
    }
    return osumat;
  }

  // Ruudut joihin oma hahmo pääsee: BFS 8 suuntaan, nousu ≤ ASKEL, pudotus sallittu. Yliarvio (kulmasäännöt, estetyt esineet
  // joita client ei näe) -> pahimmillaan sama kuin ennen: palvelin hylkää. null = omaa hahmoa ei löydy -> vanha käytös.
  function saavutettavat(r, roomId) {
    const sm = r.getFurnitureStackingHeightMap(roomId), lw = r.getLegacyWallGeometry(roomId); if (!sm || !lw) return null;
    const rsm = dv(r, '_roomSessionManager'), ss = rsm && dv(rsm, '_sessions'); let own = null;
    if (ss instanceof Map) for (const [, v] of ss) if (dv(v, '_roomId') === roomId) own = dv(v, '_ownRoomIndex');
    const u = own != null && r.getRoomObject(roomId, own, 100); if (!u) return null; // 100 = RoomObjectCategory.UNIT
    const l = u.getLocation(), W = sm.width, Hh = sm.height, sx = Math.round(l.x), sy = Math.round(l.y);
    if (sx < 0 || sy < 0 || sx >= W || sy >= Hh) return null;
    const vapaa = (x, y) => lw.isRoomTile(x, y) && !(sm._isNotStackable && sm._isNotStackable[y * W + x]) && sm.getTileHeight(x, y) < ESTETTY;
    const nahty = new Uint8Array(W * Hh), jono = [[sx, sy, l.z]]; nahty[sy * W + sx] = 1; // lähtö hahmon z:sta (istuessa tuolin ruutu on estetty)
    while (jono.length) {
      const [x, y, h] = jono.shift();
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nx = x + dx, ny = y + dy; if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= Hh || nahty[ny * W + nx] || !vapaa(nx, ny)) continue;
        const nh = sm.getTileHeight(nx, ny); if (nh - h > ASKEL) continue;
        nahty[ny * W + nx] = 1; jono.push([nx, ny, nh]);
      }
    }
    return { on: (x, y) => !!nahty[y * W + x] };
  }

  // 1.5.0 Säde suoraan näyttöpisteestä (oikean klikkauksen valikko: ei RoomObjectMouseEventiä). Näyttöpiste on lineaarinen
  //   (x,y,z):ssa, joten kanta lasketaan pelin omalla getScreenPoint:lla (sama muunnos kuin robon klikkitestissä, jonka
  //   osumat on mitattu) ja korkeudella H ratkaistaan 2x2. Palauttaa KAIKKI päällykset jotka säde ylittää, edestä taakse.
  function sadePisteesta(r, roomId, cx, cy) {
    const cv = r.getRoomInstanceRenderingCanvas(roomId, 1); if (!cv || !cv.geometry) return [];
    const sm = r.getFurnitureStackingHeightMap(roomId), lw = r.getLegacyWallGeometry(roomId); if (!sm || !lw) return [];
    const g = cv.geometry, V = g.direction.constructor, s = cv._scale || 1;
    const sp = (x, y, z) => { const p = g.getScreenPoint(new V(x, y, z)); return [p.x * s + cv._width / 2 + cv._screenOffsetX, p.y * s + cv._height / 2 + cv._screenOffsetY]; };
    const o = sp(0, 0, 0), X = sp(1, 0, 0), Y = sp(0, 1, 0), Z = sp(0, 0, 1);
    const ex = [X[0] - o[0], X[1] - o[1]], ey = [Y[0] - o[0], Y[1] - o[1]], ez = [Z[0] - o[0], Z[1] - o[1]];
    const det = ex[0] * ey[1] - ex[1] * ey[0]; if (!det) return [];
    let maxH = 0; for (let y = 0; y < sm.height; y++) for (let x = 0; x < sm.width; x++) { const h = sm.getTileHeight(x, y); if (h < ESTETTY && h > maxH) maxH = h; }
    const osumat = []; let ed = null;
    for (let H = maxH + 1; H >= -0.5; H -= 0.02) {
      const bx = cx - o[0] - H * ez[0], by = cy - o[1] - H * ez[1];
      const x = Math.round((bx * ey[1] - by * ey[0]) / det), y = Math.round((ex[0] * by - ex[1] * bx) / det);
      if (x < 0 || y < 0 || x >= sm.width || y >= sm.height || !lw.isRoomTile(x, y)) { ed = null; continue; }
      const top = sm.getTileHeight(x, y);
      if (ed && ed.x === x && ed.y === y && ed.H > top && H <= top) osumat.push({ x, y, h: top, lattia: lw.getHeight(x, y) || 0 });
      ed = { x, y, H };
    }
    return osumat;
  }

  // Pinnan valinta, sama klikkaukselle ja kursorille: hiiren alla oleva päällys jos sinne pääsee, muuten ensimmäinen
  // saavutettava pinta säteellä taaksepäin. Muut tasot: oikean klikkauksen valikko (1.5.0).
  // 1.6.0 kp 22:13 huonekierto: pintaRuutu ja sadePinnat (ja pelin oma getActiveSurfaceLocation :1631) laskevat spriten
  //   offseteista OLETUSKULMAN kaavalla (-135°). Käännetyssä kamerassa ne osuvat väärään ruutuun. Silloin säde lasketaan
  //   suoraan hiiren näyttöpisteestä pelin omalla getScreenPoint-kannalla (sadePisteesta), joka seuraa kameraa.
  //   Hiiren paikka otetaan DOM:sta: DispatchMouseEvent.ts:9 antaa Nitrolle clientX/Y sellaisenaan.
  let hiiri = null;
  document.addEventListener('mousemove', e => { hiiri = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('mousedown', e => { hiiri = { x: e.clientX, y: e.clientY }; }, true);
  function kaannetty(re, roomId) {
    const cv = re.getRoomInstanceRenderingCanvas(roomId, 1), d = cv && cv.geometry && cv.geometry.direction;
    return !!d && Math.abs((((d.x + 135) % 360) + 360) % 360) > 0.5;
  }

  function valitse(re, roomId, event) {
    if (hiiri && kaannetty(re, roomId)) {
      const sade = sadePisteesta(re, roomId, hiiri.x, hiiri.y), S = saavutettavat(re, roomId);
      const lista = S ? sade.filter(q => S.on(q.x, q.y)) : sade;
      return { p: null, k: null, kohde: lista[0] || null, tapa: 'kierto', lista, i: lista[0] ? 0 : -1, sade };
    }
    const p = pintaRuutu(re, roomId, event), k = p && kaveltava(re, roomId, p.x, p.y);
    let kohde = p && k && k.ok ? { ...p, h: k.h } : null, tapa = 'pinta';
    const S = saavutettavat(re, roomId);
    const sade = S ? sadePinnat(re, roomId, event) : [], lista = sade.filter(q => S.on(q.x, q.y));
    if (S && (!kohde || !S.on(kohde.x, kohde.y)) && lista[0]) { kohde = lista[0]; tapa = 'säde'; }
    let i = kohde ? lista.findIndex(q => q.x === kohde.x && q.y === kohde.y) : -1;
    if (kohde && i < 0) { lista.unshift(kohde); i = 0; }
    return { p, k, kohde, tapa, lista, i, sade };
  }

  function kiinnita() {
    const r = RE(); if (!r || !r._roomObjectEventHandler) return false;
    const h = r._roomObjectEventHandler;
    if (h.__klikkikavely) return true;
    // 1.4.0 Res 22:02 "miksei tää script sit näytä sitä sinistä tile selection markeria": kursori tulee pelin
    //   handleMouseOverObject -> getActiveSurfaceLocation (RoomObjectEventHandler.ts:1593-1631), jossa sama canStandOn-portti
    //   kuin klikkauksessa. Paikataan SE: kun pelin oma palauttaa null, palautetaan valitse()-pinta -> kursori näkyy siellä
    //   minne klikkaus vie (myös seinän takana). Pelin omat pinnat (canStandOn true) pysyvät ennallaan.
    // 🔴 1.5.1 kp 22:14 "sininen ruutu näkyy … oudos paikkaa, mokasit, kokeile ite": getActiveSurfaceLocationin z on SUHTEELLINEN
    //   korkeus esineen pohjasta (natiivi palauttaa sizeZ, :1674), ja handleMouseOverObject (:1613) piirtää kursorin sijaintiin
    //   (x, y, ESINEEN z) + TileCursorVisualization-kerros 1 nostettuna height*32 px. 1.4.0 antoi absoluuttisen korkeuden ->
    //   kursori leijui esineen z:n verran liian korkealla, ja säteen takaruudussa vielä väärän esineen z:n päällä.
    //   Korjaus: kun pinta tulee tältä skriptiltä, handleMouseOverObject rakentaa viestin uudestaan muodossa
    //   (x, y, ABSOLUUTTINEN korkeus), height 0 = sama muoto kuin lattiaruudun kursori (handleMouseOverTile :1686).
    // 🔴 1.9.1 kp 2026-09-28 (#598/#600/#601) "porras palikois ei näy", "jää niiden sisää ?" + "mut muista et se natiivi ois preferred":
    //   1.5.1:n muoto (x, y, ABSOLUUTTINEN z) height 0 ei ole natiivi. Natiivi handleMouseOverObject rakentaa
    //   (x, y, PINNAN ANTAVAN ESINEEN z) + height = pinta − se z, ja TileCursorVisualization nostaa vain kerroksen 1
    //   height*32 px (live-nitro-renderer-c3005467 class Qwe). Nyt samoin: POHJA = ruudun tile-mapin ylin esine
    //   (getRoomTileObjectMap().getObjectIntTile(x,y), sama jota natiivi handleMouseOverTile käyttää; addRoomObject pitää
    //   siellä korkeimman z:n esineen) — säteen takaruudussa siis SEN ruudun esine, ei hiiren alla olevan (1.5.1:n virhe).
    //   Ei esinettä tai sen z pinnan yläpuolella -> pohja = lattia (lw.getHeight), kuten natiivin vaihtuvakorkeushaara.
    //   Ensin kuitenkin HIIREN ALLA oleva esine, jos juuri se antaa pinnan (ruutu sen jalanjäljessä, z+sizeZ = pinta): se on
    //   täsmälleen natiivin muoto. Mitattu robolla 2026-09-28 (huone 395, tmp/kk191-testi-tee.js): ilman tätä 26 palikkaa joiden päällä litteä tuoli (z5, sizeZ≈0)
    //   saivat pohjaksi tuolin (5, height 0 = tila 0) kun natiivi antaa palikan (4, height 1 = tila 6).
    function kursoriPohja(re, roomId, x, y, pinta, hiirenEsine) {
      try {
        const l = hiirenEsine && hiirenEsine.getLocation(), m = hiirenEsine && hiirenEsine.model, d = hiirenEsine && hiirenEsine.getDirection();
        if (l && m) {
          let sx = m.getValue('furniture_size_x'), sy = m.getValue('furniture_size_y'); const sz = m.getValue('furniture_size_z') || 0;
          if (d && (d.x === 90 || d.x === 270)) [sx, sy] = [sy, sx]; if (!(sx >= 1)) sx = 1; if (!(sy >= 1)) sy = 1;
          if (x >= l.x && x < l.x + sx && y >= l.y && y < l.y + sy && Math.abs(l.z + sz - pinta) < 1e-3) return l.z;
        }
      } catch (e) { /* pudotaan tile-mappiin */ }
      const lw = re.getLegacyWallGeometry(roomId), lattia = (lw && lw.getHeight(x, y)) || 0;
      const tm = typeof re.getRoomTileObjectMap === 'function' ? re.getRoomTileObjectMap(roomId) : null;
      const o = tm && tm.getObjectIntTile(x, y), z = o && o.getLocation ? o.getLocation().z : null;
      return (typeof z === 'number' && z <= pinta + 1e-6) ? z : Math.min(lattia, pinta);
    }
    const pintaOrig = h.getActiveSurfaceLocation;
    let kursoriKohde = null;
    if (typeof pintaOrig === 'function') h.getActiveSurfaceLocation = function (roomObject, event) {
      const tulos = pintaOrig.apply(this, arguments), re = this._roomEngine;
      const kaan = !!re && kaannetty(re, re.activeRoomId);          // käännettynä pelin oma tulos on oletuskulman kaavalla
      if ((tulos && !kaan) || !roomObject || !event) return tulos;
      try {
        const v = valitse(re, re.activeRoomId, event); if (!v.kohde) return kaan ? null : tulos;
        const V = roomObject.getLocation().constructor, z0 = roomObject.getLocation().z;
        kursoriKohde = { x: v.kohde.x, y: v.kohde.y, h: v.kohde.h, V };
        return new V(v.kohde.x, v.kohde.y, v.kohde.h - z0);   // suhteellinen, jos joku muu kutsuja lukee tätä
      } catch (e) { VW.__klikkikavelyVirhe = String(e); return tulos; }
    };
    const yliOrig = h.handleMouseOverObject;
    if (typeof yliOrig === 'function') h.handleMouseOverObject = function (category, roomId, event) {
      kursoriKohde = null;
      const msg = yliOrig.apply(this, arguments), k = kursoriKohde; kursoriKohde = null;
      if (!msg || !k) return msg;                     // pelin oma pinta tai ei pintaa: ennallaan
      try { const b = kursoriPohja(this._roomEngine, roomId, k.x, k.y, k.h, this._roomEngine.getRoomObject(roomId, event.objectId, 10)); return new msg.constructor(new k.V(k.x, k.y, b), k.h - b, true, event.eventId); }
      catch (e) { VW.__klikkikavelyVirhe = String(e); return msg; }
    };
    const furniOrig = h.handleMoveTargetFurni;
    h.handleMoveTargetFurni = function (roomId, event) {
      // pelin oma polku kun sen OMA getActiveSurfaceLocation löytää pinnan (canStandOn true) tai liike on estetty
      const ro = this._roomEngine.getRoomObject(roomId, event.objectId, 10);
      const kaan = kaannetty(this._roomEngine, roomId);
      if (this._roomEngine.moveBlocked || typeof pintaOrig !== 'function' || (!kaan && ro && pintaOrig.call(this, ro, event))) return furniOrig.apply(this, arguments);
      const tulos = false;
      try {
        const { p, k, kohde, tapa, lista, i, sade } = valitse(this._roomEngine, roomId, event);
        VW.__klikkikavelySade = sade;   // diagnostiikka: kaikki säteen pinnat ennen saavutettavuussuodatusta
        VW.__klikkikavelyViime = { p, k, kohde, tapa, lista, i, t: Date.now(), objectId: event.objectId, lx: event.localX, ly: event.localY };
        if (!kohde) return furniOrig.apply(this, arguments);
        this.sendWalkUpdate(kohde.x, kohde.y);
        return true;
      } catch (e) { VW.__klikkikavelyVirhe = String(e); return tulos; }
    };
    // 🗑 1.2.0-1.3.1 tuplaklikkaus POISTETTU 1.5.0:ssa. Mitattu 21:53 robolla: pelin oma tuplaklikkaus palikkaan = UseFurniture,
    //   ja :bh päällä palikka siirtyy :bh-korkeuteen (243908/243906 putosivat z0:aan). Res 22:06 "tuplaklikkaus togglee myös
    //   kaman jos pitää klikkaa kaman läpi. ei oo hyvä tekniikka". Tupla-eleen syöminen rikkoisi lamppujen yms käytön, koska
    //   kuplassa lähes kaikella canStandOn=false eikä skripti erota käyttöä läpiklikkauksesta. alt+painallus = siirto
    //   (RoomObjectEventHandler.ts:623), ctrl = nosto, shift = kääntö -> muokkausnäppäimet varattu.
    // 1.5.0 Res 22:08 "robo paljonko vaatis duunia tehdä right clickistä runescape tyylinen context menu" / "vois kävellä
    //   lattialle, päälle yms": OIKEA KLIKKAUS huoneeseen = valikko kaikista tasoista hiiren alla. Konfliktiton (kp 22:09
    //   "sellane mis ei oo konfliktei minkää muun kaa"): RoomView.tsx:20-23 kuuntelee vain click/mousemove/mousedown/mouseup,
    //   ja live-bundlessa (robo 22:10) canvasilla ei ole oncontextmenu-käsittelijää eikä App-bundlessa 'contextmenu'-sanaa.
    if (!VW.__klikkikavelyValikko) {
      VW.__klikkikavelyValikko = true;
      let el = null;
      const sulje = () => { if (el) { el.remove(); el = null; } };
      document.addEventListener('contextmenu', e => {
        try {
          const t = e.target; if (!t || t.tagName !== 'CANVAS' || !t.onmousedown) return;   // vain huoneen canvas (RoomView asettaa onmousedown)
          const r = RE(), hh = r && r._roomObjectEventHandler, roomId = r && r.activeRoomId; if (!hh || roomId == null || roomId < 0) return;
          if (r.isPlayingGame && r.isPlayingGame()) return;
          e.preventDefault(); sulje();
          const sade = sadePisteesta(r, roomId, e.clientX, e.clientY), S = saavutettavat(r, roomId);
          VW.__klikkikavelyValikkoSade = sade;
          // 1.7.0 kp 22:39 "voikko tehä ton right click valikon kopioimalla visuaalisen ilmeen hahmo valikosta … ei mitää omaa
          //   tyylii": käytetään PELIN OMIA luokkia eikä kopioida arvoja, jolloin ilme seuraa clientin tyyliä jatkossakin.
          //   ContextMenuView.tsx:77 'nitro-context-menu' (+ 'visible'), ContextMenuHeaderView.tsx:10 'menu-header p-1',
          //   ContextMenuListItemView.tsx:22 'menu-item list-item' (+ 'disabled'). ContextMenu.scss antaa taustan, reunan,
          //   oranssin otsikon (#f27f46), rivien hoverin (#ee5a49) ja alareunan kärjen (:after, 45° neliö).
          //   Kärki osoittaa ALAS keskeltä, joten valikko asetetaan klikkauksen YLÄPUOLELLE ja vaakasuunnassa keskitetysti —
          //   silloin kärki osoittaa klikattuun kohtaan samoin kuin hahmovalikossa se osoittaa hahmoon.
          el = document.createElement('div');
          el.className = 'nitro-context-menu visible';
          el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:all;user-select:none';
          const rivi = (teksti, luokat, vihje) => {
            const d = document.createElement('div');
            d.className = luokat + ' d-flex justify-content-center align-items-center';
            d.textContent = teksti; if (vihje) d.title = vihje;
            d.onmousedown = ev => { ev.stopPropagation(); ev.preventDefault(); };
            el.appendChild(d); return d;
          };
          // 1.9.0 lisäosien rivit: hahmon osio ylös (hahmon nimi otsikkona kuten pelin omassa valikossa), ruudun osio kävelyn alle
          let hahmo = null; try { hahmo = hahmoPisteessa(r, roomId, t, e.clientX, e.clientY); } catch (err) { VW.__klikkikavelyVirhe = String(err); }
          let esine = null; try { esine = esinePisteessa(r, roomId, t, e.clientX, e.clientY); } catch (err) { VW.__klikkikavelyVirhe = String(err); }
          const ctx = { hahmo, esine, ruutu: sade[0] ? { x: sade[0].x, y: sade[0].y, h: sade[0].h } : null, roomId };
          VW.__klikkikavelyValikkoCtx = ctx;
          // 1.13.0 OIKEA KLIKKAUS KÄÄNTÄÄ HAHMON KATSOMAAN KLIKATTUA RUUTUA (Res 2026-09-29 01:10 kuiskaus "tarvitaan joku selkeä
          //   right click toiminto renderin sisällä" -> robo ehdotti "vasen kävelee, oikea osoittaa" -> Res "toi on hyvä").
          //   Pelin oma 3301 UNIT_LOOK (x,y) = sama paketti jonka RoomObjectEventHandler.ts:2210 lähettää kun klikkaat toista
          //   hahmoa, joten kaikki huoneessa näkevät käännöksen ilman skriptiä. Valikko aukeaa kuten ennen.
          turva(() => { if (!ctx.ruutu) return; const c = yhteys(); if (c && c.sendRawPacket) { c.sendRawPacket(3301, [ctx.ruutu.x | 0, ctx.ruutu.y | 0], 'RoomUnitLookComposer'); VW.__klikkikavelyKatse = (VW.__klikkikavelyKatse || 0) + 1; } }, null);
          const turva = (f, oletus) => { try { return f(); } catch (err) { VW.__klikkikavelyVirhe = String(err); return oletus; } };
          const osion = kohde => valikkoRivit.filter(x => [].concat(x.kohde).includes(kohde) && (!x.nakyy || turva(() => x.nakyy(ctx), false)));
          const ilmoita = (v, virhe) => { const K = VW.kuplaKomennot; if (typeof v === 'string' && v) { if (K && K.ilmoita) K.ilmoita(v, virhe); else console.log('[klikkikävely]', v); } };
          const aja = f => { const v = turva(() => f(ctx), null);
            if (v && typeof v.then === 'function') v.then(x => ilmoita(x), err => ilmoita('virhe: ' + ((err && err.message) || err), true)); else ilmoita(v); };
          const toiminto = x => {
            const nimi = String(typeof x.nimi === 'function' ? turva(() => x.nimi(ctx), '?') : x.nimi);
            const d = rivi(nimi + (x.ala ? ' ›' : ''), 'menu-item list-item', x.lisaosa || '');
            d.onclick = ev => { ev.stopPropagation(); if (x.ala) return rakennaAla(nimi, x); sulje(); if (x.tee) aja(x.tee); };
          };
          const rakennaAla = (nimi, x) => {
            el.textContent = ''; rivi(nimi, 'menu-header p-1');
            for (const a of turva(() => x.ala(ctx), []) || []) {
              const d = rivi(String(a.nimi), 'menu-item list-item'); d.onclick = ev => { ev.stopPropagation(); sulje(); if (a.tee) aja(a.tee); };
            }
            rivi('‹ Takaisin', 'menu-item list-item').onclick = ev => { ev.stopPropagation(); rakenna(); asemoi(); };
            asemoi();
          };
          const rakenna = () => {
            el.textContent = '';
            if (hahmo) { const L = osion(hahmo.oma ? 'oma' : 'hahmo'); if (L.length) { rivi(hahmo.nimi || 'hahmo', 'menu-header p-1'); L.forEach(toiminto); } }
            // 1.10.0 esineen osio: otsikkona esineen NIMI (kp 02:17 "referoi itemeihin niiden nimellä"), luokka vihjeenä
            if (esine) { const L = osion('esine'); if (L.length) { const o = rivi(esine.nimi, 'menu-header p-1'); o.title = esine.luokka + ' #' + esine.id; L.forEach(toiminto); } }
            // Res 00:59 "toi right clickin oranssin taustan title vois lähteä": ei 'Kävele'-otsikkoa. Hahmon nimi jää otsikoksi
            //   vain kun hahmolle on toimintoja, koska muuten "Mimic" ei kerro kenen asu.
            if (!sade.length && !hahmo) rivi('ei pintaa tässä', 'menu-item list-item disabled');
            sade.forEach((q, n) => {
              // Res 01:00 "vaihtoehdot vois olla tarkempia koska saman right clickin kautta voi tulla vaikka mitä": rivi kertoo itse tekonsa
              const paasee = !S || S.on(q.x, q.y), nimi = 'Kävele ' + (q.h <= q.lattia + 0.01 ? 'lattialle' : n === 0 ? 'päälle' : 'taakse');
              const d = rivi(`${nimi} · ${+q.h.toFixed(2)}${paasee ? '' : ' (ei pääsyä)'}`,
                'menu-item list-item' + (paasee ? '' : ' disabled'), `ruutu ${q.x},${q.y}`);
              if (paasee) d.onclick = ev => { ev.stopPropagation(); hh.sendWalkUpdate(q.x, q.y); VW.__klikkikavelyViime = { kohde: q, tapa: 'valikko', lista: sade, t: Date.now() }; sulje(); };
            });
            if (ctx.ruutu) osion('ruutu').forEach(toiminto);
            rivi('Peruuta', 'menu-item list-item').onclick = ev => { ev.stopPropagation(); sulje(); };
          };
          rakenna();
          document.body.appendChild(el);
          // 1.8.0 Res 23:22 "menu vois aueta cursorin alapuolelle niin että cursor ankkurina yläreuna keskellä": yläpuolelle
          //   avautuva valikko peitti klikatun kaman. Nyt yläreunan keskikohta kursorissa. Res 23:23 "ei mitään nuolia", kp 23:24
          //   "osottaa nytki suoraa kursorii, se vaa olis valikon yläreunas" + Res "käy" + kp "robo pidä nuoli" -> pelin kärki
          //   (:after, 45° neliö, bottom -7px) käännetään yläreunaan osoittamaan ylös kursoriin (225°, top -7px).
          //   Jos alla ei ole tilaa (ruudun alareuna), vanha tapa: yläpuolelle, kärki alas.
          if (!document.getElementById('kk-valikko-tyyli')) {
            const st = document.createElement('style'); st.id = 'kk-valikko-tyyli';
            st.textContent = '.nitro-context-menu.kk-alas:after{bottom:auto!important;top:-7px;transform:rotate(225deg)!important}';
            document.head.appendChild(st);
          }
          // 1.9.0 funktioksi, koska alavalikko vaihtaa kokoa (mitattu robolla 01:02: "asemoi is not defined")
          function asemoi() {
            const w = el.offsetWidth, hgt = el.offsetHeight, alas = e.clientY + 10 + hgt <= innerHeight - 4;
            el.classList.toggle('kk-alas', alas);
            el.style.left = Math.max(4, Math.min(e.clientX - w / 2, innerWidth - w - 4)) + 'px';
            el.style.top = (alas ? e.clientY + 10 : Math.max(4, e.clientY - hgt - 8)) + 'px';
          }
          asemoi();
        } catch (err) { VW.__klikkikavelyVirhe = String(err); sulje(); }
      }, true);
      document.addEventListener('mousedown', e => { if (el && !el.contains(e.target)) sulje(); }, true);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') sulje(); }, true);
    }
    h.__klikkikavely = true; VW.__kuplaKlikkikavely = true;
    return true;
  }
  // 1.11.0 PINNAN KURSORIN TYYLI (kp 2026-09-28 04:10:40 "ja entä se natiivi neliö pinnoille", 04:11:11 "tee siitä valinta", #682).
  //   Korotetulla pinnalla (height > 0.8) peli vaihtaa kursorin tilaan 6 (TileCursorLogic CURSOR_HEIGHT_STATE): kerros 0 =
  //   täysi ruudun ääriviiva (tile_cursor_64_a_0_0, 66x36) JALANJÄLJEN POHJALLA syvyydellä -2900 -> jää palikoiden taakse,
  //   ja kerros 1 = pieni sininen neliö (b_0_0, 22x19) nostettuna height*32 px (TileCursorVisualization.getLayerYOffset).
  //   Se pieni neliö on se "sininen neliö" — pelin oma korkeusmerkki, ei kenenkään pyyntö (Res 22:02 pyysi vain että pelin
  //   kursori näkyy pinnoilla). 'iso' (oletus): kerros 1 piirtää saman täyden ääriviivan kuin kerros 0 (nostettuna, syvyys
  //   100 eli pintojen edessä) ja kerros 0 piilotetaan. 'pieni' = pelin oma tila 6 sellaisenaan.
  //   Toteutus: kursoriobjektin OMAN visualisaation getSpriteAssetName korvataan instanssissa (FurnitureVisualization.updateSprite
  //   kutsuu sitä, ja tyhjä nimi -> resetSprite = kerros piiloon). Kursoriobjekti luodaan huoneittain -> tarkistus 1 s välein.
  const KURSORI_AVAIN = 'kupla.klikkikavely.kursori';
  const kursoriTyyli = () => { try { return localStorage.getItem(KURSORI_AVAIN) === 'pieni' ? 'pieni' : 'iso'; } catch (e) { return 'iso'; } };
  let tyyli = kursoriTyyli();
  // 1.12.0 (kp 2026-09-28 04:38 "ei em dasheja valikoihin niist tulee nuottiavain"): valikkorivien ja vastauksen ajatusviivat
  //   pois (pelin fontti piirtää ne nuottiavaimena) -> sulut / pilkku.
  function asetaKursori(t) {
    tyyli = t === 'pieni' ? 'pieni' : 'iso';
    try { localStorage.setItem(KURSORI_AVAIN, tyyli); } catch (e) {}
    return 'pinnan kursori: ' + (tyyli === 'iso' ? 'iso (pelin täysi ruutu)' : 'pieni (pelin korkeusneliö)') + ', näkyy kun hiiri liikkuu';
  }
  function paikkaaKursori() {
    try {
      const r = RE(); if (!r || !(r.activeRoomId >= 0) || typeof r.getRoomObjectCursor !== 'function') return;
      const o = r.getRoomObjectCursor(r.activeRoomId), v = o && o.visualization;
      if (!v || v.__kkKursori || typeof v.getSpriteAssetName !== 'function') return;
      const orig = v.getSpriteAssetName;
      v.getSpriteAssetName = function (scale, layerId) {
        if (tyyli === 'iso' && (layerId === 0 || layerId === 1)) {
          let tila = -1; try { tila = this.object.getState(0); } catch (e) {}
          if (tila === 6) return layerId === 0 ? '' : orig.call(this, scale, 0);   // kerros 1 saa kerroksen 0 kehyksen
        }
        return orig.call(this, scale, layerId);
      };
      v.__kkKursori = true;
    } catch (e) { VW.__klikkikavelyVirhe = String(e); }
  }
  setInterval(paikkaaKursori, 1000);
  VW.__klikkikavelyKursori = { tyyli: () => tyyli, aseta: asetaKursori };
  (VW.kuplaValikkoJono = VW.kuplaValikkoJono || []).push({ kohde: 'ruutu', lisaosa: 'Klikkikävely',
    nimi: () => 'Pinnan kursori: ' + tyyli,
    ala: () => [{ nimi: (tyyli === 'iso' ? '✓ ' : '') + 'iso (pelin täysi ruutu)', tee: () => asetaKursori('iso') },
                { nimi: (tyyli === 'pieni' ? '✓ ' : '') + 'pieni (sininen korkeusneliö)', tee: () => asetaKursori('pieni') }] });
  (VW.kuplaKomennotJono = VW.kuplaKomennotJono || []).push([['kursori', 'cursor'],
    (teksti, sanat) => { const a = String((sanat && sanat[0]) || '').toLowerCase(); return a === 'iso' || a === 'pieni' ? asetaKursori(a) : 'pinnan kursori nyt: ' + tyyli + ' · :kursori iso | :kursori pieni'; },
    'pinnan kursorin tyyli: iso (pelin täysi ruutu) tai pieni (sininen korkeusneliö)', 'Klikkikävely']);

  // 1.12.0 ALT + OIKEA (tai keskimmäinen) NAPPI EI ALOITA KALUSTEEN SIIRTOA (kp 2026-09-28 04:39:29 "right click + alt alkaa
  //   siirtää tahattomasti huonekaluu estä se").
  //   SYY (lähde D:/kupla-lahde/kupla-cc/client): DarkUI RoomView.tsx:22 canvas.onmousedown = DispatchMouseEvent, joka EI katso
  //   mitä nappia painettiin (DispatchMouseEvent.ts:54 välittää event.altKey sellaisenaan) -> Nitro_Render_V3
  //   RoomObjectEventHandler.ts:623: MOUSE_DOWN + altKey (ei ctrl/shift) kalusteeseen = REQUEST_MOVE = pelin siirtotila (kaluste
  //   seuraa hiirtä, seuraava klikkaus sijoittaa sen). Eli PELI tekee sen, oikean napin kanssakin. debug-näkymän Alt-kuuntelija
  //   nielee vain vasemman napin, ja kp 02:59 pyysi juuri "right click ja alt" -yhdistelmää tietoja varten -> osuu tähän.
  //   ESTO: huoneen canvasin OMA capture-kuuntelija. Kohdevaiheessa capture-kuuntelijat ajetaan ennen canvas.onmousedown-
  //   ominaisuutta (Chrome 89+), joten stopImmediatePropagation pitää pelin ulkona, mutta window/document-tason kuuntelijat
  //   (muut lisäosat) ehtivät ajaa. Oikean klikkauksen valikko tulee 'contextmenu'-tapahtumasta (yllä) eikä muutu, ja pelin oma
  //   Alt+VASEN = siirto sekä debug-näkymän Alt+vasen = speksit pysyvät ennallaan. Laskuri: window.__klikkikavelyAltEsto.
  function altSuoja() {
    for (const c of document.querySelectorAll('canvas')) {
      if (!c.onmousedown || c.__kkAltSuoja) continue;   // vain huoneen canvas (RoomView asettaa onmousedown)
      c.addEventListener('mousedown', e => { if (e.altKey && e.button !== 0) { e.stopImmediatePropagation(); VW.__klikkikavelyAltEsto = (VW.__klikkikavelyAltEsto || 0) + 1; } }, true);
      c.__kkAltSuoja = true;
    }
  }
  altSuoja(); setInterval(altSuoja, 1000);

  let yrit = 0; const t = setInterval(() => { if (kiinnita() || ++yrit > 240) clearInterval(t); }, 500);
})();
