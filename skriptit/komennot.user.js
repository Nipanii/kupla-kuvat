// ==UserScript==
// @name         Kupla Komennot
// @namespace    https://re-lab.local/kupla
// @version      1.4.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/komennot.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/komennot.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-idle
// @description  Oma komentokäsittelijä chattiin: lisäosien :komennot siepataan ennen chattia, eivät lähde huoneeseen. :komennot listaa kaikki. Sisältää :mimic <nimi> (kopioi asun itsellesi — huoneesta tai 1210-haulla mistä tahansa) ja :tp <x> <y> | <nimi> (Superkyvyt-teleport).
// @kupla-oletus on
// ==/UserScript==
/*
 * kp 2026-09-27 23:36 (kuiskaus): "pitäskö meil olla oma command handler joka ohjaa extensioneihin · esim :mimic nimi vois
 *   mennä sen kautta · estää ettei se lähe normi chattii" · "rotate kans ohjautuis siihe" · "ja sit tp vois mennä kans
 *   komennolla" · 23:38 "lisätään sit pikkuhiljaa siihen komentoja jo tehdyille jutuille".
 *
 * MITEN LISÄOSA LISÄÄ KOMENNON (latausjärjestys ei ratkaise — loader lataa moduulit rinnakkain):
 *   (window.kuplaKomennotJono = window.kuplaKomennotJono || []).push([['nimi', 'alias'], (teksti, sanat) => 'vastaus', 'ohje', 'lisäosa']);
 *   Jono puretaan kun tämä moduuli latautuu; sen jälkeen push rekisteröi heti. Paluuarvo (merkkijono tai Promise) näytetään
 *   pienenä ilmoituksena chatin yläpuolella — vain sinulle, palvelimelle ei lähde mitään.
 *   Hiekkalaatikkomoduuli (@grant GM_*) käyttää unsafeWindow.kuplaKomennotJono.
 * VAIN REKISTERÖITY komento siepataan. Tuntematon (:sit, :rotate, :pickall…) menee palvelimelle kuten ennenkin.
 * RAJA: :mimic on CLIENT-puolen korvike palvelimen :mimicille (jota esim. prinsessa sonalla ei ole): se lähettää 2730
 *   USER_FIGURE omalle hahmolle. Palvelin voi hylätä asun jos siinä on kerho-/rajoitettuja osia.
 * RAJA: :tp vaatii Superkyvyt-lisäosan (window.__kt.teleport) ja palvelin päättää onnistuuko (7016 internal write).
 */
(function () {
  'use strict';
  if (window.kuplaKomennot && window.kuplaKomennot.__versio) return;
  const dv = (o, k) => { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : undefined; };
  const komennot = new Map();
  let laatikko = null, ajastin = 0;

  function ilmoita(teksti, virhe) {
    try {
      if (!laatikko || !laatikko.isConnected) {
        laatikko = document.createElement('div');
        laatikko.id = 'kupla-komento-ilmoitus';
        laatikko.className = 'nitro-context-menu';
        Object.assign(laatikko.style, { position: 'fixed', left: '50%', bottom: '64px', transform: 'translateX(-50%)', zIndex: 2147483646,
          padding: '5px 10px', maxWidth: 'min(560px, calc(100vw - 24px))', whiteSpace: 'pre-wrap', fontSize: '12px', color: '#fff',
          pointerEvents: 'none', transition: 'opacity .3s' });
        if (!document.getElementById('kupla-komento-tyyli')) {
          const st = document.createElement('style'); st.id = 'kupla-komento-tyyli';
          st.textContent = '#kupla-komento-ilmoitus:after{display:none!important}';
          document.head.appendChild(st);
        }
        document.body.appendChild(laatikko);
      }
      laatikko.textContent = String(teksti);
      laatikko.style.borderColor = virhe ? '#ee5a49' : '';
      laatikko.style.opacity = '1';
      clearTimeout(ajastin); ajastin = setTimeout(() => { if (laatikko) laatikko.style.opacity = '0'; }, virhe ? 7000 : 5000);
    } catch (e) { console.log('[komennot]', teksti); }
  }

  function lisaa(nimet, fn, ohje, lisaosa) {
    const l = [].concat(nimet).map(n => String(n).replace(/^:/, '').toLowerCase());
    const k = { nimet: l, fn, ohje: ohje || '', lisaosa: lisaosa || '' };
    for (const n of l) komennot.set(n, k);
  }
  const lista = () => [...new Set(komennot.values())].map(k => ({ nimet: k.nimet.slice(), ohje: k.ohje, lisaosa: k.lisaosa }));

  // true = rivi oli rekisteröity komento ja se ajettiin
  function aja(rivi) {
    const m = /^\s*:(\S+)(?:\s+([\s\S]*))?$/.exec(rivi || ''); if (!m) return false;
    const k = komennot.get(m[1].toLowerCase()); if (!k) return false;
    const teksti = (m[2] || '').trim(), sanat = teksti ? teksti.split(/\s+/) : [];
    const nayta = v => { if (typeof v === 'string' && v) ilmoita(v); };
    try {
      const r = k.fn(teksti, sanat);
      if (r && typeof r.then === 'function') r.then(nayta, e => ilmoita(':' + m[1] + ' virhe: ' + ((e && e.message) || e), true));
      else nayta(r);
    } catch (e) { ilmoita(':' + m[1] + ' virhe: ' + e.message, true); }
    return true;
  }

  window.kuplaKomennot = { __versio: '1.4.0', lisaa, lista, aja, ilmoita };
  const jono = window.kuplaKomennotJono = window.kuplaKomennotJono || [];
  for (const x of jono.splice(0)) { try { lisaa(...x); } catch (e) { console.warn('[komennot] jono', e); } }
  jono.push = (...xs) => { for (const x of xs) lisaa(...x); return 0; };

  // Enter kaapataan document-capturessa ENNEN Reactia (sama tapa kuin huonekierto 1.1.0, mitattu robolla 22:25).
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const t = e.target; if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) return;
    if (!/^\s*:/.test(t.value || '')) return;
    if (!aja(t.value)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    try {   // Reactin oma setter + input-tapahtuma, muuten Reactin tila pitää tekstin
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), 'value').set;
      setter.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) { t.value = ''; }
  }, true);

  // --- apurit huoneeseen ---
  function huone() {
    const RE = window.NitroDevTools && window.NitroDevTools.roomEngine; if (!RE) return null;
    const id = dv(RE, '_activeRoomId'), rsm = dv(RE, '_roomSessionManager'), ss = rsm && dv(rsm, '_sessions');
    let s = null; if (ss instanceof Map) for (const [, v] of ss) if (dv(v, '_roomId') === id) s = v;
    return s ? { RE, id, rsm, s, ud: dv(s, '_userData'), oma: dv(s, '_ownRoomIndex') } : null;
  }
  function yhteys(rsm) {
    const seen = new Set(); let c = null;
    const sc = (o, d) => { if (!o || c || d > 4 || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
      if (Object.getOwnPropertyDescriptor(o, '_cryptoState')) { c = o; return; }
      for (const k of Object.getOwnPropertyNames(o)) { const e = Object.getOwnPropertyDescriptor(o, k); if (e && !e.get && e.value && typeof e.value === 'object') sc(e.value, d + 1); } };
    sc(rsm, 0); return c;
  }
  function hahmot(h) {
    const m = h && h.ud && dv(h.ud, '_userDataByRoomIndex'); return m instanceof Map ? [...m.values()] : [];
  }
  function etsi(h, nimi) {
    const n = nimi.toLowerCase(), kaikki = hahmot(h).filter(u => u && u.name);
    return kaikki.find(u => u.name.toLowerCase() === n) || kaikki.filter(u => u.name.toLowerCase().startsWith(n)).length === 1
      && kaikki.find(u => u.name.toLowerCase().startsWith(n)) || null;
  }

  // Asu mistä tahansa huoneesta (kp 2026-09-28 00:16 "hakee hahmon asu mistä tahansa huoneesta … yhdistää mimiciin").
  // 1210 käyttäjähaku -> 973: [n × (id, nimi, motto, online b, canFollow b, lastOnline s, int (EI sukupuoli), figure s, realName s)]
  // kahdesti (kaverit, muut). Mitattu robolla 00:20-00:24: :mimic kurkkupomo toisesta huoneesta -> robo sai kp:n asun. Kuunnellaan clientin omaa
  // subscribePacketTracea (kuplan lisäys), palvelimelle lähtee vain haku.
  function haeHaulla(c, nimi) {
    return new Promise((ok, ei) => {
      if (typeof c.subscribePacketTrace !== 'function') return ei(new Error('client ei tarjoa pakettiseurantaa'));
      let off = () => {};
      const aika = setTimeout(() => { off(); ei(new Error('"' + nimi + '" ei löytynyt haulla')); }, 4000);
      off = c.subscribePacketTrace(e => {
        if (!e || e.direction === 'OUTGOING' || e.header !== 973 || !(e.buffer instanceof ArrayBuffer)) return;
        const d = new DataView(e.buffer); let o = 0;
        const i32 = () => { const v = d.getInt32(o); o += 4; return v; }, b = () => d.getUint8(o++);
        const s = () => { const l = d.getUint16(o); o += 2; const t = new TextDecoder().decode(new Uint8Array(e.buffer, o, l)); o += l; return t; };
        const loydot = [];
        try { for (let lista = 0; lista < 2 && o < d.byteLength; lista++) { const n = i32();
          for (let k = 0; k < n; k++) { i32(); const nm = s(); s(); b(); b(); s(); i32(); const fig = s(); s(); loydot.push({ name: nm, figure: fig.replace(/\.0$/, '') }); } }
        } catch (x) { /* osittainenkin lista kelpaa */ }
        const u = loydot.find(x => x.name.toLowerCase() === nimi.toLowerCase());
        if (!u) return;
        clearTimeout(aika); off(); ok(u);
      });
      c.sendRawPacket(1210, [nimi], 'kupla-mimic-haku');
    });
  }

  // 973:n int-kenttä EI ole sukupuoli (mitattu 00:22: sona F ja kurkkupomo M antoivat molemmat 1). kp 00:20: "en usko et
  // sukupuolella välii … asunvaihto paketti kai overridee" -> käytetään omaa sukupuolta, ':mimic nimi f|m' pakottaa.
  function omaSukupuoli(h) {
    const u = hahmot(h).find(x => x && x.roomIndex === h.oma); return u && String(u.sex || '').toUpperCase().startsWith('F') ? 'F' : 'M';
  }

  lisaa(['komennot', 'apua'], () => lista().map(k => ':' + k.nimet.join(' / :') + (k.ohje ? ' — ' + k.ohje : '')
    + (k.lisaosa ? '  [' + k.lisaosa + ']' : '')).join('\n'), 'näyttää kaikki komennot', 'Komennot');

  lisaa(['mimic', 'matki'], (teksti) => {
    if (!teksti) return ':mimic <nimi> [m|f] — kopioi hahmon asun sinulle (huoneesta tai haulla mistä tahansa)';
    const h = huone(); if (!h) throw new Error('et ole huoneessa');
    let pakko = null;   // ":mimic nimi f" pakottaa sukupuolen
    const mm = /^(.*\S)\s+([mf])$/i.exec(teksti); if (mm) { teksti = mm[1]; pakko = mm[2].toUpperCase(); }
    const c = yhteys(h.rsm); if (!c || typeof c.sendRawPacket !== 'function') throw new Error('yhteyttä ei löytynyt');
    const pue = (u, mista) => {
      const fig = u.figure, sp = pakko || (String(u.sex || 'M').toUpperCase().startsWith('F') ? 'F' : 'M');
      if (!fig) throw new Error(u.name + ': ei asua luettavissa');
      c.sendRawPacket(2730, [sp, fig], 'kupla-mimic');
      return 'asu kopioitu: ' + u.name + mista;
    };
    const u = etsi(h, teksti);
    if (u) return pue(u, '');
    // ei tässä huoneessa -> käyttäjähaku (koko nimi, botteja ei löydy haulla)
    return haeHaulla(c, teksti).then(x => {
      x.sex = pakko || omaSukupuoli(h);
      return pue(x, ' (haettu toisesta huoneesta)');
    });
  }, 'kopioi asun itsellesi: huoneesta (myös botin) tai haulla mistä tahansa', 'Komennot');

  lisaa(['tp', 'teleport'], (teksti, sanat) => {
    const kt = window.__kt;
    if (!kt || typeof kt.teleport !== 'function') throw new Error('Superkyvyt-lisäosa ei ole päällä (🧩)');
    let x, y;
    if (sanat.length === 2 && sanat.every(s => /^\d+$/.test(s))) { x = +sanat[0]; y = +sanat[1]; }
    else if (teksti) {
      const h = huone(); if (!h) throw new Error('et ole huoneessa');
      const u = etsi(h, teksti); if (!u) throw new Error('"' + teksti + '" ei ole tässä huoneessa');
      const o = h.RE.getRoomObjectUser(h.id, u.roomIndex); const l = o && o.getLocation && o.getLocation();
      if (!l) throw new Error(u.name + ': sijaintia ei saatu');
      x = Math.round(l.x); y = Math.round(l.y);
    } else return ':tp <x> <y>  tai  :tp <nimi>';
    kt.teleport(x, y);
    return 'teleport (' + x + ',' + y + ') lähetetty — tulos Superkyvyt-paneelissa';
  }, 'teleporttaa ruutuun tai hahmon luo (vaatii Superkyvyt)', 'Komennot');

  // 1.2.0 oikean klikkauksen rivit (klikkikävelyn 1.9.0 valikko; kp 00:44 #592 "right clickaamal pelaajaa siel on mimic",
  //   00:45 #593 "tp vois toimii right clickaamalla … ruutuu … pelaajaaki", 00:48 "piilotetaa ne optiot mitä ei voi tehä").
  //   Rivit ajavat samat komennot kuin chatissa, joten tulos näkyy samana ilmoituksena. tp piilossa ilman Superkyvyt-lisäosaa.
  const tpOn = () => !!(window.__kt && typeof window.__kt.teleport === 'function');
  (window.kuplaValikkoJono = window.kuplaValikkoJono || []).push(
    { kohde: 'hahmo', nimi: 'Kopioi asu (mimic)', nakyy: ctx => ctx.hahmo.tyyppi !== 2, tee: ctx => { aja(':mimic ' + ctx.hahmo.nimi); }, lisaosa: 'Komennot' },
    { kohde: 'hahmo', nimi: 'Teleporttaa luokse', nakyy: tpOn, tee: ctx => { aja(':tp ' + ctx.hahmo.x + ' ' + ctx.hahmo.y); }, lisaosa: 'Komennot' },
    { kohde: 'ruutu', nimi: 'Teleporttaa tähän', nakyy: tpOn, tee: ctx => { aja(':tp ' + ctx.ruutu.x + ' ' + ctx.ruutu.y); }, lisaosa: 'Komennot' });

  // 1.3.0 (Res 2026-09-28 02:55 "totta istuminen omasta hahmost · tai makaaminen", kp "diippii pohdintaa" oikean klikkauksen
  //   valikkoon). Istu = 2235 ChangePostureMessageEvent (palvelin: makeSit, ei lue argumenttia — ChangePostureMessageEvent.java).
  //   Makaa = palvelimen :lay-komento chattina 1314 (CommandHandler sieppaa, ei näy huoneelle; commands.keys.cmd_lay = 'lay').
  //   Ei chat-spämmiä kummastakaan.
  const asento = tapa => {
    const h = huone(); if (!h) throw new Error('et ole huoneessa');
    const c = yhteys(h.rsm); if (!c || typeof c.sendRawPacket !== 'function') throw new Error('yhteyttä ei löytynyt');
    if (tapa === 'istu') c.sendRawPacket(2235, [1], 'kupla-istu'); else c.sendRawPacket(1314, [':lay', 0, ''], 'kupla-makaa');
    return '';
  };
  lisaa(['istu'], () => asento('istu'), 'istu alas (sama kuin oikean klikkauksen Istu)', 'Komennot');
  window.kuplaValikkoJono.push(
    { kohde: 'oma', nimi: 'Istu', tee: () => asento('istu'), lisaosa: 'Komennot' },
    { kohde: 'oma', nimi: 'Makaa', tee: () => asento('makaa'), lisaosa: 'Komennot' });

  // 1.4.0 esineen Käytä (kp 02:57 "esim et käytä tavaraa sen sijaa et double click", Res 03:00 "joo ei noppa specific"):
  //   pelin OMA RoomEngine.useRoomObject(id, kategoria) = infostandin Käytä-nappi (RoomEngine.ts:2408 -> logic.useObject()),
  //   joten jokainen esine käyttäytyy kuten pelissä (noppa heittää, lamppu vaihtaa tilaa, linkki aukeaa). Ei omaa pakettia.
  window.kuplaValikkoJono.push({ kohde: 'esine', nimi: 'Käytä', lisaosa: 'Komennot', tee: ctx => {
    const r = window.NitroDevTools && window.NitroDevTools.roomEngine;
    return r && typeof r.useRoomObject === 'function' && r.useRoomObject(ctx.esine.id, ctx.esine.cat) ? '' : 'tätä esinettä ei voi käyttää';
  } });
})();
