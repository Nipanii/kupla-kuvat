// ==UserScript==
// @name         Kupla Huonekierto
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      1.9.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/huonekierto.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/huonekierto.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Kääntää OMAA kameraa huoneen ympäri 90° askelin: chat-komento :kierrä [vasen|oikea|180|pois]; napit :kierrä paneeli (oletus piilossa). Vain oma näkymä, palvelimelle ei lähde mitään.
// @kupla-oletus on
// @author       re-lab
// ==/UserScript==
//
// kp 2026-09-27 22:13: "robo tee userscript room rotatorist ja tee siihe vaik joku gui ? tai komennot".
//
// Pohja: nitro/ROTATE.md (:rotate-diagnoosi 18:07) + nitro/nako.expr --kulma (mitattu 18:22-20:06).
//   - Pelin :rotate (RoomRotatingEffect) jättää kameran vinoon: doMagic kutsuu changeRotation-VAIHTOKYTKINTÄ joka freimi
//     (RoomSpriteCanvas.ts:1130). Tämä EI käytä sitä: kamera asetetaan suoraan, ja alkuperäinen tallennetaan erikseen.
//   - Vain 90° askelin: spritet ovat valmiiksi piirrettyjä isometrisiä kuvia (suunnat 0/90/180/270), vapaa kulma ei voi
//     näyttää oikealta.
//   - doMagic (RoomSpriteCanvas.ts:1145) kirjoittaa JOKA render-kutsussa geometry.direction = _effectDirection -> asetetaan
//     molemmat (mitattu 18:25: pelkkä direction pyyhkiytyi).
//   - Kiertokeskipiste = katseakselin ja lattian (z=0) leikkaus, sauva = etäisyys kamerasta (sama kuin changeRotation :1179).
//   - Seinät ja maisema piiloon käännettynä: seinätasot piirtyvät vain oletuskulman takareunoille, joten käännettynä ne tulevat
//     ETEEN (mitattu 19:40). Vipu = visualisaation _typeVisibility[1 seinä, 3 maisema] + _visiblePlanes-välimuistin nollaus
//     (RoomVisualization.ts:733 laskee sprite.visible joka päivityksessä, pelkkä sprite.visible pyyhkiytyy — mitattu 19:47).
//   - Moniruutuiset kalusteet: sprite piirretään jalanjäljen TAKAKULMASTA katsojaan nähden; oletusnäkymässä se on (min x, min y)
//     = objektin sijainti. Käännettynä objekti siirretään PAIKALLISESTI siihen kulmaan joka on kauimpana (kp 18:26 "matot ei
//     pysyneet oikealla paikallaan"). Palvelimen päivitys kirjoittaa sijainnin yli -> tarkistus 400 ms välein korjaa sen.
// RAJAT (sanotaan paneelissa): 2-suuntaiset kalusteet (vain suunnat 2 ja 4) näyttävät 90°/270°-näkymässä väärältä
//   (ROTATE.md vika 3, rakenteellinen). Pelin oma huonekalun pinnan klikkaus (getActiveSurfaceLocation) laskee oletuskulman
//   kaavalla -> käännettynä kalusteen päälle klikkaus voi osua väärään ruutuun. Lattiaruudut klikataan tasolta.
(function () {
  'use strict';
  const VW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  if (VW.__kuplaHuonekierto) return;
  VW.__kuplaHuonekierto = true;

  const RE = () => VW.NitroDevTools && VW.NitroDevTools.roomEngine;
  const rad = a => a / 180 * Math.PI;
  const tila = { kulma: 0, cv: null, rid: null, alku: null, seinat: null, siirrot: new Map() };

  function canvas() {
    const r = RE(); if (!r) return null;
    const rid = r.activeRoomId; if (rid == null || rid < 0) return null;
    const cv = r.getRoomInstanceRenderingCanvas(rid, 1); if (!cv || !cv.geometry) return null;
    return { r, rid, cv, g: cv.geometry, V: cv.geometry.direction.constructor };
  }

  // Huone tai canvas vaihtui -> vanha tila ei koske uutta (objektit ja geometria ovat uudet). Kamera on silloin oletuksessa.
  function huoneVaihtui(c) {
    if (tila.cv === c.cv && tila.rid === c.rid) return false;
    tila.cv = c.cv; tila.rid = c.rid; tila.kulma = 0; tila.alku = null; tila.seinat = null; tila.siirrot.clear();
    return true;
  }

  // Tallennetaan VAIN oletusnäkymästä (kulma 0): alkuperäinen suunta, sijainti, _effectDirection ja kiertokeskipiste.
  function tallennaAlku(c) {
    const { g, V, cv } = c, d = g.direction, l = g.location, ax = g.directionAxis;
    if (!ax || !ax.z) return null;
    const t = -l.z / ax.z, o = { x: l.x + ax.x * t, y: l.y + ax.y * t, z: 0 };
    return {
      d0: new V(d.x, d.y, d.z), l0: new V(l.x, l.y, l.z), e0: cv._effectDirection,
      o, L: Math.hypot(l.x - o.x, l.y - o.y, l.z - o.z)
    };
  }

  function seinat(c, nakyvissa) {
    const ro = c.r.getRoomInstance(c.rid).getRoomObjectsForCategory(0)[0], v = ro && ro.visualization;
    if (!v || !Array.isArray(v._typeVisibility)) return;
    if (!nakyvissa) {
      if (!tila.seinat) tila.seinat = { v, alku: v._typeVisibility.slice() };
      v._typeVisibility[1] = false; v._typeVisibility[3] = false;
    } else if (tila.seinat && tila.seinat.v === v) {
      v._typeVisibility = tila.seinat.alku; tila.seinat = null;
    } else return;
    v._visiblePlanes = []; v._visiblePlaneSpriteNumbers = [];
  }

  // Seinäesineet piiloon käännettynä (kp 2026-09-28 00:22 "wallitemit vähä glitchaa jos koittaa kattoo takaa · pitäis
  // piilottaa jos mahdoton angle, koska törröttää vääräs kulmas"). Seinät ovat jo piilossa kaikissa käännetyissä kulmissa,
  // joten seinäesine (kategoria 20) jäisi leijumaan. Vipu = mallin furniture_alpha_multiplier (visualisaatio lukee sen
  // mallipäivityksessä; vain initialize asettaa 1). Palautetaan alkuperäinen arvo oletusnäkymässä.
  function seinaesineet(c, piiloon) {
    const muisti = tila.seinaesineet || (tila.seinaesineet = new Map());
    const elossa = new Set();
    for (const o of c.r.getRoomInstance(c.rid).getRoomObjectsForCategory(20)) {
      elossa.add(o.id); const m = o.model; if (!m) continue;
      if (piiloon) {
        if (!muisti.has(o.id)) muisti.set(o.id, m.getValue('furniture_alpha_multiplier'));
        if (m.getValue('furniture_alpha_multiplier') !== 0) m.setValue('furniture_alpha_multiplier', 0);
      } else if (muisti.has(o.id)) { const a = muisti.get(o.id); m.setValue('furniture_alpha_multiplier', a == null ? 1 : a); }
    }
    if (!piiloon) muisti.clear(); else for (const id of [...muisti.keys()]) if (!elossa.has(id)) muisti.delete(id);
  }

  // Moniruutuisten sijainti käännetyssä näkymässä (nako.expr:41-53). Palvelimen päivitys tunnistetaan siitä, ettei sijainti
  // ole enää se jonka ME asetimme -> se on uusi alkuperäinen.
  function siirrot(c) {
    const kulma = tila.kulma, dx = tila.alku ? tila.alku.d0.x + kulma : 0, lx = Math.cos(rad(dx)), ly = Math.sin(rad(dx));
    const sama = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z;
    const elossa = new Set();
    for (const u of c.r.getRoomInstance(c.rid).getRoomObjectsForCategory(10)) {
      elossa.add(u.id);
      const l = u.getLocation(), s = tila.siirrot.get(u.id);
      const alkup = s && sama(l, s.siirretty) ? s.alkup : { x: l.x, y: l.y, z: l.z };
      let kohde = alkup;
      if (kulma) {
        let sx = u.model.getValue('furniture_size_x') || 1, sy = u.model.getValue('furniture_size_y') || 1;
        const q = Math.trunc((Math.trunc(u.getDirection().x + 45) % 360) / 90); if (q === 1 || q === 3) [sx, sy] = [sy, sx];
        if (sx * sy > 1) {
          let best = null;
          for (const cx of [alkup.x, alkup.x + sx - 1]) for (const cy of [alkup.y, alkup.y + sy - 1]) {
            const p = cx * lx + cy * ly; if (!best || p > best.p + 1e-9) best = { x: cx, y: cy, p };
          }
          kohde = { x: best.x, y: best.y, z: alkup.z };
        }
      }
      if (sama(kohde, alkup)) {
        if (s) { if (sama(l, s.siirretty)) u.setLocation(new c.V(alkup.x, alkup.y, alkup.z)); tila.siirrot.delete(u.id); }
        continue;
      }
      if (!sama(l, kohde)) u.setLocation(new c.V(kohde.x, kohde.y, kohde.z));
      tila.siirrot.set(u.id, { alkup, siirretty: kohde });
    }
    for (const id of [...tila.siirrot.keys()]) if (!elossa.has(id)) tila.siirrot.delete(id);
  }

  // Näyttöpiste samalla muunnoksella kuin pelin getRoomObjectScreenLocation (RoomEngine.ts:2844).
  function naytto(c, x, y, z) {
    const p = c.g.getScreenPoint(new c.V(x, y, z)), s = c.cv._scale || 1;
    return [p.x * s + c.cv._width / 2 + c.cv._screenOffsetX, p.y * s + c.cv._height / 2 + c.cv._screenOffsetY];
  }
  // Lattiapiste (z=0) ruudun keskellä. Pelin oma kierto (changeRotation) kiertää kiinteän pisteen ympäri, jolloin huone voi
  // karata ruudun ulkopuolelle; tämä pitää keskellä olevan kohdan keskellä siirtämällä näytön offsetia kierron jälkeen.
  function keskipiste(c) {
    const o = naytto(c, 0, 0, 0), X = naytto(c, 1, 0, 0), Y = naytto(c, 0, 1, 0);
    const ex = [X[0] - o[0], X[1] - o[1]], ey = [Y[0] - o[0], Y[1] - o[1]], det = ex[0] * ey[1] - ex[1] * ey[0];
    if (!det) return null;
    const bx = c.cv._width / 2 - o[0], by = c.cv._height / 2 - o[1];
    return { x: (bx * ey[1] - by * ey[0]) / det, y: (ex[0] * by - ex[1] * bx) / det };
  }
  function pidaKeskella(c, k) {
    if (!k) return;
    const [X, Y] = naytto(c, k.x, k.y, 0);
    c.cv._screenOffsetX += Math.round(c.cv._width / 2 - X); c.cv._screenOffsetY += Math.round(c.cv._height / 2 - Y);
  }

  function aseta(kulma, pakota) {
    const c = canvas(); if (!c) return false;
    huoneVaihtui(c);
    kulma = ((kulma % 360) + 360) % 360;
    if (kulma === tila.kulma && kulma && !pakota) return true;
    if (kulma && !tila.alku) { tila.alku = tallennaAlku(c); if (!tila.alku) return false; }
    const { g, V, cv } = c, keski = keskipiste(c);
    if (!kulma) {
      if (tila.alku) {
        const a = tila.alku;
        g.direction = new V(a.d0.x, a.d0.y, a.d0.z); g.setDepthVector(new V(a.d0.x, a.d0.y, 5));
        g.location = new V(a.l0.x, a.l0.y, a.l0.z); cv._effectDirection = a.e0 || new V(a.d0.x, a.d0.y, a.d0.z);
      }
      tila.kulma = 0; siirrot(c); seinat(c, true); seinaesineet(c, false); tila.alku = null;
    } else {
      const a = tila.alku, dx = a.d0.x + kulma, dy = a.d0.y;
      g.direction = new V(dx, dy, a.d0.z); g.setDepthVector(new V(dx, dy, 5)); cv._effectDirection = new V(dx, dy, a.d0.z);
      g.location = new V(a.o.x + a.L * Math.cos(rad(dx + 180)) * Math.cos(rad(dy)),
                         a.o.y + a.L * Math.sin(rad(dx + 180)) * Math.cos(rad(dy)),
                         a.o.z + a.L * Math.sin(rad(dy)));
      tila.kulma = kulma; siirrot(c); seinat(c, false); seinaesineet(c, true);
    }
    pidaKeskella(c, keski);
    paivitaPaneeli();
    return true;
  }

  // --- 1.6.0 kääntöanimaatio (#614) ---
  // Res 2026-09-28 01:14 "kamera kierto tarvis animaation jossa kamera kääntyy vaiheittain. instant 180 on liian jarring" ·
  //   01:15 "ei häivitystä vaan rotate tyylinen käännös" · 01:16 "ei haittaa vaikka kamojen kääntyminen laahais".
  // Spritet ovat valmiita 90° kuvia, joten välikulmaa ei voi renderöidä. Feikki: lattia on 2:1-litistetty neliö, joten CSS
  //   scaleY(0.5) rotate(θ) scaleY(2) kiertää sitä kuin kamera kiertäisi pystyakselin ympäri. Pelin canvas-elementtiä
  //   kierretään ruudun keskipisteen ympäri (keskipiste() = se lattiapiste, jonka pidaKeskella pitää keskellä), ja lopussa
  //   vaihdetaan oikeaan kulmaan + transform pois. Suunta MITATTU robolla 01:17: ':kierrä oikea' (+90) kääntää litistämättömät
  //   lattia-akselit -90° (45°→-45°, 135°→45°) -> CSS-kulma = -Δ. Lähtö- ja loppu-transform samoilla funktioilla, jotta CSS
  //   interpoloi vain rotate()-kulmaa (none→lista interpoloisi myös scaleY:t ja vääntäisi).
  // 🔴 1.6.1 Res 01:23 "robo sun piti tehä niin että kamera kääntyy gradually samalla tavalla kun :rotate komennolla" ·
  //   "eikä mitään renderin css flippausta": CSS-feikki POIS. Nyt kamera kiertää OIKEASTI välikulmien kautta kuten pelin
  //   RoomRotatingEffect: joka ruudunpäivitys sama geometria kuin aseta():n else-haara (direction + depth + _effectDirection +
  //   location kiertokeskipisteen ympäri) välikulmalla, pidaKeskella samalla keskipisteellä. Seinät/seinäesineet piiloon
  //   alussa (välikulmassa ne ovat väärin joka tapauksessa), lopussa aseta(kulma) tekee lopullisen tilan (seinät takaisin
  //   jos 0°). Moniruutuisten siirrot tehdään vasta lopussa -> ne laahaavat hetken (Res 01:16 "ei haittaa").
  //   Piilotetussa välilehdessä requestAnimationFrame ei aja -> setTimeout-varapolku.
  let animoi = false;
  function kaanna(kulma) {
    const c = canvas();
    const uusi = ((kulma % 360) + 360) % 360;
    let d = uusi - tila.kulma; if (d > 180) d -= 360; if (d < -180) d += 360;
    if (animoi || !c || !d) return aseta(kulma);
    huoneVaihtui(c);
    if (!tila.alku) { tila.alku = tallennaAlku(c); if (!tila.alku) return aseta(kulma); }
    const { g, V, cv } = c, a = tila.alku, keski = keskipiste(c), k0 = tila.kulma;
    seinat(c, false); seinaesineet(c, true);
    const asetaVali = k => {
      const dx = a.d0.x + k, dy = a.d0.y;
      g.direction = new V(dx, dy, a.d0.z); g.setDepthVector(new V(dx, dy, 5)); cv._effectDirection = new V(dx, dy, a.d0.z);
      g.location = new V(a.o.x + a.L * Math.cos(rad(dx + 180)) * Math.cos(rad(dy)),
                         a.o.y + a.L * Math.sin(rad(dx + 180)) * Math.cos(rad(dy)),
                         a.o.z + a.L * Math.sin(rad(dy)));
      pidaKeskella(c, keski);
    };
    animoi = true;
    const ms = Math.round(Math.abs(d) / 90 * 450), t0 = performance.now();
    const seuraava = f => (document.hidden ? setTimeout(() => f(performance.now()), 16) : requestAnimationFrame(f));
    // Varmistus: jos ruudunpäivitys ei aja (taustaikkuna jossa document.hidden on silti false), lopetetaan ajastimella.
    let valmis = false;
    const lopeta = () => { if (valmis) return; valmis = true; try { aseta(kulma, true); } catch (y) {} animoi = false; };
    const askel = nyt => {
      if (valmis) return;
      const t = Math.min(1, (nyt - t0) / ms), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      try { if (t < 1 && canvas() && canvas().cv === cv) { asetaVali(k0 + d * e); return seuraava(askel); } } catch (x) {}
      lopeta();
    };
    setTimeout(lopeta, ms + 600);
    seuraava(askel);
    return true;
  }

  // --- paneeli ---
  let paneeli = null, kulmaTeksti = null;
  function paivitaPaneeli() { if (kulmaTeksti) kulmaTeksti.textContent = tila.kulma + '°'; }
  function nappi(teksti, otsikko, fn) {
    // 1.1.0 kp 23:15 "siisti" + "mis huonekierto gui" (tumma laatikko hukkui oikeaan palkkiin): pelin oman valikon luokat
    // (DarkUI ContextMenu.scss: .menu-item.list-item = tumma rivi, hover #ee5a49; .menu-header = oranssi #f27f46)
    const b = document.createElement('div');
    b.className = 'menu-item list-item d-flex justify-content-center align-items-center';
    b.textContent = teksti; b.title = otsikko;
    b.style.cssText = 'min-width:30px;margin:2px 2px 0;font-size:16px';
    b.onmousedown = e => e.stopPropagation();
    b.onclick = e => { e.stopPropagation(); fn(); };
    return b;
  }
  function teePaneeli() {
    if (paneeli || !document.body) return;
    paneeli = document.createElement('div');
    paneeli.id = 'kupla-huonekierto';
    paneeli.className = 'nitro-context-menu';
    // 1.1.1 kp 23:26 "rotator GUI blockaa ui elementtei ja en voi siirtää": oletus oikean sivupalkin (leveys ~240 px)
    // VASEMMALLE puolelle, ja raahattu paikka muistetaan (localStorage, vain tämä selain).
    paneeli.style.cssText = 'position:fixed;right:250px;bottom:140px;z-index:2147483646;user-select:none;display:none;flex-direction:column;color:#fff';
    try {
      const p = JSON.parse(localStorage.getItem('kupla.huonekierto.paikka') || 'null');
      if (p && p.x >= 0 && p.y >= 0 && p.x < innerWidth - 40 && p.y < innerHeight - 20) Object.assign(paneeli.style, { left: p.x + 'px', top: p.y + 'px', right: 'auto', bottom: 'auto' });
    } catch (e) {}
    paneeli.title = 'Huonekierto (vain oma näkymä). Käännettynä seinät piilossa. Chat: :kierrä [vasen|oikea|180|pois]';
    // valikon alareunan nuoli (:after) kuuluu hahmovalikolle, ei irralliselle paneelille
    const css = document.createElement('style'); css.textContent = '#kupla-huonekierto:after{display:none!important}';
    document.head.appendChild(css);
    const kahva = document.createElement('div'); kahva.textContent = '📷 Kierto';
    kahva.className = 'menu-header d-flex justify-content-center align-items-center'; kahva.style.cssText = 'cursor:move;margin-bottom:2px';
    kulmaTeksti = document.createElement('span'); kulmaTeksti.style.cssText = 'display:inline-block;min-width:36px;text-align:center;font-size:14px';
    const rivi = document.createElement('div'); rivi.style.cssText = 'display:flex;align-items:center';
    rivi.append(nappi('⟲', 'käännä vasemmalle 90°', () => kaanna(tila.kulma + 90)), kulmaTeksti,
      nappi('⟳', 'käännä oikealle 90°', () => kaanna(tila.kulma - 90)), nappi('↺', 'takaisin oletukseen', () => kaanna(0)));
    paneeli.append(kahva, rivi);
    // raahaus kahvasta
    kahva.onmousedown = e => {
      e.preventDefault(); e.stopPropagation();
      const r0 = paneeli.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      const liiku = ev => { paneeli.style.left = (r0.left + ev.clientX - x0) + 'px'; paneeli.style.top = (r0.top + ev.clientY - y0) + 'px'; paneeli.style.right = 'auto'; paneeli.style.bottom = 'auto'; };
      const irti = () => {
        document.removeEventListener('mousemove', liiku, true); document.removeEventListener('mouseup', irti, true);
        const r = paneeli.getBoundingClientRect();
        try { localStorage.setItem('kupla.huonekierto.paikka', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (e) {}
      };
      document.addEventListener('mousemove', liiku, true); document.addEventListener('mouseup', irti, true);
    };
    document.body.appendChild(paneeli);
    paivitaPaneeli();
  }

  // --- chat-komento: :kierrä [vasen|oikea|180|pois|<aste>] ---
  // Siepataan Enter chat-kentässä ENNEN Reactia (capture), jotta komento ei lähde huoneeseen. Kentän tyhjennys Reactin
  // omalla setterillä + input-tapahtumalla, muuten Reactin tila pitäisi tekstin.
  // Komennot-lisäosa (kp 23:37 "rotate kans ohjautuis siihe"): jos se on ladattu, :kierrä kulkee sen kautta ja näkyy
  //   :komennot-listassa. Konsoliversiossa (ei loaderia) alla oleva oma kuuntelija hoitaa sen kuten ennen.
  // PANEELI (kp 2026-09-28 00:32 "toi kamera extension on häiritsevä · en voi ees siirtää · se ois kiva jos toimis vaikka
  //   komennolla"): paneeli oletuksena PIILOSSA, kääntö komennolla. ':kierrä paneeli' näyttää/piilottaa, muistetaan.
  let paneeliNakyy = false; try { paneeliNakyy = localStorage.getItem('kupla.huonekierto.paneeli') === '1'; } catch (e) {}
  const vaihdaPaneeli = () => { paneeliNakyy = !paneeliNakyy; try { localStorage.setItem('kupla.huonekierto.paneeli', paneeliNakyy ? '1' : '0'); } catch (e) {}
    if (paneeli) paneeli.style.display = paneeliNakyy && canvas() ? 'flex' : 'none'; return 'kierron paneeli ' + (paneeliNakyy ? 'näkyviin' : 'piiloon'); };
  const kierraKomento = a => {
    a = (a || '').toLowerCase();
    if (a === 'paneeli' || a === 'panel') return vaihdaPaneeli();
    const uusi = a === 'pois' || a === '0' || a === 'reset' ? 0 : a === 'vasen' ? tila.kulma + 90 : a === '180' ? tila.kulma + 180
      : /^-?\d+$/.test(a) ? Math.round(Number(a) / 90) * 90 : tila.kulma - 90;
    // 1.8.0 (kp 2026-09-30 03:26 "kamera kääntyy päinvastasee suuntaa mitä nuolet näyttää"): +90 kiertää huonetta ruudulla
    //   VASTApäivään (mitattu 01:17, ks. yllä), joten ⟳/oikea = -90 ja ⟲/vasen = +90. Nuolet ja sanat ennallaan.
    kaanna(uusi);
    return 'kierto ' + (((uusi % 360) + 360) % 360) + '°';
  };
  (VW.kuplaKomennotJono = VW.kuplaKomennotJono || []).push([['kierrä', 'kierra', 'kierto', 'rotate90'],
    (teksti, sanat) => kierraKomento(sanat[0]), 'kääntää omaa näkymää 90°: vasen | oikea | 180 | pois | paneeli (näytä/piilota napit)', 'Huonekierto']);
  // 1.5.0 oikea klikkaus omaan hahmoon (klikkikävelyn 1.9.0 valikko; kp 00:48 #597 "omaa hahmoo lisää right click se rotaatio juttu")
  (VW.kuplaValikkoJono = VW.kuplaValikkoJono || []).push({ kohde: 'oma', nimi: 'Kierrä kameraa', lisaosa: 'Huonekierto', ala: () => [
    { nimi: '↺ Vasemmalle', tee: () => kierraKomento('vasen') }, { nimi: '↻ Oikealle', tee: () => kierraKomento('oikea') },
    { nimi: '180°', tee: () => kierraKomento('180') }, { nimi: 'Oletusnäkymä', tee: () => kierraKomento('pois') },
    { nimi: 'Napit näkyviin / piiloon', tee: () => kierraKomento('paneeli') }] });
  // 1.9.0 (kp 2026-10-01 22:25 "menu tulee jo" / "res lisäs sen tänne" / "tee uus mikä vaa lisää halutun"): pelissä on nyt
  //   oma right click -valikko (.surface-walk-menu, Res PR #55). Ilman klikkikävelyä tämä lisää siihen YHDEN rivin
  //   "Kierrä kameraa ›" Peruuta-rivin eteen. Klikkikävelyn kanssa ei tehdä mitään (se lisää rivin jo omaan hahmoon).
  //   Pelin luokat (menu-item list-item / menu-header p-1), sulkeminen = Escape kuten klikkikävely 1.22.0:ssa.
  document.addEventListener('contextmenu', e => {
    try {
      if (VW.kuplaValikko) return;   // klikkikävely hoitaa
      const t = e.target; if (!t || t.tagName !== 'CANVAS' || !t.onmousedown) return;   // vain huoneen canvas
      let yrit = 0;
      const kiinnita = () => {
        const m = document.querySelector('.surface-walk-menu');
        if (!m) { if (++yrit < 20) setTimeout(kiinnita, 15); return; }
        if (m.querySelector('.hk-rivit')) return;
        const oma = document.createElement('div'); oma.className = 'hk-rivit';
        const sulje = () => { oma.remove(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); };
        const rivi = (teksti, luokat) => { const d = document.createElement('div'); d.className = luokat + ' d-flex justify-content-center align-items-center';
          d.textContent = teksti; d.onmousedown = ev => { ev.stopPropagation(); ev.preventDefault(); }; oma.appendChild(d); return d; };
        const paa = () => { oma.textContent = ''; rivi('Kierrä kameraa ›', 'menu-item list-item').onclick = ev => { ev.stopPropagation(); ala(); }; };
        const ala = () => {
          oma.textContent = ''; rivi('Kierrä kameraa', 'menu-header p-1');
          for (const [n, a] of [['↺ Vasemmalle', 'vasen'], ['↻ Oikealle', 'oikea'], ['180°', '180'], ['Oletusnäkymä', 'pois']])
            rivi(n, 'menu-item list-item').onclick = ev => { ev.stopPropagation(); kierraKomento(a); sulje(); };
          rivi('‹ Takaisin', 'menu-item list-item').onclick = ev => { ev.stopPropagation(); paa(); };
        };
        paa();
        const peru = m.lastElementChild; m.insertBefore(oma, peru || null);
      };
      setTimeout(kiinnita, 0);
    } catch (err) { VW.__huonekiertoVirhe = String(err && err.stack || err); }
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (VW.kuplaKomennot) return;   // komennot-lisäosa hoitaa
    const t = e.target; if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
    // 🔴 EI \b: JS:n \w on ASCII, joten "kierrä\b" ei täsmää koskaan (ä ei ole sanamerkki) — mitattu 22:25 robolla, kolme
    //   komentoa lähti huoneeseen chattina. (?=\s|$) toimii ääkkösten kanssa.
    const m = /^\s*:(kierr[äa]|kierto|rotate90)(?=\s|$)\s*(\S*)\s*$/i.exec(t.value || ''); if (!m) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    kierraKomento(m[2]);
    try {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), 'value').set;
      setter.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) { t.value = ''; }
  }, true);

  // --- ylläpito: paneeli näkyviin huoneessa, huoneenvaihto, moniruutuisten korjaus palvelimen päivityksen jälkeen ---
  setInterval(() => {
    try {
      teePaneeli();
      const c = canvas();
      if (paneeli) paneeli.style.display = c && paneeliNakyy ? 'flex' : 'none';
      if (!c) return;
      if (huoneVaihtui(c)) { paivitaPaneeli(); return; }
      // 1.8.1 (kp 2026-09-30 03:28 "välähtää oudosti huone kääntäes"): tämä tarkistus ajoi KESKEN animaation, näki kameran
      //   eri kulmassa kuin tila.kulma (vanha) ja palautti sen -> kamera ja seinät hyppäsivät takaisin ja eteen (mitattu robolla:
      //   ruudun kirkkaus 18,9 -> 16,6 -> 18,9 -> 15,2 animaation lopussa). Animaation aikana ei kosketa.
      if (tila.kulma && !animoi) {
        // doMagic ei pyyhi, mutta varmistetaan että joku muu (esim. :rotate) ei jättänyt kameraa muualle
        const dx = tila.alku.d0.x + tila.kulma;
        if (Math.abs(c.g.direction.x - dx) > 0.01) aseta(tila.kulma, true); else { siirrot(c); seinaesineet(c, true); }
      }
    } catch (err) { VW.__huonekiertoVirhe = String(err && err.stack || err); }
  }, 400);

  // 1.7.0 (kp 2026-09-28 03:34 "ja mis mun rotator gui"): Robo-ohjain 4.0:n Liiku-välilehden "oma kamera" -rivi kutsuu komento():a,
  //   koska tämän oma paneeli on oletuksena piilossa (kp 00:32) eikä sitä löytänyt.
  VW.__huonekierto = { aseta, tila, kaanna, komento: kierraKomento };
})();
