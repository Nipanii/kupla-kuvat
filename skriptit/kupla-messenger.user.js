// ==UserScript==
// @name         Kupla Messenger
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      0.1.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/kupla-messenger.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/kupla-messenger.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Kaverit, yksityisviestit, maininnat ja Datajako yhden napin takana. Pelkkä client, ei palvelinmuutoksia.
// @kupla-oletus off
// @author       re-lab
// ==/UserScript==
/*
 * MIKSI: Res 2026-10-13 07:27-07:40 "teetkö userscriptin siitä v3 messengeristä, lisätään siihen myös maininnat … saman napin
 *   taakse … ja paremmin luettavaks" · "datajaon ominaisuudet" (07:38: datajako PYSYY asukanavalla, tulee omaksi välilehdeksi) ·
 *   "ensin tosin userscript et voidaan tunnustella ja testaa sitä". Rakennusohje: re-lab tmp/messenger-us/RAKENNUS.md.
 * MITEN: pelin React-tilaa ei saa ulkoa, joten skripti kääri clientin omat parserit (lukee jäsennetyt kentät heti parse():n jälkeen)
 *   ja lähettää clientin omilla paketeilla `conn.sendPacket(header, arvot)` (SocketConnection.ts:921). Uusia pakettimuotoja ei ole.
 * RAJAT: ennen skriptin latautumista tulleet yksityisviestit näkyvät vain pelin omassa ikkunassa. Viestit ovat vain muistissa
 *   (ei levylle). Kaverilista pyydetään uudelleen (2781) jos sitä ei näkynyt; pyynnöt ja maininnat vain Päivitä-napista, koska
 *   pelin oma client näyttäisi maininnoista kuplat uudelleen. Yksityisviesti max 255 merkkiä (palvelin leikkaa, SendMsgMessageEvent.java:30).
 */
(() => {
  'use strict';
  const VW = window;
  if (VW.__kuplaMessenger) return; VW.__kuplaMessenger = true;
  // testiä varten uudelleenasennettava: käärityt parserit kutsuvat AINA viimeisintä käsittelijätaulua (VW.__km2K)
  const VERSIO = '0.1.0';
  // uudelleenasennus (testi) pysäyttää edellisen kopion ajastimet: vain uusin sukupolvi elää
  const SUKU = (VW.__km2Suku = (VW.__km2Suku || 0) + 1), elossa = () => VW.__km2Suku === SUKU;
  const ajoita = (f, ms) => { const h = setInterval(() => { if (!elossa()) return clearInterval(h); f(h); }, ms); return h; };
  const dv = (o, k) => { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : undefined; };
  const RE = () => VW.NitroDevTools && VW.NitroDevTools.roomEngine;
  const loki = (...a) => console.log('%c[kupla-messenger]', 'color:#3a9', ...a);

  // ---------- yhteys ----------
  let conn = null;
  function etsiYhteys() {
    const re = RE(); if (!re) return null;
    const nahty = new Set();
    const kay = (o, d) => { if (!o || typeof o !== 'object' || nahty.has(o) || d > 5) return null; nahty.add(o);
      if (Object.getOwnPropertyDescriptor(o, '_cryptoState')) return o;
      for (const k of Object.getOwnPropertyNames(o)) { const de = Object.getOwnPropertyDescriptor(o, k);
        if (de && !de.get && de.value && typeof de.value === 'object') { const f = kay(de.value, d + 1); if (f) return f; } }
      return null; };
    return kay(dv(re, '_roomSessionManager'), 0);
  }
  const yhteys = () => { if (!conn || dv(conn, '_socket') && dv(conn, '_socket').readyState > 1) conn = etsiYhteys() || conn; return conn; };
  const laheta = (h, arvot) => { const c = yhteys(); if (!c || typeof c.sendPacket !== 'function') { loki('ei yhteyttä, ei lähetetty', h); return false; }
    return c.sendPacket(h, arvot) !== false; };
  const oma = () => { const s = dv(RE(), '_sessionDataManager'); return { id: s ? s.userId : 0, nimi: s ? s.userName : '' }; };

  // ---------- tila (vain muistissa) ----------
  const T = { kaverit: new Map(), pyynnot: new Map(), ketjut: new Map(), lukematta: new Map(), maininnat: [], haku: null,
    raja: 0, kaverilistaSaatu: 0, koukutettu: 0, aktiivinen: null, valilehti: 'viestit', auki: false };
  const kaveri = f => ({ id: f.id, nimi: f.name, paikalla: !!f.online, seurattava: !!f.followingAllowed, asu: f.figure || '', motto: f.motto || '', suhde: f.relationshipStatus || 0 });
  const nimiId = id => (T.kaverit.get(id) || {}).nimi || ('#' + id);
  function lisaaViesti(peer, v) {
    if (!T.ketjut.has(peer)) T.ketjut.set(peer, []);
    const l = T.ketjut.get(peer); l.push(v); if (l.length > 300) l.splice(0, l.length - 300);
    if (!v.oma && !(T.auki && T.valilehti === 'viestit' && T.aktiivinen === peer)) T.lukematta.set(peer, (T.lukematta.get(peer) || 0) + 1);
  }

  // ---------- parserien kääriminen ----------
  function kaari(c, id, fn) {
    const viestit = dv(c, '_messages'), lista = dv(viestit, '_messageInstancesById'); let t = lista && lista.get(id);
    // Kukaan ei kuuntele (esim. 973 pelaajahaku ennen pelin oman hakunäkymän avaamista) -> client ei jäsennä pakettia lainkaan.
    // Rekisteröidään tyhjä kuuntelija pelin omalla tapahtumaluokalla, kuten client itse tekee (SocketConnection.addMessageEvent).
    if ((!t || !t[0]) && typeof c.addMessageEvent === 'function') {
      const luokat = dv(viestit, '_messageIdByEvent');
      for (const [Luokka, h] of (luokat || new Map())) if (h === id) { try { c.addMessageEvent(new Luokka(() => {})); } catch (e) {} break; }
      t = lista && lista.get(id);
    }
    if (!t || !t[0]) return false;
    const P = t[0].parserClass || dv(t[0], '_parserClass');
    if (!P || !P.prototype || typeof P.prototype.parse !== 'function') return false;
    const merkki = '__kuplaMessenger_' + id;
    if (P.prototype[merkki]) return true;
    const alkuperainen = P.prototype.parse;
    P.prototype.parse = function (w) {
      const ok = alkuperainen.call(this, w);
      if (ok) { const k = VW.__km2K; try { if (k && k[id]) { k[id](this); k.paivita(); } } catch (e) { console.warn('[kupla-messenger] käsittelijä ' + id + ' kaatui', e); } }
      return ok;   // pelin oma käsittely jatkuu aina samalla oliolla
    };
    P.prototype[merkki] = true; return true;
  }
  const KASITTELIJAT = {
    1605: p => { T.raja = p.userFriendLimit || T.raja; },
    3130: p => { for (const f of p.fragment || []) T.kaverit.set(f.id, kaveri(f)); T.kaverilistaSaatu = Date.now(); },
    2800: p => { for (const id of p.removedFriendIds || []) T.kaverit.delete(id);
      for (const f of [...(p.addedFriends || []), ...(p.updatedFriends || [])]) T.kaverit.set(f.id, kaveri(f)); },
    280: p => { T.pyynnot.clear(); for (const r of p.requests || []) T.pyynnot.set(r.requestId, { id: r.requestId, nimi: r.requesterName, asu: r.figureString || '' }); },
    2219: p => { const r = p.request; if (r) T.pyynnot.set(r.requestId, { id: r.requestId, nimi: r.requesterName, asu: r.figureString || '' }); },
    1587: p => lisaaViesti(p.senderId, { oma: false, teksti: String(p.messageText || ''), t: Date.now() - (p.secondsSinceSent || 0) * 1000, offline: (p.secondsSinceSent || 0) > 0 }),
    3870: p => lisaaViesti(p.senderId, { oma: false, teksti: String(p.messageText || ''), t: Date.now(), kutsu: true }),
    973: p => { const k = r => ({ id: r.avatarId, nimi: r.avatarName, motto: r.avatarMotto || '', asu: r.avatarFigure || '', paikalla: !!r.isAvatarOnline });
      T.haku = { kaverit: (p.friends || []).map(k), muut: (p.others || []).map(k), t: Date.now() }; },
    4801: p => { const m = p.mention; if (m) { T.maininnat = [kopioiMaininta(m), ...T.maininnat.filter(x => x.id !== m.mentionId)]; } },
    4802: p => { T.maininnat = (p.mentions || []).map(kopioiMaininta).sort((a, b) => b.id - a.id); },
  };
  const kopioiMaininta = m => ({ id: m.mentionId, lahettajaId: m.senderId, lahettaja: m.senderUsername, asu: m.senderFigure || '', huone: m.roomId,
    huoneNimi: m.roomName || '', viesti: m.message || '', aika: m.timestamp, luettu: !!m.read });
  function koukuta() {
    const c = yhteys(); if (!c) return false;
    VW.__km2K = Object.assign({}, KASITTELIJAT, { paivita: paivitaPian });
    let ok = 0; for (const id of Object.keys(KASITTELIJAT)) if (kaari(c, +id, KASITTELIJAT[id])) ok++;
    if (ok === Object.keys(KASITTELIJAT).length) { if (!T.koukutettu) { T.koukutettu = Date.now(); loki('koukut asennettu', ok); } return true; }
    return false;
  }
  ajoita(h => { if (koukuta()) { clearInterval(h); rakennaUI(); } }, 150);
  // kaverilista: jos skripti latautui vasta listan jälkeen, pyydetään uudelleen (peli yhdistää kaverit id:llä, useFriends.ts:255-267)
  ajoita(() => { if (T.koukutettu && !T.kaverilistaSaatu && Date.now() - T.koukutettu > 8000) { T.kaverilistaSaatu = -1; laheta(2781, []); loki('kaverilista pyydetty uudelleen (2781)'); } }, 2000);

  // ---------- apurit ----------
  const el = (tag, cls, teksti, attr) => { const e = document.createElement(tag); if (cls) e.className = cls; if (teksti != null) e.textContent = teksti; if (attr) for (const k in attr) e.setAttribute(k, attr[k]); return e; };
  const paa = asu => location.origin + '/avatarimage?figure=' + encodeURIComponent(asu || '') + '&headonly=1&size=l&direction=3&head_direction=3';   // size=s on 16x16, l 64x84 (mitattu 13.10.)
  const kaksi = n => String(n).padStart(2, '0');
  const klo = t => { const d = new Date(t); return kaksi(d.getHours()) + ':' + kaksi(d.getMinutes()); };
  const paiva = t => { const d = new Date(t), n = new Date(); const ero = Math.round((new Date(n.toDateString()) - new Date(d.toDateString())) / 864e5);
    return ero === 0 ? 'Tänään' : ero === 1 ? 'Eilen' : d.getDate() + '.' + (d.getMonth() + 1) + '.' + d.getFullYear(); };
  const listaAika = t => { const d = new Date(t); return d.toDateString() === new Date().toDateString() ? klo(t) : d.getDate() + '.' + (d.getMonth() + 1) + '.'; };
  const mainintaAika = s => { if (!s) return ''; const t = s > 1e11 ? s : s * 1000; return paiva(t) + ' ' + klo(t); };

  // ---------- käyttöliittymä ----------
  let juuri, nappi, runko, merkki, paneelit = {};
  const VALILEHDET = [['viestit', 'Viestit'], ['kaverit', 'Kaverit'], ['pyynnot', 'Pyynnöt'], ['haku', 'Haku'], ['maininnat', 'Maininnat'], ['datajako', 'Datajako']];
  const CSS = `
#km2{position:fixed;z-index:470;width:460px;height:560px;min-width:340px;min-height:360px;resize:both;overflow:hidden;display:flex;flex-direction:column;
  background:#141b26;color:#eef3f8;border:1px solid #3b4a5e;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.55);
  font:14px/1.45 system-ui,'Segoe UI',Roboto,Arial,sans-serif;}
#km2 *{box-sizing:border-box}
#km2 .km2-ots{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1d2734;border-bottom:1px solid #3b4a5e;cursor:move;user-select:none}
#km2 .km2-ots b{flex:1;font-size:15px}
#km2 button{font:inherit;color:#eef3f8;background:#2a3a4e;border:1px solid #4a5d75;border-radius:6px;padding:4px 10px;cursor:pointer}
#km2 button:hover{background:#34465c}
#km2 button.km2-ens{background:#1f7a8c;border-color:#2a9cb2}
#km2 button.km2-vaara{background:#5a2630;border-color:#8a3a48}
#km2 .km2-x{padding:2px 9px}
#km2 .km2-tabit{display:flex;gap:1px;padding:6px 4px 0;background:#18212d;border-bottom:1px solid #3b4a5e;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin}
#km2 .km2-tab{flex:1 0 auto;border:0;border-radius:6px 6px 0 0;background:transparent;color:#b9c6d4;padding:6px 7px;white-space:nowrap;font-size:13.5px}
#km2 .km2-tab.on{background:#141b26;color:#fff;font-weight:600}
#km2 .km2-luku{display:inline-block;min-width:19px;padding:0 5px;margin-left:4px;border-radius:10px;background:#d64545;color:#fff;font-size:12px;font-weight:700;line-height:19px;text-align:center}
#km2 .km2-luku.hiljaa{background:#4a5d75}
#km2 .km2-runko{flex:1;min-height:0;position:relative}
#km2 .km2-pan{position:absolute;inset:0;overflow:auto;padding:8px}
#km2 .km2-pan.piilo{display:none}
#km2 .km2-rivi{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;cursor:pointer}
#km2 .km2-rivi:hover{background:#1e2836}
#km2 .km2-rivi.valittu{background:#233246}
#km2 .km2-pää{width:40px;height:40px;flex:none;border-radius:50%;background:#26313f;overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;color:#cfe0f0;font-weight:700;font-size:16px}
#km2 .km2-pää img{position:absolute;left:50%;top:50%;width:44px;height:auto;transform:translate(-50%,-50%)}
#km2 .km2-pää.paikalla{box-shadow:0 0 0 2px #3fbf6f}
#km2 .km2-tiedot{flex:1;min-width:0}
#km2 .km2-nimi{font-weight:600}
#km2 .km2-pieni{color:#b9c6d4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#km2 .km2-aika{color:#b9c6d4;font-size:13px;flex:none}
#km2 .km2-osio{margin:10px 4px 4px;color:#9fb0c3;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
#km2 .km2-tyhja{padding:24px 12px;color:#b9c6d4;text-align:center}
#km2 .km2-kentta{width:100%;padding:7px 10px;border-radius:7px;border:1px solid #4a5d75;background:#0f151e;color:#eef3f8;font:inherit}
#km2 .km2-kentta:focus{outline:2px solid #2a9cb2;border-color:#2a9cb2}
#km2 .km2-viestit{display:flex;flex-direction:column;height:100%}
#km2 .km2-ketjuots{display:flex;align-items:center;gap:8px;padding:4px 2px 8px;border-bottom:1px solid #2c3949}
#km2 .km2-ketju{flex:1;overflow:auto;padding:8px 2px}
#km2 .km2-paivays{text-align:center;color:#9fb0c3;font-size:13px;margin:10px 0 6px}
#km2 .km2-kupla{max-width:80%;margin:3px 0;padding:7px 11px;border-radius:12px;background:#243042;word-wrap:break-word;white-space:pre-wrap}
#km2 .km2-kupla.oma{align-self:flex-end;background:#1f5f6e}
#km2 .km2-kupla .km2-klo{display:block;font-size:12px;color:#c3d0dd;margin-top:2px;text-align:right}
#km2 .km2-kupla.kutsu{background:#3a3220}
#km2 .km2-kirjoita{display:flex;gap:6px;padding-top:8px;border-top:1px solid #2c3949}
#km2 .km2-laskuri{font-size:12px;color:#b9c6d4;align-self:center;min-width:44px;text-align:right}
#km2 .km2-napit{display:flex;gap:6px;flex-wrap:wrap}
#km2 .km2-maininta{padding:9px 8px;border-radius:8px;border-left:3px solid transparent}
#km2 .km2-maininta.uusi{border-left-color:#d64545;background:#1b2431}
#km2 .km2-pan.dj{padding:0}
#km2 .dj-ikkuna>.nitro-card{height:100%}
#km2 .dj-ikkuna>.nitro-card>.nitro-card-header,#km2 .dj-kahva{display:none!important}
#km2 .dj-ikkuna .content-area{height:auto!important;flex:1;min-height:0}
.km2-nappi .km2-toolbar-luku{position:absolute;top:-4px;right:-6px;min-width:17px;padding:0 5px;border-radius:9px;background:#d64545;color:#fff;font:700 11px/17px system-ui,Arial,sans-serif;text-align:center;pointer-events:none}
`;
  function rakennaUI() {
    if (juuri) return;
    const st = el('style'); st.id = 'km2-tyyli'; st.textContent = CSS; document.head.appendChild(st);
    juuri = el('div'); juuri.id = 'km2'; juuri.style.display = 'none';
    let paikka = null; try { paikka = JSON.parse(localStorage.getItem('km2.paikka') || 'null'); } catch (e) {}
    juuri.style.left = (paikka && paikka.x != null ? paikka.x : Math.max(10, innerWidth - 490)) + 'px';
    juuri.style.top = (paikka && paikka.y != null ? paikka.y : 70) + 'px';
    if (paikka && paikka.w) { juuri.style.width = paikka.w + 'px'; juuri.style.height = paikka.h + 'px'; }
    const ots = el('div', 'km2-ots'); ots.appendChild(el('b', null, 'Viestit ja kaverit'));
    const sulje = el('button', 'km2-x', '✕', { title: 'Sulje' }); sulje.onclick = () => avaa(false); ots.appendChild(sulje);
    const tabit = el('div', 'km2-tabit');
    for (const [k, n] of VALILEHDET) { const b = el('button', 'km2-tab', n); b.dataset.k = k; b.onclick = () => { T.valilehti = k; if (k === 'viestit' && T.aktiivinen != null) T.lukematta.delete(T.aktiivinen); piirra(); }; tabit.appendChild(b); }
    runko = el('div', 'km2-runko');
    for (const [k] of VALILEHDET) { paneelit[k] = el('div', 'km2-pan piilo'); runko.appendChild(paneelit[k]); }
    juuri.append(ots, tabit, runko); document.body.appendChild(juuri);
    // pelin näppäinkuuntelijat eivät saa nähdä kirjoittamista (muuten peli siirtää fokuksen omaan chattiinsa)
    for (const tyyppi of ['keydown', 'keyup', 'keypress']) juuri.addEventListener(tyyppi, e => e.stopPropagation());
    raahattava(ots);
    new ResizeObserver(() => tallennaPaikka()).observe(juuri);
    ajoita(asennaNappi, 1500); asennaNappi();
    ajoita(paivitaMerkit, 2000);
    VW.kuplaMessenger = { versio: VERSIO, tila: T, avaa, piirra, laheta };
    loki('valmis', VERSIO);
  }
  function tallennaPaikka() { if (!elossa() || !juuri.offsetWidth) return; try { localStorage.setItem('km2.paikka', JSON.stringify({ x: juuri.offsetLeft, y: juuri.offsetTop, w: juuri.offsetWidth, h: juuri.offsetHeight })); } catch (e) {} }
  function raahattava(kahva) {
    kahva.addEventListener('pointerdown', e => { if (e.target.closest('button')) return;
      const x0 = e.clientX - juuri.offsetLeft, y0 = e.clientY - juuri.offsetTop;
      const liiku = ev => { juuri.style.left = Math.min(Math.max(0, ev.clientX - x0), innerWidth - 80) + 'px'; juuri.style.top = Math.min(Math.max(0, ev.clientY - y0), innerHeight - 40) + 'px'; };
      const loppu = () => { removeEventListener('pointermove', liiku); removeEventListener('pointerup', loppu); tallennaPaikka(); };
      addEventListener('pointermove', liiku); addEventListener('pointerup', loppu); });
  }
  function avaa(auki) {
    T.auki = auki == null ? !T.auki : !!auki; juuri.style.display = T.auki ? 'flex' : 'none';
    if (!T.auki) delete paneelit.datajako.dataset.auki;
    if (T.auki && T.valilehti === 'viestit' && T.aktiivinen != null) T.lukematta.delete(T.aktiivinen);
    if (T.auki) piirra(); paivitaMerkit();
  }
  // työkalupalkin nappi: pelin oma viesti-ikoni, lisätään ikonisäiliöön; koko palkki voi syntyä uudelleen, joten tarkistetaan 1,5 s välein
  function asennaNappi() {
    if (nappi && document.body.contains(nappi)) return;
    const sailio = document.querySelector('.nitro-toolbar-main-icons');
    nappi = el('div', 'toolbar-control text-center km2-nappi', null, { title: 'Viestit ja kaverit' });
    const ikoni = el('div', 'cursor-pointer navigation-item icon icon-message nitro-toolbar-icon sidebar-navigation-icon'); ikoni.style.position = 'relative';
    merkki = el('span', 'km2-toolbar-luku'); merkki.style.display = 'none'; ikoni.appendChild(merkki);
    const nimiko = el('div', 'toolbar-control-label w-100 text-center'); nimiko.appendChild(el('div', 'd-inline text-white fw-bold text-center nitro-small-size-text', 'Viestit'));   // sama rakenne kuin pelin Kamera-napissa
    nappi.append(ikoni, nimiko);
    nappi.onclick = () => avaa();
    if (sailio) sailio.insertBefore(nappi, sailio.firstChild);
    else { Object.assign(nappi.style, { position: 'fixed', left: '12px', bottom: '70px', zIndex: '460', cursor: 'pointer' }); document.body.appendChild(nappi); }
    paivitaMerkit();
  }
  const djUI = () => VW.kuplaDatajakoUI || null;
  const djLukematta = () => { const u = djUI(); const n = u && u.avaaja ? parseInt(u.avaaja.textContent, 10) : NaN; return Number.isFinite(n) ? n : 0; };
  const lukemattomat = () => [...T.lukematta.values()].reduce((a, b) => a + b, 0);
  const mainintojaUusia = () => T.maininnat.filter(m => !m.luettu).length;
  function paivitaMerkit() {
    // Datajako asuu nyt Viestit-ikkunan välilehdellä (Res 13.10. 07:38): sen oma kelluva 💬-nappi piiloon, lukemattomat näkyvät tämän napin luvussa
    const dju = djUI(); if (dju && dju.avaaja && dju.avaaja.style.display !== 'none') dju.avaaja.style.display = 'none';
    const yht = lukemattomat() + mainintojaUusia() + djLukematta();
    if (merkki) { merkki.textContent = yht > 99 ? '99+' : String(yht); merkki.style.display = yht ? '' : 'none'; }
    if (!juuri) return;
    const luvut = { viestit: lukemattomat(), maininnat: mainintojaUusia(), pyynnot: T.pyynnot.size, datajako: djLukematta() };
    for (const b of juuri.querySelectorAll('.km2-tab')) { const k = b.dataset.k, n = luvut[k] || 0;
      b.classList.toggle('on', k === T.valilehti); b.textContent = VALILEHDET.find(v => v[0] === k)[1];
      if (n) b.appendChild(el('span', 'km2-luku' + (k === 'pyynnot' ? ' hiljaa' : ''), String(n))); }
  }
  let ajastin = null;
  function paivitaPian() { if (ajastin) return; ajastin = setTimeout(() => { ajastin = null; if (T.auki) piirra(); paivitaMerkit(); }, 120); }
  // pää palvelimen imagerilta; tuntematon (oma) vaateosa voi palauttaa 7x1-virhekuvan -> näytetään nimen alkukirjain
  function paaEl(asu, paikalla, nimi) { const p = el('div', 'km2-pää' + (paikalla ? ' paikalla' : ''), (nimi || '?').slice(0, 1).toUpperCase());
    if (asu) { const i = el('img', null, null, { alt: '', loading: 'lazy' }); i.onload = () => { if (i.naturalWidth < 20) i.remove(); else p.firstChild && p.firstChild.nodeType === 3 && p.firstChild.remove(); }; i.onerror = () => i.remove(); i.src = paa(asu); p.appendChild(i); } return p; }
  function rivi(asu, paikalla, nimi, alarivi, oikea) {
    const r = el('div', 'km2-rivi'); const t = el('div', 'km2-tiedot');
    t.append(el('div', 'km2-nimi', nimi), el('div', 'km2-pieni', alarivi || ''));
    r.append(paaEl(asu, paikalla, nimi), t); if (oikea) r.appendChild(oikea); return r;
  }

  function piirra() {
    if (!juuri) return;
    for (const [k] of VALILEHDET) paneelit[k].classList.toggle('piilo', k !== T.valilehti);
    if (T.valilehti !== 'datajako' || !T.auki) delete paneelit.datajako.dataset.auki;
    const p = paneelit[T.valilehti]; const fokus = document.activeElement && juuri.contains(document.activeElement) ? document.activeElement.dataset.km2 : null;
    const arvo = fokus ? document.activeElement.value : null;
    ({ viestit: piirraViestit, kaverit: piirraKaverit, pyynnot: piirraPyynnot, haku: piirraHaku, maininnat: piirraMaininnat, datajako: piirraDatajako })[T.valilehti](p);
    if (fokus) { const e = p.querySelector('[data-km2="' + fokus + '"]'); if (e) { if (arvo != null && e.value !== arvo) e.value = arvo; e.focus(); } }
    paivitaMerkit();
  }

  function piirraViestit(p) {
    if (T.aktiivinen != null) return piirraKetju(p);
    p.textContent = '';
    const ketjut = [...T.ketjut.entries()].map(([id, l]) => ({ id, viimeinen: l[l.length - 1] })).filter(k => k.viimeinen).sort((a, b) => b.viimeinen.t - a.viimeinen.t);
    if (!ketjut.length) { p.appendChild(el('div', 'km2-tyhja', 'Ei vielä viestejä. Avaa keskustelu Kaverit-välilehdeltä.')); return; }
    for (const k of ketjut) { const f = T.kaverit.get(k.id) || {}; const n = T.lukematta.get(k.id) || 0;
      const oikea = el('div'); oikea.appendChild(el('div', 'km2-aika', listaAika(k.viimeinen.t))); if (n) oikea.appendChild(el('span', 'km2-luku', String(n)));
      const esikatselu = (k.viimeinen.oma ? 'Sinä: ' : '') + (k.viimeinen.kutsu ? 'Kutsu huoneeseen' : k.viimeinen.teksti);
      const r = rivi(f.asu, f.paikalla, f.nimi || nimiId(k.id), esikatselu, oikea); r.onclick = () => avaaKetju(k.id); p.appendChild(r); }
  }
  function avaaKetju(id) { T.aktiivinen = id; T.valilehti = 'viestit'; T.lukematta.delete(id); if (!T.auki) avaa(true); else piirra(); }
  function piirraKetju(p) {
    const id = T.aktiivinen, f = T.kaverit.get(id) || {}, l = T.ketjut.get(id) || [];
    p.textContent = ''; const v = el('div', 'km2-viestit');
    const ots = el('div', 'km2-ketjuots');
    const takaisin = el('button', null, '‹ Kaikki', { title: 'Takaisin keskusteluihin' }); takaisin.onclick = () => { T.aktiivinen = null; piirra(); };
    const tiedot = el('div', 'km2-tiedot'); tiedot.append(el('div', 'km2-nimi', f.nimi || nimiId(id)), el('div', 'km2-pieni', f.paikalla ? 'Paikalla' : 'Poissa'));
    ots.append(takaisin, paaEl(f.asu, f.paikalla, f.nimi || nimiId(id)), tiedot);
    const napit = el('div', 'km2-napit');
    if (f.paikalla && f.seurattava) { const s = el('button', null, 'Seuraa'); s.onclick = () => laheta(3997, [id]); napit.appendChild(s); }
    if (id > 0) { const pr = el('button', null, 'Profiili'); pr.onclick = () => laheta(3265, [id, true]); napit.appendChild(pr); }
    ots.appendChild(napit);
    const ketju = el('div', 'km2-ketju'); ketju.style.display = 'flex'; ketju.style.flexDirection = 'column';
    let edPaiva = '';
    if (!l.length) ketju.appendChild(el('div', 'km2-tyhja', 'Ei viestejä tässä istunnossa.'));
    for (const m of l) { const pv = paiva(m.t); if (pv !== edPaiva) { ketju.appendChild(el('div', 'km2-paivays', pv)); edPaiva = pv; }
      const k = el('div', 'km2-kupla' + (m.oma ? ' oma' : '') + (m.kutsu ? ' kutsu' : ''), (m.kutsu ? 'Kutsu huoneeseen: ' : '') + m.teksti);
      k.appendChild(el('span', 'km2-klo', klo(m.t) + (m.offline ? ' (kun olit poissa)' : '') + (m.virhe ? ' (ei lähtenyt)' : ''))); ketju.appendChild(k); }
    const kirjoita = el('div', 'km2-kirjoita');
    const kentta = el('input', 'km2-kentta', null, { maxlength: '255', placeholder: f.paikalla === false ? 'Kaveri on poissa' : 'Kirjoita viesti', 'data-km2': 'viesti-' + id });
    const laskuri = el('span', 'km2-laskuri', '');
    const lahetaNappi = el('button', 'km2-ens', 'Lähetä');
    const tee = () => { const teksti = kentta.value.trim(); if (!teksti) return; const ok = laheta(3567, [id, teksti.slice(0, 255)]);
      lisaaViesti(id, { oma: true, teksti: teksti.slice(0, 255), t: Date.now(), virhe: !ok }); kentta.value = ''; piirra(); };
    kentta.addEventListener('input', () => { const n = kentta.value.length; laskuri.textContent = n >= 200 ? n + '/255' : ''; });
    kentta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tee(); } });
    lahetaNappi.onclick = tee;
    kirjoita.append(kentta, laskuri, lahetaNappi);
    v.append(ots, ketju, kirjoita); p.appendChild(v);
    requestAnimationFrame(() => { ketju.scrollTop = ketju.scrollHeight; });
  }

  let suodatin = '';
  function piirraKaverit(p) {
    p.textContent = '';
    const haku = el('input', 'km2-kentta', null, { placeholder: 'Etsi kavereista', 'data-km2': 'kaverisuodatin' }); haku.value = suodatin;
    haku.addEventListener('input', () => { suodatin = haku.value; piirra(); }); p.appendChild(haku);
    const kaikki = [...T.kaverit.values()].filter(f => !suodatin || f.nimi.toLowerCase().includes(suodatin.toLowerCase())).sort((a, b) => a.nimi.localeCompare(b.nimi, 'fi'));
    if (T.kaverilistaSaatu <= 0) { p.appendChild(el('div', 'km2-tyhja', 'Kaverilista latautuu...')); return; }
    const yla = el('div', 'km2-pieni', 'Kavereita ' + T.kaverit.size + (T.raja ? ' / ' + T.raja : '')); yla.style.margin = '6px 4px'; p.appendChild(yla);
    for (const [otsikko, lista] of [['Paikalla', kaikki.filter(f => f.paikalla)], ['Poissa', kaikki.filter(f => !f.paikalla)]]) {
      p.appendChild(el('div', 'km2-osio', otsikko + ' (' + lista.length + ')'));
      for (const f of lista) { const napit = el('div', 'km2-napit');
        const v = el('button', null, 'Viesti'); v.onclick = e => { e.stopPropagation(); avaaKetju(f.id); }; napit.appendChild(v);
        if (f.paikalla && f.seurattava) { const s = el('button', null, 'Seuraa'); s.onclick = e => { e.stopPropagation(); laheta(3997, [f.id]); }; napit.appendChild(s); }
        const r = rivi(f.asu, f.paikalla, f.nimi, f.motto, napit); r.onclick = () => laheta(3265, [f.id, true]); r.title = 'Avaa profiili'; p.appendChild(r); }
    }
  }
  function piirraPyynnot(p) {
    p.textContent = '';
    const paiv = el('button', null, 'Päivitä'); paiv.onclick = () => laheta(2448, []); p.appendChild(paiv);
    if (!T.pyynnot.size) { p.appendChild(el('div', 'km2-tyhja', 'Ei kaveripyyntöjä. (Ennen skriptin latausta tulleet näkyvät Päivitä-napilla.)')); return; }
    for (const r of T.pyynnot.values()) { const napit = el('div', 'km2-napit');
      const ok = el('button', 'km2-ens', 'Hyväksy'); ok.onclick = e => { e.stopPropagation(); laheta(137, [1, r.id]); T.pyynnot.delete(r.id); piirra(); };
      const ei = el('button', 'km2-vaara', 'Hylkää'); ei.onclick = e => { e.stopPropagation(); laheta(2890, [false, 1, r.id]); T.pyynnot.delete(r.id); piirra(); };
      napit.append(ok, ei); p.appendChild(rivi(r.asu, false, r.nimi, 'Haluaa kaveriksesi', napit)); }
  }
  let hakusana = '';
  function piirraHaku(p) {
    p.textContent = '';
    const lomake = el('div', 'km2-kirjoita'); lomake.style.borderTop = '0'; lomake.style.paddingTop = '0';
    const k = el('input', 'km2-kentta', null, { maxlength: '50', placeholder: 'Pelaajan nimi', 'data-km2': 'haku' }); k.value = hakusana;
    const b = el('button', 'km2-ens', 'Hae');
    const tee = () => { hakusana = k.value.trim(); if (hakusana) { T.haku = null; laheta(1210, [hakusana]); piirra(); } };
    k.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tee(); } }); k.addEventListener('input', () => { hakusana = k.value; });
    b.onclick = tee; lomake.append(k, b); p.appendChild(lomake);
    if (!T.haku) { if (hakusana) p.appendChild(el('div', 'km2-tyhja', 'Haetaan...')); return; }
    for (const [otsikko, lista, kaveri] of [['Kaverit', T.haku.kaverit, true], ['Muut pelaajat', T.haku.muut, false]]) {
      p.appendChild(el('div', 'km2-osio', otsikko + ' (' + lista.length + ')'));
      for (const h of lista) { const napit = el('div', 'km2-napit'); const kf = T.kaverit.get(h.id);
        if (kaveri) { const v = el('button', null, 'Viesti'); v.onclick = e => { e.stopPropagation(); avaaKetju(h.id); }; napit.appendChild(v); }
        else { const lisaa = el('button', 'km2-ens', 'Lisää kaveriksi'); lisaa.onclick = e => { e.stopPropagation(); laheta(3157, [h.nimi]); lisaa.disabled = true; lisaa.textContent = 'Pyyntö lähetetty'; }; napit.appendChild(lisaa); }
        const r = rivi(h.asu, kf ? kf.paikalla : false, h.nimi, h.motto, napit); r.onclick = () => laheta(3265, [h.id, true]); p.appendChild(r); }
    }
  }
  function piirraMaininnat(p) {
    p.textContent = '';
    const napit = el('div', 'km2-napit'); napit.style.marginBottom = '6px';
    const paiv = el('button', null, 'Päivitä'); paiv.onclick = () => laheta(4803, []);
    const kaikki = el('button', null, 'Merkitse kaikki luetuiksi'); kaikki.onclick = () => { laheta(4804, [0, 0]); for (const m of T.maininnat) m.luettu = true; piirra(); };
    napit.append(paiv, kaikki); p.appendChild(napit);
    if (!T.maininnat.length) { p.appendChild(el('div', 'km2-tyhja', 'Ei mainintoja. (Ennen skriptin latausta tulleet näkyvät Päivitä-napilla.)')); return; }
    for (const m of T.maininnat) { const r = el('div', 'km2-maininta' + (m.luettu ? '' : ' uusi'));
      const yla = rivi(m.asu, false, m.lahettaja, (m.huone > 0 ? m.huoneNimi || ('huone ' + m.huone) : 'Huoneeton maininta') + '  ·  ' + mainintaAika(m.aika));
      const poista = el('button', 'km2-x', '✕', { title: 'Poista maininta' }); poista.onclick = e => { e.stopPropagation(); laheta(4805, [m.id]); T.maininnat = T.maininnat.filter(x => x.id !== m.id); piirra(); };
      yla.appendChild(poista);
      r.append(yla, el('div', null, m.viesti || 'Pelkkä @-maininta, ei viestiä'));
      r.onclick = () => { if (!m.luettu) { laheta(4804, [1, m.id]); m.luettu = true; piirra(); } };
      p.appendChild(r); }
  }
  // Datajako: oma ikkuna siirretään välilehden sisään ja sen kelluva avausnappi piilotetaan (Res 07:38: datajako pysyy asukanavalla)
  function piirraDatajako(p) {
    const u = djUI();
    if (!u || !u.ikkuna) { p.textContent = ''; p.appendChild(el('div', 'km2-tyhja', 'Datajako-lisäosa ei ole päällä tässä selaimessa.')); return; }
    const uusi = u.ikkuna.parentElement !== p; if (uusi) { p.textContent = ''; p.appendChild(u.ikkuna); }
    Object.assign(u.ikkuna.style, { position: 'relative', left: '0', top: '0', right: 'auto', bottom: 'auto', width: '100%', height: '100%', display: '', transform: 'none', zIndex: 'auto', maxWidth: 'none' });
    p.classList.add('dj');
    if (u.avaaja) u.avaaja.style.display = 'none';
    // avaa() piirtää Datajakon uudelleen: vain kun välilehti tulee näkyviin, ei jokaisesta saapuvasta paketista
    try { if (u.onPien && u.onPien()) u.pienenna(false); if (uusi || u.ikkuna.style.display === 'none' || !p.dataset.auki) { p.dataset.auki = '1'; u.avaa(); } } catch (e) {}
  }
})();
