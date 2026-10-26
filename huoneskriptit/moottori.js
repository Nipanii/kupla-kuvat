// ==UserScript==
// @name         Huone-efektit (miinarata ym.)
// @version      0.4.5
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
  const cfg = window.miina = { versio: '0.4.5', kesto: null, vali: 1500, piilotaPohja: true, loki: [], lista: null };
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
    // 0.3.7: tila 1 (animaatio) katosi jos se tuli ennen kuin visualisointi oli valmis -> vain pohja näkyi (kp 2/5). Odotetaan spritejä.
    let yrit = 0; const kaynnista = setInterval(() => { const o = e.getRoomObject(r, id, 10); yrit++;
      if ((o && o.visualization && o.visualization.sprites && o.visualization.sprites.length) || yrit > 30) { clearInterval(kaynnista); e.updateRoomObjectFloor(r, id, L, D, 1, data('1')); } }, 30);
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

  // 0.4.0: kutsutaan updateRoomObjectUserLocation-koukusta (asennetaan kerran, delegoi tähän -> päivitys korvaa logiikan).
  cfg.__liike = (rid, oid, loc, tgt, kesto) => {
    if (rid !== huone || haetaan || !saannot.length) return;
    // 0.4.2: teleport-hyppy ilman räjähdystä 1,5 s sisällä = hukka -> lokiin (mista = edellinen sijainti/kohde), jotta hukka näkyy datana
    if (loc) { const ed = edellinen.get(oid); edellinen.set(oid, { x: loc.x, y: loc.y, t: tgt ? [Math.round(tgt.x), Math.round(tgt.y)] : null });
      if (ed && Math.hypot(loc.x - ed.x, loc.y - ed.y) > 1.5 && Date.now() - (viimeksi.get(oid) || 0) > 1500)
        cfg.loki.push({ u: oid, ohi: true, mista: [Math.round(ed.x), Math.round(ed.y)], kohde: ed.t, nyt: [Math.round(loc.x), Math.round(loc.y)] }); }
    for (const [P, tulossa] of [[tgt, true], [loc, false]]) {
      if (!P) continue; const x = Math.round(P.x), y = Math.round(P.y), k = x + ',' + y;
      const s = saannot.find(s => s.ruudut && s.ruudut.has(k)); if (!s) continue;
      // 0.4.5: teleportin natiiviviiveen aikana hahmo ehtii astua 2-3 miinaruutuun (kp loki 8,18 -> 8,17 -> 8,16) -> yksi räjähdys per hahmo per cfg.vali
      const nyt = Date.now(); if (nyt - (viimeksi.get(oid) || 0) < cfg.vali) return;
      viimeksi.set(oid + '@' + k, nyt); viimeksi.set(oid, nyt);
      const viive = tulossa && loc && (Math.round(loc.x) !== x || Math.round(loc.y) !== y) ? (kesto > 0 ? kesto : 500) : 0;
      cfg.loki.push({ u: oid, x, y, tapa: tulossa ? 'kohde' : 'sijainti', viive });
      setTimeout(() => cfg.rajayta(x, y, P.z, s.furni, s.kesto), viive);
      return;
    }
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
      // 0.4.3: furni voi olla monta ruutua (681:n nurmi 2x2) -> kaikki sen ruudut, ei vain kulmaa (kp 23:52 "joku ruutu ei laukee ikinä")
      for (const id of s.furnit || []) { const o = e.getRoomObject(r, id, 10), L = o?.getLocation(); if (!L) continue;
        const m = o.model, sx = Number(m?.getValue?.('furniture_size_x')) || 1, sy = Number(m?.getValue?.('furniture_size_y')) || 1;
        const k = Math.round(o.getDirection?.()?.x || 0) % 180 === 90, w = k ? sy : sx, h = k ? sx : sy;
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) set.add((Math.round(L.x) + dx) + ',' + (Math.round(L.y) + dy)); }
      if (set.size) s.ruudut = set;
    }
    // 0.4.0: tunnistus suoraan jokaisesta sijaintipäivityksestä (kp 23:47 "tyhmä tunnistus"): 50 ms kysely ei nähnyt miinaruutua,
    //   kun palvelin lähetti askeleen miinalle ja teleportin samassa nipussa (loki: hyppy 10,16 -> 11,23 ilman miinaa).
    if (!e.__miinaKoukku) { const orig = e.updateRoomObjectUserLocation; e.__miinaKoukku = true;
      e.updateRoomObjectUserLocation = function (rid, oid, loc, tgt) { try { const k = window.miina && window.miina.__liike; if (k) k(rid, oid, loc, tgt, arguments[10]); } catch (x) {} return orig.apply(this, arguments); }; }
  }, 50);
})();
// 0.3.4: itsepäivitys 60 s välein. Lataaja (#87) hakee vain kun huone-id vaihtuu, ja saman huoneen uudelleentulo ei vaihda sitä.
(() => {
  const cfg = window.miina, URL = 'https://nipanii.github.io/kupla-kuvat/huoneskriptit/moottori.js';
  // 0.4.4: vain UUDEMPAAN. Pages jää julkaisusta ~1 min jälkeen, ja "eri versio" vaihtoi 0.4.3 -> 0.4.2 takaisin (mitattu robolla).
  const uudempi = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  cfg._paivitys = setInterval(async () => {
    if (window.miina !== cfg) { clearInterval(cfg._paivitys); return; }
    try { const t = await (await fetch(URL + '?t=' + Date.now(), { cache: 'no-store' })).text(); const v = (t.match(/versio: '([^']*)'/) || [])[1];
      if (v && uudempi(v, cfg.versio)) { clearInterval(cfg._paivitys); const L = window.huoneEfektiLataaja; if (L) L.koodi = t; (0, eval)(t); console.info('[huone-efektit] päivitetty', v); } } catch (e) {}
  }, 15000); // 0.4.1: 60 s + Pagesin ~1 min julkaisuviive oli kp:lle liian hidas
})();
