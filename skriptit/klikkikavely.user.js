// ==UserScript==
// @name         Kupla Klikkikävely
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      1.8.0
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
      try { return new msg.constructor(new k.V(k.x, k.y, k.h), 0, true, event.eventId); }
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
            el.appendChild(d); return d;
          };
          rivi('Kävele', 'menu-header p-1');
          if (!sade.length) rivi('ei pintaa tässä', 'menu-item list-item disabled');
          sade.forEach((q, n) => {
            const paasee = !S || S.on(q.x, q.y), nimi = q.h <= q.lattia + 0.01 ? 'Lattialle' : n === 0 ? 'Päälle' : 'Taakse';
            const d = rivi(`${nimi} · ${+q.h.toFixed(2)}${paasee ? '' : ' (ei pääsyä)'}`,
              'menu-item list-item' + (paasee ? '' : ' disabled'), `ruutu ${q.x},${q.y}`);
            if (paasee) {
              d.onmousedown = ev => { ev.stopPropagation(); ev.preventDefault(); };
              d.onclick = ev => { ev.stopPropagation(); hh.sendWalkUpdate(q.x, q.y); VW.__klikkikavelyViime = { kohde: q, tapa: 'valikko', lista: sade, t: Date.now() }; sulje(); };
            }
          });
          rivi('Peruuta', 'menu-item list-item').onclick = ev => { ev.stopPropagation(); sulje(); };
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
          const w = el.offsetWidth, hgt = el.offsetHeight, alas = e.clientY + 10 + hgt <= innerHeight - 4;
          el.classList.toggle('kk-alas', alas);
          el.style.left = Math.max(4, Math.min(e.clientX - w / 2, innerWidth - w - 4)) + 'px';
          el.style.top = (alas ? e.clientY + 10 : Math.max(4, e.clientY - hgt - 8)) + 'px';
        } catch (err) { VW.__klikkikavelyVirhe = String(err); sulje(); }
      }, true);
      document.addEventListener('mousedown', e => { if (el && !el.contains(e.target)) sulje(); }, true);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') sulje(); }, true);
    }
    h.__klikkikavely = true; VW.__kuplaKlikkikavely = true;
    return true;
  }
  let yrit = 0; const t = setInterval(() => { if (kiinnita() || ++yrit > 240) clearInterval(t); }, 500);
})();
