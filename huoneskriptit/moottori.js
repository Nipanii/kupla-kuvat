// ==UserScript==
// @name         Huone-efektit (miinarata ym.)
// @version      0.3.1
// @match        https://kupla.cc/*
// @grant        none
// ==/UserScript==
// Hakee kp:n Pagesista listan huoneista joissa on efektejä (huoneskriptit/efektit.json) aina kun huone vaihtuu.
// Laukaisu 'astu': kun hahmo astuu listatun furnin ruutuun, furnin oma animaatio (esim. fx_explosion) piirtyy hänen kohdalleen.
// Vain tässä clientissä: ei itemiä, ei pakettia. Kesto tulee listasta (kesto, ms).
// PROTOTYYPPIVAIHE: miina.kesto = 1200 konsolissa ohittaa listan keston testausta varten (poistetaan lopullisesta).
(() => {
  const LISTA = 'https://nipanii.github.io/kupla-kuvat/huoneskriptit/efektit.json';
  if (window.miina && window.miina.ajastin) clearInterval(window.miina.ajastin);
  const cfg = window.miina = { versio: '0.3.1', kesto: null, vali: 1500, piilotaPohja: true, loki: [], lista: null };
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
    } catch (err) { console.warn('[huone-efektit] listan haku epäonnistui', err); saannot = []; }
    haetaan = false;
  };

  cfg.ajastin = setInterval(() => {
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
      const hyppy = Math.hypot(P.x - ed.P[0], P.y - ed.P[1]) > 1.5;
      if (hyppy) { ehd.push(ed.T, [ed.T[0] + ed.d[0], ed.T[1] + ed.d[1]]); }
      else if (T[0] !== ed.T[0] || T[1] !== ed.T[1]) ehd.push(T);
      for (const [x, y] of ehd) {
        const k = x + ',' + y, s = saannot.find(s => s.ruudut && s.ruudut.has(k)); if (!s) continue;
        if (nyt - (viimeksi.get(u.id) || 0) < cfg.vali) break;
        viimeksi.set(u.id, nyt);
        const viive = hyppy ? 0 : Math.max(0, (g._updateInterval || 0) - ((g._time || 0) - (g._changeTime || 0)));
        cfg.loki.push({ u: u.id, x, y, tapa: hyppy ? 'hyppy' : 'askel' });
        setTimeout(() => cfg.rajayta(x, y, ed.z, s.furni, s.kesto), viive);
        break;
      }
    }
  }, 50);
})();
