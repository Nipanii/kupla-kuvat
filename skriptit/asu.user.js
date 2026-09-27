// ==UserScript==
// @name         Kupla Asu
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      1.1.1
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/asu.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/asu.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  :asu = robon uusin asu listasta · :asu <nimi> · :asu lista · :asu <figure> [M|F] · :asu palauta (edellinen asu takaisin) · :asu näytä (oma nykyinen merkkijono). Botille: pue asu ja valitse botista "kopioi asuni".
// @kupla-oletus off
// @author       re-lab
// ==/UserScript==
// 1.0.0 (kp 2026-09-28 02:31 "sona tarvii sen · asun et voi laittaa botille"): prinsessa sona tarvitsee robon suunnitteleman
//   ruokalan tädin asun päälleen, jotta voi kopioida sen botille. Lähettää 2730 UPDATE_FIGURE clientin OMALLA composer-luokalla
//   (sama tapa kuin nitro/ohjain.js pue(): _messageIdByComposer -> luokka), ei käsin rakennettua pakettia. Edellinen asu
//   tallennetaan localStorageen ennen vaihtoa (:asu palauta).
(() => {
  'use strict';
  const VW = window;
  if (VW.__kuplaAsu) return; VW.__kuplaAsu = true;
  const dv = (o, k) => { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : undefined; };
  const LS = 'kupla.asu.edellinen';

  function yhteys() {
    const RE = VW.NitroDevTools && VW.NitroDevTools.roomEngine; if (!RE) return {};
    if (!VW.__nitroConn) {
      const seen = new Set(); let conn = null;
      const scan = (o, d) => { if (!o || conn || d > 4 || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
        if (Object.getOwnPropertyDescriptor(o, '_cryptoState')) { conn = o; return; }
        for (const k of Object.getOwnPropertyNames(o)) { const de = Object.getOwnPropertyDescriptor(o, k); if (de && !de.get && de.value && typeof de.value === 'object') scan(de.value, d + 1); } };
      scan(dv(RE, '_roomSessionManager'), 0); VW.__nitroConn = conn;
    }
    return { c: VW.__nitroConn, sdm: dv(RE, '_sessionDataManager') };
  }
  function nykyinen() {
    const { sdm } = yhteys(); if (!sdm) return null;
    return { figure: String(dv(sdm, '_figure') || '').replace(/\.0$/, ''), gender: String(dv(sdm, '_gender') || 'M').toUpperCase().startsWith('F') ? 'F' : 'M' };
  }
  function pue(figure, gender) {
    const { c } = yhteys(); if (!c) return 'ei yhteyttä peliin';
    const map = dv(dv(c, '_messages'), '_messageIdByComposer'); let C = null;
    if (map) for (const [k, v] of map) if (v === 2730 && !C) C = k;   // ENSIMMÄINEN = pelin oma; m.js/t.js/k.js/e.js lisäävät oman kiinteän 2730-luokan perään
    if (!C) return 'asunvaihtoviestiä ei löytynyt';
    c.send(new C(gender, figure)); return 'ok';
  }
  // 1.1.0 (kp 02:36 "sona ajaa komennon ja se asettaa viimeisen asun jonka oot updatennu sinne"): robo päivittää asulistaa
  //   kupla-kuvat/asut.json. Listasta haetaan VAIN asumerkkijono + sukupuoli, ne tarkistetaan samalla regexillä kuin käsin
  //   annettu — koodia ei ladata eikä ajeta, ja asu vaihtuu vain kun pelaaja itse kirjoittaa komennon.
  const LISTA = 'https://nipanii.github.io/kupla-kuvat/asut.json';
  const ASU_RE = /^[a-z]{2}-\d+(-\d+)*(\.[a-z]{2}-\d+(-\d+)*)*$/i;
  async function listasta(nimi) {
    let j; try { j = await (await fetch(LISTA + '?t=' + Date.now(), { cache: 'no-store' })).json(); } catch (e) { return 'asulistaa ei saatu: ' + e.message; }
    const asut = (j && j.asut) || {}, avain = nimi ? Object.keys(asut).find(k => k.toLowerCase() === nimi.toLowerCase()) : j.uusin;
    if (nimi === 'lista') return 'asut: ' + Object.keys(asut).join(', ') + (j.uusin ? ' · uusin: ' + j.uusin : '');
    const x = avain && asut[avain]; if (!x) return nimi ? 'ei asua nimeltä ' + nimi + ' (:asu lista)' : 'listassa ei ole uusinta asua';
    if (!ASU_RE.test(x.figure || '') || !/^[MF]$/.test(x.gender || '')) return 'listan asu "' + avain + '" on viallinen';
    const n = nykyinen(); if (n && n.figure) { try { localStorage.setItem(LS, JSON.stringify(n)); } catch (e) {} }
    const r = pue(x.figure, x.gender); return r === 'ok' ? 'päällä: ' + avain + (x.kuvaus ? ' (' + x.kuvaus + ')' : '') + '. Takaisin: :asu palauta' : r;
  }
  function komento(sanat) {
    const a = (sanat[0] || '').trim();
    if (!a) return listasta(null);
    if (/^(apua|help|\?)$/i.test(a)) return ':asu = robon uusin asu · :asu <nimi> · :asu lista · :asu <asumerkkijono> [M|F] · :asu palauta · :asu näytä';
    if (!a.includes('-') || a.toLowerCase() === 'lista') { if (!/^(palauta|undo|näytä|nayta|show)$/i.test(a)) return listasta(a.toLowerCase() === 'lista' ? 'lista' : a); }
    if (/^(näytä|nayta|show)$/i.test(a)) { const n = nykyinen(); if (n) { try { navigator.clipboard.writeText(n.figure); } catch (e) {} } return n ? 'asusi (kopioitu leikepöydälle): ' + n.figure + ' ' + n.gender : 'asua ei voitu lukea'; }
    if (/^(palauta|undo)$/i.test(a)) {
      let e = null; try { e = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (x) {}
      if (!e) return 'ei tallennettua edellistä asua';
      const r = pue(e.figure, e.gender); return r === 'ok' ? 'edellinen asu palautettu' : r;
    }
    if (!/^[a-z]{2}-\d+(-\d+)*(\.[a-z]{2}-\d+(-\d+)*)*$/i.test(a)) return 'ei näytä asumerkkijonolta (esim. hr-3273-40.hd-600-1...)';
    const g = /^f/i.test(sanat[1] || '') ? 'F' : /^m/i.test(sanat[1] || '') ? 'M' : (/(^|\.)hd-6\d\d-/.test(a) ? 'F' : (nykyinen() || {}).gender || 'M');
    const n = nykyinen(); if (n && n.figure) { try { localStorage.setItem(LS, JSON.stringify(n)); } catch (x) {} }
    const r = pue(a, g); return r === 'ok' ? 'asu vaihdettu (' + g + '). Takaisin: :asu palauta' : r;
  }
  VW.kuplaAsu = { komento, pue, nykyinen };

  (VW.kuplaKomennotJono = VW.kuplaKomennotJono || []).push([['asu', 'look', 'pue'],
    (teksti, sanat) => komento(sanat), 'pue asu merkkijonosta: :asu <figure> [M|F] · palauta · näytä', 'Asu']);
  // Konsoliversio / ilman komennot-lisäosaa: oma Enter-kuuntelija (sama tapa kuin huonekierrossa).
  document.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || VW.kuplaKomennot) return;
    const t = e.target; if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
    const m = /^\s*:(asu|look|pue)(?=\s|$)\s*(.*)$/i.exec(t.value || ''); if (!m) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const tulos = komento(m[2].trim().split(/\s+/).filter(Boolean));
    try { const s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), 'value').set; s.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); } catch (x) { t.value = ''; }
    const vastaus = await tulos; try { console.log('[asu]', vastaus); } catch (x) {}
    if (!VW.kuplaKomennot) { const d = document.createElement('div'); d.textContent = vastaus;
      d.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:#1b1f2a;color:#fff;padding:6px 10px;border-radius:4px;font:12px sans-serif;z-index:99999';
      document.body.appendChild(d); setTimeout(() => d.remove(), 5000); }
  }, true);
})();
