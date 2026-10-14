// ==UserScript==
// @name         kupla: PR-valitsin (avoimet pull requestit omalla clientilla)
// @namespace    kupla
// @version      0.5.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/pr-valitsin.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/pr-valitsin.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Listaa repon 0-es/kupla-cc avoimet PR:t ja lataa valitun PR:n clientin kupla.cc:n oikeaa palvelinta vasten. Bannerissa näkyy "PR #N käytössä" ja nappi takaisin liveen.
// @match        https://kupla.cc/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      github.com
// @connect      raw.githubusercontent.com
// @connect      127.0.0.1
// ==/UserScript==
//
// Res 2026-10-14: "nappi jolla valitaan avoin PR ja client ladataan sillä PR:n buildilla oikeaa palvelinta vasten".
//
// LÄHDE (0.3.0, kp 14.10. "local yksinkertaisempi ... aloittaisin sillä"): ensin OMA KONE, eli kupla-cc:n
// client/DarkUI/scripts/pr-preview-serve.mjs osoitteessa http://127.0.0.1:9270/ (rakentaa pyydettäessä, vastaa 202 + vaihe
// kunnes valmis; yhdistelmät ?pr=318+322 ja paneelin ruksit). Jos /health ei vastaa 600 ms sisällä, käytetään repon
// pr-builds-haaraa alla kuvatulla tavalla (Actions-workflow tai nitro/pr-buildit.js kirjoittaa sen).
//
// MITEN: repo on yksityinen, joten buildit ovat haarassa pr-builds (nitro/pr-buildit.js kirjoittaa ne). Skripti hakee
//   https://github.com/0-es/kupla-cc/raw/pr-builds/<polku>
// GM_xmlhttpRequestilla. GitHub vastaa kirjautuneelle 302:lla raw.githubusercontent.com-osoitteeseen, jonka mukana on
// kertakayttoinen token (siksi @connect molemmille). Avoimien PR:ien lista on pr-builds/index.json, EI GitHub API:a.
// Valittu PR tallennetaan localStorageen (avain kuplaPrPreview.active) ja sivu ladataan uudelleen. Document-startissa
//   1. document.open() heti synkronisesti: se keskeyttaa livesivun jasentimen ja tyhjentaa dokumentin ENNEN kuin livebundlen
//      moduuli-script ehtii ajaa (moduulit ajetaan vasta jasennyksen jalkeen). EI window.stop() ennen sita: mitattu
//      (nitro/pr-valitsin-testi.js, headless Edge) etta window.stop() + document.open/write jattaa dokumentin TYHJAKSI (ei documentElementtia),
//   2. document.write/close kirjoittaa PR:n OMAN index.html:n (merkkaus-muutokset huomioidaan),
//   3. app.css tulee inline-<style>:ksi ja app.js inline-<script type=module>:ksi (kupla.cc ei laheta CSP:ta).
// Pakotettu poistuminen jos jumittuu: lisaa osoitteeseen ?pr=live (tai ?pr=off). ?pr=123 valitsee PR:n suoraan.
//
// LIMIT:
//  - Toimii vain jos GM_xmlhttpRequest lahettaa github.com-evasteet ja seuraa uudelleenohjauksen. Sita EI ole mitattu
//    taalla (ei selainta) - UNCLEAR kunnes testattu livena. Ilman sita nakyy suomenkielinen virheilmoitus ja live jatkuu.
//  - PR-build lukee renderer-config.json / ui-config.json / public/src/assets/* LIVE-palvelimelta (suhteelliset polut),
//    eli PR:n muutokset niihin eivat nay. Isot kuvat viittaavat live-palvelimen /src/assets/-polkuun (hash = sisalto).
//  - Nappi on kelluva, ei messengerissa: messenger on React-ikkuna joka on olemassa vain kun se on auki.
(() => {
  'use strict';
  if (window.__kuplaPrValitsin) return;
  window.__kuplaPrValitsin = true;

  const REPO_RAW = 'https://github.com/0-es/kupla-cc/raw/pr-builds/';
  // Oma kone ensin: client/DarkUI/scripts/pr-preview-serve.mjs rakentaa pyydetyn PR:n (tai yhdistelmän) tällä koneella.
  // Jos se ei vastaa, käytetään repon valmiita buildeja.
  const LOCAL = 'http://127.0.0.1:9270/';
  const KOMENTO = 'yarn pr-preview';   // client/DarkUI/package.json: node scripts/pr-preview-serve.mjs
  const KEY_ACTIVE = 'kuplaPrPreview.active';      // PR:n numero merkkijonona
  const KEY_ERROR = 'kuplaPrPreview.error';        // sessionStorage: viimeisin latausvirhe, nakyy yhden kerran
  const KEY_TRIES = 'kuplaPrPreview.tries';        // sessionStorage: silmukkasuoja
  const ROOT_ID = 'pr-valitsin-root';
  const KEY_PAIKKA = 'kuplaPrPreview.paikka';               // napin paikka {x, y} raahauksen jälkeen
  const KEY_NAPPI_PIILOSSA = 'kuplaPrPreview.nappiPiilossa'; // '1' = nappi piilossa, Alt+Shift+P tuo takaisin
  const KEY_BANNERI_PIILOSSA = 'kuplaPrPreview.banneriPiilossa';

  // ---- pieni apuri: localStorage voi heittaa (yksityinen ikkuna, estetyt evasteet) ----
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
  const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} };
  const ssDel = (k) => { try { sessionStorage.removeItem(k); } catch (e) {} };

  // "318 322" / "322+318" / "318,322" -> "318+322" (URLSearchParams muuttaa +:n välilyönniksi). Kansio pr-318-322.
  const normalisoi = (v) => [...new Set(String(v).split(/[ +,]+/).filter(Boolean).map(Number))].sort((a, b) => a - b).join('+');
  const kansio = (v) => 'pr-' + String(v).replace(/\+/g, '-');

  // ---- ?pr=123 / ?pr=318+322 / ?pr=live / ?pr=off ----
  const params = new URLSearchParams(location.search);
  if (params.has('pr')) {
    const v = params.get('pr');
    if (v === 'live' || v === 'off' || v === '') lsDel(KEY_ACTIVE);
    else if (/^\d+([ +,]+\d+)*$/.test(v.trim())) lsSet(KEY_ACTIVE, normalisoi(v));
    params.delete('pr');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }

  const active = lsGet(KEY_ACTIVE);
  const nimiA = active ? 'PR #' + active.replace(/\+/g, ' + #') : '';   // '318+322' -> 'PR #318 + #322'

  // ---- GM_xmlhttpRequest lupauksena ----
  // Lähde selvitetään kerran: oma kone jos /health vastaa 600 ms sisällä, muuten repo.
  let lahdeLupaus = null;
  const lahde = () => lahdeLupaus || (lahdeLupaus = new Promise((resolve) => {
    try {
      GM_xmlhttpRequest({
        method: 'GET', url: LOCAL + 'health', timeout: 600, anonymous: true,
        onload: (r) => resolve(r.status === 200 && /"ok":true/.test(r.responseText || '') ? 'oma' : 'repo'),
        onerror: () => resolve('repo'), ontimeout: () => resolve('repo'),
      });
    } catch (e) { resolve('repo'); }
  }));
  let lahdeNyt = null;   // 'oma' | 'repo' kun tiedetään (paneelin otsikkoa varten)

  const hae = (path, accept, tila) => lahde().then((l) => new Promise((resolve, reject) => {
    lahdeNyt = l;
    GM_xmlhttpRequest({
      method: 'GET',
      url: (l === 'oma' ? LOCAL : REPO_RAW) + path,
      anonymous: false,                 // evasteet mukaan: yksityinen repo
      timeout: 60000,
      headers: { 'Cache-Control': 'no-cache', Accept: accept || '*/*' },
      onload: (r) => {
        if (r.status === 202 && tila) { tila.rakennetaan = JSON.parse(r.responseText || '{}'); resolve(null); return; }
        if (l === 'oma' && r.status >= 400) {
          let virhe = ''; try { virhe = JSON.parse(r.responseText).error; } catch (e) {}
          reject(new Error('oma kone: ' + (virhe || 'HTTP ' + r.status))); return;
        }
        if (r.status >= 200 && r.status < 300) {
          // Kirjautumaton selain saa GitHubilta 404:n tai kirjautumissivun HTML:na.
          if (/^\s*<!doctype html/i.test(r.responseText || '') && !/\.html$/.test(path)) reject(new Error('GitHub antoi kirjautumissivun (et ole kirjautunut tai ei pääsyä)'));
          else resolve(r.responseText);
        } else if (r.status === 404) reject(new Error('404: tiedostoa ei löydy (et ole kirjautunut GitHubiin tai ei oikeutta repoon?) ' + path));
        else reject(new Error('HTTP ' + r.status + ' ' + path));
      },
      onerror: () => reject(new Error('verkkovirhe tai GM_xmlhttpRequest esti pyynnön: ' + path)),
      ontimeout: () => reject(new Error('aikakatkaisu: ' + path)),
    });
  }));

  const haeIndeksi = async () => {
    const data = JSON.parse(await hae('index.json', 'application/json'));
    return Array.isArray(data) ? data : (data.prs || []);
  };

  const aika = (iso) => {
    if (!iso || isNaN(new Date(iso))) return '';
    try { return new Date(iso).toLocaleString('fi-FI', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return iso || ''; }
  };

  // ---- uudelleenlataus ilman kertakayttoista sso-tunnusta (sama siivous kuin clientin uiUpdate) ----
  const lataaUudelleen = () => {
    const u = new URL(location.href);
    u.searchParams.delete('sso'); u.searchParams.delete('darkui-version'); u.searchParams.delete('darkui-refresh');
    if (u.toString() !== location.href) history.replaceState(null, '', u.toString());
    location.reload();
  };
  const valitse = (numero) => { if (numero == null) lsDel(KEY_ACTIVE); else lsSet(KEY_ACTIVE, String(numero)); ssDel(KEY_TRIES); lataaUudelleen(); };

  // ---- UI (shadow DOM, ei vuoda pelin CSS:aa; rootti <html>:n alla, React ei koske) ----
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, Segoe UI, Arial, sans-serif; }
    .nappi { position: fixed; left: 8px; bottom: 8px; z-index: 2147483647; min-width: 30px; height: 22px; padding: 0 7px; border: 1px solid #555; border-radius: 6px; background: #1c1c1cdd; color: #eee; font-size: 11px; cursor: grab; touch-action: none; user-select: none; opacity: .45; transition: opacity .15s; }
    .nappi:hover, .nappi.aktiivinen, .nappi.auki { opacity: 1; }
    .nappi.vetaa { cursor: grabbing; }
    .pieni { padding: 0 6px; border: 0; border-radius: 10px; background: transparent; color: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
    .tarkistus { padding: 1px 8px; border-radius: 10px; background: #0003; font-weight: 500; }
    .komento { display: flex; gap: 6px; align-items: center; margin: 4px 6px; }
    .komento code { flex: 1; padding: 4px 8px; border-radius: 5px; background: #000; color: #f0c040; font: 12px ui-monospace, Consolas, monospace; }
    .komento button { padding: 3px 10px; border: 1px solid #555; border-radius: 5px; background: #333; color: #eee; cursor: pointer; font-size: 11px; }
    .alaosa { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; padding-top: 6px; border-top: 1px solid #333; color: #999; font-size: 11px; }
    .alaosa button { padding: 2px 8px; border: 1px solid #444; border-radius: 5px; background: #262626; color: #ddd; font-size: 11px; cursor: pointer; }
    .nappi.aktiivinen { background: #b8860b; color: #111; border-color: #b8860b; font-weight: 700; }
    .paneeli { position: fixed; left: 8px; bottom: 40px; z-index: 2147483647; width: min(460px, calc(100vw - 16px)); max-height: 60vh; overflow: auto; background: #1b1b1bf2; color: #eee; border: 1px solid #555; border-radius: 8px; padding: 8px; font-size: 12px; }
    .paneeli h3 { margin: 0 0 6px; font-size: 13px; }
    .rivi { display: flex; gap: 6px; align-items: baseline; width: 100%; padding: 5px 6px; margin: 2px 0; border: 1px solid #333; border-radius: 5px; background: #262626; color: #eee; text-align: left; cursor: pointer; font-size: 12px; }
    .rivi:hover { background: #333; }
    .rivikehys { display: flex; gap: 6px; align-items: center; }
    .rivikehys input { flex: none; width: 16px; height: 16px; margin: 0; cursor: pointer; }
    .rivikehys .rivi { width: auto; flex: 1 1 auto; min-width: 0; }
    .rivi.yhdessa { justify-content: center; border-color: #b8860b; color: #f0c040; font-weight: 600; }
    .rivi.kaytossa { border-color: #b8860b; }
    .rivi.virhe { opacity: .6; cursor: not-allowed; }
    .num { font-weight: 700; min-width: 42px; }
    .otsikko { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { color: #aaa; white-space: nowrap; font-size: 11px; }
    .ok { color: #6c6; } .vika { color: #e66; }
    .viesti { padding: 6px; color: #ddd; }
    .varoitus { padding: 1px 8px; border-radius: 10px; background: #7a1f1f; color: #fff; font-weight: 500; }
    .banneri { position: fixed; top: 6px; left: 50%; transform: translateX(-50%); z-index: 2147483647; display: flex; gap: 10px; align-items: center; max-width: calc(100vw - 16px); padding: 4px 6px 4px 12px; background: #b8860b; color: #111; border-radius: 16px; font-size: 12px; font-weight: 600; box-shadow: 0 1px 6px #0008; }
    .banneri span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .banneri button { border: 0; border-radius: 12px; background: #111; color: #eee; padding: 3px 10px; font-size: 12px; cursor: pointer; white-space: nowrap; }
    .virhebanneri { position: fixed; top: 6px; left: 50%; transform: translateX(-50%); z-index: 2147483647; max-width: calc(100vw - 16px); padding: 6px 12px; background: #8b2b2b; color: #fff; border-radius: 8px; font-size: 12px; }
    .virhebanneri button { margin-left: 8px; border: 0; border-radius: 10px; padding: 2px 8px; cursor: pointer; }
  `;

  let metaAktiivinen = null;   // aktiivisen PR:n meta, kun tiedetaan
  // Mitä build sisältää PR:n lisäksi (workflow pr-preview.yml kirjoittaa meta.jsoniin): "Depends on #N" -riippuvuudet
  // yhdistetään mukaan, ja PR yhdistetään kohdehaaransa nykytilaan. Vanha paikallinen builder ei kirjoita näitä kenttiä.
  const mukana = (m) => (m && Array.isArray(m.dependsOn) && m.dependsOn.length ? ' + ' + m.dependsOn.map(n => '#' + n).join(' + ') : '');
  // Oman koneen palvelin ajaa buildin jälkeen tyyppitarkistuksen ja testit (meta.checks); ne eivät estä esikatselua.
  const tarkistukset = (m) => {
    const c = m && m.checks;
    if (!c) return null;
    if (!c.done) return { teksti: 'tarkistukset käynnissä', vika: false, tiedot: '' };
    const t = c.typecheck || {}, testit = c.tests || [], ok = testit.filter(x => x.ok).length;
    const osat = [t.ok ? 'tyypit ok' : 'tyypit: ' + (t.errors || '?') + ' virhettä'];
    if (testit.length) osat.push('testit ' + ok + '/' + testit.length);
    const tiedot = [t.ok ? '' : t.tail, ...testit.filter(x => !x.ok).map(x => x.name + ':\n' + x.tail)].filter(Boolean).join('\n\n');
    return { teksti: osat.join(', '), vika: !t.ok || ok < testit.length, tiedot };
  };
  const varoitukset = (m) => {
    const v = [];
    if (m && m.mergedWithBase === false) v.push('ristiriita ' + (m.base || 'mainin') + ':n kanssa, sen uusimmat muutokset puuttuvat');
    if (m && Array.isArray(m.missingDependencies) && m.missingDependencies.length) v.push('riippuvuutta ' + m.missingDependencies.map(n => '#' + n).join(', ') + ' ei löytynyt');
    return v.join('; ');
  };

  const mountUi = () => {
    if (!document.documentElement) return;
    let host = document.getElementById(ROOT_ID);
    if (host) return;
    host = document.createElement('div');
    host.id = ROOT_ID;
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const kehys = document.createElement('div');
    root.append(style, kehys);
    document.documentElement.appendChild(host);

    const render = () => {
      kehys.textContent = '';
      const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

      const virhe = ssGet(KEY_ERROR);
      if (virhe) {
        const b = el('div', 'virhebanneri', virhe);
        const x = el('button', '', 'Sulje'); x.onclick = () => { ssDel(KEY_ERROR); render(); };
        b.append(x); kehys.append(b);
      }

      if (active) {
        const b = el('div', 'banneri');
        const m = metaAktiivinen || {};
        const teksti = nimiA + mukana(m) + ' käytössä' + (m.title ? ': ' + m.title : '') + (m.sha ? ' (' + String(m.sha).slice(0, 7) + ')' : '');
        const t = el('span', '', teksti);
        b.append(t);
        const varoitus = varoitukset(m);
        if (varoitus) { const v = el('span', 'varoitus', varoitus); b.append(v); }
        const tk = tarkistukset(m);
        if (tk) { const v = el('span', tk.vika ? 'varoitus' : 'tarkistus', tk.teksti); if (tk.tiedot) v.title = tk.tiedot; b.append(v); }
        const x = el('button', '', 'Takaisin liveen'); x.onclick = () => valitse(null);
        const piilota = el('button', 'pieni', '×');
        piilota.title = 'Piilota banneri (PR-tila näkyy edelleen napissa)';
        piilota.onclick = () => { lsSet(KEY_BANNERI_PIILOSSA, '1'); render(); };
        b.append(x, piilota);
        if (lsGet(KEY_BANNERI_PIILOSSA) !== '1') kehys.append(b);
      }
      if (lsGet(KEY_NAPPI_PIILOSSA) === '1') return;   // piilossa: Alt+Shift+P tuo takaisin

      const nappi = el('button', 'nappi' + (active ? ' aktiivinen' : ''), active ? nimiA : 'PR');
      nappi.title = (active ? nimiA + ' käytössä' + (varoitukset(metaAktiivinen) ? '\n' + varoitukset(metaAktiivinen) : '') + '\n' : '') + 'Klikkaa: valitse PR. Raahaa: siirrä nappia.';
      let paneeli = null;

      // Raahaus: yli 5 px liike siirtää nappia eikä avaa paneelia; paikka muistetaan ja pidetään ikkunan sisällä.
      const asetaPaikka = (x, y) => {
        const w = nappi.offsetWidth || 40, h = nappi.offsetHeight || 22;
        x = Math.min(Math.max(0, x), window.innerWidth - w); y = Math.min(Math.max(0, y), window.innerHeight - h);
        Object.assign(nappi.style, { left: x + 'px', top: y + 'px', bottom: 'auto' });
      };
      const sijoitaPaneeli = () => {
        if (!paneeli) return;
        const r = nappi.getBoundingClientRect(), pw = paneeli.offsetWidth || 460;
        const left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
        if (r.top > window.innerHeight / 2) Object.assign(paneeli.style, { left: left + 'px', top: 'auto', bottom: (window.innerHeight - r.top + 6) + 'px' });
        else Object.assign(paneeli.style, { left: left + 'px', bottom: 'auto', top: (r.bottom + 6) + 'px' });
      };
      let paikka = null;
      try { paikka = JSON.parse(lsGet(KEY_PAIKKA) || 'null'); } catch (e) {}
      if (paikka) requestAnimationFrame(() => asetaPaikka(paikka.x, paikka.y));
      let veto = null, vedetty = false;
      nappi.addEventListener('pointerdown', (e) => { veto = { sx: e.clientX, sy: e.clientY, r: nappi.getBoundingClientRect() }; vedetty = false; try { nappi.setPointerCapture(e.pointerId); } catch (er) {} });
      nappi.addEventListener('pointermove', (e) => {
        if (!veto) return;
        const dx = e.clientX - veto.sx, dy = e.clientY - veto.sy;
        if (!vedetty && Math.hypot(dx, dy) < 5) return;
        vedetty = true; nappi.classList.add('vetaa');
        asetaPaikka(veto.r.left + dx, veto.r.top + dy); sijoitaPaneeli();
      });
      nappi.addEventListener('pointerup', () => {
        if (veto && vedetty) { const r = nappi.getBoundingClientRect(); lsSet(KEY_PAIKKA, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); }
        veto = null; nappi.classList.remove('vetaa');
      });

      nappi.onclick = async () => {
        if (vedetty) { vedetty = false; return; }
        if (paneeli) { paneeli.remove(); paneeli = null; nappi.classList.remove('auki'); return; }
        nappi.classList.add('auki');
        paneeli = el('div', 'paneeli');
        const otsikko = el('h3', '', 'Avoimet PR:t (0-es/kupla-cc)');
        paneeli.append(otsikko);
        const live = el('button', 'rivi' + (active ? '' : ' kaytossa'));
        live.append(el('span', 'num', 'Live'), el('span', 'otsikko', 'Oikea kupla.cc-client'));
        live.onclick = () => valitse(null);
        paneeli.append(live);
        const tila = el('div', 'viesti', 'Haetaan listaa...');
        paneeli.append(tila);
        // Alaosa: napin piilotus ja piilotetun bannerin palautus.
        const alaosa = el('div', 'alaosa');
        const piiloon = el('button', '', 'Piilota nappi');
        piiloon.title = 'Alt+Shift+P tuo napin takaisin';
        piiloon.onclick = () => { lsSet(KEY_NAPPI_PIILOSSA, '1'); render(); };
        alaosa.append(piiloon);
        if (active && lsGet(KEY_BANNERI_PIILOSSA) === '1') { const nb = el('button', '', 'Näytä banneri'); nb.onclick = () => { lsDel(KEY_BANNERI_PIILOSSA); render(); }; alaosa.append(nb); }
        alaosa.append(el('span', '', 'Raahaa nappia siirtääksesi. Alt+Shift+P piilottaa ja tuo takaisin.'));
        kehys.append(paneeli);
        sijoitaPaneeli();
        try {
          const lista = (await haeIndeksi()).slice().sort((a, b) => b.number - a.number);
          const oma = lahdeNyt === 'oma';
          otsikko.textContent = 'Avoimet PR:t (' + (oma ? 'rakennetaan omalla koneella' : 'valmiit buildit reposta') + ')';
          tila.remove();
          // Yhdistelmä (vain omalla koneella, koska se rakennetaan pyydettäessä): ruksi useampi PR ja avaa ne yhdessä.
          const valitut = new Set();
          const yhdessa = el('button', 'rivi yhdessa', '');
          yhdessa.style.display = 'none';
          const paivitaYhdessa = () => {
            const n = [...valitut].sort((a, b) => a - b);
            yhdessa.style.display = n.length >= 2 ? '' : 'none';
            yhdessa.textContent = 'Avaa yhdessä: #' + n.join(' + #');
          };
          yhdessa.onclick = () => valitse(normalisoi([...valitut].join('+')));
          if (oma && lista.length >= 2) paneeli.append(el('div', 'viesti', 'Ruksi useampi PR avataksesi ne yhdessä.'));
          if (!lista.length) paneeli.append(el('div', 'viesti', 'Ei avoimia PR:iä, tai builder ei ole vielä ajanut.'));
          for (const pr of lista) {
            const ok = pr.buildOk !== false;
            const r = el('button', 'rivi' + (ok ? '' : ' virhe') + (String(pr.number) === active ? ' kaytossa' : ''));
            r.append(el('span', 'num', '#' + pr.number + mukana(pr)), el('span', 'otsikko', pr.title || ''), el('span', 'meta', (pr.author || '') + ' ' + aika(pr.builtAt || pr.updatedAt)), el('span', ok ? 'ok' : 'vika', ok ? (varoitukset(pr) ? 'ok, huom' : 'ok') : 'build epäonnistui'));
            r.title = ok ? ((pr.title || '') + (varoitukset(pr) ? '\n' + varoitukset(pr) : '')) : ('Build epäonnistui: ' + (pr.error || '').slice(-300));
            r.onclick = () => { if (ok) valitse(pr.number); };
            if (oma) {
              const k = el('div', 'rivikehys');
              const ruksi = document.createElement('input');
              ruksi.type = 'checkbox';
              ruksi.title = 'Valitse yhdistelmään';
              ruksi.onchange = () => { if (ruksi.checked) valitut.add(pr.number); else valitut.delete(pr.number); paivitaYhdessa(); };
              k.append(ruksi, r);
              paneeli.append(k);
            } else paneeli.append(r);
          }
          paneeli.append(yhdessa);
          paneeli.append(alaosa);
          sijoitaPaneeli();
        } catch (e) {
          if (lahdeNyt === 'repo') {
            // Oma kone ei vastannut eikä repossa ole buildeja: kerro suoraan mitä tehdä, älä näytä GitHub-virhettä.
            tila.textContent = 'Esikatselupalvelin ei ole käynnissä. Käynnistä se kupla-cc-repon kansiossa client/DarkUI:';
            const rivi = el('div', 'komento');
            const koodi = el('code', '', KOMENTO);
            const kopioi = el('button', '', 'Kopioi');
            kopioi.onclick = () => { try { navigator.clipboard.writeText(KOMENTO); kopioi.textContent = 'Kopioitu'; } catch (er) {} };
            rivi.append(koodi, kopioi);
            paneeli.append(rivi, el('div', 'viesti', 'Avaa sitten tämä paneeli uudelleen. Live-client toimii normaalisti.'));
            lahdeLupaus = null;   // seuraava avaus kokeilee omaa konetta uudestaan
          } else tila.textContent = 'Listan haku epäonnistui: ' + (e && e.message ? e.message : e) + '. Live-client toimii normaalisti.';
          paneeli.append(alaosa);
        }
      };
      kehys.append(nappi);
    };
    render();
    host.__render = render;
    // Alt+Shift+P: napin piilotus/palautus. Ikkunan koon muutos pitää napin näkyvissä.
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyP') { if (lsGet(KEY_NAPPI_PIILOSSA) === '1') lsDel(KEY_NAPPI_PIILOSSA); else lsSet(KEY_NAPPI_PIILOSSA, '1'); render(); e.preventDefault(); }
    }, true);
    window.addEventListener('resize', () => render());
  };

  const mountKun = () => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUi, { once: true });
    else mountUi();
  };

  // ---- välimuisti (IndexedDB, kupla.cc-origin): avain pr-N@sha, säilytetään VALIMUISTI_MAX uusinta ----
  // Uusi commit = uusi sha = uusi avain, joten vanhentunutta buildia ei voi tulla. Virhe (yksityinen ikkuna, täysi levy)
  // ei estä mitään: silloin haetaan aina verkosta.
  const VALIMUISTI_MAX = 4;
  const avaaKanta = () => new Promise((resolve) => {
    try {
      const req = indexedDB.open('kuplaPrPreview', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('buildit', { keyPath: 'avain' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  const valimuistiHae = async (avain) => {
    const kanta = await avaaKanta();
    if (!kanta) return null;
    return new Promise((resolve) => {
      try {
        const req = kanta.transaction('buildit').objectStore('buildit').get(avain);
        req.onsuccess = () => { kanta.close(); resolve(req.result || null); };
        req.onerror = () => { kanta.close(); resolve(null); };
      } catch (e) { kanta.close(); resolve(null); }
    });
  };
  const valimuistiTallenna = async (avain, data) => {
    const kanta = await avaaKanta();
    if (!kanta) return;
    await new Promise((resolve) => {
      try {
        const tx = kanta.transaction('buildit', 'readwrite');
        const store = tx.objectStore('buildit');
        store.put({ avain, aika: Date.now(), ...data });
        const kaikki = store.getAll();
        kaikki.onsuccess = () => {
          kaikki.result.filter(r => r.avain !== avain).sort((a, b) => b.aika - a.aika).slice(VALIMUISTI_MAX - 1).forEach(r => store.delete(r.avain));
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => resolve();
      } catch (e) { resolve(); }
    });
    kanta.close();
  };

  // ---- PR:n kaynnistys ----
  // Tulosta lataus/virhe-nayttö kun alkuperainen dokumentti on pysaytetty.
  const kirjoitaSivu = (html) => { document.open(); document.write(html); document.close(); };
  const tilaSivu = (teksti, alaotsikko) => kirjoitaSivu(
    '<!doctype html><html><head><meta charset="utf-8"><title>kupla.cc</title></head>' +
    '<body style="margin:0;background:#111;color:#ddd;font:14px system-ui,Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">' +
    '<div style="text-align:center;max-width:90vw"><div style="font-size:18px">' + teksti + '</div>' + (alaotsikko ? '<div style="margin-top:8px;color:#999;font-size:12px">' + alaotsikko + '</div>' : '') + '</div></body></html>');

  const peruuta = (syy) => {
    // Takaisin liveen: poista valinta, nayta syy ja lataa live. Silmukkaa ei synny koska avain poistetaan.
    lsDel(KEY_ACTIVE);
    ssSet(KEY_ERROR, nimiA + ' ei latautunut: ' + syy + ' Live-client käytössä.');
    tilaSivu(nimiA + ' ei latautunut', syy + ' Palataan liveen...');
    setTimeout(lataaUudelleen, 3500);
  };

  const kaynnistaPr = async () => {
    // Silmukkasuoja: jos sama sessio on yrittanyt jo montaa kertaa ilman etenemista, luovuta.
    const tries = (parseInt(ssGet(KEY_TRIES) || '0', 10) || 0) + 1;
    ssSet(KEY_TRIES, String(tries));
    if (tries > 4) { lsDel(KEY_ACTIVE); ssDel(KEY_TRIES); ssSet(KEY_ERROR, nimiA + ' kaatui toistuvasti, palattu liveen.'); location.reload(); return; }

    const nimi = nimiA;
    const polku = kansio(active);
    tilaSivu('Ladataan ' + nimi + '...', 'Etsitään buildia');

    let html, js, css, meta = null;
    try {
      // meta.json ensin (pieni): sen sha kertoo onko välimuistissa jo sama build, jolloin 13 Mt ei haeta uudelleen.
      // Oma kone vastaa 202 kun build on kesken (se aloittaa sen itse): odotetaan ja näytetään eteneminen.
      const VAIHE = { queued: 'jonossa', fetching: 'haetaan koodia', merging: 'yhdistetään', building: 'rakennetaan' };
      const alku = Date.now();
      for (;;) {
        const tila = {};
        let teksti = null;
        try { teksti = await hae(polku + '/meta.json', 'application/json', tila); }
        catch (e) { if (lahdeNyt === 'oma') throw e; }   // repon vanhoissa buildeissa meta voi puuttua
        if (tila.rakennetaan) {
          if (Date.now() - alku > 15 * 60000) throw new Error('build ei valmistunut 15 minuutissa');
          tilaSivu('Rakennetaan ' + nimi + ' omalla koneella...', (VAIHE[tila.rakennetaan.step] || tila.rakennetaan.step || '') + ', ' + (tila.rakennetaan.seconds || 0) + ' s (ensimmäinen avaus tälle versiolle, noin 1,5 min)');
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        if (teksti) meta = JSON.parse(teksti);
        break;
      }
      if (meta && meta.buildOk === false) { peruuta('build epäonnistui' + (meta.error ? ': ' + String(meta.error).split('\n').filter(Boolean).slice(-1)[0] : '') + '.'); return; }
      // Avain = build, ei pelkkä commit: workflow rakentaa saman commitin uudelleen kun main liikkuu (uusi builtAt).
      const versio = meta && (meta.key || [meta.sha, meta.builtAt].filter(Boolean).join('@'));
      const avain = versio ? polku + '@' + versio : null;
      const muistissa = avain ? await valimuistiHae(avain) : null;
      if (muistissa) ({ html, js, css } = muistissa);
      else {
        tilaSivu('Ladataan ' + nimi + '...', lahdeNyt === 'oma' ? 'Haetaan build omalta koneelta' : 'Haetaan build GitHubista (ensimmäinen kerta tälle versiolle)');
        [html, js, css] = await Promise.all([hae(polku + '/index.html'), hae(polku + '/app.js'), hae(polku + '/app.css')]);
        if (avain && js && js.length >= 1000) await valimuistiTallenna(avain, { html, js, css });
      }
    } catch (e) {
      peruuta(lahdeNyt === 'repo' && /404|kirjautu/.test(String(e && e.message))
        ? 'esikatselupalvelin ei ole käynnissä. Käynnistä se kupla-cc-repon kansiossa client/DarkUI komennolla ' + KOMENTO + ' ja avaa linkki uudelleen.'
        : (e && e.message ? e.message : String(e)) + '.');
      return;
    }
    if (!js || js.length < 1000) { peruuta('app.js on tyhjä tai liian pieni.'); return; }
    metaAktiivinen = meta;

    // Puolustava siivous: builder poistaa jo moduuli-scriptit ja buildin CSS-linkit, mutta jos jaljelle jai viittauksia
    // PR:n omiin hashattuihin tiedostoihin, ne hakisivat LIVE-bundlen. Poistetaan ne. Merkit <!--PR-APP-CSS--> / JS pysyvat.
    html = html
      .replace(/<script\b[^>]*type\s*=\s*["']module["'][^>]*>\s*<\/script>/gi, '')
      .replace(/<link\b[^>]*rel\s*=\s*["']modulepreload["'][^>]*>/gi, '')
      .replace(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["'][^"']*\/assets\/[^"']*["'][^>]*>/gi, '');
    if (!/<!--PR-APP-CSS-->/.test(html)) html = html.replace(/<\/head>/i, '<!--PR-APP-CSS--></head>');
    html = html.replace('<!--PR-APP-CSS-->', '<style id="pr-preview-css"></style>');

    kirjoitaSivu(html);   // document.open poistaa kaikki kuuntelijat, joten UI liitetaan vasta taman jalkeen
    if (!document.documentElement || !document.getElementById('root')) { peruuta('PR:n sivua ei saatu kirjoitettua (ei #root-elementtia).'); return; }

    const styleEl = document.getElementById('pr-preview-css');
    if (styleEl) styleEl.textContent = css;
    else { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); }

    const script = document.createElement('script');
    script.type = 'module';
    script.textContent = js;
    script.id = 'pr-preview-js';
    (document.body || document.documentElement).appendChild(script);

    ssDel(KEY_TRIES);
    mountKun();
    // Tarkistukset valmistuvat buildin jälkeen: haetaan meta 10 s välein kunnes valmis, banneri päivittyy.
    if (meta && meta.checks && !meta.checks.done) {
      const ajastin = setInterval(async () => {
        try {
          const uusi = JSON.parse(await hae(polku + '/meta.json', 'application/json', {}) || 'null');
          if (!uusi) return;
          metaAktiivinen = uusi;
          const h = document.getElementById(ROOT_ID);
          if (h && h.__render) h.__render();
          if (!uusi.checks || uusi.checks.done) clearInterval(ajastin);
        } catch (e) { clearInterval(ajastin); }
      }, 10000);
    }
    // UI paivittyy kun meta tiedetaan (banneriin otsikko ja sha).
    const host = document.getElementById(ROOT_ID);
    if (host && host.__render) host.__render();
  };

  if (active) kaynnistaPr();
  else mountKun();
})();
