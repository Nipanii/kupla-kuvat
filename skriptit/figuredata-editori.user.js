// ==UserScript==
// @name         Kupla Figuredata-editori
// @namespace    https://re-lab.local/kupla
// @version      0.2.1
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/figuredata-editori.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/figuredata-editori.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-start
// @description  Vaatekaapin päälle: poista vaatteita, muokkaa piilotuksia (hiddenLayers) suoraan vaatekaapin omasta ruudukosta (FD-nappi), lisää vaate .nitro-tiedostosta. Muutokset näkyvät vain sinulle (sivun uudelleenlatauksen jälkeen) ja uudet FigureDataISO.json + FigureMapISO.json voi ladata koneelle.
// ==/UserScript==
/*
 * Res 2026-09-29 21:2x: "robo voitko tehä figuredata editor userscriptin" · "lyöt sen toho avatar editorin päälle" ·
 *   "haluun poistaa itemeitä sielt avatareditorista ja muokkaa hideparts" · "myös lisääminen ... .nitro filu ... päivittyy
 *   figuredata" · "ja figuremap" · "jos tehään userscript nii antaa lataa uuden" · "tee hidepartsista visuaalinen ... durag".
 *
 * MITEN SE TOIMII (lähde: tmp/figuredata-editori-tausta.md):
 *   Client lataa renderer-config.jsonin avaimista avatar.figuredata.url (gamedata/FigureDataISO.json, 7.5 MB, yksi tiedosto)
 *   ja avatar.figuremap.url (gamedata/FigureMapISO.json, 0.8 MB) natiivilla fetchillä, kerran, sivun alussa.
 *   Figuredataa ei voi muokata ajon aikana: mikään ei tuo AvatarRenderManageria windowiin (NitroDevTools = {roomEngine,
 *   diagnostics}). Siksi tämä skripti ajetaan document-startissa ja se korvaa fetchin: jos muokattu versio on tallessa
 *   (IndexedDB), client saa sen alkuperäisen sijaan. Sama lisätyille .nitro-kirjastoille (bundled/figure2/<lib>.nitro).
 *   => Muutos näkyy SINULLE vasta kun sivu ladataan uudelleen. Muille ei näy mitään ennen kuin tiedostot viedään palvelimelle.
 * RAJA: myytävä (sellable:true) setti näkyy editorissa vain jos palvelin on antanut sen tilille (FIGURE_SET_IDS) —
 *   siksi lisätyt vaatteet tehdään sellable:false.
 * 0.2 (Res 22:07): ei omia kuvia eikä /avatarimage-pyyntöjä — muokkaustila käyttää vaatekaapin omaa ruudukkoa ja
 *   clientin omaa renderöintiä. Uusi piilotus näkyy vaatekaapissa tallennuksen + päivityksen jälkeen.
 * RAJA: poisto ja piilotukset muokkaavat vain tätä selainta. Palvelimelle vienti (rankilla) on myöhempi vaihe.
 */
(function () {
  'use strict';
  const W = window;
  if (W.__kuplaFdEditori) return;
  W.__kuplaFdEditori = true;

  const FD_RE = /\/gamedata\/FigureDataISO\.json/i;
  const FM_RE = /\/gamedata\/FigureMapISO\.json/i;
  const NITRO_RE = /\/bundled\/figure2\/([^/?#]+)\.nitro/i;
  const FD_URL = 'https://kupla.cc/nitro-assets/gamedata/FigureDataISO.json';
  const FM_URL = 'https://kupla.cc/nitro-assets/gamedata/FigureMapISO.json';

  // ---------- IndexedDB ----------
  const dbP = new Promise((ok, ko) => {
    const r = indexedDB.open('kupla-figuredata-editori', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
  const idb = async (mode, fn) => {
    const db = await dbP;
    return new Promise((ok, ko) => {
      const tx = db.transaction('kv', mode), st = tx.objectStore('kv');
      const req = fn(st);
      tx.oncomplete = () => ok(req && req.result);
      tx.onerror = () => ko(tx.error);
    });
  };
  const get = k => idb('readonly', s => s.get(k));
  const put = (k, v) => idb('readwrite', s => s.put(v, k));
  const del = k => idb('readwrite', s => s.delete(k));
  const keys = () => idb('readonly', s => s.getAllKeys());

  // ---------- fetch-korvaus (document-start) ----------
  const origFetch = W.fetch.bind(W);
  W.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if ((await get('paalla')) !== false) {
        if (FD_RE.test(url)) { const t = await get('fd'); if (t) return new Response(t, { headers: { 'content-type': 'application/json' } }); }
        else if (FM_RE.test(url)) { const t = await get('fm'); if (t) return new Response(t, { headers: { 'content-type': 'application/json' } }); }
        else { const m = url.match(NITRO_RE); if (m) { const b = await get('nitro:' + decodeURIComponent(m[1])); if (b) return new Response(b, { headers: { 'content-type': 'application/octet-stream' } }); } }
      }
    } catch (e) { console.warn('[fd-editori] korvaus epäonnistui, alkuperäinen käyttöön', e); }
    return origFetch(input, init);
  };

  // ---------- data ----------
  let FD = null, FM = null, muutettu = false;
  const lataa = async () => {
    if (FD) return;
    const [fd, fm] = await Promise.all([get('fd'), get('fm')]);
    FD = JSON.parse(fd || await (await origFetch(FD_URL)).text());
    FM = JSON.parse(fm || await (await origFetch(FM_URL)).text());
  };
  const tallenna = async () => {
    await put('fd', JSON.stringify(FD));
    await put('fm', JSON.stringify(FM));
    muutettu = false;
  };
  const setType = t => FD.setTypes.find(s => s.type === t);

  const NIMET = {
    hr: 'hiukset', hrb: 'hiukset takaa', ha: 'hattu', he: 'hiuskoriste', ea: 'silmälasit', fa: 'kasvokoriste',
    hd: 'pää/iho', ey: 'silmät', fc: 'kasvot', ch: 'paita', cc: 'takki', cp: 'paidan kuva', ca: 'kaulakoru',
    wa: 'vyö', lg: 'housut', sh: 'kengät', ls: 'vasen hiha', rs: 'oikea hiha', lh: 'vasen käsi', rh: 'oikea käsi',
    lc: 'vasen hiha (takki)', rc: 'oikea hiha (takki)', bd: 'vartalo', pt: 'lemmikki', mc: 'viitta',
  };
  const nimi = t => (NIMET[t] ? NIMET[t] + ' (' + t + ')' : t);
  // Piilotettavat osatyypit: kaikki mitä figuremapissa esiintyy.
  const osaTyypit = () => {
    const s = new Set();
    FM.libraries.forEach(l => l.parts.forEach(p => s.add(p.type)));
    return [...s].sort((a, b) => (NIMET[a] ? 0 : 1) - (NIMET[b] ? 0 : 1) || a.localeCompare(b));
  };
  const vari = (st, setti) => {
    const pal = FD.palettes.find(p => p.id === st.paletteId);
    const c = pal && pal.colors.find(c => c.selectable) || (pal && pal.colors[0]);
    return setti.colorable && c ? c.id : 0;
  };
  // ---------- .nitro-luku ----------
  // Muoto (Nitro Renderer NitroBundle): uint16 tiedostomäärä; per tiedosto uint16 nimen pituus, nimi, uint32 pituus, pakattu data.
  // Mitattu 2026-09-29 Hat_U_sombrero.nitro: 2 tiedostoa (.json + .png), json gzip-pakattu.
  const lueNitro = async (buf) => {
    const dv = new DataView(buf); let o = 0;
    const n = dv.getUint16(o); o += 2;
    const tiedostot = {};
    for (let i = 0; i < n; i++) {
      const nl = dv.getUint16(o); o += 2;
      const nm = new TextDecoder().decode(new Uint8Array(buf, o, nl)); o += nl;
      const len = dv.getUint32(o); o += 4;
      tiedostot[nm] = new Uint8Array(buf, o, len); o += len;
    }
    const jsonNimi = Object.keys(tiedostot).find(k => k.endsWith('.json'));
    if (!jsonNimi) throw new Error('.nitro-paketissa ei ole json-tiedostoa');
    // kuplan omat paketit ovat gzipiä (1f 8b), alkuperäinen Nitro käytti zlibiä (78 ..) — tunnistetaan tavuista
    const d = tiedostot[jsonNimi];
    const tapa = d[0] === 0x1f && d[1] === 0x8b ? 'gzip' : d[0] === 0x78 ? 'deflate' : null;
    const teksti = tapa ? await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream(tapa))).text() : new TextDecoder().decode(d);
    const j = JSON.parse(teksti);
    // Asset-nimet: h_std_ha_4011_2_0 -> tyyppi ha, id 4011 (neljänneksi ja kolmanneksi viimeinen)
    const osat = new Map();
    Object.keys(j.assets || {}).forEach(a => {
      const p = a.split('_');
      if (p.length < 6) return;
      const type = p[p.length - 4], id = +p[p.length - 3];
      if (/^[a-z]{2,3}$/.test(type) && id >= 0) osat.set(type + ':' + id, { id, type });
    });
    return { nimi: j.name || jsonNimi.replace(/\.json$/, ''), osat: [...osat.values()] };
  };

  // ---------- UI (0.2) ----------
  // Res 2026-09-29 22:07: "en haluu nähä jokaselle itemille avatar renderiä ja voitaisko käyttää clientin renderiä
  //   mielummin kun floodaa avatarimageria" · "+ tää vois olla paljon kompaktimpi".
  // => Ei omaa listaa eikä yhtään /avatarimage-pyyntöä. Muokkaustila kytkee vaatekaapin OMAN ruudukon:
  //    klikkaus valitsee vaatteen normaalisti (client piirtää sen esikatseluun) ja pieni paneeli näyttää sen setin.
  //    Setin id ja tyyppi luetaan ruudun React-propsista (partItem.id, partItem.partSet.type) — mitattu 29.9.:
  //    hd #1000002779 löytyy FigureDataISO.jsonista sellaisenaan.
  const css = `
  #fd-nappi{position:absolute;top:6px;right:44px;z-index:5;background:#3a6ea5;color:#fff;border:1px solid #1d3f63;border-radius:4px;font:bold 11px sans-serif;padding:2px 7px;cursor:pointer}
  #fd-nappi.on{background:#c9463d;border-color:#8e2a23}
  #fd-paneeli{position:fixed;width:280px;background:#f1ede4;color:#222;border:2px solid #283f5d;border-radius:6px;z-index:99999;font:12px sans-serif;box-shadow:0 4px 14px #0007}
  #fd-paneeli header{display:flex;align-items:center;gap:6px;background:#283f5d;color:#fff;padding:3px 6px;cursor:move}
  #fd-paneeli header b{flex:1}
  #fd-paneeli button{font:12px sans-serif;padding:1px 6px;border:1px solid #888;border-radius:3px;background:#fff;cursor:pointer}
  #fd-paneeli button.pun{background:#c9463d;color:#fff;border-color:#8e2a23}
  #fd-paneeli button.vih{background:#3c8d4a;color:#fff;border-color:#23602d}
  #fd-paneeli .osio{padding:4px 6px;border-bottom:1px solid #d6cfbf;display:flex;flex-wrap:wrap;gap:3px;align-items:center}
  #fd-paneeli .siru{padding:0 4px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer;line-height:15px}
  #fd-paneeli .siru.pois{background:#c9463d;color:#fff;border-color:#8e2a23}
  #fd-tila{padding:3px 6px;color:#333}
  .nitro-avatar-editor.fd-on .layout-grid-item{outline:1px dashed #3a6ea599}
  .fd-merkki{position:absolute;left:1px;top:1px;font:bold 10px sans-serif;color:#fff;background:#c9463d;border-radius:3px;padding:0 2px;pointer-events:none;z-index:2}
  .fd-poistettu{opacity:.25!important}
  `;
  const el = (tag, attrs, ...lapset) => {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => k.startsWith('on') ? e.addEventListener(k.slice(2), v) : k === 'class' ? (e.className = v) : e.setAttribute(k, v));
    lapset.flat().forEach(l => l != null && e.append(l.nodeType ? l : String(l)));
    return e;
  };
  const lataaTiedosto = (nimi, data, tyyppi) => {
    const a = el('a', { href: URL.createObjectURL(new Blob([data], { type: tyyppi || 'application/json' })), download: nimi });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  };

  let paalla = false, paneeli = null, valittu = null, valittuTyyppi = null, muutMuut = false;
  const poistetut = new Set(); // 'ha:6543' — client näyttää ne vielä kunnes sivu päivitetään
  const tila = t => { const e = document.getElementById('fd-tila'); if (e) e.textContent = t; };

  // ruudun partItem React-fiberistä (5 tasoa ylöspäin, mitattu 29.9.)
  // 0.2.1: DOM-solmun __reactFiber$ voi olla VANHA alternate-fiber — vaatepino 0.4.0 mittasi alavälilehden vaihdon jälkeen
  // 958/1927 ruutua väärällä partItemilla (hiusten 3733 hattu-ruudussa). Nykyinen fiber on se jonka memoizedProps === __reactProps$.
  const partItem = d => {
    const keys = Object.keys(d);
    const k = keys.find(k => k.startsWith('__reactFiber$')); const pk = keys.find(k => k.startsWith('__reactProps$'));
    let f = k && d[k];
    if (f && pk && f.alternate && f.memoizedProps !== d[pk] && f.alternate.memoizedProps === d[pk]) f = f.alternate;
    for (let i = 0; f && i < 8; i++, f = f.return) if (f.memoizedProps && f.memoizedProps.partItem) return f.memoizedProps.partItem;
    return null;
  };
  const settiRuudusta = d => {
    const p = partItem(d);
    if (!p || p.isClear || !p.partSet) return null;
    const st = setType(p.partSet.type);
    const s = st && st.sets.find(x => x.id === p.id);
    return s ? { s, type: p.partSet.type } : null;
  };

  // piilotusmerkit ruudukkoon
  let merkitAjastin = 0;
  const merkitse = () => {
    clearTimeout(merkitAjastin);
    merkitAjastin = setTimeout(() => {
      const ed = document.querySelector('.nitro-avatar-editor'); if (!ed || !FD) return;
      ed.classList.toggle('fd-on', paalla);
      ed.querySelectorAll('.layout-grid-item').forEach(d => {
        const vanha = d.querySelector(':scope > .fd-merkki');
        const r = paalla ? settiRuudusta(d) : null;
        const lista = r ? (r.s.hiddenLayers || []).map(h => h.partType) : [];
        const piilo = lista.length > 2 ? lista.length + '' : lista.join(' ');
        d.classList.toggle('fd-poistettu', !!(r && poistetut.has(r.type + ':' + r.s.id)));
        if (!piilo) { if (vanha) vanha.remove(); return; }
        if (vanha) { vanha.textContent = '⊘' + piilo; vanha.title = lista.join(' '); }
        else { if (getComputedStyle(d).position === 'static') d.style.position = 'relative'; d.append(el('span', { class: 'fd-merkki', title: lista.join(' ') }, '⊘' + piilo)); }
      });
    }, 120);
  };

  const YLEISET = ['hr', 'hrb', 'ha', 'he', 'ea', 'fa', 'hd', 'ch', 'cc', 'ca', 'lg', 'sh'];
  const piirra = () => {
    if (!paneeli) return;
    const V = paneeli.querySelector('#fd-valittu'); V.replaceChildren();
    if (!valittu) { V.append('Klikkaa vaatetta vaatekaapissa.'); return; }
    const s = valittu, piilossa = new Set((s.hiddenLayers || []).map(h => h.partType));
    V.append(el('b', {}, nimi(valittuTyyppi) + ' #' + s.id), ' ' + s.gender + (s.club ? ' · HC' : '') + (s.sellable ? ' · myyt.' : ''),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'pun', title: 'Poista setti figuredatasta', onclick: poista }, '🗑'));
    const P = paneeli.querySelector('#fd-piilot'); P.replaceChildren(el('span', { title: 'Osat jotka tämä vaate piilottaa (näkyy vaatekaapissa tallennuksen ja päivityksen jälkeen)' }, 'piilottaa:'));
    const kaikki = osaTyypit();
    const naytettavat = muutMuut ? kaikki : kaikki.filter(t => YLEISET.includes(t) || piilossa.has(t));
    naytettavat.forEach(t => P.append(el('span', {
      class: 'siru' + (piilossa.has(t) ? ' pois' : ''), title: nimi(t),
      onclick: () => {
        piilossa.has(t) ? piilossa.delete(t) : piilossa.add(t);
        s.hiddenLayers = [...piilossa].map(p => ({ partType: p }));
        muutettu = true; piirra(); merkitse();
        tila('muutettu — tallenna');
      },
    }, t)));
    P.append(el('span', { class: 'siru', onclick: () => { muutMuut = !muutMuut; piirra(); } }, muutMuut ? '−' : '+' + (kaikki.length - naytettavat.length)));
  };

  const poista = () => {
    if (!valittu) return;
    const st = setType(valittuTyyppi);
    if (!confirm('Poistetaanko ' + nimi(valittuTyyppi) + ' #' + valittu.id + '? (vain tästä selaimesta)')) return;
    st.sets = st.sets.filter(x => x !== valittu);
    poistetut.add(valittuTyyppi + ':' + valittu.id);
    tila('poistettu #' + valittu.id + ' — tallenna');
    valittu = null; muutettu = true; piirra(); merkitse();
  };

  const lisaaNitro = async (file) => {
    const buf = await file.arrayBuffer();
    const n = await lueNitro(buf);
    if (!n.osat.length) throw new Error('paketista ei löytynyt vaateosia (asset-nimet eivät ole muotoa h_std_ha_1234_2_0)');
    const libId = file.name.replace(/\.nitro$/i, '');
    const tyypit = [...new Set(n.osat.map(o => o.type))];
    const paa = prompt('Paketissa ' + libId + ' osat: ' + n.osat.map(o => o.type + '-' + o.id).join(', ') +
      '\n\nMihin kategoriaan setti lisätään? (esim. ' + tyypit.join(', ') + ')', tyypit[0]);
    if (!paa) return;
    const st = setType(paa); if (!st) throw new Error('tuntematon kategoria ' + paa);
    const ehd = Math.max(...st.sets.filter(s => s.id < 1e9).map(s => s.id), 0) + 1;
    const idTxt = prompt('Setin id (oletus: seuraava vapaa tässä kategoriassa)', String(ehd));
    if (!idTxt) return;
    const id = +idTxt;
    if (st.sets.some(s => s.id === id)) throw new Error('setti #' + id + ' on jo olemassa kategoriassa ' + paa);
    const sukup = (prompt('Sukupuoli: M, F vai U', 'U') || 'U').toUpperCase();
    const varillinen = confirm('Voiko vaatteen värjätä? (OK = kyllä)');
    FM.libraries = FM.libraries.filter(l => l.id !== libId);
    FM.libraries.push({ id: libId, revision: 1, parts: n.osat.map(o => ({ id: o.id, type: o.type })) });
    st.sets.push({
      id, gender: sukup, club: 0, colorable: varillinen, selectable: true, preselectable: false, sellable: false,
      parts: n.osat.map((o, i) => ({ id: o.id, type: o.type, colorable: varillinen, index: i, colorindex: varillinen ? 1 : 0 })),
      hiddenLayers: [],
    });
    await put('nitro:' + libId, buf);
    const lisatyt = (await get('lisatyt')) || [];
    await put('lisatyt', [...new Set(lisatyt.concat(libId))]);
    muutettu = true; valittu = st.sets[st.sets.length - 1]; valittuTyyppi = paa; piirra();
    tila('lisätty ' + paa + ' #' + id + ' (' + n.osat.length + ' osaa) — tallenna, näkyy päivityksen jälkeen');
  };

  const teePaneeli = async () => {
    const tied = el('input', { type: 'file', accept: '.nitro', style: 'display:none', onchange: async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await lisaaNitro(f); } catch (er) { alert('Lisäys epäonnistui: ' + er.message); } } });
    const kaytossa = el('input', { type: 'checkbox', title: 'Käytä muokattua figuredataa sivun latauksessa' });
    kaytossa.checked = (await get('paalla')) !== false;
    kaytossa.addEventListener('change', async () => { await put('paalla', kaytossa.checked); tila(kaytossa.checked ? 'muokattu käytössä seuraavalla latauksella' : 'alkuperäinen käytössä seuraavalla latauksella'); });
    paneeli = el('div', { id: 'fd-paneeli' },
      el('header', {}, el('b', {}, 'Figuredata'), el('button', { title: 'Muokkaustila pois', onclick: () => kytke(false) }, '✕')),
      el('div', { class: 'osio', id: 'fd-valittu' }),
      el('div', { class: 'osio', id: 'fd-piilot' }),
      el('div', { class: 'osio' },
        el('button', { class: 'vih', title: 'Tallenna ja lataa sivu uudelleen', onclick: async () => { await tallenna(); location.reload(); } }, '💾 Tallenna'),
        el('button', { title: 'Lisää vaate .nitro-tiedostosta', onclick: () => tied.click() }, '+ .nitro'), tied,
        el('button', { title: 'Lataa FigureDataISO.json + FigureMapISO.json + lisätyt .nitrot', onclick: async () => {
          lataaTiedosto('FigureDataISO.json', JSON.stringify(FD)); lataaTiedosto('FigureMapISO.json', JSON.stringify(FM));
          for (const l of (await get('lisatyt')) || []) { const b = await get('nitro:' + l); if (b) lataaTiedosto(l + '.nitro', b, 'application/octet-stream'); }
        } }, '⬇'),
        el('label', { title: 'Muokkaukset käytössä' }, kaytossa, 'käytössä'),
        el('button', { class: 'pun', title: 'Palauta alkuperäinen (poistaa kaikki omat muutokset tästä selaimesta)', onclick: async () => {
          if (!confirm('Palautetaanko alkuperäinen figuredata ja poistetaan omat muutokset + lisätyt .nitrot?')) return;
          for (const k of await keys()) await del(k); location.reload();
        } }, '↺')),
      el('div', { id: 'fd-tila' }, (await get('fd')) ? 'muokattu versio tallessa' : 'alkuperäinen'));
    document.body.append(paneeli);
    const ed = document.querySelector('.nitro-avatar-editor');
    // ei vaatekaapin päälle: oikealle jos mahtuu, muuten vasemmalle, muuten alle
    const r = ed ? ed.getBoundingClientRect() : { left: 0, right: 400, top: 80, bottom: 400 };
    const x = r.right + 290 <= innerWidth ? r.right + 6 : r.left - 290 >= 0 ? r.left - 290 : Math.max(4, r.left);
    const y = x === Math.max(4, r.left) && r.right + 290 > innerWidth && r.left - 290 < 0 ? Math.min(innerHeight - 160, r.bottom + 6) : Math.max(4, r.top);
    paneeli.style.left = x + 'px'; paneeli.style.top = y + 'px';
    const h = paneeli.querySelector('header'); let d = null;
    h.addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') return; const rr = paneeli.getBoundingClientRect(); d = [e.clientX - rr.left, e.clientY - rr.top]; });
    addEventListener('mousemove', e => { if (d) { paneeli.style.left = (e.clientX - d[0]) + 'px'; paneeli.style.top = (e.clientY - d[1]) + 'px'; } });
    addEventListener('mouseup', () => { d = null; });
    piirra();
  };

  const kytke = async (on) => {
    paalla = on;
    const n = document.getElementById('fd-nappi'); if (n) n.classList.toggle('on', on);
    if (!on) { if (paneeli) paneeli.style.display = 'none'; merkitse(); return; }
    if (paneeli) { paneeli.style.display = ''; merkitse(); return; }
    if (n) n.textContent = '…';
    try { await lataa(); } catch (e) { alert('figuredatan lataus epäonnistui: ' + e.message); paalla = false; if (n) n.textContent = 'FD'; return; }
    if (n) n.textContent = 'FD';
    await teePaneeli(); merkitse();
  };

  // Klikkaus vaatekaapin ruudussa: EI estetä (client valitsee vaatteen ja piirtää sen), luetaan vain setti.
  document.addEventListener('click', e => {
    if (!paalla || !FD) return;
    const d = e.target.closest && e.target.closest('.nitro-avatar-editor .layout-grid-item'); if (!d) return;
    const r = settiRuudusta(d); if (!r) return;
    valittu = r.s; valittuTyyppi = r.type; piirra();
  }, true);

  const lisaaNappi = () => {
    const kortti = document.querySelector('.nitro-avatar-editor');
    if (!kortti) { if (paalla && paneeli) paneeli.style.display = 'none'; return; }
    if (paalla && paneeli) paneeli.style.display = '';
    if (paalla) merkitse();
    if (kortti.querySelector('#fd-nappi')) return;
    if (getComputedStyle(kortti).position === 'static') kortti.style.position = 'relative';
    kortti.append(el('button', { id: 'fd-nappi', class: paalla ? 'on' : '', title: 'Figuredata-muokkaus päälle/pois', onclick: e => { e.stopPropagation(); kytke(!paalla); } }, 'FD'));
  };
  const kaynnista = () => {
    document.head.append(el('style', {}, css));
    let odottaa = false;
    new MutationObserver(() => { if (odottaa) return; odottaa = true; requestAnimationFrame(() => { odottaa = false; lisaaNappi(); }); }).observe(document.body, { childList: true, subtree: true });
    lisaaNappi();
    addEventListener('beforeunload', e => { if (muutettu) { e.preventDefault(); e.returnValue = ''; } });
    W.kuplaFdEditori = { kytke, lueNitro };
  };
  if (document.body) kaynnista(); else document.addEventListener('DOMContentLoaded', kaynnista);
})();
