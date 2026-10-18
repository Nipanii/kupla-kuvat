// ==UserScript==
// @name         Kupla Stranger-piilotus
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-idle
// @version      1.0.1
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/stranger-piilotus.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/stranger-piilotus.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Piilottaa Mysterious Strangerin omasta clientistäsi: ei hahmoa huoneeseen, ei haasteikkunaa, ei "aika loppui" -tuloskorttia.
// @author       re-lab
// ==/UserScript==
//
// kp + bobo50cent 2026-10-18 05:12-05:13: "robo poistas tää mysterious stranger spawnaus multa" · "myös ilmotukset kun stranger
//   menee pois · et aika loppui tjsp".
// MITEN: client näyttää Strangerin vain saapuvista paketeista (kupla-cc client/DarkUI/src/hooks/random-events/useStranger.ts):
//   9830 StrangerTrigger -> lisää botti-objektin -900001 huoneeseen (:305) ja odottaa klikkausta; 9832 StrangerResult -> tuloskortti
//   ("Haaste ehti vanhentua." StrangerService.java:234, voitto/häviö); 9833 StrangerProgress -> pelin välitila.
//   Renderöijä pudottaa paketin jos jäsentimen parse() palauttaa false (Nitro_Render_V3 SocketConnection.ts:1126), joten koukku
//   palauttaa false näille kolmelle -> mikään Stranger-käsittelijä ei saa niitä.
// RAJA: vain OMA näkymä. Palvelin luo haasteen silti; se vanhenee itsestään (ei palkintoa, ei rangaistusta).
//   Älä käytä yhtä aikaa Stranger-ratkaisijan kanssa: piilotus pudottaa paketit joita ratkaisija tarvitsee.
//   Kytkin: nappi vasemmassa alakulmassa (localStorage kupla.strangerPiilotus). Pois päältä = Stranger näkyy taas seuraavasta haasteesta.
(function () {
  'use strict';
  const VW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (VW.__strangerPiilotus) return; // jo käynnissä (userscript + Messenger-kortti samassa sivussa)
  const AVAIN = 'kupla.strangerPiilotus';
  let paalla = true; try { paalla = localStorage.getItem(AVAIN) !== 'off'; } catch (e) {}
  let piilotettu = 0;

  const dv = (o, k) => { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : undefined; };
  const RE = () => VW.NitroDevTools && VW.NitroDevTools.roomEngine;
  const yhteys = () => {
    const re = RE(); if (!re) return null;
    try { const cn = re._sessionDataManager._messageEvents[0]._connection; if (cn && Object.getOwnPropertyDescriptor(cn, '_cryptoState')) return cn; } catch (e) {}
    const seen = new Set(); let conn = null;
    const scan = (o, d) => { if (!o || conn || d > 4 || typeof o !== 'object' || seen.has(o)) return; seen.add(o); if (Object.getOwnPropertyDescriptor(o, '_cryptoState')) { conn = o; return; }
      for (const k of Object.getOwnPropertyNames(o)) { const de = Object.getOwnPropertyDescriptor(o, k); if (de && !de.get && de.value && typeof de.value === 'object') scan(de.value, d + 1); } };
    try { scan(dv(re, '_roomSessionManager'), 0); } catch (e) {}
    return conn;
  };

  const koukuta = () => { try {
    const M = dv(dv(yhteys(), '_messages'), '_messageInstancesById'); if (!M) return 0; let n = 0;
    for (const id of [9830, 9832, 9833]) { const list = M.get(id); if (!list) continue;
      for (const h of list) { const P = h._parserClass && h._parserClass.prototype; if (!P || P.__strPiilo) continue; P.__strPiilo = true; n++; const o = P.parse;
        P.parse = function () { if (paalla) { if (id === 9830) { piilotettu++; paivita(); } return false; } return o.apply(this, arguments); }; } }
    return n; } catch (e) { return 0; } };

  // Jo huoneessa oleva Stranger-botti (haaste tuli ennen kuin skripti latautui) pois näkyvistä.
  const poistaBotti = () => { try { const re = RE();
    const rid = re && re._activeRoomId; if (paalla && re && rid != null && re.getRoomObject && re.getRoomObject(rid, -900001, 100)) re.removeRoomObjectUser(rid, -900001); } catch (e) {} };

  const tyyli = document.createElement('style');
  const css = () => { tyyli.textContent = paalla ? '.stranger-modal{display:none!important}' : ''; };

  let nappi = null;
  const paivita = () => { if (nappi) nappi.textContent = paalla ? `🙈 Stranger piilossa · ${piilotettu}` : '👀 Stranger näkyy'; };
  const teeNappi = () => {
    nappi = document.createElement('div');
    nappi.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:12px sans-serif;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.65);color:#fff;cursor:pointer;user-select:none';
    nappi.title = 'Klikkaa: Stranger-piilotus päälle/pois';
    nappi.onclick = () => { paalla = !paalla; try { localStorage.setItem(AVAIN, paalla ? 'on' : 'off'); } catch (e) {} css(); paivita(); poistaBotti(); };
    document.body.appendChild(nappi); paivita();
  };

  const tick = () => { koukuta(); poistaBotti(); };
  // Messenger-kortin Kumoa kutsuu tätä: piilotus pois, Stranger näkyy taas.
  VW.__strangerPiilotus = { pois: () => { if (paalla) nappi.onclick(); }, paalle: () => { if (!paalla) nappi.onclick(); } };
  const alku = () => { document.head.appendChild(tyyli); css(); teeNappi(); tick(); setInterval(tick, 5000); };
  if (document.body) alku(); else addEventListener('DOMContentLoaded', alku);
})();
