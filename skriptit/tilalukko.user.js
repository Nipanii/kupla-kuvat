// ==UserScript==
// @name         Kupla Tilalukko
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-idle
// @version      1.1.0
// @description  🔒-nappi: kun lukko on päällä, klikkaus/tuplaklikkaus EI vaihda huoneen kamojen tilaa (lattia 99, seinä 210). Oikeuksien kanssa ettei vahingossa hajota esim. wired-rataa.
// @author       re-lab
// ==/UserScript==
//
// kp 2026-09-30 03:58 "tee kans userscript et saa oikallisena disabloituu huoneen kamojen state muokkauksen" · 03:58 "koska
//   adminit voi vahingos hajottaa esim sonan wired rataa".
// Mekanismi: yhteysolion send-koukku (sama tapa kuin enable-wired). Composer-luokka -> id kartasta _messageIdByComposer;
//   99 FURNITURE_MULTISTATE ja 210 FURNITURE_WALL_MULTISTATE (nitro/PROTOCOL.md) jätetään lähettämättä kun lukko päällä.
// RAJA: estää KAIKKI 99/210-klikkaukset, myös teleportit/portit jotka käyttävät samaa pakettia -> avaa lukko niitä varten.
//   Ei koske noppia, himmentimiä, yksisuuntaisia ovia eikä kamojen siirtoa/kääntöä. Vain oma client — muut eivät huomaa mitään.
(function () {
  'use strict';
  const VW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  if (VW.__kuplaTilalukko) return;
  VW.__kuplaTilalukko = true;
  const AVAIN = 'kupla.tilalukko', ESTETYT = new Set([99, 210]);
  const dv = (o, k) => { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : undefined; };
  const RE = () => VW.NitroDevTools && VW.NitroDevTools.roomEngine;
  let lukossa = false; try { lukossa = localStorage.getItem(AVAIN) === '1'; } catch (e) {}

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

  let viesti = null, viestiAjastin = null;
  function ilmoita(t) {
    if (!viesti) { viesti = document.createElement('div');
      viesti.style.cssText = 'position:fixed;left:50%;top:60px;transform:translateX(-50%);z-index:99999;background:#222c;color:#fff;padding:6px 12px;border-radius:6px;font:13px sans-serif;pointer-events:none';
      document.body.appendChild(viesti); }
    viesti.textContent = t; viesti.style.display = 'block';
    clearTimeout(viestiAjastin); viestiAjastin = setTimeout(() => { viesti.style.display = 'none'; }, 1500);
  }

  const nappi = document.createElement('div');
  // kp 2026-09-30 05:28 "taas näit UI elementtei mitkä ei oo draggable hyi": raahattava (>4 px = raahaus, ei klikkaus),
  //   sijainti muistetaan; pelin tumma kortti kuten kamera-uploader 4.1.0.
  nappi.style.cssText = 'position:fixed;left:8px;bottom:90px;z-index:99999;width:34px;height:34px;border-radius:6px;border:2px solid #000;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:grab;user-select:none;touch-action:none;box-shadow:0 2px 0 #0008';
  try { const xy = JSON.parse(localStorage.getItem(AVAIN + '.xy') || 'null'); if (xy) { nappi.style.left = xy[0] + 'px'; nappi.style.top = xy[1] + 'px'; nappi.style.bottom = 'auto'; } } catch (e) {}
  let alku = null, liikkui = false;
  nappi.addEventListener('pointerdown', e => { if (e.button !== 0) return; const r = nappi.getBoundingClientRect();
    alku = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top }; liikkui = false; nappi.setPointerCapture(e.pointerId); });
  nappi.addEventListener('pointermove', e => { if (!alku) return;
    if (!liikkui && Math.hypot(e.clientX - alku.x, e.clientY - alku.y) < 4) return;
    liikkui = true; nappi.style.cursor = 'grabbing';
    const x = Math.max(0, Math.min(innerWidth - nappi.offsetWidth, e.clientX - alku.dx)), y = Math.max(0, Math.min(innerHeight - nappi.offsetHeight, e.clientY - alku.dy));
    nappi.style.left = x + 'px'; nappi.style.top = y + 'px'; nappi.style.bottom = 'auto'; });
  nappi.addEventListener('pointerup', () => { if (!alku) return; alku = null; nappi.style.cursor = 'grab';
    if (liikkui) try { localStorage.setItem(AVAIN + '.xy', JSON.stringify([parseInt(nappi.style.left), parseInt(nappi.style.top)])); } catch (e) {} });
  const piirra = () => { nappi.textContent = lukossa ? '🔒' : '🔓'; nappi.style.background = lukossa ? '#b22' : 'rgb(17,26,38)';
    nappi.title = lukossa ? 'Tilalukko PÄÄLLÄ: klikkaus ei vaihda kamojen tilaa. Klikkaa avataksesi.' : 'Tilalukko pois. Klikkaa lukitaksesi kamojen tilat.'; };
  nappi.addEventListener('click', () => { if (liikkui) { liikkui = false; return; } lukossa = !lukossa; try { localStorage.setItem(AVAIN, lukossa ? '1' : '0'); } catch (e) {}
    piirra(); ilmoita(lukossa ? '🔒 kamojen tila lukittu' : '🔓 tilalukko pois'); });
  piirra(); document.body.appendChild(nappi);

  // Koukku yhteysolioon; tarkistus 2 s välein, koska uudelleenyhdistys voi tuoda uuden olion.
  function hook(conn) {
    if (conn.__tilalukkoHooked) return;
    const map = dv(dv(conn, '_messages'), '_messageIdByComposer'); if (!map) return;
    const luokat = new Set(); for (const [k, v] of map) if (ESTETYT.has(v)) luokat.add(k);
    if (!luokat.size) return;
    const orig = conn.send;
    conn.send = function (m) {
      if (lukossa && m && luokat.has(m.constructor)) { ilmoita('🔒 tilalukko esti tilan vaihdon'); return; }
      return orig.apply(this, arguments);
    };
    conn.__tilalukkoHooked = true;
  }
  const tick = () => { try { const c = findConn(); if (c) hook(c); } catch (e) {} };
  tick(); setInterval(tick, 2000);
})();
