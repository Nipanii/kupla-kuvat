// ==UserScript==
// @name         Kupla Klikki-käveltävyys
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      0.1.10
// @description  Testilisäosa (B84): pintakävelyn kursori ja klikkaus vain ruutuihin joille palvelin sallii kävelyn tai istumisen. Pullo, minibaari ja pöytä eivät enää saa sinistä ruutua; sohva ja tuoli pysäyttävät säteen.
// @kupla-oletus off
// @author       re-lab
// ==/UserScript==
//
// MIKSI: kp 22.10. 14:50 "laita mun clienttii pluginina se niinku vittu pyysin tekee ekana". Sama korjaus kuin haarassa
//   robo/klikki-saavutettava (kupla-cc, Nitro_Render_V3 RoomObjectEventHandler + FurnitureFloorDataParser), ajonaikaisena.
// MITEN KÄVELTÄVYYS TIEDETÄÄN: Daybreak HabboItem.serializeFloorData kirjoittaa huonekalun korkeusmerkkijonon VAIN jos
//   allowWalk()||allowSit(), muuten "" (pokaali/crackable/gnome_box aina "1.0"). Clientin jäsennin muuttaa tyhjän nollaksi,
//   joten tämä lisäosa lukee sen itse paketeista 1778 / 1534 / 3776: jokaisen huoneen huonekalun id + x + y etsitään
//   paketista, ja perästä luetaan z- ja korkeusmerkkijono. Tulos -> mallin 'furniture_allow_walk' (1/0).
//   Mitattu langalta 22.10. 14:27: lamppu/bonsai/kävelee-päälle-laukaisin "" · rulla 0.5 · lattialaatta 1.0E-6 · palikat 1.0.
// RAJA: lukee vain paketit jotka tulevat lisäosan latauksen JÄLKEEN -> huoneeseen pitää tulla uudelleen (tai F5).
//   Pokaalit näyttävät käveltäviltä. Liput: window.__kkKav = { nahty, kavelee, ei, viimeisin }.
(function () {
  'use strict';
  const VW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  if (VW.__kkKav) return;
  const tila = VW.__kkKav = { nahty: 0, kavelee: 0, ei: 0, viimeisin: null, virhe: null, odottaa: new Map(), raaka: {} };   // raaka: tyyppi -> { palvelimen korkeusmerkkijono: kpl }
  const RE = () => VW.NitroDevTools && VW.NitroDevTools.roomEngine;
  // Oma avain: live-client kirjoittaa 'furniture_allow_walk' = 0 KAIKILLE (Daybreak-haara ei lue lippuja), joten 0 siellä ei
  // tarkoita mitään. Tätä avainta asettaa vain tämä lisäosa -> puuttuva arvo = ei tietoa = vanha käytös.
  const AVAIN = 'kk_server_walkable', KORKEUS = 'kk_server_height', LATTIA = 10;

  // --- 1. käveltävyys paketeista ---------------------------------------------------------------
  const lueStr = (dv, i) => { const L = dv.getUint16(i); let s = ''; for (let k = 0; k < L; k++) s += String.fromCharCode(dv.getUint8(i + 2 + k)); return [s, i + 2 + L]; };
  function kasittele(body) {
    const r = RE(); if (!r) return;
    const rid = r.activeRoomId, objs = r.getRoomObjects(rid, LATTIA) || [];
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    // id:t paketista: jokainen kohta jossa int(id), int(sprite), int(x), int(y), int(dir), str(z), str(korkeus)
    for (let i = 0; i + 24 <= body.byteLength; i++) {
      const id = dv.getInt32(i); if (id <= 0) continue;
      const x = dv.getInt32(i + 8), y = dv.getInt32(i + 12), dir = dv.getInt32(i + 16);
      if (x < 0 || x > 255 || y < 0 || y > 255 || dir < 0 || dir > 7) continue;
      try {
        const [z, j] = lueStr(dv, i + 20); if (!/^-?\d+(\.\d+)?(E-?\d+)?$/i.test(z)) continue;
        const [k] = lueStr(dv, j); if (k !== '' && !/^-?\d+(\.\d+)?(E-?\d+)?$/i.test(k)) continue;
        tila.odottaa.set(id, { x, y, kavelee: k !== '', raaka: k });
      } catch (e) { /* rajan yli */ }
    }
    paivita();
  }
  function paivita() {
    const r = RE(); if (!r || !tila.odottaa.size) return;
    const rid = r.activeRoomId;
    for (const [id, t] of tila.odottaa) {
      const o = r.getRoomObject(rid, id, LATTIA); if (!o || !o.model) continue;
      const l = o.getLocation(); if (Math.round(l.x) !== t.x || Math.round(l.y) !== t.y) continue;   // id osui sattumalta: ohitetaan
      o.model.setValue(AVAIN, t.kavelee ? 1 : 0);
      if (t.kavelee) o.model.setValue(KORKEUS, parseFloat(t.raaka));   // palvelimen Item.getCurrentHeight
      tila.odottaa.delete(id); tila.nahty++; t.kavelee ? tila.kavelee++ : tila.ei++;
      tila.viimeisin = { id, tyyppi: o.type, kavelee: t.kavelee };
      (tila.raaka[o.type] = tila.raaka[o.type] || {})[JSON.stringify(t.raaka)] = ((tila.raaka[o.type] || {})[JSON.stringify(t.raaka)] || 0) + 1;
    }
  }
  setInterval(paivita, 1000);
  function kuuntele(ws) {
    if (!ws || ws.__kkKav) return; ws.__kkKav = true;
    ws.addEventListener('message', e => {
      try {
        if (!(e.data instanceof ArrayBuffer)) return;
        const b = new Uint8Array(e.data), dv = new DataView(e.data);
        for (let o = 0; o + 6 <= b.length;) {
          const len = dv.getInt32(o), hdr = dv.getInt16(o + 4);
          if (len < 2 || o + 4 + len > b.length) break;
          if (hdr === 1778 || hdr === 1534 || hdr === 3776) { const body = b.subarray(o + 6, o + 4 + len); setTimeout(() => kasittele(body), 300); }
          o += 4 + len;
        }
      } catch (err) { tila.virhe = String(err); }
    });
  }
  const sendOrig = VW.WebSocket.prototype.send;
  VW.WebSocket.prototype.send = function () { if (/kupla/.test(this.url || '')) kuuntele(this); return sendOrig.apply(this, arguments); };

  // --- 2. säde ja kursori (RoomObjectEventHandler, sama logiikka kuin haarassa) ----------------
  const BLOCKED = 40, STEP_UP = 1.1, RAY_STEP = 0.02;
  function paikkaa() {
    const r = RE(), h = r && (r.objectEventHandler || r._roomObjectEventHandler);
    if (!h || h.__kkKav || typeof h.getRaisedSurfaceLocation !== 'function') return;
    h.__kkKav = true;
    const ylin = (rid, x, y) => { const tm = h._roomEngine.getRoomTileObjectMap(rid); return tm ? tm.getObjectIntTile(x, y) : null; };
    // Klikkikävely 1.23.0+ kysyy tätä (oikean klikkauksen valikko + sen oma säde). false = palvelin ei päästä ruutuun.
    tila.avoin = (rid, x, y) => h.getTopFurnitureWalkable(rid, x, y);
    // Pino: palvelimen sääntö (RoomTileManager.calculateTileState): ruudun KORKEIN esine päättää. Ei-käveltävän korkeutta
    // client ei tiedä (palvelin lähettää "", client tekee siitä koko-z:n 0 -> mehiläislamppu ruohon kanssa näytti ruoholta,
    // kp 15:30). Mutta ruudun korkeus (pinokartta) on palvelimen max(z + korkeus). Siis: ruutu on auki vain jos jonkin
    // KÄVELTÄVÄN esineen yläpinta osuu ruudun korkeuteen; muuten korkein on ei-käveltävä. Matto pöydällä -> matto = ruudun
    // korkeus -> auki. TV maton päällä / lamppu ruohossa -> ei osu -> kiinni. Tuolit (pinoamaton ruutu, korkeus 0): ylin esine.
    let pino = null, pinoT = 0;
    const pinoKartta = (rid) => {
      const nyt = Date.now(); if (pino && pino.rid === rid && nyt - pinoT < 300) return pino.m;
      const m = new Map();   // ruutu -> { pinnat: [[z, yläpinta]] käveltäville/istuttaville, tuntematon }
      for (const o of r.getRoomObjects(rid, LATTIA) || []) {
        if (!o || !o.model) continue; const v = o.model.getValue(AVAIN); if (v !== 0 && v !== 1) continue;
        const l = o.getLocation(), [sx, sy, sz] = h.getFurnitureFootprint(o), hk = o.model.getValue(KORKEUS);
        // Korkeus vain palvelimelta: mallin koko-z on assetin (kivipolku 1, palvelin 1.0E-6), ei kelpaa. Puuttuu -> ruutu tuntematon.
        const tunnettu = (typeof hk === 'number' && !isNaN(hk)), yla = (v === 1 && tunnettu) ? l.z + hk : null;
        for (let dx = 0; dx < Math.max(1, sx); dx++) for (let dy = 0; dy < Math.max(1, sy); dy++) {
          const k = (Math.round(l.x) + dx) + ',' + (Math.round(l.y) + dy), e = m.get(k) || { pinnat: [], tuntematon: false };
          if (v === 1 && !tunnettu) e.tuntematon = true;
          if (yla !== null) e.pinnat.push([l.z, yla, sz || 0]);
          m.set(k, e);
        }
      }
      pino = { rid, m }; pinoT = nyt; return m;
    };
    // 0.1.9 MERKIN KORKEUS (Res 22.10. 16:06 "sininen indicator pitäs mennä koko stackin päälle", kp 16:02 "piirtää sen aika alas
    //   penkkii / pyllyn korkeudelle"). Natiivi getActiveSurfaceLocation piirtää istuimen merkin sizeZ - 0.5:een (rahi tyynyn
    //   kanssa -> negatiivinen -> lattiatasolle, tmp/res-oyrf.png), ja säde/pinta-polku palvelimen ruudun korkeuteen, joka
    //   istuimella on istuimen POHJA (Daybreak: istuin ei kasvata pinokorkeutta). Mitattu kp:n huone 424: arabian_chair z 0.2,
    //   palvelin h 1.2, ruutu 0.199. Sääntö: esine jonka z = ruudun korkeus ja yläpinta sen yli on istuin/sänky -> merkki sen
    //   istumakorkeuteen (0.1.10: natiivi z + sizeZ - 0.5; 0.1.9 yläpinta hylätty, kp 16:22); muuten kävelypinta = ruudun korkeus. null = ei tietoa -> natiivi.
    const merkki = (rid, x, y) => {
      const hm = h._roomEngine.getFurnitureStackingHeightMap(rid), e = pinoKartta(rid).get(x + ',' + y);
      if (!hm || !e || e.tuntematon || x < 0 || y < 0 || x >= hm.width || y >= hm.height || hm.isStackingBlocked(x, y)) return null;   // estetty ruutu: korkeus ei kerro pintaa (ES-kone 5,12 th 0)
      const th = hm.getTileHeight(x, y); let istuin = null;
      // 0.1.10 kp 16:22 "siirrä se ruutu takas mis se oli penkis … se korkeus ei ollu ongelma, vaa et se ei näkyny penkis
      //   ollenkaa": istuimen korkeus = natiivin istumakorkeus z + max(0, sizeZ - 0.5) (RoomObjectEventHandler sitOffset).
      let paras = null;
      for (const [z, yla, sz] of e.pinnat) if (Math.abs(z - th) < 0.01 && yla - th > 0.01 && (paras === null || yla > paras[1])) paras = [z, yla, sz];
      if (paras) istuin = paras[0] + Math.max(0, paras[2] - 0.5);
      if (istuin !== null) return istuin;
      return e.pinnat.some(([, yla]) => Math.abs(yla - th) < 0.01) ? th : null;
    };
    tila.merkki = merkki;
    h.getTopFurnitureWalkable = function (rid, x, y) {
      const o = ylin(rid, x, y); if (!o || !o.model) return null;
      const hm = this._roomEngine.getFurnitureStackingHeightMap(rid), e = pinoKartta(rid).get(x + ',' + y);
      // Istuin (tuoli/sohva) antaa ruudun korkeudeksi oman z:nsa, ei yläpintaa (kp 15:36: 33 tuoliruutua maton päällä kiinni).
      if (e && !e.tuntematon && hm && !hm.isStackingBlocked(x, y)) { const th = hm.getTileHeight(x, y); return e.pinnat.some(([z, yla]) => Math.abs(yla - th) < 0.01 || Math.abs(z - th) < 0.01); }
      const v = o.model.getValue(AVAIN); return (v === 0 || v === 1) ? v === 1 : null;
    };
    // Natiivi polku (getActiveSurfaceLocation) luottaa furnidataan: res_eskone on siellä canstandon=true, palvelin "" ->
    // sininen ruutu esineen päällä ilman käveltävyystarkistusta (kp 15:13). Palvelimen 0 ohittaa furnidatan.
    const aktiivinenOrig = h.getActiveSurfaceLocation;
    if (typeof aktiivinenOrig === 'function') h.getActiveSurfaceLocation = function (ro, event) {
      if (ro && ro.model && ro.model.getValue(AVAIN) === 0) return null;
      const p = aktiivinenOrig.call(this, ro, event); if (!p) return p;
      const T = merkki(this._roomEngine.activeRoomId, p.x, p.y); if (T !== null) p.z = Math.max(0, T - ro.getLocation().z);
      return p;
    };
    const avoinOrig = h.isSurfaceTileOpen;
    h.isSurfaceTileOpen = function (rid, x, y) { return avoinOrig.call(this, rid, x, y) && this.getTopFurnitureWalkable(rid, x, y) !== false; };
    h.getSeatHeight = function (rid, x, y) {
      const m = this._roomEngine.getFurnitureStackingHeightMap(rid);
      if (!m || x < 0 || y < 0 || x >= m.width || y >= m.height || !m.isStackingBlocked(x, y)) return null;
      if (this.getTopFurnitureWalkable(rid, x, y) !== true) return null;
      const o = ylin(rid, x, y); return o.getLocation().z + Math.max(0, this.getFurnitureFootprint(o)[2] - 0.5);   // 0.1.10: natiivi istumakorkeus (kp 16:22)
    };
    h.isTileReachable = function (rid, reach, x, y) {
      const m = this._roomEngine.getFurnitureStackingHeightMap(rid); if (!m) return false;
      const w = m.width; if (reach[y * w + x]) return true;
      if (this.getSeatHeight(rid, x, y) === null) return false;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < m.height && reach[ny * w + nx]) return true; }
      return false;
    };
    h.getSurfaceRayHits = function (rid, ray) {
      const m = this._roomEngine.getFurnitureStackingHeightMap(rid), wg = this._roomEngine.getLegacyWallGeometry(rid);
      if (!m || !wg) return [];
      let max = 0; for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) { const t = m.getTileHeight(x, y); if (t < BLOCKED && t > max) max = t; }
      const hits = []; let prev = null; const V = (h.__V || (h.__V = r.getRoomObjectCursor && r.getRoomObjectCursor(rid) && r.getRoomObjectCursor(rid).getLocation().constructor));
      for (let z = max + 1; z >= -0.5; z -= RAY_STEP) {
        const [x, y] = this.getSurfaceRayTile(ray, z);
        if (x < 0 || y < 0 || x >= m.width || y >= m.height || !wg.isRoomTile(x, y)) { prev = null; continue; }
        const seat = this.getSeatHeight(rid, x, y), mk = seat !== null ? null : merkki(rid, x, y), top = seat !== null ? seat : (mk !== null ? mk : m.getTileHeight(x, y));
        if (prev && prev[0] === x && prev[1] === y && prev[2] > top && z <= top) hits.push(new V(x, y, top));
        prev = [x, y, z];
      }
      return hits;
    };
    h.getRaisedSurfaceLocation = function (rid, ro, event) {
      if (!this._surfaceWalkEnabled || !ro || !ro.model || !event) return null;
      const ray = this.getSurfaceRay(ro, event), m = this._roomEngine.getFurnitureStackingHeightMap(rid);
      if (!ray || !m) return null;
      const l = ro.getLocation(), [sx, sy, sz] = this.getFurnitureFootprint(ro), [tx, ty] = this.getSurfaceRayTile(ray, l.z + sz);
      h.__V = l.constructor;   // Vector3d getSurfaceRayHitsille
      let target = null;
      if (tx >= l.x && tx < l.x + sx && ty >= l.y && ty < l.y + sy && this.isSurfaceTileOpen(rid, tx, ty)) { const T = merkki(rid, tx, ty); target = new l.constructor(tx, ty, T !== null ? T : m.getTileHeight(tx, ty)); }
      const reach = this.getReachableSurfaceTiles(rid); if (!reach) return target;
      if (target && this.isTileReachable(rid, reach, target.x, target.y)) return target;
      for (const hit of this.getSurfaceRayHits(rid, ray)) if (this.isTileReachable(rid, reach, hit.x, hit.y)) return hit;
      return null;   // mihinkään säteen kohtaan ei pääse: ei kursoria eikä kävelyä
    };
  }
  setInterval(paikkaa, 1000);
})();
