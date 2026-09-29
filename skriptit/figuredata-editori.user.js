// ==UserScript==
// @name         Kupla Figuredata-editori
// @namespace    https://re-lab.local/kupla
// @version      0.1.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/figuredata-editori.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/figuredata-editori.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-start
// @description  Vaatekaapin päälle: poista vaatteita, muokkaa piilotuksia (hiddenLayers) kuvien kanssa, lisää vaate .nitro-tiedostosta. Muutokset näkyvät vain sinulle (sivun uudelleenlatauksen jälkeen) ja uudet FigureDataISO.json + FigureMapISO.json voi ladata koneelle.
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
 * RAJA: kuvat tulevat palvelimen kuvaimesta (/avatarimage), joka käyttää PALVELIMEN figuredataa: tallentamattomat
 *   piilotukset eivät näy niissä. Oikea tulos näkyy vaatekaapissa tallennuksen + päivityksen jälkeen.
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
  const IMG = 'https://kupla.cc/avatarimage';

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
  const MALLI_HIUS = 'hr-828-45';
  const kuva = (figure, iso) => IMG + '?figure=' + encodeURIComponent(figure) + '&direction=2&head_direction=2&size=' + (iso ? 'l' : 'm');
  const asuSetilla = (type, setti, st) => {
    const osa = type + '-' + setti.id + (vari(st, setti) ? '-' + vari(st, setti) : '');
    const perus = ['hd-180-1', 'ch-210-66', 'lg-270-82', 'sh-290-80'].filter(x => !x.startsWith(type + '-'));
    if (type !== 'hr') perus.push(MALLI_HIUS);
    return perus.concat(osa).join('.');
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

  // ---------- UI ----------
  const css = `
  #fd-nappi{position:absolute;top:6px;right:44px;z-index:5;background:#3a6ea5;color:#fff;border:1px solid #1d3f63;border-radius:4px;font:bold 11px sans-serif;padding:2px 7px;cursor:pointer}
  #fd-ikkuna{position:fixed;top:60px;left:50%;transform:translateX(-50%);width:760px;max-width:96vw;max-height:84vh;display:flex;flex-direction:column;background:#f1ede4;color:#222;border:2px solid #283f5d;border-radius:8px;z-index:99999;font:12px sans-serif;box-shadow:0 6px 24px #0008}
  #fd-ikkuna header{display:flex;align-items:center;gap:8px;background:#283f5d;color:#fff;padding:6px 10px;cursor:move}
  #fd-ikkuna header b{flex:1}
  #fd-ikkuna .rivi{display:flex;gap:6px;align-items:center;padding:6px 10px;flex-wrap:wrap;border-bottom:1px solid #d6cfbf}
  #fd-ikkuna button{font:12px sans-serif;padding:2px 8px;border:1px solid #888;border-radius:4px;background:#fff;cursor:pointer}
  #fd-ikkuna button.pun{background:#c9463d;color:#fff;border-color:#8e2a23}
  #fd-ikkuna button.vih{background:#3c8d4a;color:#fff;border-color:#23602d}
  #fd-lista{flex:1;min-height:140px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:6px;padding:8px 10px}
  #fd-lista .setti{background:#fff;border:1px solid #ccc;border-radius:6px;text-align:center;padding:3px;cursor:pointer;font-size:11px}
  #fd-lista .setti.poistettu{opacity:.35}
  #fd-lista .setti:hover{border-color:#283f5d}
  #fd-lista img{width:64px;height:110px;object-fit:contain;image-rendering:pixelated}
  #fd-tiedot{padding:8px 10px;flex-shrink:0;max-height:55vh;overflow:auto}
  #fd-tiedot .kuvat{display:flex;gap:14px;align-items:flex-end}
  #fd-tiedot .kuvat figure{margin:0;text-align:center}
  #fd-tiedot .kuvat img{image-rendering:pixelated;background:#fff;border:1px solid #ccc;border-radius:6px}
  #fd-tiedot .osat{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:3px 10px;margin-top:8px}
  #fd-tiedot .osat label{display:flex;gap:4px;align-items:center;padding:2px 4px;border-radius:4px}
  #fd-tiedot .osat label.pois{background:#f7c9c4}
  #fd-tila{font-size:11px;color:#555;padding:4px 10px}
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

  let ikkuna = null, tyyppi = 'ha', haku = '', valittu = null;
  const tila = t => { const e = document.getElementById('fd-tila'); if (e) e.textContent = t; };

  const piirraLista = () => {
    const L = document.getElementById('fd-lista'); if (!L) return;
    L.replaceChildren();
    const st = setType(tyyppi); if (!st) return;
    let sets = st.sets;
    if (haku) sets = sets.filter(s => String(s.id).includes(haku));
    const naytettavat = sets.slice(-240).reverse();
    naytettavat.forEach(s => {
      const k = el('img', { loading: 'lazy', src: kuva(asuSetilla(tyyppi, s, st)) });
      const piilo = (s.hiddenLayers || []).map(h => h.partType).join(',');
      L.append(el('div', { class: 'setti', title: 'piilottaa: ' + (piilo || '-'), onclick: () => avaa(s) }, k, el('div', {}, '#' + s.id), piilo ? el('div', { style: 'color:#a33' }, '⊘ ' + piilo) : null));
    });
    tila(st.sets.length + ' settiä tyypissä ' + nimi(tyyppi) + (sets.length > 240 ? ' · näytetään uusimmat 240, rajaa id-haulla' : ''));
  };

  const avaa = (s) => {
    valittu = s;
    const T = document.getElementById('fd-tiedot'); T.replaceChildren();
    const st = setType(tyyppi);
    const piilossa = new Set((s.hiddenLayers || []).map(h => h.partType));
    const ilman = ['hd-180-1', 'ch-210-66', 'lg-270-82', 'sh-290-80', MALLI_HIUS].join('.');
    T.append(el('div', { class: 'rivi', style: 'border:0;padding:0 0 6px' },
      el('b', {}, nimi(tyyppi) + ' #' + s.id), ' · sukupuoli ' + s.gender + ' · club ' + s.club + (s.sellable ? ' · myytävä' : ''),
      el('button', { class: 'pun', onclick: () => poista(s) }, 'Poista tämä setti'),
      el('button', { onclick: () => { valittu = null; T.replaceChildren(); } }, 'Sulje')));
    T.append(el('div', { class: 'kuvat' },
      el('figure', {}, el('img', { src: kuva(ilman, true) }), el('figcaption', {}, 'ilman')),
      el('figure', {}, el('img', { src: kuva(asuSetilla(tyyppi, s, st), true) }), el('figcaption', {}, 'päällä (palvelimen nykyinen)')),
      el('div', { style: 'max-width:300px;color:#444' }, 'Ruksaa osat jotka tämä vaate PIILOTTAA. Esim. durag: hiukset (hr) ja hiukset takaa (hrb). Kuvat tulevat palvelimelta, joten uusi piilotus näkyy vasta vaatekaapissa kun tallennat ja päivität sivun.')));
    const osat = el('div', { class: 'osat' });
    osaTyypit().forEach(t => {
      const cb = el('input', { type: 'checkbox' }); cb.checked = piilossa.has(t);
      const lab = el('label', { class: cb.checked ? 'pois' : '' }, cb, nimi(t));
      cb.addEventListener('change', () => {
        cb.checked ? piilossa.add(t) : piilossa.delete(t);
        lab.className = cb.checked ? 'pois' : '';
        s.hiddenLayers = [...piilossa].map(p => ({ partType: p }));
        muutettu = true; tila('muutettu: #' + s.id + ' piilottaa ' + ([...piilossa].join(', ') || 'ei mitään') + ' — muista tallentaa');
      });
      osat.append(lab);
    });
    T.append(osat);
  };

  const poista = (s) => {
    const st = setType(tyyppi);
    if (!confirm('Poistetaanko ' + nimi(tyyppi) + ' #' + s.id + '? (vain tästä selaimesta, kunnes viet tiedostot palvelimelle)')) return;
    st.sets = st.sets.filter(x => x !== s);
    muutettu = true; document.getElementById('fd-tiedot').replaceChildren();
    piirraLista(); tila('poistettu #' + s.id + ' — muista tallentaa');
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
    const kaikki = FD.setTypes.flatMap(x => x.sets.map(s => s.id));
    const ehd = Math.max(...st.sets.map(s => s.id), 0) + 1;
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
    muutettu = true; tyyppi = paa;
    ikkuna.querySelector('select').value = paa;
    piirraLista(); avaa(st.sets[st.sets.length - 1]);
    tila('lisätty ' + paa + ' #' + id + ' kirjastosta ' + libId + ' (' + n.osat.length + ' osaa, id:t ' + (kaikki.includes(id) ? 'käytössä muualla, tarkista' : 'ok') + ') — tallenna ja päivitä sivu nähdäksesi sen vaatekaapissa');
  };

  const avaaIkkuna = async () => {
    if (ikkuna) { ikkuna.style.display = ''; return; }
    ikkuna = el('div', { id: 'fd-ikkuna' });
    ikkuna.append(el('header', {}, el('b', {}, 'Figuredata-editori'), el('button', { onclick: () => { ikkuna.style.display = 'none'; } }, '✕')));
    ikkuna.append(el('div', { id: 'fd-tila' }, 'ladataan figuredataa (7.5 MB)…'));
    document.body.append(ikkuna);
    // raahaus
    const h = ikkuna.querySelector('header'); let d = null;
    h.addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') return; const r = ikkuna.getBoundingClientRect(); d = [e.clientX - r.left, e.clientY - r.top]; });
    addEventListener('mousemove', e => { if (!d) return; ikkuna.style.transform = 'none'; ikkuna.style.left = (e.clientX - d[0]) + 'px'; ikkuna.style.top = (e.clientY - d[1]) + 'px'; });
    addEventListener('mouseup', () => { d = null; });
    try { await lataa(); } catch (e) { tila('lataus epäonnistui: ' + e.message); return; }
    const sel = el('select', { onchange: e => { tyyppi = e.target.value; piirraLista(); } },
      FD.setTypes.map(s => { const o = el('option', { value: s.type }, nimi(s.type) + ' · ' + s.sets.length); if (s.type === tyyppi) o.selected = true; return o; }));
    const hakuK = el('input', { placeholder: 'setin id', size: 9, oninput: e => { haku = e.target.value.trim(); piirraLista(); } });
    const tied = el('input', { type: 'file', accept: '.nitro', style: 'display:none', onchange: async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await lisaaNitro(f); } catch (er) { alert('Lisäys epäonnistui: ' + er.message); } } });
    const paalla = (await get('paalla')) !== false;
    const onMuokattu = !!(await get('fd'));
    ikkuna.insertBefore(el('div', { class: 'rivi' }, 'Kategoria', sel, hakuK,
      el('button', { onclick: () => tied.click() }, '+ Lisää .nitro'), tied,
      el('span', { style: 'flex:1' }),
      el('button', { class: 'vih', onclick: async () => { await tallenna(); if (confirm('Tallennettu. Päivitetäänkö sivu nyt, jotta vaatekaappi käyttää muutoksia?')) location.reload(); } }, 'Tallenna + päivitä')), ikkuna.querySelector('#fd-tila'));
    ikkuna.insertBefore(el('div', { class: 'rivi' },
      el('button', { onclick: () => { lataaTiedosto('FigureDataISO.json', JSON.stringify(FD)); lataaTiedosto('FigureMapISO.json', JSON.stringify(FM)); } }, '⬇ Lataa figuredata + figuremap'),
      el('button', { onclick: async () => { for (const l of (await get('lisatyt')) || []) { const b = await get('nitro:' + l); if (b) lataaTiedosto(l + '.nitro', b, 'application/octet-stream'); } } }, '⬇ Lisätyt .nitrot'),
      el('label', {}, (() => { const c = el('input', { type: 'checkbox' }); c.checked = paalla; c.addEventListener('change', async () => { await put('paalla', c.checked); tila(c.checked ? 'muokattu versio käytössä seuraavalla latauksella' : 'alkuperäinen versio käytössä seuraavalla latauksella'); }); return c; })(), ' muokkaukset käytössä'),
      el('button', { class: 'pun', onclick: async () => { if (!confirm('Palautetaanko alkuperäinen figuredata ja poistetaan kaikki omat muutokset ja lisätyt .nitrot tästä selaimesta?')) return; for (const k of await keys()) await del(k); location.reload(); } }, 'Palauta alkuperäinen'),
      el('span', {}, onMuokattu ? '· muokattu versio tallessa' : '· alkuperäinen')), ikkuna.querySelector('#fd-tila'));
    ikkuna.append(el('div', { id: 'fd-tiedot' }), el('div', { id: 'fd-lista' }));
    piirraLista();
    addEventListener('beforeunload', e => { if (muutettu) { e.preventDefault(); e.returnValue = ''; } });
  };

  // Nappi vaatekaapin (avatar editor) kortin kulmaan
  const lisaaNappi = () => {
    const kortti = document.querySelector('.nitro-avatar-editor');
    if (!kortti || kortti.querySelector('#fd-nappi')) return;
    if (getComputedStyle(kortti).position === 'static') kortti.style.position = 'relative';
    kortti.append(el('button', { id: 'fd-nappi', title: 'Figuredata-editori', onclick: e => { e.stopPropagation(); avaaIkkuna(); } }, 'FD'));
  };
  const kaynnista = () => {
    document.head.append(el('style', {}, css));
    new MutationObserver(lisaaNappi).observe(document.body, { childList: true, subtree: true });
    lisaaNappi();
    W.kuplaFdEditori = { avaa: avaaIkkuna, lueNitro };
  };
  if (document.body) kaynnista(); else document.addEventListener('DOMContentLoaded', kaynnista);
})();
