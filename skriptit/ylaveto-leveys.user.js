// ==UserScript==
// @name         Kupla ylävetohistoria: kuplat ikkunan leveyden mukaan
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      0.2.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/ylaveto-leveys.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/ylaveto-leveys.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Ylävetohistorian kuplat pysyvät puhujiensa kohdalla, vaikka selainikkunan leveys muuttuu kuplan tallennuksen jälkeen.
// @kupla-oletus on
// @author       re-lab
// ==/UserScript==
//
// kp 2026-10-07 15:47: "fix the resize chat bubble bug. bubbles in ylävetohistoria is at fixed positional and not relative
// to window size. if works, we do pr".
//
// SYY (kupla-cc 9a087c1a):
//   useChatWidget.ts:412 tallentaa historiariville bubbleX = kuplan ruutu-x − GetRoomCanvasPanX(). Huone piirretään ikkunan
//   KESKELLE, joten ruutu-x sisältää W/2:n tallennushetken leveydestä. ChatHistoryPulldownView.tsx:268 piirtää
//   bubbleX + panX, mutta ei korjaa leveyttä -> leveyden muutoksen jälkeen jokainen vanha kupla on (W_nyt − W_tall)/2 sivussa.
//   Mitattu robon välilehdellä 7.10. 15:55 (Emulation.setDeviceMetricsOverride): robon ruutu-x 404 @1000 px, 604 @1400 px,
//   eli siirtymä = Δleveys/2. (Sama mittaus näytti, että koonmuutos nollaa myös kameran panoroinnin; panX hoitaa sen jo.)
//
// KORJAUS (selaimessa, koska layout-funktioon ei pääse): kirjataan ikkunan leveys aikaleimoineen (localStorage). Kun
//   ylävetohistorian kuplat ovat DOMissa, haetaan jokaisen rivin entry React-fiberistä ja siirretään entry.bubbleX:ää
//   (W_nyt − W_rivi)/2, jossa W_rivi = leveys, jota rivin nykyinen bubbleX vastaa. Sitten näkymä asetellaan uudelleen
//   lähettämällä resize-tapahtuma (sama polku jota näkymä itse kuuntelee, ChatHistoryPulldownView.tsx:546).
//   Siirto muuttaa entryä itseään, ja ChatHistoryCache tallentaa sen seuraavalla kerralla. Siksi siirretty arvo kirjataan
//   omaan muistiin {w, x}: jos uudelleenlatauksen jälkeen bubbleX === x, arvo on jo siirretty ja vastaa leveyttä w.
//
// TOINEN SYY (mitattu 7.10. 16:10, sama välilehti): RoomEngine.setRoomInstanceRenderingCanvasOffset (RoomEngine.ts:514)
//   lähettää ROOM_DRAG-tapahtuman ENNEN kuin kirjoittaa uuden offsetin. ChatHistoryPulldownView.tsx:240 lukee
//   GetRoomCanvasPanX():n tapahtuman käsittelijässä -> saa EDELLISEN arvon. Koonmuutoksessa moottori kirjoittaa offsetin
//   -200 -> 0 (+400 px), joten näkymän panX jäi -200:aan ja kuplat siirtyivät vielä Δleveys/2 väärään suuntaan.
//   Korjaus: kääritään moottorin setRoomInstanceRenderingCanvasOffset, ja kirjoituksen jälkeen lähetetään toinen
//   ROOM_DRAG nollasiirrolla (sama luokka, offset 0,0 -> livechatin siirto on no-op), jolloin näkymä lukee oikean arvon.
//
// RAJA: riveille, jotka tallennettiin ennen kuin tämä skripti ajoi ensimmäisen kerran, tallennusleveys on tuntematon.
//   Niille oletetaan skriptin ensimmäisen ajon leveys (lokin vanhin rivi).
// PR:ssä oikea korjaus olisi tallentaa leveys riville (tai bubbleX keskikohdasta) ja lisätä ero piirrossa.

(() => {
  'use strict';
  const NIMI = 'ylaveto-leveys';
  if (window.__kuplaYlavetoLeveys) window.__kuplaYlavetoLeveys.pois();

  const LOKI_AVAIN = 'kupla.ylavetoLeveys.loki';
  const MUISTI_AVAIN = 'kupla.ylavetoLeveys.siirretyt';
  const lue = (k, oletus) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? oletus; } catch { return oletus; } };
  const kirjoita = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* täynnä tai estetty */ } };

  // [[aika, leveys], ...] nousevassa aikajärjestyksessä
  const loki = lue(LOKI_AVAIN, []);
  const kirjaaLeveys = () => {
    const w = window.innerWidth; const viim = loki[loki.length - 1];
    if (viim && viim[1] === w) return;
    loki.push([Date.now(), w]); if (loki.length > 500) loki.splice(0, loki.length - 500);
    kirjoita(LOKI_AVAIN, loki);
  };
  kirjaaLeveys();
  const leveysHetkella = t => {
    let w = loki[0][1];
    for (const [aika, lev] of loki) { if (aika <= t) w = lev; else break; }
    return w;
  };

  // avain -> { w, x }: rivin bubbleX on x ja vastaa leveyttä w
  const muisti = lue(MUISTI_AVAIN, {});
  const avainOf = e => `${ e.cachedAt }|${ e.entityId }|${ e.name }`;
  const tallennaMuisti = () => {
    const avaimet = Object.keys(muisti);
    if (avaimet.length > 3000) avaimet.slice(0, avaimet.length - 3000).forEach(k => delete muisti[k]);
    kirjoita(MUISTI_AVAIN, muisti);
  };

  // DOM-solmun __reactFiber$ voi olla vanha vaihtoehtofiber (figure-stack 0.4.0) -> valitaan se, jonka props täsmää
  const fiberOf = el => {
    const keys = Object.keys(el); const fk = keys.find(k => k.startsWith('__reactFiber$')); const pk = keys.find(k => k.startsWith('__reactProps$'));
    const f = fk ? el[fk] : null; if (!f) return null;
    const props = pk ? el[pk] : undefined;
    if (f.alternate && f.memoizedProps !== props && f.alternate.memoizedProps === props) return f.alternate;
    return f;
  };
  const entryOf = el => {
    for (let f = fiberOf(el), d = 0; f && d < 8; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p && p.entry && typeof p.entry === 'object' && 'cachedAt' in p.entry) return p.entry;
    }
    return null;
  };

  // palauttaa siirrettyjen rivien määrän
  const korjaa = () => {
    const W = window.innerWidth; let n = 0;
    for (const el of document.querySelectorAll('.nitro-chat-pulldown .chat-pulldown-bubble')) {
      const e = entryOf(el);
      if (!e || !Number.isFinite(e.bubbleX) || !Number.isFinite(e.cachedAt)) continue;
      const k = avainOf(e); const m = muisti[k];
      const wNyt = (m && Math.abs(m.x - e.bubbleX) <= 1) ? m.w : leveysHetkella(e.cachedAt);
      if (wNyt === W) { if (!m) muisti[k] = { w: W, x: e.bubbleX }; continue; }
      e.bubbleX = Math.round(e.bubbleX + ((W - wNyt) / 2));
      muisti[k] = { w: W, x: e.bubbleX }; n++;
    }
    if (n) tallennaMuisti();
    return n;
  };

  // resize: entryt siirretään ennen kuin näkymän oma resize-kuuntelija ehtii asetella (capture, ikkunassa ennen Reactia)
  let synteettinen = false;
  const onResize = () => { kirjaaLeveys(); if (!synteettinen) korjaa(); };
  window.addEventListener('resize', onResize, true);

  // historia aukeaa tai saa uusia rivejä -> korjataan näkyvät ja asetellaan uudelleen, jos jotain siirtyi
  let ajastin = 0;
  const mo = new MutationObserver(() => {
    if (ajastin) return;
    ajastin = setTimeout(() => {
      ajastin = 0;
      if (korjaa()) { synteettinen = true; window.dispatchEvent(new Event('resize')); synteettinen = false; }
    }, 50);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // ROOM_DRAG ennen offsetin kirjoitusta -> uusi nollasiirto kirjoituksen jälkeen (ks. TOINEN SYY)
  let RE = null; let alkup = null; let odotus = 0;
  const kaari = () => {
    const re = window.NitroDevTools && window.NitroDevTools.roomEngine;
    if (!re || typeof re.setRoomInstanceRenderingCanvasOffset !== 'function' || !re.events) return false;
    if (re.setRoomInstanceRenderingCanvasOffset.__ylaveto) return true;
    RE = re; alkup = re.setRoomInstanceRenderingCanvasOffset;
    const kaarre = function (roomId, canvasId, point) {
      const ev = re.events; const lahetys = ev.dispatchEvent; let veto = null;
      ev.dispatchEvent = function (e) { if (e && e.type === 'RDE_ROOM_DRAG') veto = e; return lahetys.apply(this, arguments); };
      let tulos;
      try { tulos = alkup.apply(this, arguments); } finally { ev.dispatchEvent = lahetys; }
      if (veto && tulos) { try { ev.dispatchEvent(new veto.constructor(veto.roomId, 0, 0)); } catch { /* luokka muuttunut */ } }
      return tulos;
    };
    kaarre.__ylaveto = true;
    re.setRoomInstanceRenderingCanvasOffset = kaarre;
    return true;
  };
  if (!kaari()) odotus = setInterval(() => { if (kaari()) { clearInterval(odotus); odotus = 0; } }, 2000);

  window.__kuplaYlavetoLeveys = {
    versio: '0.2.0', korjaa, loki, muisti,
    pois: () => {
      window.removeEventListener('resize', onResize, true); mo.disconnect(); clearTimeout(ajastin); clearInterval(odotus);
      if (RE && alkup) { if (Object.prototype.hasOwnProperty.call(RE, 'setRoomInstanceRenderingCanvasOffset') && Object.getPrototypeOf(RE).setRoomInstanceRenderingCanvasOffset === alkup) delete RE.setRoomInstanceRenderingCanvasOffset; else RE.setRoomInstanceRenderingCanvasOffset = alkup; }
      delete window.__kuplaYlavetoLeveys;
    }
  };
  console.log(`[${ NIMI }] 0.2.0 päällä, leveys ${ window.innerWidth }, lokissa ${ loki.length } riviä`);
})();
