// ==UserScript==
// @name         Kupla Huoneeseen palaaja
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-idle
// @version      2.1.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/huoneeseen-palaaja.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/huoneeseen-palaaja.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @kupla-oletus on
// @description  Sivun päivityksen (F5) jälkeen vie takaisin huoneeseen jossa olit. Vain oma client, ei muuta mitään muille.
// @author       re-lab
// ==/UserScript==
//
// kp 2026-09-30 03:30 "saisko lisärin et muistaa mis huonees oli jos tekee refresh · ja tulee heti takas".
// 2.0.0 (kp 03:43 "keksi ei-ajastin soluutio · ajastin on tyhmää purkkaa" + 03:44 "jäit jumii hotel view"): EI AJASTIMIA.
//   Syy 1.x:n jumiin (MainView.tsx:99): hotel view piiloutuu vain RoomSessionEvent.CREATED-tapahtumasta, jota React kuuntelee
//   vasta kun MainView on piirretty. 1.x kutsui createSessionia ennen sitä -> pelin huone-id oli 40 mutta ruutu jäi hotel
//   viewiin (mittasin huone-id:tä, väärä havaittava). Nyt:
//   - TALLENNUS: pagehide-tapahtumassa (sivu suljetaan/päivitetään) luetaan nykyinen huone, jos hotel view ei ole näkyvissä.
//   - PALUU: MutationObserver odottaa että .nitro-hotel-view ilmestyy DOMiin (= MainView piirretty ja kuuntelee) ja kutsuu
//     silloin createSession(id) kerran. Ilmestyykö hotel view uudelleen / katoaako se = pelin oma näkyvä tila.
// RAJAT: vain alle 30 min vanha tallennus. Salasana-/ovikellohuone kysyy kuten normaalisti.
(function () {
  'use strict';
  if (window.__kuplaPalaaja) return; window.__kuplaPalaaja = true;
  const AVAIN = 'kupla.palaaja', MAX_IKA = 30 * 60 * 1000;
  const RE = () => window.NitroDevTools && window.NitroDevTools.roomEngine;
  let alku = null; try { alku = JSON.parse(sessionStorage.getItem(AVAIN) || 'null'); } catch (e) {}
  sessionStorage.removeItem(AVAIN);   // yksi paluu per tallennus
  window.addEventListener('pagehide', () => {
    try { const r = RE(), rid = r && r.activeRoomId;
      if (rid != null && rid >= 0 && !document.querySelector('.nitro-hotel-view')) sessionStorage.setItem(AVAIN, JSON.stringify({ id: rid, ts: Date.now() })); } catch (e) {}
  });
  if (!alku || !(Date.now() - alku.ts < MAX_IKA)) return;
  const yrita = () => {
    if (!document.querySelector('.nitro-hotel-view')) return false;
    const r = RE(), rsm = r && r._roomSessionManager; if (!rsm || typeof rsm.createSession !== 'function') return false;
    rsm.createSession(alku.id); window.__kuplaPalaajaViime = { id: alku.id, t: Date.now() }; return true;
  };
  if (yrita()) return;
  const mo = new MutationObserver(() => { if (yrita()) mo.disconnect(); });
  mo.observe(document.body, { childList: true, subtree: true });
})();
