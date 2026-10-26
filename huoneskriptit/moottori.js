// ==UserScript==
// @name         Huone-efektit (miinarata ym.)
// @version      0.2.0
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
  const cfg = window.miina = { kesto: null, vali: 1500, piilotaPohja: true, loki: [], lista: null };
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
    setTimeout(() => { clearInterval(piilo); e.removeRoomObjectFloor(r, id); cfg.loki.push({ x, y, ms: Math.round(performance.now() - alku) }); }, ms);
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
      const L = u.getLocation(); if (!L) continue;
      const k = Math.round(L.x) + ',' + Math.round(L.y);
      if (edellinen.get(u.id) === k) continue;
      edellinen.set(u.id, k);
      const s = saannot.find(s => s.ruudut && s.ruudut.has(k)); if (!s) continue;
      if (nyt - (viimeksi.get(u.id) || 0) < cfg.vali) continue;
      viimeksi.set(u.id, nyt);
      cfg.rajayta(Math.round(L.x), Math.round(L.y), L.z, s.furni, s.kesto);
    }
  }, 100);
})();
