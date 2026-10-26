// ==UserScript==
// @name         Huone-efektit (miinarata ym.)
// @version      0.3.6
// @match        https://kupla.cc/*
// @grant        none
// ==/UserScript==
// Hakee kp:n Pagesista listan huoneista joissa on efektejä (huoneskriptit/efektit.json) aina kun huone vaihtuu.
// Laukaisu 'astu': kun hahmo astuu listatun furnin ruutuun, furnin oma animaatio (esim. fx_explosion) piirtyy hänen kohdalleen.
// Vain tässä clientissä: ei itemiä, ei pakettia. Kesto tulee listasta (kesto, ms).
// PROTOTYYPPIVAIHE: miina.kesto = 1200 konsolissa ohittaa listan keston testausta varten (poistetaan lopullisesta).
(() => {
  const LISTA = 'https://nipanii.github.io/kupla-kuvat/huoneskriptit/efektit.json';
  // 0.3.2: oikea ajastin on _ajastin, koska vanha 0.2.x pysäyttää window.miina.ajastin -kentän ajastimen latautuessaan.
  if (window.miina) { clearInterval(window.miina.ajastin); clearInterval(window.miina._ajastin); clearInterval(window.miina._paivitys); }
  const cfg = window.miina = { versio: '0.3.6', kesto: null, vali: 1500, piilotaPohja: true, loki: [], lista: null };
  let seuraavaId = -930001;
  const edellinen = new Map(), viimeksi = new Map();
  let huone = null, saannot = [], haetaan = false;

  const data = (st) => ({ flags: 0, uniqueNumber: 0, uniqueSeries: 0, rarityLevel: -1, state: 0,
    writeRoomObjectModel(m) { m.setValue('furniture_data_format', 0); m.setValue('furniture_data', st); },
    initializeFromRoomObjectModel() {}, parseWrapper() {}, getLegacyString() { return st; },
    compare() { return false; }, setString() {}, getValue() { return ''; } });

  cfg.rajayta = (x, y, z, furni = 'fx_explosion', kesto = 1500) => {
    const e = window.NitroDevTools && window.NitroDevTools.roomEngine; if (!e) return false;
    const r = e.activeRoomId, V = e.getRoomObjects(r, 100)[0]?.getLocation().constructor; if (!V) return false;
    const id = seuraavaId--, L = new V(x, y, z), D = new V(0), ms = cfg.kesto || kesto;
    if (!e.addFurnitureFloorByTypeName(r, id, furni, L, D, 0, data('0'), NaN, -1, 0, -1, '', true, false)) return false;
    const alku = performance.now();
    const piilo = cfg.piilotaPohja ? setInterval(() => { const o = e.getRoomObject(r, id, 10); if (!o) return; for (const s of o.visualization.sprites) if (/_a_\d+_\d+$/.test(s.name)) s.visible = false; }, 16) : null;
    setTimeout(() => e.updateRoomObjectFloor(r, id, L, D, 1, data('1')), 50);
    setTimeout(() => { clearInterval(piilo); e.removeRoomObjectFloor(r, id); cfg.loki.push({ piirretty: true, x, y, ms: Math.round(performance.now() - alku) }); }, ms);
    return true;
  };

  // Haetaan lista tuoreena joka huoneeseen tullessa, jotta uudet huoneet tulevat mukaan ilman skriptin päivitystä.
  const lataa = async (r) => {
    haetaan = true;
    try {
      const j = await (await fetch(LISTA + '?t=' + Date.now(), { cache: 'no-store' })).json();
      cfg.lista = j;
      saannot = ((j.huoneet || {})[String(r)] || {}).efektit || [];
      saannot.forEach(s => { s.ruudut = null; });
      // 0.3.5: ensimmäinen räjähdys jäi näkymättä, koska efektin grafiikka latautuu vasta ensikäytössä -> esilataus kartan ulkopuolelle.
      for (const f of new Set(saannot.map(s => s.furni || 'fx_explosion'))) setTimeout(() => cfg.rajayta(-60, -60, 0, f, 3000), 500);
    } catch (err) { console.warn('[huone-efektit] listan haku epäonnistui', err); saannot = []; }
    haetaan = false;
  };

  cfg._ajastin = setInterval(() => {
    // 0.3.2: vanha prototyyppi (0.2.x, ei versiota) käynnistyy lataajan jälkeen ja pysäyttää tämän -> otetaan valta takaisin.
    if (window.miina !== cfg) { const v = window.miina; if (!v) { clearInterval(cfg._ajastin); return; } // kumoa poisti -> pysähdy
      if (!v.versio) { if (v.ajastin) clearInterval(v.ajastin); window.miina = cfg; } }
    const e = window.NitroDevTools && window.NitroDevTools.roomEngine; if (!e) return;
    const r = e.activeRoomId;
    if (r !== huone) { huone = r; saannot = []; edellinen.clear(); if (r > 0) lataa(r); return; }
    if (haetaan || !saannot.length) return;
    for (const s of saannot) {
      if (s.ruudut || s.laukaisu !== 'astu') continue;
      const set = new Set();
      for (const id of s.furnit || []) { const L = e.getRoomObject(r, id, 10)?.getLocation(); if (L) set.add(Math.round(L.x) + ',' + Math.round(L.y)); }
      if (set.size) s.ruudut = set;
    }
    const nyt = Date.now();
    for (const u of e.getRoomObjects(r, 100)) {
      const g = u.logic, P = u.getLocation(); if (!g || !P) continue;
      const d = g._locationDelta, liikkuu = d && d.length > 0;
      const T = liikkuu ? [Math.round(g._location.x + d.x), Math.round(g._location.y + d.y)] : [Math.round(P.x), Math.round(P.y)];
      const ed = edellinen.get(u.id);
      edellinen.set(u.id, { T, d: liikkuu ? [Math.sign(d.x), Math.sign(d.y)] : (ed ? ed.d : [0, 0]), P: [P.x, P.y], z: P.z });
      if (!ed) continue;
      // Ehdokasruudut: askeleen kohde (kävely miinalle ilman teleporttia) ja, jos hahmo HYPPÄSI (teleport-wired),
      // viimeinen kohde + yksi askel samaan suuntaan — palvelin on askeleen edellä, joten miinaruutuun ei koskaan tule siirtoa.
      const ehd = [];
      const hyppy = Math.hypot(P.x - ed.P[0], P.y - ed.P[1]) > 0.75; // 0.3.3: kävely liikkuu ~0.1 ruutua/50 ms, joten lyhytkin teleport (alle 1,5) on hyppy
      if (hyppy) { ehd.push(ed.T, [ed.T[0] + ed.d[0], ed.T[1] + ed.d[1]]);
        // 0.3.6: reitti saattoi kääntyä viimeisellä askeleella -> myös ed.T:n naapurimiinat (vain jos tasan yksi, ettei arvata)
        const naap = []; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { if (!dx && !dy) continue; const q = [ed.T[0] + dx, ed.T[1] + dy]; if (saannot.some(s => s.ruudut && s.ruudut.has(q[0] + ',' + q[1]))) naap.push(q); }
        if (naap.length === 1) ehd.push(naap[0]); }
      else if (T[0] !== ed.T[0] || T[1] !== ed.T[1]) ehd.push(T);
      for (const [x, y] of ehd) {
        const k = x + ',' + y, s = saannot.find(s => s.ruudut && s.ruudut.has(k)); if (!s) continue;
        if (nyt - (viimeksi.get(u.id + '@' + k) || 0) < cfg.vali) break; // 0.3.3: tauko per ruutu, toinen miina räjähtää heti
        viimeksi.set(u.id + '@' + k, nyt);
        const viive = hyppy ? 0 : Math.max(0, (g._updateInterval || 0) - ((g._time || 0) - (g._changeTime || 0)));
        cfg.loki.push({ u: u.id, x, y, tapa: hyppy ? 'hyppy' : 'askel' });
        setTimeout(() => cfg.rajayta(x, y, ed.z, s.furni, s.kesto), viive);
        break;
      }
      if (hyppy && !ehd.some(([x, y]) => saannot.some(s => s.ruudut && s.ruudut.has(x + ',' + y)))) cfg.loki.push({ u: u.id, ohi: ehd, mista: ed.T, P: [Math.round(P.x), Math.round(P.y)] }); // 0.3.6: hyppy ilman miinaa = mahdollinen hukka
    }
  }, 50);
})();
// 0.3.4: itsepäivitys 60 s välein. Lataaja (#87) hakee vain kun huone-id vaihtuu, ja saman huoneen uudelleentulo ei vaihda sitä.
(() => {
  const cfg = window.miina, URL = 'https://nipanii.github.io/kupla-kuvat/huoneskriptit/moottori.js';
  cfg._paivitys = setInterval(async () => {
    if (window.miina !== cfg) { clearInterval(cfg._paivitys); return; }
    try { const t = await (await fetch(URL + '?t=' + Date.now(), { cache: 'no-store' })).text(); const v = (t.match(/versio: '([^']*)'/) || [])[1];
      if (v && v !== cfg.versio) { clearInterval(cfg._paivitys); const L = window.huoneEfektiLataaja; if (L) L.koodi = t; (0, eval)(t); console.info('[huone-efektit] päivitetty', v); } } catch (e) {}
  }, 60000);
})();
