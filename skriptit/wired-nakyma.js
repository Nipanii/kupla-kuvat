// Wired-näkymä — näyttää huoneen wiredit läpikuultavina vaikka huoneessa on :hidewireds.
// kp 2026-10-26 22:07 "tee script joka näyttää wiredit vaikka on tehny :hidewireds" · "auki olevassa radassa oli virheitä wiredissä"
//   · "lähetä sonalle script kortti kun valmis" · "ja mulle".
// MIKSI TILANNEKUVA: kun :hidewireds on päällä, palvelin ei lähetä wired-furneja clientille ollenkaan (Habbo-Daybreak
//   RoomManager.java:1027 `room.isHideWired() && object instanceof InteractionWired` -> ohitetaan; piilotus lähettää ObjectRemove).
//   Wired-valikon tarkastus (7012) vaatii valmiiksi tiedetyn id:n, joten pelkkä client ei voi löytää niitä.
// MITEN: kun wiredit NÄKYVÄT, niiden paikat tallennetaan tähän selaimeen (localStorage, huonekohtainen). Kun ne katoavat
//   (piilotus tai huoneeseen tulo piilotettuna), samat wiredit piirretään vain tähän clientiin läpikuultavina — ei itemiä, ei pakettia.
//   Jos omaa tallennusta ei ole, haetaan robon tallentama lista kp:n sivulta (huoneskriptit/wiredit/<huone>.json).
//   Tuplaklikkaus haamuun avaa OIKEAN wiredin asetukset (id vaihdetaan lähtevään pakettiin) — oikeudet tarkistaa palvelin.
// RAJAT: tilannekuva on niin tuore kuin viimeisin kerta kun wiredit näkyivät tässä selaimessa (tai robon lista).
//   Piilotuksen aikana tehdyt muutokset eivät näy. Area hiden piilottamat wiredit eivät tallennu.
// Konsoli: wiredNakyma.tila() · .paalle() · .pois() · .unohda()
(() => {
  const W = window;
  if (W.wiredNakyma && W.wiredNakyma.lopeta) W.wiredNakyma.lopeta();
  const VERSIO = '1.0.0', LISTA = 'https://nipanii.github.io/kupla-kuvat/huoneskriptit/wiredit/';
  const AVAIN = 'wiredNakyma', ALPHA = 0.55;
  const dv = (o, k) => { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : undefined; };
  const RE = () => W.NitroDevTools && W.NitroDevTools.roomEngine;
  const lue = (k, o) => { try { const v = localStorage.getItem(k); return v == null ? o : JSON.parse(v); } catch (e) { return o; } };
  const kirjoita = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let paalla = lue(AVAIN + '.paalla', true);
  let huone = null, huoneAlku = 0, edellinenMaara = -1, lahde = '', haettu = new Set();
  const haamut = new Map();   // haamun id (negatiivinen) -> oikea wired-id
  const ajastimet = [];

  const data = (st) => ({ flags: 0, uniqueNumber: 0, uniqueSeries: 0, rarityLevel: -1, state: 0,
    writeRoomObjectModel(m) { m.setValue('furniture_data_format', 0); m.setValue('furniture_data', st); },
    initializeFromRoomObjectModel() {}, parseWrapper() {}, getLegacyString() { return st; },
    compare() { return false; }, setString() {}, getValue() { return ''; } });

  const tallennus = (r) => lue(AVAIN + '.h' + r, null);

  function oikeatWiredit(e, r) {
    const out = [];
    for (const o of e.getRoomObjects(r, 10)) {
      if (!o || o.id <= 0 || !/^wf_/i.test(o.type || '')) continue;
      const L = o.getLocation(), D = o.getDirection();
      let st = 0; try { st = +(o.model.getValue('furniture_state')) || 0; } catch (e) {}
      out.push([o.id, o.type, L.x, L.y, L.z, Math.round(D.x), st]);
    }
    return out;
  }

  function poistaHaamut(e, r) {
    for (const id of haamut.keys()) try { e.removeRoomObjectFloor(r, id); } catch (x) {}
    haamut.clear();
  }

  function piirra(e, r, lista) {
    const V = (e.getRoomObjects(r, 100)[0] || e.getRoomObjects(r, 10)[0])?.getLocation().constructor; if (!V) return 0;
    let n = 0;
    for (const [id, type, x, y, z, dir, st] of lista) {
      const hid = -id; if (haamut.has(hid) || e.getRoomObject(r, hid, 10)) { haamut.set(hid, id); continue; }
      try {
        if (e.addFurnitureFloorByTypeName(r, hid, type, new V(x, y, z), new V(dir), st, data(String(st)), NaN, -1, 0, -1, '', true, false)) { haamut.set(hid, id); n++; }
      } catch (x) {}
    }
    return n;
  }

  function lapinakyvyys(e, r) {
    // Suoraan malliin: changeObjectModelData palautti true mutta arvo pysyi 1:nä (mitattu robolla 26.10.), setValue pysyy.
    for (const hid of haamut.keys()) try { const o = e.getRoomObject(r, hid, 10);
      if (o && o.model && o.model.getValue('furniture_alpha_multiplier') !== ALPHA) o.model.setValue('furniture_alpha_multiplier', ALPHA); } catch (x) {}
  }

  async function haeLista(r) {
    if (haettu.has(r)) return; haettu.add(r);
    try {
      const res = await fetch(LISTA + r + '.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (j && Array.isArray(j.w) && !tallennus(r)) kirjoita(AVAIN + '.h' + r, { t: j.t || 0, w: j.w, robo: true });
    } catch (x) {}
  }

  function tick() {
    const e = RE(); if (!e) return;
    const r = e.activeRoomId;
    if (r !== huone) { haamut.clear(); huone = r; huoneAlku = Date.now(); edellinenMaara = -1; lahde = ''; }
    if (!(r > 0)) return;
    const oikeat = oikeatWiredit(e, r);
    if (oikeat.length) {
      // Wiredit näkyvät: haamut pois ja tallennus. Tallennetaan vasta kun määrä on pysynyt samana kaksi kierrosta ja
      // huoneessa on oltu 3 s (huoneen esineet latautuvat erissä — kesken latauksen tallennus olisi vajaa).
      if (haamut.size) poistaHaamut(e, r);
      if (oikeat.length === edellinenMaara && Date.now() - huoneAlku > 3000) {
        const vanha = tallennus(r);
        if (!vanha || vanha.robo || JSON.stringify(vanha.w) !== JSON.stringify(oikeat)) kirjoita(AVAIN + '.h' + r, { t: Date.now(), w: oikeat });
      }
      edellinenMaara = oikeat.length; lahde = 'näkyvissä'; paivitaNappi(oikeat.length);
      return;
    }
    edellinenMaara = 0;
    // Huoneeseen tullessa esineet saapuvat erissä: ei haamuja ensimmäisiin 3 sekuntiin, ettei näkyviksi tulevat välähdä tuplana.
    if (Date.now() - huoneAlku < 3000) return;
    if (!paalla) { if (haamut.size) poistaHaamut(e, r); lahde = 'pois'; paivitaNappi(0); return; }
    const t = tallennus(r);
    if (!t) { haeLista(r); lahde = 'ei tallennusta'; paivitaNappi(0); return; }
    if (haamut.size < t.w.length) piirra(e, r, t.w);
    lapinakyvyys(e, r);
    lahde = (t.robo ? 'robon lista ' : 'oma tallennus ') + new Date(t.t).toLocaleString('fi-FI');
    paivitaNappi(haamut.size);
  }

  // Tuplaklikkaus haamuun: client lähettää paketin haamun negatiivisella id:llä -> vaihdetaan oikeaan wired-id:hen.
  // Muut paketit haamun id:llä (siirto, nosto, kierto) jätetään lähettämättä: palvelimella ei ole sellaista esinettä.
  function findConn() {
    const re = RE(); if (!re) return null;
    const seen = new Set();
    const find = (o, d) => { if (!o || typeof o !== 'object' || seen.has(o) || d > 5) return null; seen.add(o);
      if (Object.getOwnPropertyDescriptor(o, '_cryptoState')) return o;
      for (const k of Object.getOwnPropertyNames(o)) { const de = Object.getOwnPropertyDescriptor(o, k);
        if (de && !de.get && de.value && typeof de.value === 'object') { const f = find(de.value, d + 1); if (f) return f; } }
      return null; };
    return find(dv(re, '_roomSessionManager'), 0);
  }
  // Koukku asennetaan yhteyteen KERRAN ja se kutsuu aina uusinta instanssia (W.__wiredNakymaKaanna): lataaja ajaa skriptin
  // uudelleen joka päivityksellä, ja vanhan instanssin koukku katsoi tyhjää haamukarttaa (mitattu robolla 26.10.: id ei vaihtunut).
  W.__wiredNakymaKaanna = (m, id) => {
    const a = m && m._data;
    if (!Array.isArray(a) || typeof a[0] !== 'number' || !haamut.has(a[0])) return true;
    if (id !== 99) return false;                         // ei siirtoja/nostoja/kiertoja haamulle: palvelimella ei ole sitä
    a[0] = haamut.get(a[0]);                             // tuplaklikkaus avaa oikean wiredin
    return true;
  };
  function koukku() {
    const c = findConn(); if (!c || c.__wiredNakyma) return;
    const map = dv(dv(c, '_messages'), '_messageIdByComposer'); if (!map) return;
    const orig = c.send;
    c.send = function (m) {
      try { const k = W.__wiredNakymaKaanna; if (k && m && !k(m, map.get(m.constructor))) return; } catch (x) {}
      return orig.apply(this, arguments);
    };
    c.__wiredNakyma = true;
  }

  // Raahattava nappi (kp: UI-elementtien pitää olla raahattavia), sijainti muistetaan.
  const nappi = document.createElement('div');
  nappi.style.cssText = 'position:fixed;left:8px;bottom:132px;z-index:99999;min-width:34px;height:34px;padding:0 6px;box-sizing:border-box;border-radius:6px;border:2px solid #000;display:flex;align-items:center;justify-content:center;font:bold 12px sans-serif;color:#fff;cursor:grab;user-select:none;touch-action:none;box-shadow:0 2px 0 #0008';
  const xy = lue(AVAIN + '.xy', null); if (xy) { nappi.style.left = xy[0] + 'px'; nappi.style.top = xy[1] + 'px'; nappi.style.bottom = 'auto'; }
  let alku = null, liikkui = false;
  nappi.addEventListener('pointerdown', ev => { if (ev.button !== 0) return; const b = nappi.getBoundingClientRect();
    alku = { x: ev.clientX, y: ev.clientY, dx: ev.clientX - b.left, dy: ev.clientY - b.top }; liikkui = false; nappi.setPointerCapture(ev.pointerId); });
  nappi.addEventListener('pointermove', ev => { if (!alku) return;
    if (!liikkui && Math.hypot(ev.clientX - alku.x, ev.clientY - alku.y) < 4) return;
    liikkui = true; nappi.style.cursor = 'grabbing';
    nappi.style.left = Math.max(0, Math.min(innerWidth - nappi.offsetWidth, ev.clientX - alku.dx)) + 'px';
    nappi.style.top = Math.max(0, Math.min(innerHeight - nappi.offsetHeight, ev.clientY - alku.dy)) + 'px'; nappi.style.bottom = 'auto'; });
  nappi.addEventListener('pointerup', () => { if (!alku) return; alku = null; nappi.style.cursor = 'grab';
    if (liikkui) kirjoita(AVAIN + '.xy', [parseInt(nappi.style.left), parseInt(nappi.style.top)]); });
  nappi.addEventListener('click', () => { if (liikkui) { liikkui = false; return; } asetaPaalla(!paalla); });
  function paivitaNappi(n) {
    nappi.textContent = 'W' + (n ? ' ' + n : '');
    nappi.style.background = !paalla ? 'rgb(17,26,38)' : lahde === 'näkyvissä' ? '#2a5a2a' : n ? '#8a5a00' : 'rgb(17,26,38)';
    nappi.title = 'Wired-näkymä ' + (paalla ? 'PÄÄLLÄ' : 'POIS') + ' — ' + lahde + '. Klikkaa: päälle/pois. Tuplaklikkaa haamua: avaa wiredin asetukset.';
  }
  function asetaPaalla(v) { paalla = v; kirjoita(AVAIN + '.paalla', v); tick(); }
  document.body.appendChild(nappi);
  paivitaNappi(0);

  ajastimet.push(setInterval(tick, 1000), setInterval(() => { try { koukku(); } catch (x) {} }, 2000));
  tick(); koukku();

  W.wiredNakyma = {
    versio: VERSIO,
    tila: () => ({ versio: VERSIO, paalla, huone, lahde, haamuja: haamut.size, tallennettu: huone > 0 ? (tallennus(huone) || { w: [] }).w.length : 0 }),
    paalle: () => asetaPaalla(true),
    pois: () => asetaPaalla(false),
    unohda: () => { if (huone > 0) try { localStorage.removeItem(AVAIN + '.h' + huone); } catch (x) {} haettu.delete(huone); },
    lopeta: () => { ajastimet.forEach(clearInterval); W.__wiredNakymaKaanna = null; const e = RE(); if (e && huone > 0) poistaHaamut(e, huone); nappi.remove(); },
  };
  console.info('[wired-näkymä] ' + VERSIO + ' ladattu');
})();
