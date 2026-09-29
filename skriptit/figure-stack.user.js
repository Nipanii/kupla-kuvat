// ==UserScript==
// @name         Kupla vaatepino (figure stack)
// @namespace    https://re-lab.local/kupla
// @version      0.4.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/figure-stack.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/figure-stack.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-idle
// @description  Useampi vaate samasta kategoriasta päällekkäin (esim. kaksi hattua tai kaksi takkia). Vaatekaapissa: tavallinen klikkaus toimii kuten ennenkin; ruudun kulman vihreä + lisää vaatteen päälle (pinoon), pinotuissa on punainen - joka poistaa sen pinosta ja järjestysnumero (1 = alin). Pinossa olevan vaatteen klikkaus valitsee sen väritettäväksi, jolloin paletti värittää juuri sen. Renderöi myös muiden pelaajien pinotut asut. Värivalinta koskee päällimmäistä.
// @author       re-lab
// ==/UserScript==
/*
 * Res 2026-09-29 22:48-22:54: "voi valita useamman vaatteen samasta kategoriasta" · "vois stackaa takkeja esim" ·
 *   "pitäis vaan pystyä valita useempi ja renderöidä järjestyksessä" · "tee userscript testiks".
 *
 * MITEN (lähde: client/Nitro_Render_V3/packages/avatar/src, base 239c1eb8):
 *   Figure-merkkijono on "tyyppi-setti-väri[-väri2]" pisteillä erotettuna. AvatarFigureContainer tallettaa osat
 *   Map<tyyppi,...>:iin, joten toinen saman tyypin osa korvasi ensimmäisen. Palvelin päästää duplikaatit läpi (mitattu).
 *   1) Renderöijä: kontti tallettaa duplikaatit avaimilla "ha", "ha~2", "ha~3"... Kaikki kontin lukijat
 *      (AvatarStructure.getParts, asset-lataus, club-taso) hakevat setin figureData.getSetType(avain):lla, joten
 *      getSetType riisuu "~N"-päätteen -> duplikaatin kirjastot latautuvat ja se piirretään.
 *      Piirtojärjestys: AvatarImageCache.renderBodyPart piirtää listan LOPUSTA ALKUUN, eli ensimmäinen osa on
 *      päällimmäinen. Siksi getPartTypeIds antaa saman tyypin duplikaatit KÄÄNTEISESSÄ järjestyksessä: merkkijonossa
 *      myöhempi = päällä. Ilman duplikaatteja järjestys on täsmälleen sama kuin ennen.
 *   2) Vaatekaappi (DarkUI FigureData, Map<tyyppi,id>): päävalinta pysyy _data/_colors-kentissä, sen ALLA olevat
 *      pinotut talletetaan erikseen (WeakMap). getFigureString kirjoittaa pinon ennen päävalintaa.
 * Luokat ovat bundlessa; ne haetaan elävistä olioista (NitroDevTools.roomEngine -> huoneen avatar -> AvatarImage,
 *   ja React-fiberin propseista vaatekaapissa). Metodit tarkistetaan muodon perusteella; jos jokin puuttuu,
 *   konsoliin tulee [vaatepino] VIRHE eikä mitään patchata.
 * 0.2.0 (Res 23:07 "ei shift clickiä näytä pieni vihree + merkki yläreunassa ... näytä myös numerona järjestys"):
 *   shift+klikkaus pois; vihreä + (oikea yläkulma) lisää, numero (vasen yläkulma, 1 = alin) poistaa. Ei kasvoille (hd)
 *   eikä tyhjä-ruudulle. Merkit piilotetaan kun figuredata-editorin FD-tila on päällä (#fd-nappi.on tai #fd-paneeli
 *   näkyvissä), koska sen capture-kuuntelija lukee ruudun klikkaukset omaan paneeliinsa.
 * 0.3.0 (Res 23:14 "miksei väri voi apply siihen valittuun itemiin"): pinossa olevan ruudun tavallinen klikkaus EI enää
 *   tyhjennä pinoa vaan valitsee sen väritettäväksi ("värikohde", sininen numero); paletti näyttää kohteen värit ja
 *   värittää sen (FigureData.savePartSetColourId ohjataan pinon alkioon). Pinon järjestys ei muutu. Klikkaus ruutuun joka
 *   ei ole pinossa toimii kuten ennenkin (yksi vaate). Värit tallentuvat merkkijonoon alkiokohtaisesti pinon järjestyksessä.
 * 0.4.0 (Res 23:25 / 23:28): pinotun ruudun oikeassa yläkulmassa punainen "-" (poistaa pinosta) +:n tilalla;
 *   järjestysnumero on pelkkä teksti ("1", "2"; ei nappi, ei ×). Sininen värikohdemerkki pois: ruudun oma valintatausta
 *   seuraa värikohdetta (CategoryData.selectPartIndex + ruudukon setMaxPaletteCount, joten myös palettien määrä vastaa
 *   kohdetta). Vaatekaapin tallennus lukee vain FigureDatan merkkijonon, ei valittua ruutua.
 *   KORJAUS: ruudun React-fiber haetaan nykyisestä (ei vanhasta alternate-)fiberistä; 0.2.0-0.3.0 saattoivat alavälilehden
 *   vaihdon jälkeen näyttää merkit väärissä ruuduissa ja +:n klikkaus ajaa toisen vaatteen (jopa toisen kategorian) valinnan.
 * RAJA: kupla.cc/avatarimage (palvelimen kuvapalvelu) piirtää edelleen vain viimeisen duplikaatin.
 * RAJA: renderöijä patchataan vasta kun huoneessa on ensimmäinen avatar; sitä ennen luodut kuvat (esim. työkalupalkin
 *   pää) näyttävät vanhan tavan, kunnes ne luodaan uudelleen. Huoneen avatarit päivitetään patchatessa.
 */
(() => {
  'use strict';
  const W = window;
  const VERSION = '0.4.0';
  if (W.__figureStack && W.__figureStack.version === VERSION && !W.__figureStackTestOnly) return;
  const TAG = '[vaatepino]';
  const SEP = '~';
  const baseType = k => (typeof k === 'string' && k.indexOf(SEP) > 0) ? k.slice(0, k.indexOf(SEP)) : k;
  const dupIndex = k => (typeof k === 'string' && k.indexOf(SEP) > 0) ? (parseInt(k.slice(k.indexOf(SEP) + 1)) || 1) : 1;
  const fail = (msg) => { console.error(TAG, 'VIRHE:', msg, '— skripti ei tee mitään tälle osalle.'); return false; };

  // Ryhmittele avaimet tyypeittäin ensiesiintymän kohtaan, ryhmän sisällä ~N-järjestyksessä.
  function groupedKeys(keys, reverseGroups) {
    const out = []; const done = new Set();
    for (const k of keys) {
      const t = baseType(k); if (done.has(t)) continue; done.add(t);
      const grp = keys.filter(x => baseType(x) === t).sort((a, b) => dupIndex(a) - dupIndex(b));
      if (reverseGroups) grp.reverse();
      for (const g of grp) out.push(g);
    }
    return out;
  }

  // ---------- 1) renderöijä ----------
  function patchContainer(P) {
    for (const m of ['getPartTypeIds', 'getPartSetId', 'getPartColorIds', 'updatePart', 'partSets', 'parseFigure', 'getFigureString'])
      if (typeof P[m] !== 'function') return fail('AvatarFigureContainer.' + m + ' puuttuu');
    P.parseFigure = function (figure) {
      if (!figure) figure = '';
      const count = Object.create(null);
      for (const part of figure.split('.')) {
        const pieces = part.split('-');
        if (pieces.length < 2) continue;
        const type = pieces[0];
        const setId = parseInt(pieces[1]);
        const colors = [];
        for (let i = 2; i < pieces.length; i++) colors.push(parseInt(pieces[i]));
        const n = (count[type] = (count[type] || 0) + 1);
        this.updatePart((n === 1) ? type : (type + SEP + n), setId, colors);
      }
    };
    P.getPartTypeIds = function () {
      return groupedKeys(Array.from(this.partSets().keys()), true)[Symbol.iterator]();
    };
    P.getFigureString = function () {
      const parts = [];
      for (const key of groupedKeys(Array.from(this.partSets().keys()), false)) {
        if (!key) continue;
        parts.push([baseType(key), this.getPartSetId(key)].concat(this.getPartColorIds(key)).join('-'));
      }
      return parts.join('.');
    };
    return true;
  }

  function patchSetData(FP) {
    if (typeof FP.getSetType !== 'function') return fail('FigureSetData.getSetType puuttuu');
    const orig = FP.__fsOrigGetSetType || (FP.__fsOrigGetSetType = FP.getSetType);
    FP.getSetType = function (setType) { return orig.call(this, baseType(setType)); };
    return true;
  }

  function findAvatarImage() {
    const RE = W.NitroDevTools && W.NitroDevTools.roomEngine;
    if (!RE || typeof RE.getRoomObjectByIndex !== 'function') return null;
    const rid = RE._activeRoomId; if (rid === undefined || rid < 0) return null;
    const n = RE.getTotalObjectsForManager ? RE.getTotalObjectsForManager(rid, 100) : 0;
    for (let i = 0; i < n; i++) {
      const o = RE.getRoomObjectByIndex(rid, i, 100);
      const ai = o && o.visualization && o.visualization._avatarImage;
      if (ai && typeof ai.getFigure === 'function' && ai.getFigure() && ai._structure && ai._structure._figureData) return ai;
    }
    return null;
  }

  function hasDuplicates(figure) {
    const seen = new Set();
    for (const p of String(figure || '').split('.')) { const t = p.split('-')[0]; if (!t) continue; if (seen.has(t)) return true; seen.add(t); }
    return false;
  }

  function refreshRoomAvatars() {
    const RE = W.NitroDevTools.roomEngine; const rid = RE._activeRoomId; let n = 0;
    const total = RE.getTotalObjectsForManager(rid, 100);
    for (let i = 0; i < total; i++) {
      const o = RE.getRoomObjectByIndex(rid, i, 100); const vis = o && o.visualization;
      if (!vis || !('_figure' in vis)) continue;
      if (!hasDuplicates(vis._figure)) continue;
      vis._figure = null;            // updateFigure() -> clearAvatar() -> _avatarImage = null -> rakennetaan uudelleen
      vis._updateModelCounter = -1;  // muuten updateModel() ohittaa (sama model.updateCounter)
      n++;
    }
    return n;
  }

  let rendererDone = false;
  function tryPatchRenderer() {
    if (rendererDone) return true;
    const ai = findAvatarImage(); if (!ai) return false;
    rendererDone = true;
    const P = Object.getPrototypeOf(ai.getFigure());
    const FP = Object.getPrototypeOf(ai._structure._figureData);
    const getParts = String(ai._structure.getParts || '');
    if (!/getPartTypeIds\(\)/.test(getParts) || !/getSetType\(/.test(getParts)) return fail('AvatarStructure.getParts ei näytä odotetulta (getPartTypeIds/getSetType puuttuu lähteestä)');
    if (P.__figureStack === VERSION) return true;
    if (!patchContainer(P) || !patchSetData(FP)) return false;
    P.__figureStack = VERSION;
    const n = refreshRoomAvatars();
    console.info(TAG, 'renderöijä patchattu; huoneen avatareja päivitetty:', n);
    return true;
  }

  // ---------- 2) vaatekaappi ----------
  // Tila on windowissa, jotta uudempi versio voi patchata vanhan päälle ilman sivun uudelleenlatausta.
  const S = W.__figureStackState || (W.__figureStackState = { stacksOf: new WeakMap(), pending: null });
  const stacks = fd => { let s = S.stacksOf.get(fd); if (!s) { s = new Map(); S.stacksOf.set(fd, s); } return s; };
  const stackArr = (fd, t) => { const s = stacks(fd); let a = s.get(t); if (!a) { a = []; s.set(t, a); } return a; }; // päävalinnan ALLA, alin ensin
  const NO_STACK = new Set(['hd']); // kasvot/vartalo: aina yksi
  if (!S.targets) S.targets = new WeakMap(); // FigureData -> Map<tyyppi, pinotun alkion id> (värikohde; puuttuu = päällimmäinen)
  const targets = fd => { let m = S.targets.get(fd); if (!m) { m = new Map(); S.targets.set(fd, m); } return m; };
  // Värikohteen pinoalkio, tai null jos kohde on päällimmäinen (= clientin oma _data/_colors).
  const targetEntry = (fd, t) => { const id = targets(fd).get(t); if (id === undefined) return null; return (stacks(fd).get(t) || []).find(e => e.id === id) || null; };

  function fmt(t, id, colors) {
    let s = t + '-' + id;
    if (colors && colors.length) for (const c of colors) s += '-' + c;
    return s;
  }

  function patchFigureData(FDP) {
    for (const m of ['loadAvatarData', 'parseFigureString', 'getFigureString', 'savePartData', 'savePartSetId', 'savePartSetColourId', 'updateView'])
      if (typeof FDP[m] !== 'function') return fail('vaatekaapin FigureData.' + m + ' puuttuu');
    const origSave = FDP.__fsOrigSave || (FDP.__fsOrigSave = FDP.savePartData);
    const origColour = FDP.__fsOrigColour || (FDP.__fsOrigColour = FDP.savePartSetColourId);
    FDP.parseFigureString = function (figure) {
      stacks(this).clear(); targets(this).clear();
      if (!figure) return;
      const seen = new Set();
      for (const set of figure.split('.')) {
        const parts = set.split('-');
        if (!parts.length) continue;
        const setType = parts[0];
        const setId = parseInt(parts[1]);
        const colorIds = [];
        for (let i = 2; i < parts.length; i++) colorIds.push(parseInt(parts[i]));
        if (!colorIds.length) colorIds.push(0);
        if (seen.has(setType) && this._data.has(setType))
          stackArr(this, setType).push({ id: this._data.get(setType), colors: (this._colors.get(setType) || []).slice() });
        seen.add(setType);
        this.savePartSetId(setType, setId, false);
        this.savePartSetColourId(setType, colorIds, false);
      }
    };
    FDP.getFigureString = function () {
      const out = []; const s = stacks(this);
      for (const [setType, setId] of this._data.entries()) {
        for (const e of (s.get(setType) || [])) out.push(fmt(setType, e.id, e.colors));
        out.push(fmt(setType, setId, this._colors.get(setType)));
      }
      return out.join('.');
    };
    FDP.savePartData = function (setType, partId, colorIds, update) {
      const p = (S.pending && S.pending.type === setType) ? S.pending.mode : null;
      S.pending = null;
      targets(this).delete(setType); // päävalinta vaihtuu -> värikohde takaisin päällimmäiseen
      if (p === 'add' && partId >= 0) {
        const old = this._data.get(setType);
        const a = stackArr(this, setType);
        const i = a.findIndex(e => e.id === partId); if (i >= 0) a.splice(i, 1);
        if (old !== undefined && old >= 0 && old !== partId) a.push({ id: old, colors: (this._colors.get(setType) || []).slice() });
      } else if (p !== 'keep') {
        stacks(this).delete(setType); // tavallinen klikkaus = yksi vaate, kuten ennenkin
      }
      return origSave.apply(this, arguments);
    };
    FDP.savePartSetColourId = function (setType, colorIds, update = true) {
      const e = targetEntry(this, setType);
      if (!e) return origColour.apply(this, arguments);
      e.colors = (colorIds || []).slice(); // paletti värittää valitun pinotun vaatteen
      if (update) this.updateView();
    };
    return true;
  }

  // DOM-solmun __reactFiber$ voi olla VANHA vaihtoehtofiber (mitattu 0.4.0: alavälilehden vaihdon jälkeen 958/1927 ruutua
  // antoi väärän partItemin, esim. hiusten 3733 hattu-ruudussa). Nykyinen host-fiber on se, jonka memoizedProps === __reactProps$.
  const fiberOf = el => {
    if (!el) return null;
    const keys = Object.keys(el); const fk = keys.find(k => k.startsWith('__reactFiber$')); const pk = keys.find(k => k.startsWith('__reactProps$'));
    const f = fk ? el[fk] : null; if (!f) return null;
    const props = pk ? el[pk] : undefined;
    if (f.alternate && f.memoizedProps !== props && f.alternate.memoizedProps === props) return f.alternate;
    return f;
  };
  function upProps(el, pred, max) {
    let f = fiberOf(el);
    for (let d = 0; f && d < (max || 40); d++, f = f.return) { const p = f.memoizedProps; if (p && typeof p === 'object' && pred(p)) return p; }
    return null;
  }
  function findEditorFigureData() {
    const root = document.querySelector('.nitro-avatar-editor'); if (!root) return null;
    let found = null;
    const walk = (f, d) => { for (; f && !found && d < 600; f = f.sibling) { const p = f.memoizedProps; if (p && p.figureData && typeof p.figureData.getFigureString === 'function') { found = p.figureData; return; } walk(f.child, d + 1); } };
    walk(fiberOf(root), 0);
    return found;
  }

  let editorDone = false; let editorFailed = false;
  function tryPatchEditor() {
    if (editorDone || editorFailed) return editorDone;
    const fd = findEditorFigureData(); if (!fd) return false;
    const FDP = Object.getPrototypeOf(fd);
    if (!(fd._data instanceof Map) || !(fd._colors instanceof Map)) { editorFailed = true; return fail('vaatekaapin FigureData._data/_colors ei ole Map'); }
    if (FDP.__figureStack !== VERSION) { if (!patchFigureData(FDP)) { editorFailed = true; return false; } FDP.__figureStack = VERSION; }
    editorDone = true;
    // Editori ladattiin ennen patchia -> duplikaatit litistyivät. Lataa oma asu uudelleen jos siinä on duplikaatteja.
    try {
      const sdm = W.NitroDevTools.roomEngine._sessionDataManager;
      const own = sdm && String(sdm._figure || '');
      if (own && hasDuplicates(own) && fd.getFigureString() !== own) { fd.loadAvatarData(own, fd.gender); }
    } catch (e) { console.warn(TAG, 'oman asun uudelleenlataus epäonnistui', e); }
    console.info(TAG, 'vaatekaappi patchattu: vihreä + lisää pinoon, numero poistaa, pinotun klikkaus = värikohde');
    return true;
  }

  // Ruudun tiedot fiberistä: ruudun omat propsit (partItem, onClick) ja ruudukon propsit (category, model).
  function tileInfo(el) {
    const pp = upProps(el, p => p.partItem, 8);
    const cp = upProps(el, p => p.category && p.model && typeof p.model.selectPart === 'function', 40);
    if (!pp || !cp || !pp.partItem) return null;
    return { partItem: pp.partItem, onClick: pp.onClick, type: cp.category.name, category: cp.category, model: cp.model, setMaxPaletteCount: cp.setMaxPaletteCount };
  }

  // Värikohteen vaihto: paletin valinta näyttää kohteen värit (CategoryData.selectColorIds ei tallenna mitään).
  function setTarget(fd, t, id) {
    const e = (stacks(fd).get(t.type) || []).find(x => x.id === id);
    if (e) targets(fd).set(t.type, id); else targets(fd).delete(t.type);
    t.category.selectColorIds(e ? e.colors : (fd._colors.get(t.type) || []));
    // Ruudun oma valintatausta seuraa värikohdetta (vain näkymän valinta; FigureData ei muutu).
    const shownId = e ? id : fd._data.get(t.type);
    const idx = t.category.parts.findIndex(p => p && p.id === shownId);
    if (idx >= 0 && idx !== t.category.selectedPartIndex) {
      const item = t.category.selectPartIndex(idx);
      if (item && typeof t.setMaxPaletteCount === 'function') t.setMaxPaletteCount(item.maxColorIndex || 1);
    }
    setTimeout(markGrid, 30);
  }

  // Tavallinen klikkaus pinossa olevaan ruutuun: vain värikohteen valinta, ei clientin omaa valintaa (joka tyhjentäisi pinon).
  function onTileClick(ev) {
    if (fdModeOn() || !ev.target || !ev.target.closest || ev.target.closest('.vp-badge')) return;
    const el = ev.target.closest('.nitro-avatar-editor .layout-grid-item'); if (!el) return;
    const fd = editorDone && findEditorFigureData(); const t = fd && tileInfo(el);
    if (!t || NO_STACK.has(t.type) || t.partItem.isClear) return;
    const a = stacks(fd).get(t.type) || []; if (!a.length) return;
    const id = t.partItem.id;
    if (id !== fd._data.get(t.type) && !a.some(e => e.id === id)) return; // ei pinossa -> tavallinen valinta
    ev.stopPropagation(); ev.preventDefault();
    setTarget(fd, t, id);
  }

  function addToStack(el) {
    const t = tileInfo(el); if (!t || typeof t.onClick !== 'function') return;
    const fd = findEditorFigureData(); if (fd && targetEntry(fd, t.type)) setTarget(fd, t, null); // uusi vaate saa päällimmäisen paletin, ei alemman
    S.pending = { type: t.type, mode: 'add' };
    try { t.onClick(); } finally { S.pending = null; } // ruudun oma valintakoodi (sama kuin tavallinen klikkaus), pinoon lisäten
    setTimeout(markGrid, 30);
  }

  function removeFromStack(el) {
    const fd = findEditorFigureData(); const t = tileInfo(el); if (!fd || !t) return;
    const a = stackArr(fd, t.type); const id = t.partItem.id;
    const i = a.findIndex(e => e.id === id);
    if (i >= 0) { a.splice(i, 1); if (targets(fd).get(t.type) === id) setTarget(fd, t, null); fd.updateView(); }
    else if (id === fd._data.get(t.type) && a.length) { // päällimmäinen pois -> alla oleva nousee päälle
      const next = a.pop();
      const idx = t.category.parts.findIndex(p => p && p.id === next.id);
      if (idx >= 0) { S.pending = { type: t.type, mode: 'keep' }; try { t.model.selectPart(t.type, idx); } finally { S.pending = null; } }
      else fd._data.set(t.type, next.id);
      fd.savePartSetColourId(t.type, next.colors, true);
      t.category.selectColorIds(next.colors);
    }
    setTimeout(markGrid, 30);
  }

  function badge(el, cls, text, title, onUse) {
    let b = el.querySelector(':scope > .' + cls);
    if (!b) {
      b = document.createElement('span'); b.className = 'vp-badge ' + cls;
      const stop = ev => { ev.stopPropagation(); ev.preventDefault(); };
      b.addEventListener('pointerdown', stop); b.addEventListener('mousedown', stop);
      b.addEventListener('click', ev => { stop(ev); onUse(el); });
      el.appendChild(b);
    }
    if (b.textContent !== text) b.textContent = text;
    if (b.title !== title) b.title = title;
    return b;
  }
  // Järjestysnumero: pelkkä teksti, ei klikattava (klikkaus menee ruudulle = värikohteen valinta).
  function label(el, text, title) {
    let b = el.querySelector(':scope > .vp-nro');
    if (!b) { b = document.createElement('span'); b.className = 'vp-nro'; el.appendChild(b); }
    if (b.textContent !== text) b.textContent = text;
    if (b.title !== title) b.title = title;
  }
  function dropBadge(el, cls) { const b = el.querySelector(':scope > .' + cls); if (b) b.remove(); }

  // figuredata-editorin FD-tila (nappi #fd-nappi.on / paneeli näkyvissä) lukee ruudun klikkaukset -> ei merkkejä silloin
  function fdModeOn() { const p = document.getElementById('fd-paneeli'); return !!document.querySelector('#fd-nappi.on') || !!(p && p.style.display !== 'none'); }

  function markGrid() {
    const fdOn = fdModeOn();
    const fd = editorDone && findEditorFigureData();
    for (const el of document.querySelectorAll('.nitro-avatar-editor .layout-grid-item')) {
      const t = (!fdOn && fd) ? tileInfo(el) : null;
      if (!t || NO_STACK.has(t.type) || t.partItem.isClear || !t.partItem.partSet) { dropBadge(el, 'vp-plus'); dropBadge(el, 'vp-minus'); dropBadge(el, 'vp-nro'); continue; }
      const a = stacks(fd).get(t.type) || [];
      const id = t.partItem.id; const primary = fd._data.get(t.type);
      const i = a.findIndex(e => e.id === id);
      const nro = (i >= 0) ? (i + 1) : ((id === primary && a.length) ? (a.length + 1) : 0); // 1 = alin
      if (nro) label(el, String(nro), 'Pinossa ' + nro + '. (1 = alin). Klikkaa vaatetta: väritä tämä.');
      else dropBadge(el, 'vp-nro');
      if (nro) badge(el, 'vp-minus', '-', 'Poista pinosta', removeFromStack);
      else dropBadge(el, 'vp-minus');
      if (!nro && id !== primary) badge(el, 'vp-plus', '+', 'Lisää tämä päälle (pinoon)', addToStack);
      else dropBadge(el, 'vp-plus');
    }
  }

  const api = { patchContainer, patchSetData, patchFigureData, groupedKeys, hasDuplicates, state: S, _setPending: v => { S.pending = v; }, markGrid, version: VERSION };

  function install(prev) {
    if (prev && prev !== api && typeof prev.uninstall === 'function') prev.uninstall(); // vanha versio samassa sivussa
    const st = document.createElement('style');
    st.textContent = '.nitro-avatar-editor .layout-grid-item{position:relative}' +
      '.vp-badge{position:absolute;top:1px;z-index:5;min-width:13px;height:13px;padding:0 2px;border-radius:7px;font:bold 10px/13px sans-serif;text-align:center;cursor:pointer;user-select:none;box-shadow:0 0 0 1px #0006}' +
      '.vp-plus{right:1px;background:#3c8d4a;color:#fff;opacity:.85}.vp-plus:hover{opacity:1;background:#4fb35f}' +
      '.vp-minus{right:1px;background:#c9463d;color:#fff;opacity:.85}.vp-minus:hover{opacity:1;background:#e0554b}' +
      '.vp-nro{position:absolute;left:3px;top:1px;z-index:5;font:bold 10px/12px sans-serif;color:#fff;text-shadow:0 0 2px #000,0 0 1px #000;pointer-events:none;user-select:none}';
    document.head.appendChild(st);
    document.addEventListener('click', onTileClick, true);
    let warned = false; const t0 = Date.now();
    const timer = setInterval(() => {
      tryPatchRenderer();
      if (document.querySelector('.nitro-avatar-editor')) { tryPatchEditor(); markGrid(); }
      if (!rendererDone && !warned && Date.now() - t0 > 120000 && W.NitroDevTools) { warned = true; console.warn(TAG, 'renderöijää ei vielä löytynyt (ei avataria huoneessa?) — yritetään edelleen'); }
    }, 500);
    api.uninstall = () => { clearInterval(timer); document.removeEventListener('click', onTileClick, true); st.remove(); document.querySelectorAll('.vp-badge, .vp-nro').forEach(b => b.remove()); };
    console.info(TAG, VERSION + ' ladattu');
  }

  const prevApi = W.__figureStack;
  W.__figureStack = api;
  if (!W.__figureStackTestOnly) install(prevApi);
})();
