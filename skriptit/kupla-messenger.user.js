// ==UserScript==
// @name         Kupla Messenger
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      0.5.1
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/kupla-messenger.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/kupla-messenger.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Kaverit & viestit (v3-ulkoasu), kanavat, ryhmät, maininnat ja Datajako yhden napin takana.
// @kupla-oletus off
// @author       re-lab
// ==/UserScript==
/*
 * MIKSI: Res 2026-10-13 07:27-07:40 "teetkö userscriptin siitä v3 messengeristä, lisätään siihen myös maininnat … saman napin
 *   taakse … ja paremmin luettavaks" · "datajaon ominaisuudet" (07:38: datajako PYSYY asukanavalla, tulee omaksi välilehdeksi) ·
 *   "ensin tosin userscript et voidaan tunnustella ja testaa sitä". Rakennusohje: re-lab tmp/messenger-us/RAKENNUS.md.
 *   0.2.0: Res 08:11 "tyyli ei vastaa näitä v3 sketchejä" -> ulkoasu on robo/messenger-v3 -haaran oma (MessengerView.scss käännettynä,
 *   valitsimet #km2-rajattuina, ikonit data-URI:na) ja rakenne views/*.tsx:n mukainen. MUOKKAA rakennus/osa1.js + osa2.js ja aja rakennus/kokoa.py, älä tätä tiedostoa.
 *   0.3.0: Res 08:34-08:35 -> Viestit-sivupalkissa Ryhmät ja Kanavat (Datajaon huoneet, vaatii Datajako 0.21.0) ja Datajako-välilehden
 *   tilalla Skriptit (lisäosat; packet tools ja makrot tulevat sinne).
 *   0.3.1: Res 08:47 "hahmojen päät on vinksallaan" -> päät pelin omalla piirtäjällä (90x130, hattuineen) kuten v3:ssa.
 *   0.4.0: Res 09:00 "foorumikanavat korvaa datajaon kanavat" -> Kanavat-osio käyttää messenger-pluginin kanavia (foorumipaketit
 *   negatiivisella id:llä, ChannelService). Jos palvelin ei vastaa, Datajaon kanavat kuten ennen.
 *   0.5.0: Res 09:43-09:50 -> Ryhmät-osio messenger-pluginin ryhmille (tila 5 omat, 6 kutsut): luonti, jäsenlista, kaverin kutsu,
 *   jäsenen poisto. Kutsu tulee yksityisviestinä (#ryhmakutsu:<id>) ja näkyy kortilla Liity/Hylkää-napein.
 *   0.5.1: ID-TÖRMÄYS: pluginin 9418 (poistu/hylkää) = utility RESET_RESPECT_POINTS, 9421 (uusi ryhmä) = catalog-progression.
 *   Niitä ei lähetetä, ja Poistu/Hylkää/Uusi ryhmä on piilossa kunnes plugin saa vapaat id:t.
 * MITEN: pelin React-tilaa ei saa ulkoa, joten skripti kääri clientin omat parserit (lukee jäsennetyt kentät heti parse():n jälkeen)
 *   ja lähettää clientin omilla paketeilla `conn.sendPacket(header, arvot)` (SocketConnection.ts:921). Kanavat (0.4.0)
 *   tarvitsevat messenger-pluginin ChannelServicen: foorumipaketit negatiivisella id:llä + uudet 9417-9420 (liity/poistu/luo/poista).
 * RAJAT: ennen skriptin latautumista tulleet yksityisviestit näkyvät vain pelin omassa ikkunassa. Viestit ovat vain muistissa
 *   (ei levylle). Kaverilista pyydetään uudelleen (2781) jos sitä ei näkynyt; pyynnöt ja maininnat vain Päivitä-napista, koska
 *   pelin oma client näyttäisi maininnoista kuplat uudelleen. Yksityisviesti max 255 merkkiä (palvelin leikkaa, SendMsgMessageEvent.java:30).
 */
(() => {
  'use strict';
  const VW = window;
  if (VW.__kuplaMessenger) return; VW.__kuplaMessenger = true;
  // testiä varten uudelleenasennettava: käärityt parserit kutsuvat AINA viimeisintä käsittelijätaulua (VW.__km2K)
  const VERSIO = '0.5.1';
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
  const oma = () => { const s = dv(RE(), '_sessionDataManager'); return { id: s ? s.userId : 0, nimi: s ? s.userName : '', asu: s ? s.figure : '' }; };

  // ---------- tila (vain muistissa) ----------
  const T = { kaverit: new Map(), pyynnot: new Map(), ketjut: new Map(), lukematta: new Map(), maininnat: [], haku: null,
    raja: 0, kaverilistaSaatu: 0, koukutettu: 0, aktiivinen: null, valilehti: 'viestit', auki: false,
    luonnos: new Map(), suljetut: new Set(), valitut: new Set(), pyydetyt: new Set(), suodatin: '', hakusana: '', hakuKaynnissa: false,
    paikallaAuki: true, poissaAuki: true, dialogi: null, kutsuteksti: '', suhdeAuki: null };
  const kaveri = f => ({ id: f.id, nimi: f.name, paikalla: !!f.online, seurattava: !!f.followingAllowed, asu: f.figure || '', motto: f.motto || '', suhde: f.relationshipStatus || 0 });
  const nimiId = id => (T.kaverit.get(id) || {}).nimi || ('#' + id);
  function lisaaViesti(peer, v) {
    if (!T.ketjut.has(peer)) T.ketjut.set(peer, []);
    T.suljetut.delete(peer);   // uusi viesti avaa suljetun keskustelun uudelleen
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
  // ---------- kanavat: messenger-pluginin ChannelService (Res 13.10. 09:00 "foorumikanavat korvaa datajaon kanavat") ----------
  // Kanava kulkee ryhmäfoorumin paketeissa negatiivisella id:llä: kanava 7 = foorumi -7, sen ainoa ketju = 7. Foorumilista: tila 3 = kaikki
  // kanavat, 4 = liitetyt. Vastaukset ovat foorumin omia paketteja (3001/3011/509/2049/324), joten pelin omat jäsentimet lukevat ne.
  // Ryhmät (Res 13.10. 09:43 "kanavat ja ryhmät messengerissä ja niin et voidaan heivata datajako scriptit"): yksityinen kanava samoilla
  // paketeilla. Tila 5 = omat ryhmät, 6 = kutsut. Kutsu tulee yksityisviestinä joka päättyy "#ryhmakutsu:<id>" (Res 09:50); 9417 hyväksyy,
  // 9418 hylkää. 232 ketjulle 0 vastaa jäsenlistalla (509, threadId 0).
  // Ellei palvelin vastaa tilaan 3 (plugin ei asennettu), K.tuettu = false ja Kanavat-osio näyttää Datajaon kanavat kuten ennen.
  const K = T.kanavat = { tuettu: null, kysytty: 0, lista: new Map(), liitetyt: new Set(), viestit: new Map(), hallinta: false, virhe: null, odottaa: 0, koukutettu: 0,
    ryhmat: new Set(), kutsut: new Map(), jasenet: new Map(), toimi: 0 };
  const kopioiKanava = d => ({ id: -d.groupId, nimi: d.name, kuvaus: d.description || '', yhteensa: d.totalMessages, lukematta: d.unreadMessages,
    viimeinen: d.lastMessageAuthorId > 0 ? { nimi: d.lastMessageAuthorName, t: Date.now() - d.lastMessageTimeAsSecondsAgo * 1000 } : null });
  const kopioiKanavaViesti = m => ({ id: m.messageId, ind: m.messageIndex, lahettajaId: m.authorId, nimi: m.authorName, asu: m.authorFigure,
    t: Date.now() - m.creationTime * 1000, teksti: m.messageText, tila: m.state, moderoija: m.adminName });
  function kanavaViestit(id, uudet) {
    const m = new Map((K.viestit.get(id) || []).map(v => [v.id, v])); for (const v of uudet) m.set(v.id, v);
    const l = [...m.values()].sort((a, b) => a.id - b.id); if (l.length > 300) l.splice(0, l.length - 300); K.viestit.set(id, l); return l;
  }
  const paivitaKanava = k => K.lista.set(k.id, Object.assign(K.lista.get(k.id) || {}, k));
  const kanavaAuki = id => T.auki && T.valilehti === 'viestit' && T.aktiivinen === 'k:' + id;
  const KANAVA_KASITTELIJAT = {
    3001: p => { if (p.listCode < 3 || p.listCode > 6) return; K.tuettu = true; const l = (p.forums || []).map(kopioiKanava), alku = p.startIndex === 0;
      if (p.listCode === 3) { if (alku) { const ennen = new Set([...K.lista.values()].filter(k => !k.ryhma).map(k => k.id)); for (const k of l) ennen.delete(k.id); for (const id of ennen) K.lista.delete(id); } }
      else if (p.listCode === 4) { if (alku) K.liitetyt.clear(); for (const k of l) K.liitetyt.add(k.id); }
      else if (p.listCode === 5) { if (alku) { for (const id of K.ryhmat) if (!l.some(k => k.id === id)) K.lista.delete(id); K.ryhmat.clear(); } for (const k of l) { k.ryhma = true; K.ryhmat.add(k.id); } }
      else { if (alku) K.kutsut.clear(); for (const k of l) K.kutsut.set(k.id, k); return; }   // kutsu ei ole vielä ryhmä: ei K.listaan
      l.forEach(paivitaKanava); },
    // isStaf = canModerate: kanavalla acc_channels_manage (K.hallinta), ryhmällä omistaja tai staff (ryhmän oma k.moderoi)
    3011: p => { const d = p.extendedForumData; if (!d || d.groupId >= 0) return; K.tuettu = true; const k = kopioiKanava(d);
      if (K.ryhmat.has(k.id)) k.moderoi = !!d.isStaf; else K.hallinta = !!d.isStaf; paivitaKanava(k); },
    509: p => { if (p.groupId >= 0) return; const id = -p.groupId;
      if (p.threadId === 0) { K.jasenet.set(id, (p.messages || []).map(m => ({ id: m.authorId, nimi: m.authorName, asu: m.authorFigure, t: Date.now() - m.creationTime * 1000 }))); return; }
      kanavaViestit(id, (p.messages || []).map(kopioiKanavaViesti)); if (kanavaAuki(id)) merkitseKanavaLuetuksi(id); },
    2049: p => { if (p.groupId >= 0 || !p.message) return; const id = -p.groupId, v = kopioiKanavaViesti(p.message); kanavaViestit(id, [v]);
      if (!K.ryhmat.has(id)) K.liitetyt.add(id); const k = K.lista.get(id);
      if (k) { k.yhteensa = Math.max(k.yhteensa || 0, v.ind + 1); k.viimeinen = { nimi: v.nimi, t: v.t, teksti: v.teksti };
        if (v.lahettajaId !== oma().id && !kanavaAuki(id)) k.lukematta = (k.lukematta || 0) + 1; }
      if (kanavaAuki(id)) merkitseKanavaLuetuksi(id); },
    324: p => { if (p.groupId >= 0 || !p.message) return; kanavaViestit(-p.groupId, [kopioiKanavaViesti(p.message)]); },
    // 1004 virheraportti: 400 viesti/nimi, 403 ei oikeutta tai mykistetty, 404 kanavaa ei ole. Kohdistetaan vain juuri tehtyyn kanavatoimeen.
    1004: p => { if (K.odottaa && Date.now() - K.odottaa < 4000) { K.virhe = { koodi: p.errorCode, t: Date.now(), toimi: K.toimi }; K.odottaa = 0; } },
  };
  function kysyKanavat() { K.kysytty = Date.now(); for (const tila of [3, 4, 5, 6]) laheta(873, [tila, 0, 20]); }
  function avaaKanava(id) { const k = K.lista.get(id); laheta(3149, [-id]); laheta(232, [-id, id, Math.max(0, ((k && k.yhteensa) || 0) - 50), 50]);
    if (K.ryhmat.has(id)) laheta(232, [-id, 0, 0, 100]); }
  function merkitseKanavaLuetuksi(id) {
    const l = K.viestit.get(id) || [], v = l[l.length - 1], k = K.lista.get(id); if (k) k.lukematta = 0;
    if (K.liitetyt.has(id) || K.ryhmat.has(id)) laheta(1855, [1, -id, v ? v.id : 0, !v]);
  }
  // 🔴 ID-TÖRMÄYS (mitattu livenä 13.10. 10:20): palvelimella 9418 = utility-pluginin RESET_RESPECT_POINTS (staffilta nollaa KAIKKIEN
  // respektit) ja 9421 = catalog-progressionin REQUEST_CATALOG_SPENDING_PROGRESSION. Messenger-plugin sai ne samat id:t (poistu, uusi
  // ryhmä). Näitä ei lähetetä ennen kuin plugin saa vapaat id:t (nitro/CUSTOM-PACKETS.md); napit piilotetaan (sallittu()).
  const ESTETYT = new Set([9418, 9421]), sallittu = h => !ESTETYT.has(h);
  const kanavaToimi = (h, arvot) => { if (!sallittu(h)) { loki('estetty id-törmäyksen takia, ei lähetetty', h); return false; }
    K.odottaa = Date.now(); K.virhe = null; K.toimi = h; return laheta(h, arvot); };
  const lahetaKanavaan = (id, teksti) => kanavaToimi(3529, [-id, id, '', teksti]);
  const liityKanavaan = id => { K.liitetyt.add(id); kanavaToimi(9417, [id]); };
  const poistuKanavasta = id => { K.liitetyt.delete(id); kanavaToimi(9418, [id]); };
  const luoKanava = (nimi, kuvaus) => kanavaToimi(9419, [nimi, kuvaus]);
  const poistaKanava = id => kanavaToimi(9420, [id]);
  const moderoiKanavaViesti = (id, viestiId, tila) => kanavaToimi(286, [-id, id, viestiId, tila]);
  const luoRyhma = (nimi, kuvaus) => kanavaToimi(9421, [nimi, kuvaus]);
  const kutsuRyhmaan = (id, kaveriId) => kanavaToimi(9422, [id, kaveriId]);
  const poistaJasen = (id, jasenId) => kanavaToimi(9423, [id, jasenId]);
  // kutsu poistuu listalta vasta palvelimen tilan 6 listasta; vastattu estää tuplaklikkauksen siihen asti
  const vastaaKutsuun = (id, kylla) => { const k = K.kutsut.get(id); if (k) k.vastattu = Date.now(); kanavaToimi(kylla ? 9417 : 9418, [id]); };
  const poistuRyhmasta = id => kanavaToimi(9418, [id]);
  const ryhmaKutsu = teksti => { const m = /#ryhmakutsu:(\d+)\s*$/.exec(teksti || ''); if (!m) return null; const n = /"([^"]{1,32})"/.exec(teksti); return { id: +m[1], nimi: n ? n[1] : '#' + m[1] }; };

  function koukuta() {
    const c = yhteys(); if (!c) return false;
    VW.__km2K = Object.assign({}, KASITTELIJAT, KANAVA_KASITTELIJAT, { paivita: paivitaPian });
    if (!K.koukutettu) { let n = 0; for (const id of Object.keys(KANAVA_KASITTELIJAT)) if (kaari(c, +id, KANAVA_KASITTELIJAT[id])) n++;
      if (n === Object.keys(KANAVA_KASITTELIJAT).length) K.koukutettu = Date.now(); }
    let ok = 0; for (const id of Object.keys(KASITTELIJAT)) if (kaari(c, +id, KASITTELIJAT[id])) ok++;
    if (ok === Object.keys(KASITTELIJAT).length) { if (!T.koukutettu) { T.koukutettu = Date.now(); loki('koukut asennettu', ok); } return true; }
    return false;
  }
  ajoita(h => { if (koukuta()) { clearInterval(h); rakennaUI(); } }, 150);
  // kaverilista: jos skripti latautui vasta listan jälkeen, pyydetään uudelleen (peli yhdistää kaverit id:llä, useFriends.ts:255-267)
  ajoita(() => { if (T.koukutettu && !T.kaverilistaSaatu && Date.now() - T.koukutettu > 8000) { T.kaverilistaSaatu = -1; laheta(2781, []); loki('kaverilista pyydetty uudelleen (2781)'); } }, 2000);
  // kanavat: koukut (uudelleen kunnes kaikki 6 löytyvät), sitten kysely tiloilla 3-6. Ei vastausta 6 s -> plugin ei ole palvelimella.
  ajoita(h => { if (!T.koukutettu) return; if (!K.koukutettu) { koukuta(); if (!K.koukutettu) return; }
    if (!K.kysytty) { kysyKanavat(); return; }
    if (K.tuettu === null && Date.now() - K.kysytty > 6000) { K.tuettu = false; loki('kanavat: palvelin ei vastannut foorumilistan tilaan 3 -> Datajaon kanavat'); paivitaPian(); }
    if (K.tuettu !== null) clearInterval(h); }, 1000);

  // ---------- apurit ----------
  const el = (tag, cls, teksti, attr) => { const e = document.createElement(tag); if (cls) e.className = cls; if (teksti != null) e.textContent = teksti; if (attr) for (const k in attr) e.setAttribute(k, attr[k]); return e; };
  const kaksi = n => String(n).padStart(2, '0');
  const klo = t => { const d = new Date(t); return kaksi(d.getHours()) + ':' + kaksi(d.getMinutes()); };
  const paivaNimi = t => { const d = new Date(t), n = new Date(); const ero = Math.round((new Date(n.toDateString()) - new Date(d.toDateString())) / 864e5);
    return ero === 0 ? 'Tänään' : ero === 1 ? 'Eilen' : d.getDate() + '.' + (d.getMonth() + 1) + '.' + d.getFullYear(); };
  const listaAika = t => { const d = new Date(t); return d.toDateString() === new Date().toDateString() ? klo(t) : d.getDate() + '.' + (d.getMonth() + 1) + '.'; };
  const mainintaAika = s => { if (!s) return ''; const t = s > 1e11 ? s : s * 1000; return paivaNimi(t) + ' ' + klo(t); };
  const nimiJarjestys = (a, b) => a.nimi.localeCompare(b.nimi, 'fi', { sensitivity: 'base' });
  // pelin oma FaTimes-ristikuvake (react-icons), sama kuin pelin ikkunoiden sulkunapissa
  const risti = cls => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 352 512'); s.setAttribute('fill', 'currentColor');
    s.setAttribute('class', cls || 'km-x'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M242.72 256l100.07-100.07c12.28-12.28 12.28-32.19 0-44.48l-22.24-22.24c-12.28-12.28-32.19-12.28-44.48 0L176 189.28 75.93 89.21c-12.28-12.28-32.19-12.28-44.48 0L9.21 111.45c-12.28 12.28-12.28 32.19 0 44.48L109.28 256 9.21 356.07c-12.28 12.28-12.28 32.19 0 44.48l22.24 22.24c12.28 12.28 32.2 12.28 44.48 0L176 322.72l100.07 100.07c12.28 12.28 32.2 12.28 44.48 0l22.24-22.24c12.28-12.28 12.28-32.19 0-44.48L242.72 256z');
    s.appendChild(p); return s; };
  const nappiEl = (cls, teksti, ikoni, fn) => { const b = el('button', 'km-btn' + (cls ? ' ' + cls : ''), null, { type: 'button' });
    if (ikoni) b.appendChild(ikoni instanceof Node ? ikoni : el('span', 'km-icon ' + ikoni)); if (teksti) b.appendChild(document.createTextNode(teksti));
    if (fn) b.onclick = e => { e.stopPropagation(); fn(e); }; return b; };
  const ib = (ikoni, otsikko, fn) => { const b = el('button', 'km-ib', null, { type: 'button', title: otsikko, 'aria-label': otsikko });
    b.appendChild(ikoni instanceof Node ? ikoni : el('span', 'km-icon ' + ikoni)); b.onclick = e => { e.stopPropagation(); fn(e); }; return b; };
  const merkkiEl = (n, hiljaa) => n > 0 ? el('span', 'km-badge' + (hiljaa ? ' is-muted' : ''), n > 99 ? '99+' : String(n)) : null;
  const tyhja = (teksti, toiminto, fn) => { const e = el('div', 'km-empty', teksti); if (toiminto) { e.appendChild(el('br')); const a = el('span', 'km-sec-action', toiminto, { role: 'button' }); a.onclick = fn; e.appendChild(a); } return e; };

  // Avatar: palvelimen oma kuvapalvelu (headonly, size=l = 64x84; size=s on vain 16x16, mitattu 13.10.).
  // Tuntematon oma vaateosa voi palauttaa 7x1-virhekuvan -> nimen alkukirjain. Tulos muistetaan, ettei uudelleenpiirto välky.
  // Kuvapalvelu rajaa kuvan sisällön mukaan (64x84 tavallinen pää, 90x136 hatun ja pitkien hiusten kanssa, mitattu 13.10.), joten
  // hattu (ha) ja pääkoriste (he) jätetään pois ympyrästä ja kuva ankkuroidaan yläreunasta: hiusten yläreuna on pään yläreuna.
  const KUVATILA = new Map();
  const ilmanHattua = asu => String(asu).split('.').filter(o => !/^(ha|he)-/.test(o)).join('.');
  const paaUrl = (asu, suunta) => location.origin + '/avatarimage?figure=' + encodeURIComponent(ilmanHattua(asu)) + '&headonly=1&size=l&direction=' + suunta + '&head_direction=' + suunta;
  // 0.3.1 (Res 08:47 "hahmojen päät on vinksallaan ... vs sketchit"): ensisijaisesti pelin OMA piirtäjä, kuten v3:n LayoutAvatarImageView
  // (createAvatarImage LARGE, setDirection('head'), processAsImageUrl('head')). Se antaa aina saman 90x130-kankaan hattuineen, jolle
  // v3:n oma CSS (background-position 50% -36px / -32px) on mitattu. Piirtäjään päästään huoneen avatar-visualisoinnin datasta
  // (AvatarVisualizationData.createAvatarImage kutsuu GetAvatarRenderManageria); ilman huonetta käytetään palvelimen kuvaa kuten ennen.
  const PELIKUVA = new Map();
  function pelinPiirtaja() {
    if (VW.__km2AvData) return VW.__km2AvData;
    try { const re = VW.NitroDevTools && VW.NitroDevTools.roomEngine, h = re && re._roomManager && re._roomManager._rooms;
      if (h) for (const r of h.values()) { const ob = r && r._renderer && r._renderer._objects; if (!ob) continue;
        for (const x of ob.values()) { const d = x && x._visualization && x._visualization._data;
          if (d && typeof d.createAvatarImage === 'function') return (VW.__km2AvData = d); } } } catch (e) {}
    return null;
  }
  function pelinPaa(asu, suunta) {
    const avain = asu + '|' + suunta; if (PELIKUVA.has(avain)) return PELIKUVA.get(avain);
    const d = pelinPiirtaja(); if (!d) return null;
    try {
      let kuva = null, valmis = false;
      const piirra1 = () => { try { const u = kuva.processAsImageUrl('head'); if (u) PELIKUVA.set(avain, u); } catch (e) {} };
      const loppu = () => { if (valmis) return; valmis = true; try { kuva.dispose(); } catch (e) {} };
      kuva = d.createAvatarImage(asu, 64, 'M', { resetFigure: () => { if (valmis) return; piirra1(); loppu(); paivitaPian(); }, dispose: () => {}, get disposed() { return valmis; } });
      if (!kuva) return null;
      kuva.setDirection('head', suunta); piirra1();
      setTimeout(loppu, 8000);   // osat jo ladattu -> resetFigurea ei tule
      return PELIKUVA.get(avain) || null;
    } catch (e) { return null; }
  }
  function avatar(asu, o) {
    o = o || {};
    const w = el('div', 'km-avw'), a = el('div', 'km-av' + (o.iso ? ' is-large' : '')), k = el('div', 'avatar-image km-imager');
    a.appendChild(k); w.appendChild(a);
    if (o.paikalla !== undefined) w.appendChild(el('span', 'km-dot' + (o.paikalla ? ' is-online' : '')));
    const alku = () => { k.classList.add('km-alku'); k.textContent = (o.nimi || '?').slice(0, 1).toUpperCase(); };
    if (!asu) { alku(); return w; }
    const peli = pelinPaa(asu, o.suunta || 2);
    if (peli) { k.style.backgroundImage = 'url("' + peli + '")'; return w; }
    const url = paaUrl(asu, o.suunta || 2), tila = KUVATILA.get(url);
    if (tila && tila.w) { const sk = o.iso ? 0.94 : 0.78;
      k.style.setProperty('background-image', 'url("' + url + '")', 'important');
      k.style.setProperty('background-size', Math.round(tila.w * sk) + 'px auto', 'important');
      k.style.setProperty('background-position', '50% ' + (o.iso ? -14 : -11) + 'px', 'important'); }
    else if (tila === 'virhe') alku();
    else if (!tila) { KUVATILA.set(url, 'lataa'); const im = new Image();
      im.onload = () => { KUVATILA.set(url, im.naturalWidth >= 20 ? { w: im.naturalWidth, h: im.naturalHeight } : 'virhe'); paivitaPian(); };
      im.onerror = () => { KUVATILA.set(url, 'virhe'); paivitaPian(); }; im.src = url; }
    return w;
  }

  // ---------- käyttöliittymä: robo/messenger-v3 -haaran ulkoasu (MessengerView.scss + views/*.tsx), Resin pyynnöstä 13.10. 08:11 ----------
  let juuri, kortti, tabit, nappi, nappiMerkki; const paneelit = {};
  const VALILEHDET = [
    { k: 'viestit', ikoni: 'chat', nimi: 'Viestit' },
    { k: 'kaverit', ikoni: 'friends', nimi: 'Kaverit' },
    { k: 'pyynnot', ikoni: 'requests', nimi: 'Pyynnöt' },
    { k: 'haku', ikoni: 'search', nimi: 'Haku' },
    { k: 'maininnat', ikoni: 'at', nimi: 'Maininnat' },
    { k: 'skriptit', ikoni: 'koodi', nimi: 'Skriptit' },
  ];
  const IKONIT = {"chat": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABUAAAAVCAYAAACpF6WWAAAAh0lEQVR4Ad3PsQmAMBQGYUdxAidwBGvHcACncA07B3AetxAlhUeKkCccNv5wTRI+tBG7iElsXE8CtxjtBKyxfjnygA0WoAIL0Bjrpi31Gq1hgM+AKyiHCQQjh+agR9th/gRN/QIFDkH7pQQoUTBAJn4/xxTKvUcBeBOgrISCld4FKAOh0oL7G0g4Bqt8Qk8aAAAAAElFTkSuQmCC", "friends": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACMAAAAhCAMAAABkz+JgAAABF1BMVEX///9rlqhslqgkNTwlNT1rlagkNDwsQkosQkt3WywAAACeMS+vlnlZSDRZSDWWeViWelhaSDUkNTxgTjhaSTUlNT1uQh1vQh2wl3rJkV6wlnmdMS9JKxMsQkphTjmRVybJkl5KPCzKkl6McFKdMC6VeVihdEslNTxhTzlgTjlvKSgkNDxvQx5JLBNvKimSWCZIKxKUMC6RdVUtQkuRWCZ4VzgsQkuhdUtwKimWdDeVMC6RdlVkUDuwl3mLcFJQQS9LPSyhdErKkl+WczdjUDqVMS9wW0J5VzmQdVSRVyWVeVeQdVVPQC9QQC+McVKdMS5vWkFvKihkUTt3Wyx3XC2skHKVMC9FOClfTTl2WyxLPCyWdDhfTTgVKrGnAAAACnRSTlMAAAAAAAAAAAAAc6AYaAAAAoZJREFUeF5909WS21AQBFDLtJu+YgYz0zIzhpnx/78jPVd5SVWyUyq/3OOeliVX/hrIVB4a4Droz/oPKcz6nf7sx/x69n8EEkGdToAKyvkXmc14zXMgSVZbyf5Wqap6DANcFQSzIM3TCwoa+ehuQUytVq8B8NEPOh3TNNMcyWo/6VJoRWTU1tcQHbYjBJ3AzNPcNGlIiJgVJwkqRh2I2r5PEyDnuO/0queCVkBMU0Xkt/2pv0SAJ2mep0jRohESI8uwYg78dhT5ke8D45SraDZWMVHcJekdQcweCXdFyF8wR/q0WnFLFvWybPKUneHvkSypiMwL08xzmg204hhHBxkGYpZtEi5j0GfIjQHbGzhAggwZL53DYdJ0GQE5UuawNCYQMMgm2mixJIO1CxN6tnEzyFg4w+RWTMRzWQUvPHvJZWaOeyIRPZa+0YYhTJkidJyzXcg4YwA8H0DXqTQQSWNZ5brO7v35h3vXdeXwNhv0qGiq0D/hlLtonjmOg7GFxRciPcdEBo3PKBo5dx3HJlmcPpZGPSwU9DM9lD4R4Lq8LDu0sVkUOzs6RRU01XodviCkADzbs4eX/LZSp4vNxUgVSkyt1gSiaIk0xSvbuhxaNo4LpXaUnjJHXkQimCleD9/YthdiU6kRSqL71JrNerMGH3mOc8sKw+EQi6KAGqm3qih0TrVR5awBuYkrK7wc6qoKPJegEU3DaAhbh/S5Yl+EHk0BikIVI6VzDMnBkn1yAJbFzu+V0oauNIwxpLNjmrBDz8IvuXf2KUVGowfyPo9d2J5nY65NeU8fMZA+sg36hcbcsy2POQQQ8enuBPK8KIwG+P9Z4us327NkVw8y33+e3OFRpfIbFMJVtcchyzUAAAAASUVORK5CYII=", "requests": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB8AAAAiCAMAAACQlPJ4AAAAb1BMVEU+TlY/Tle7zdc+TVYpWmQYMzlhTzkpWmVgTjkYMzq6zda6zdc/TlZhTjkXMzkoWmRgTjgoWWQ4fIoAAAAXMjkTKS0+Tla7zde6zNY/TlYTKS66zde6zdY+TVY/TlcAAAB00k4UKS5z0U500U4TKC2kacgTAAAAFXRSTlMAAAAAAAAAAAAAAAAAAAAAAAAAAABzkhMSAAAB+ElEQVR4XjVUCbajMAxzgO5/n3HWBWjn/mccyeG7pSmWZcmmr3Ji3E4fysi4cIfMx+n2F+mbXMU5caq9e9976l71H+qyMC8neRcnswI0tPmOE7VdgTr5I2dRAcw0MJzJszaNgh+55paZJq2ROd6IjIofOauxmgea0tHcm1JXuQjIZB/5RhNHeODfoiz0iVAzaZM4DCn5I0Hu4YKM4RG4ju/ME+Ar/fo0fvOeeQJHa+gY3nxT2YF66NOZWTV/NcSAI6mo2WNtO7zhCCHGWIFk2cE0Hjv4ldFDDaXWig6/u23HFOu2vVYgIfDDHzilh/y6vV4r0QIDoWfOP9qbYeLbCoRRaxbMT/fcRTLt7fm0sxaIqANuw9I9tJ8brtdrQ48KPvGzetrDLXDCcAgNTBCqzt/AbauGPwGOWEMp0fhfTumw1mi6KOHB/kP/HTg3ZOOGdXAr5DBFNlyUqwuBjsDn/LGyIijmu9rPt6cS4Sis9M7Ri83vFjnP4sxCCSUOD+zE9VXyzyLi+JBsI9HmLlYBfVkGLgqL5IxHE0etOtN3wN+y5lgSs1xMiSzL8xtwkRkWp7uC1emb7gt1VOZFvozuHtNO0T4eXCykTyKcn3w3PSalqgfPSnSf7gN3grg/JhQEWyJb6zQBx/4uy+fFYrksed/38S9xOeLzPyKsWw7cE9IyAAAAAElFTkSuQmCC", "search": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAYAAABWdVznAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABSSURBVChTrZDRDgAQDAPL//8zIbY0TfHAvSzmOpkCT1uVma4LODkoGmCZ77JfV1V0UJ53gS3fArp4np9+KcTRc6HpRoAF92qi047ygJe+ygDQASfpCxL/V9w3AAAAAElFTkSuQmCC", "follow": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAPAgMAAACQHae8AAAACVBMVEX///8AAAAb2AAnw6rbAAAAAXRSTlMAQObYZgAAADtJREFUeF5NyKERACEQxdCYK+H6WYNfwe8ABPRDE1QJCwbzJhPgNzA5eFA2aps+D8Oi7D6qMkiCFHwvC3JUEFNhwuyeAAAAAElFTkSuQmCC", "profile": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAMBAMAAACZySCyAAAAJ1BMVEX///+RkZH09PT////rwoHrwoDswoDqwoDYk2HYlGHrwYDpwX/Zk2HDsc8wAAAAAXRSTlMAQObYZgAAAFFJREFUeF5VzLENgDAMBEBHWYDkkajxBFhMkIIRWIEi2zANKzBWHDsFfPE6ffEUkmUi7Bb5YDngeG9IgqKWsZyPLoo8X5mZV+r9h/gzKPrh1gBQjQ9ajffB6wAAAABJRU5ErkJggg==", "start-chat": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAOAgMAAABbQXQZAAAACVBMVEX///////8AAACO9MPsAAAAAXRSTlMAQObYZgAAADdJREFUeF51yqENACAMRcGnmQJTwkKfMANTsAS+BtMpCUFjTh0pwjGps6T25ZW0h4NNoADUS4YDzx0Ql4GNbg8AAAAASUVORK5CYII=", "add": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABkAAAAZBAMAAAA2x5hQAAAAElBMVEX///8AAAB3v0Nloznk4uLS0NCoLOgPAAAAAXRSTlMAQObYZgAAAF9JREFUeF590NEJwCAMBuF2Aw/qAlnBCQpdwId//1WKGlSK9d4+JIR4bDvxQlGUl8uTHk+h6YZrklmXlM2itFIGM4guq62VamtBSuBS09hXpv4EkwRyjWvL8fQ+/7LtBUboLihV41V4AAAAAElFTkSuQmCC", "invite": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAANAgMAAAA24r20AAAACVBMVEX///8AAAD///9+749PAAAAAXRSTlMAQObYZgAAAEJJREFUeF4lzCEOgFAMg+Ei3tHwkICZn9l9OMIE/ynpgvnSLO0kHTIrx6jTkWpH6rlUxG37HQOb4HvAPs3eZvV/MB/g3BMN7OqiyQAAAABJRU5ErkJggg==", "remove": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA0AAAANCAYAAABy6+R8AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAACxMAAAsTAQCanBgAAABJSURBVChTY2TADv5DaRDAUIMsgKwQFwCrh2kiRgMMwC0CaSKkEa6GLJvI8hMTmIkKYAah03CATRNBMMg1kRV66CGDTyNULQMDACkBCxHze4N3AAAAAElFTkSuQmCC", "home": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA0AAAALAQMAAACefJUiAAAABlBMVEX///8AAABVwtN+AAAAAXRSTlMAQObYZgAAACtJREFUeF49wrENABAQAMCLRmkEa+iMxmhG+RGUOjrJSWTKVJcexnaPFt8DgvAKXXvwnfgAAAAASUVORK5CYII="};
  const CSS = `.badge.km-badge,
.km-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  border: 0 !important;
  border-radius: 8px;
  background: #e5484d !important;
  color: #fff;
  font-size: 10px;
  font-weight: bold;
  line-height: 16px;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.55);
}
.badge.km-badge.is-muted,
.km-badge.is-muted {
  background: var(--colors-secondary, #267f93) !important;
}
.km-badge.km-toolbar-count {
  position: absolute;
  top: 2px;
  right: 2px;
  z-index: 1;
  pointer-events: none;
}
#km2 .km-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 2.5px solid #0f1724;
  background: #4a5568;
}
#km2 .km-dot.is-online {
  background: #3ecf5a;
}
#km2 .nitro-card.kupla-messenger {
  width: 720px;
  height: 540px;
  min-width: 560px;
  min-height: 400px;
  max-width: 100vw;
  max-height: 100vh;
  background: #0b1018;
  border: 1px solid #2c4566;
  border-radius: 10px !important;
  box-shadow: 0 0 0 1px #000, 0 18px 50px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  color: #dce6f2;
  font-size: 13px;
}
#km2 .nitro-card.kupla-messenger .nitro-card-header {
  min-height: 40px;
  max-height: 40px;
  padding: 0 12px;
  background: linear-gradient(#17283d, #101b2a);
  border-bottom: 1px solid #22364f;
}
#km2 .nitro-card.kupla-messenger .nitro-card-header .nitro-card-header-text {
  font-size: 14px;
  letter-spacing: 0.01em;
}
#km2 .nitro-card.kupla-messenger button {
  font-family: inherit;
}
#km2 .nitro-card.kupla-messenger .km-icon {
  display: inline-block;
  flex: none;
  background: center/contain no-repeat;
  image-rendering: pixelated;
}
#km2 .nitro-card.kupla-messenger .km-icon.chat {
  width: 17px;
  height: 16px;
  background-image: url("__IKONI_chat__");
}
#km2 .nitro-card.kupla-messenger .km-icon.friends {
  width: 18px;
  height: 16px;
  background-image: url("__IKONI_friends__");
}
#km2 .nitro-card.kupla-messenger .km-icon.requests {
  width: 18px;
  height: 16px;
  background-image: url("__IKONI_requests__");
}
#km2 .nitro-card.kupla-messenger .km-icon.search {
  width: 13px;
  height: 13px;
  background-image: url("__IKONI_search__");
}
#km2 .nitro-card.kupla-messenger .km-icon.follow {
  width: 16px;
  height: 14px;
  background-image: url("__IKONI_follow__");
}
#km2 .nitro-card.kupla-messenger .km-icon.profile {
  width: 14px;
  height: 14px;
  background-image: url("__IKONI_profile__");
}
#km2 .nitro-card.kupla-messenger .km-icon.start-chat {
  width: 16px;
  height: 14px;
  background-image: url("__IKONI_start-chat__");
}
#km2 .nitro-card.kupla-messenger .km-icon.add {
  width: 16px;
  height: 15px;
  background-image: url("__IKONI_add__");
}
#km2 .nitro-card.kupla-messenger .km-icon.invite {
  width: 19px;
  height: 13px;
  background-image: url("__IKONI_invite__");
}
#km2 .nitro-card.kupla-messenger .km-icon.home {
  width: 13px;
  height: 11px;
  background-image: url("__IKONI_home__");
}
#km2 .nitro-card.kupla-messenger .km-icon.remove {
  width: 13px;
  height: 13px;
  background-image: url("__IKONI_remove__");
}
#km2 .km-tabs {
  display: flex;
  flex: none;
  gap: 4px;
  padding: 8px 12px;
  background: #0f1724;
  border-bottom: 1px solid #22364f;
}
#km2 .km-tab {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #7f92aa;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
#km2 .km-tab:hover {
  background: rgba(255, 255, 255, 0.04);
  color: #dce6f2;
}
#km2 .km-tab.is-active {
  background: #18263a;
  color: #dce6f2;
  box-shadow: inset 0 0 0 1px #2c4566;
}
#km2 .km-tab .km-tab-meta {
  color: #7f92aa;
  font-weight: normal;
}
#km2 .km-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
#km2 .km-pane {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
#km2 .km-pane.is-hidden {
  display: none;
}
#km2 .km-side {
  display: flex;
  flex-direction: column;
  width: 240px;
  flex: none;
  min-height: 0;
  background: #0f1724;
  border-right: 1px solid #22364f;
}
#km2 .km-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 8px;
}
#km2 .km-scroll::-webkit-scrollbar {
  width: 8px;
}
#km2 .km-scroll::-webkit-scrollbar-thumb {
  background: #2c4566;
  border-radius: 4px;
}
#km2 .km-scroll::-webkit-scrollbar-track {
  background: transparent;
}
#km2 .km-sec {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 14px 4px;
  color: #7f92aa;
  font-size: 10.5px;
  font-weight: bold;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
#km2 .km-sec.is-toggle {
  width: calc(100% - 28px);
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
#km2 .km-sec.is-toggle:hover {
  color: #dce6f2;
}
#km2 .km-sec .km-caret {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid currentColor;
  transition: transform 0.12s;
}
#km2 .km-sec .km-caret.is-closed {
  transform: rotate(-90deg);
}
#km2 .km-sec .km-sec-action {
  margin-left: auto;
  color: var(--colors-secondary, #267f93);
  font-size: 10px;
  letter-spacing: 0.02em;
  text-transform: none;
  cursor: pointer;
}
#km2 .km-sec .km-sec-action:hover {
  text-decoration: underline;
}
#km2 .km-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 36px;
  margin: 1px 8px;
  padding: 0 8px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
}
#km2 .km-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
#km2 .km-row.is-active,
#km2 .km-row.is-selected {
  background: linear-gradient(90deg, rgba(38, 127, 147, 0.25), rgba(38, 127, 147, 0.06));
  box-shadow: inset 2px 0 0 var(--colors-secondary, #267f93);
}
#km2 .km-row.is-tall {
  height: 44px;
}
#km2 .km-row.is-offline .km-name {
  color: #7f92aa;
}
#km2 .km-row.is-offline .km-av {
  filter: grayscale(0.8) brightness(0.7);
}
#km2 .km-avw {
  position: relative;
  flex: none;
}
#km2 .km-av {
  position: relative;
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 50%;
  overflow: hidden;
  background: #1d2e44;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
}
#km2 .km-av .avatar-image {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  transform: none !important;
  background-size: auto !important;
  background-repeat: no-repeat !important;
  background-position: 50% -36px !important;
  image-rendering: pixelated;
}
#km2 .km-av.is-large {
  width: 44px;
  height: 44px;
}
#km2 .km-av.is-large .avatar-image {
  background-position: 50% -32px !important;
}
#km2 .km-nm {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  line-height: 1.2;
}
#km2 .km-nm .km-name,
#km2 .km-nm small {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
#km2 .km-nm small {
  color: #7f92aa;
  font-size: 11px;
}
#km2 .km-row-meta {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  min-width: 32px;
}
#km2 .km-row-meta time {
  color: #7f92aa;
  font-size: 10.5px;
  line-height: 12px;
}
#km2 .km-row-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
}
#km2 .km-ib {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: #7f92aa;
  cursor: pointer;
}
#km2 .km-ib:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #dce6f2;
}
#km2 .km-ib:disabled {
  opacity: 0.4;
  cursor: default;
}
#km2 .km-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  flex: none;
  border: 0;
  border-radius: 7px;
  background: #18263a;
  box-shadow: inset 0 0 0 1px #2c4566;
  color: #dce6f2;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
#km2 .km-btn:hover {
  background: #1f324c;
}
#km2 .km-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
#km2 .km-btn.is-danger {
  background: rgba(229, 72, 77, 0.14);
  box-shadow: inset 0 0 0 1px rgba(229, 72, 77, 0.45);
  color: #ff9a9d;
}
#km2 .km-btn.is-danger:hover {
  background: rgba(229, 72, 77, 0.24);
}
#km2 .km-btn.is-primary {
  background: linear-gradient(#18b842, #0e8a2c);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.19);
  color: #fff;
  font-weight: bold;
}
#km2 .km-btn.is-primary:hover {
  filter: brightness(1.1);
}
#km2 .km-btn.is-square {
  width: 28px;
  padding: 0;
  justify-content: center;
}
#km2 .km-search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  margin: 10px;
  padding: 0 10px;
  flex: none;
  border: 1px solid #22364f;
  border-radius: 7px;
  background: #070b11;
}
#km2 .km-search:focus-within {
  border-color: #2c4566;
}
#km2 .km-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #dce6f2;
  font-size: 13px;
}
#km2 .km-search input::placeholder {
  color: #7f92aa;
}
#km2 .km-empty {
  margin: 18px 16px;
  color: #7f92aa;
  font-size: 12px;
  line-height: 1.45;
  text-align: center;
}
#km2 .km-empty.is-inline {
  margin: 4px 22px 8px;
  text-align: left;
}
#km2 .km-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: #0b1018;
}
#km2 .km-mh {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 14px;
  flex: none;
  border-bottom: 1px solid #22364f;
}
#km2 .km-mh .km-mh-title {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
#km2 .km-mh .km-mh-title b {
  overflow: hidden;
  font-size: 15px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
#km2 .km-mh .km-mh-title span {
  color: #7f92aa;
  font-size: 12px;
}
#km2 .km-mh .km-mh-actions {
  display: flex;
  gap: 6px;
}
#km2 .km-msgs {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  padding: 10px 16px;
  overflow-y: auto;
  overflow-x: hidden;
}
#km2 .km-msgs::-webkit-scrollbar {
  width: 8px;
}
#km2 .km-msgs::-webkit-scrollbar-thumb {
  background: #2c4566;
  border-radius: 4px;
}
#km2 .km-sys {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 2px 0 6px;
  padding: 8px 12px;
  border: 1px solid rgba(19, 163, 56, 0.33);
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(19, 163, 56, 0.13), rgba(19, 163, 56, 0.04));
  font-size: 12.5px;
}
#km2 .km-sys.is-notice {
  border-color: #22364f;
  background: #131e2e;
  color: #7f92aa;
  font-size: 12px;
}
#km2 .km-sys.is-invite {
  align-self: flex-start;
  max-width: 100%;
  border-color: #2c4566;
  background: #18263a;
  color: #dce6f2;
}
#km2 .km-sys .km-sys-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
#km2 .km-day {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0;
  color: #7f92aa;
  font-size: 11px;
}
#km2 .km-day::before,
#km2 .km-day::after {
  content: "";
  flex: 1;
  height: 1px;
  background: #22364f;
}
#km2 .km-m {
  display: flex;
  gap: 11px;
  padding: 6px;
  border-radius: 8px;
}
#km2 .km-m:hover {
  background: rgba(255, 255, 255, 0.025);
}
#km2 .km-m .km-m-body {
  flex: 1;
  min-width: 0;
}
#km2 .km-m .km-who {
  font-size: 13px;
  font-weight: bold;
}
#km2 .km-m .km-who .km-ts {
  margin-left: 7px;
  color: #7f92aa;
  font-size: 11px;
  font-weight: normal;
}
#km2 .km-m.is-own .km-who > span:first-child {
  color: #62c1d6;
}
#km2 .km-m .km-txt {
  margin-top: 2px;
  color: #c9d6e5;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
#km2 .km-inp {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  margin: 6px 14px 14px;
  padding: 0 6px 0 12px;
  flex: none;
  border: 1px solid #2c4566;
  border-radius: 9px;
  background: #070b11;
}
#km2 .km-inp input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #dce6f2;
  font-size: 13px;
}
#km2 .km-inp input::placeholder {
  color: #7f92aa;
}
#km2 .km-inp .km-counter {
  flex: none;
  color: #7f92aa;
  font-size: 11px;
}
#km2 .km-inp .km-counter.is-full {
  color: #ff9a9d;
  font-weight: bold;
}
#km2 .km-inp .km-btn.is-primary {
  height: 30px;
  padding: 0 14px;
}
#km2 .km-col {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: #0f1724;
}
#km2 .km-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 12px;
  flex: none;
}
#km2 .km-toolbar .km-search {
  flex: 1;
  margin-right: 0;
}
#km2 .km-toolbar .km-toolbar-meta {
  flex: none;
  color: #7f92aa;
  font-size: 12px;
}
#km2 .km-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  flex: none;
  border-top: 1px solid #22364f;
  background: #0f1724;
}
#km2 .km-footer .km-footer-spacer {
  flex: 1;
}
#km2 .km-check {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px #2c4566;
  background: #070b11;
}
#km2 .km-check.is-on {
  background: var(--colors-secondary, #267f93);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
}
#km2 .km-rel {
  position: absolute;
  top: 32px;
  right: 8px;
  z-index: 5;
  display: flex;
  gap: 4px;
  padding: 6px;
  border-radius: 8px;
  background: #131e2e;
  box-shadow: 0 0 0 1px #2c4566, 0 8px 20px rgba(0, 0, 0, 0.6);
}
#km2 .km-rel-icon {
  display: inline-block;
}
#km2 .km-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(5, 8, 12, 0.7);
}
#km2 .km-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 340px;
  max-width: 100%;
  max-height: 100%;
  padding: 14px;
  border-radius: 10px;
  background: #131e2e;
  box-shadow: 0 0 0 1px #2c4566, 0 12px 32px rgba(0, 0, 0, 0.7);
}
#km2 .km-dialog h3 {
  margin: 0;
  font-size: 14px;
  font-weight: bold;
}
#km2 .km-dialog p {
  margin: 0;
  color: #7f92aa;
  font-size: 12px;
  line-height: 1.45;
}
#km2 .km-dialog .km-dialog-list {
  max-height: 120px;
  overflow-y: auto;
  color: #dce6f2;
  font-size: 12px;
  overflow-wrap: anywhere;
}
#km2 .km-dialog textarea {
  min-height: 70px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid #2c4566;
  border-radius: 7px;
  outline: 0;
  background: #070b11;
  color: #dce6f2;
  font-size: 13px;
}
#km2 .km-dialog .km-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
@media (max-width: 600px) {
#km2 .nitro-card.kupla-messenger {
    width: 100vw;
    min-width: 0;
    height: 80vh;
    min-height: 0;
  }
#km2 .km-side {
    width: 40%;
    min-width: 140px;
  }
#km2 .km-tab {
    padding: 0 8px;
    gap: 5px;
  }
#km2 .km-mh {
    gap: 6px;
    padding: 0 8px;
  }

}


#km2{position:fixed;z-index:470}
#km2 .nitro-card.kupla-messenger{resize:both;overflow:hidden}
#km2 .nitro-card.kupla-messenger .nitro-card-header{cursor:move;user-select:none}
#km2 .nitro-card.kupla-messenger .km-icon.at{width:auto;height:16px;line-height:16px;font-weight:bold;font-size:14px;color:#62c1d6;background:none}
#km2 .nitro-card.kupla-messenger .km-icon.at::before{content:"@"}
#km2 .nitro-card.kupla-messenger .km-icon.koodi{width:auto;height:16px;line-height:16px;font-weight:bold;font-size:12px;color:#62c1d6;background:none;font-family:monospace}
#km2 .nitro-card.kupla-messenger .km-icon.koodi::before{content:"</>"}
#km2 .km-av.km-djav{display:flex;align-items:center;justify-content:center;color:#62c1d6;font-weight:bold;font-size:17px}
#km2 .km-av.km-djav.is-ryhma::before{content:"";width:16px;height:14px;background:center/contain no-repeat url("__IKONI_friends__");image-rendering:pixelated}
#km2 .km-djpaikka{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
#km2 .km-djpaikka .dj-takaisin{display:none!important}
#km2 .km-djpaikka > .dj-ikkuna{position:relative!important;inset:auto!important;flex:1;min-height:0;display:flex;flex-direction:column}
#km2 .km-sec .km-sec-ohje{margin-left:auto;font-weight:normal;letter-spacing:0;text-transform:none;font-size:10.5px}
#km2 .km-txt .km-mod{margin-left:8px;font-size:10.5px;color:#7f92aa;cursor:pointer;text-decoration:underline}
#km2 .km-txt.km-piilossa{font-style:italic;color:#7f92aa}
#km2 .km-row.is-kutsu{cursor:default}
#km2 .km-kutsu-napit{display:flex;gap:6px;align-items:center;margin-top:6px}
#km2 .km-row.is-kutsu .km-kutsu-napit{margin-top:0}
#km2 .km-kutsu-napit .km-btn{height:24px;min-width:0;padding:0 10px;font-size:11px}
#km2 .km-dialog.km-dialog-jasenet{max-height:calc(100% - 24px);overflow:auto}
#km2 .km-jasenet{flex:0 0 auto;max-height:150px;overflow:auto;margin:6px 0;display:flex;flex-direction:column;gap:2px}
#km2 .km-jasen{display:flex;align-items:center;gap:8px;padding:2px 0}
#km2 .km-jasen .km-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#km2 .km-jasen .km-mod{font-size:11px;color:#7f92aa;cursor:pointer;text-decoration:underline}
#km2 .km-dialog .km-virhe{color:#e8a0a0;font-size:12px;margin:6px 0 0}
#km2 .km-tulossa{padding:8px 14px;border-top:1px solid #22364f;color:#7f92aa;font-size:12px}
#km2 .km-x{width:10px;height:12px}
#km2 .km-av .avatar-image.km-alku{display:flex;align-items:center;justify-content:center;color:#9fb3c8;font-weight:bold;font-size:15px;background:none!important}
#km2 .km-row.km-mrow{height:auto;min-height:44px;padding:7px 8px;align-items:flex-start}
#km2 .km-row.km-mrow .km-nm{line-height:1.3}
#km2 .km-row.km-mrow .km-txt{margin-top:3px;color:#c9d6e5;line-height:1.4;white-space:normal;overflow-wrap:anywhere}
#km2 .km-row.km-mrow .km-row-actions{align-self:center}
#km2 .km-sec .km-sec-action + .km-sec-action{margin-left:12px}
#km2 .km-pane > .dj-ikkuna{flex:1;min-width:0;min-height:0;display:flex!important;flex-direction:column}
#km2 .dj-ikkuna > .nitro-card{flex:1;min-height:0;height:100%;border:0!important;border-radius:0!important;box-shadow:none!important}
#km2 .dj-ikkuna > .nitro-card > .nitro-card-header,#km2 .dj-kahva{display:none!important}
#km2 .dj-ikkuna .content-area{height:auto!important;flex:1;min-height:0}
.km2-nappi .icon-message{position:relative}
`;

  function rakennaUI() {
    if (juuri) return;
    const st = el('style'); st.id = 'km2-tyyli'; st.textContent = CSS.replace(/__IKONI_([a-z-]+)__/g, (_, k) => IKONIT[k] || ''); document.head.appendChild(st);
    juuri = el('div', 'position-absolute draggable-window'); juuri.id = 'km2'; juuri.style.display = 'none';
    let paikka = null; try { paikka = JSON.parse(localStorage.getItem('km2.paikka') || 'null'); } catch (e) {}
    juuri.style.left = (paikka && paikka.x != null ? paikka.x : Math.max(10, Math.round((innerWidth - 720) / 2))) + 'px';
    juuri.style.top = (paikka && paikka.y != null ? paikka.y : 60) + 'px';
    kortti = el('div', 'd-flex flex-column nitro-card rounded theme-primary kupla-messenger');
    if (paikka && paikka.w) { kortti.style.width = paikka.w + 'px'; kortti.style.height = paikka.h + 'px'; }
    const ots = el('div', 'd-flex position-relative flex-column gap-2 align-items-center justify-content-center drag-handler container-fluid nitro-card-header');
    const orivi = el('div', 'd-flex w-100'); orivi.appendChild(el('span', 'nitro-card-header-text', 'Kaverit & viestit'));
    const sulje = el('button', 'd-flex align-items-center justify-content-center position-absolute end-2 nitro-card-header-close', null, { type: 'button', 'aria-label': 'Sulje ikkuna' });
    sulje.appendChild(risti('fa-icon w-12 h-12')); sulje.onclick = () => avaa(false); orivi.appendChild(sulje); ots.appendChild(orivi);
    tabit = el('div', 'km-tabs', null, { role: 'tablist' });
    const keho = el('div', 'km-body');
    for (const v of VALILEHDET) { paneelit[v.k] = el('div', 'km-pane is-hidden'); keho.appendChild(paneelit[v.k]); }
    kortti.append(ots, tabit, keho); juuri.appendChild(kortti); document.body.appendChild(juuri);
    // pelin näppäinkuuntelijat eivät saa nähdä kirjoittamista (muuten peli siirtää fokuksen omaan chattiinsa)
    for (const tyyppi of ['keydown', 'keyup', 'keypress']) juuri.addEventListener(tyyppi, e => e.stopPropagation());
    // suhdevalikko sulkeutuu klikkauksesta muualle (kuten v3:n FriendRow)
    juuri.addEventListener('mousedown', e => { if (T.suhdeAuki != null && !e.target.closest('.km-rel, .km-suhde')) { T.suhdeAuki = null; piirra(); } });
    raahattava(ots);
    new ResizeObserver(() => tallennaPaikka()).observe(kortti);
    ajoita(asennaNappi, 1500); asennaNappi();
    ajoita(paivitaMerkit, 2000);
    VW.kuplaMessenger = { versio: VERSIO, tila: T, avaa, piirra, laheta, avaaKetju };
    loki('valmis', VERSIO);
  }
  function tallennaPaikka() { if (!elossa() || !kortti.offsetWidth) return;
    try { localStorage.setItem('km2.paikka', JSON.stringify({ x: juuri.offsetLeft, y: juuri.offsetTop, w: kortti.offsetWidth, h: kortti.offsetHeight })); } catch (e) {} }
  function raahattava(kahva) {
    kahva.addEventListener('pointerdown', e => { if (e.target.closest('button')) return;
      const x0 = e.clientX - juuri.offsetLeft, y0 = e.clientY - juuri.offsetTop;
      const liiku = ev => { juuri.style.left = Math.min(Math.max(0, ev.clientX - x0), innerWidth - 80) + 'px'; juuri.style.top = Math.min(Math.max(0, ev.clientY - y0), innerHeight - 40) + 'px'; };
      const loppu = () => { removeEventListener('pointermove', liiku); removeEventListener('pointerup', loppu); tallennaPaikka(); };
      addEventListener('pointermove', liiku); addEventListener('pointerup', loppu); });
  }
  function avaa(auki) {
    T.auki = auki == null ? !T.auki : !!auki; juuri.style.display = T.auki ? '' : 'none';
    if (T.auki) { juuri.style.left = Math.min(juuri.offsetLeft, Math.max(0, innerWidth - 120)) + 'px'; juuri.style.top = Math.min(juuri.offsetTop, Math.max(0, innerHeight - 80)) + 'px'; }
    else { djPiiloon(); T.dialogi = null; T.suhdeAuki = null; }
    piirra();
  }
  const vaihda = k => { T.valilehti = k; T.dialogi = null; T.suhdeAuki = null; piirra(); };
  function avaaKetju(id) { T.aktiivinen = id; T.valilehti = 'viestit'; T.suljetut.delete(id); T.lukematta.delete(id); if (!T.auki) avaa(true); else piirra(); }

  // työkalupalkin nappi pelin omaan ikonisäiliöön; koko palkki voi syntyä uudelleen (ToolbarView), joten tarkistetaan 1,5 s välein
  function asennaNappi() {
    if (nappi && document.body.contains(nappi)) return;
    const sailio = document.querySelector('.nitro-toolbar-main-icons');
    nappi = el('div', 'toolbar-control text-center km2-nappi', null, { title: 'Kaverit & viestit' });
    const ikoni = el('div', 'cursor-pointer navigation-item icon icon-message nitro-toolbar-icon sidebar-navigation-icon');
    nappiMerkki = el('span', 'km-badge km-toolbar-count'); nappiMerkki.style.display = 'none'; ikoni.appendChild(nappiMerkki);
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
  const paikallaMaara = () => [...T.kaverit.values()].filter(f => f.paikalla).length;
  function paivitaMerkit() {
    // Datajako asuu Viestit-ikkunan välilehdellä (Res 13.10. 07:38): sen oma kelluva 💬-nappi piiloon, lukemattomat näkyvät tämän napin luvussa
    const dju = djUI(); if (dju && dju.avaaja && dju.avaaja.style.display !== 'none') dju.avaaja.style.display = 'none';
    const yht = lukemattomat() + mainintojaUusia() + djLukematta() + kanavaLukematta();
    if (nappiMerkki) { nappiMerkki.textContent = yht > 99 ? '99+' : String(yht); nappiMerkki.style.display = yht ? '' : 'none'; }
    if (juuri && T.auki) piirraTabit();
  }
  let ajastin = null;
  function paivitaPian() { if (ajastin) return; ajastin = setTimeout(() => { ajastin = null; if (T.auki) piirra(); else paivitaMerkit(); }, 120); }

  function piirraTabit() {
    tabit.textContent = '';
    const luvut = { viestit: [lukemattomat() + djLukematta() + kanavaLukematta()], pyynnot: [T.pyynnot.size, true], maininnat: [mainintojaUusia()] };
    for (const v of VALILEHDET) {
      const on = T.valilehti === v.k;
      const b = el('button', 'km-tab' + (on ? ' is-active' : ''), null, { type: 'button', role: 'tab', 'aria-selected': String(on) });
      b.appendChild(el('span', 'km-icon ' + v.ikoni)); b.appendChild(document.createTextNode(v.nimi));
      if (v.k === 'kaverit' && T.kaverilistaSaatu > 0) b.appendChild(el('span', 'km-tab-meta', paikallaMaara() + '/' + T.kaverit.size));
      const l = luvut[v.k]; const m = l && merkkiEl(l[0], l[1]); if (m) b.appendChild(m);
      b.onclick = () => vaihda(v.k); tabit.appendChild(b);
    }
  }

  // Koko välilehti piirretään uudelleen jokaisesta muutoksesta: kirjoituskentän fokus/valinta ja listojen vieritys palautetaan avaimella.
  function piirra() {
    if (!juuri) return;
    if (!T.auki) { paivitaMerkit(); return; }
    const ae = document.activeElement, fokus = ae && juuri.contains(ae) && ae.dataset && ae.dataset.km ? { k: ae.dataset.km, a: ae.selectionStart, b: ae.selectionEnd } : null;
    const vieritys = {}; juuri.querySelectorAll('[data-kmv]').forEach(e => { vieritys[e.dataset.kmv] = { top: e.scrollTop, pohjassa: e.scrollHeight - e.scrollTop - e.clientHeight < 40 }; });
    piirraTabit();
    for (const v of VALILEHDET) paneelit[v.k].classList.toggle('is-hidden', v.k !== T.valilehti);
    if (T.valilehti !== 'viestit' && T.valilehti !== 'skriptit') djPiiloon();
    const p = paneelit[T.valilehti];
    ({ viestit: piirraViestit, kaverit: piirraKaverit, pyynnot: piirraPyynnot, haku: piirraHaku, maininnat: piirraMaininnat, skriptit: piirraSkriptit })[T.valilehti](p);
    p.querySelectorAll('[data-kmv]').forEach(e => { const s = vieritys[e.dataset.kmv];
      if (e.dataset.kmvAlas === '1') e.scrollTop = (!s || s.pohjassa) ? e.scrollHeight : s.top; else if (s) e.scrollTop = s.top; });
    if (fokus) { const e = p.querySelector('[data-km="' + fokus.k + '"]'); if (e) { e.focus(); try { if (fokus.a != null) e.setSelectionRange(fokus.a, fokus.b); } catch (er) {} } }
    const dju = djUI(); if (dju && dju.avaaja) dju.avaaja.style.display = 'none';
    if (nappiMerkki) { const yht = lukemattomat() + mainintojaUusia() + djLukematta() + kanavaLukematta(); nappiMerkki.textContent = yht > 99 ? '99+' : String(yht); nappiMerkki.style.display = yht ? '' : 'none'; }
  }

  // ---------- Viestit (MessengerConversationsTab + MessengerThreadPane) ----------
  const henkilo = id => T.kaverit.get(id) || { id, nimi: nimiId(id), paikalla: false, seurattava: false, asu: '', motto: '' };
  function ketjuLista() {
    return [...T.ketjut.entries()].filter(([id, l]) => l.length && !T.suljetut.has(id)).map(([id, l]) => ({ id, l, viim: l[l.length - 1] })).sort((a, b) => b.viim.t - a.viim.t);
  }
  // Viestit-sivupalkki: pelin yksityisviestit + Datajaon huoneet (Res 13.10. 08:34 "lisää viestit osioon ryhmät, kanavat ja datajaon
  // ominaisuudet liite, osoita ja toiminto"). Datajaon huone näytetään oikeassa palstassa Datajakon omana chat-näkymänä, jonka
  // kirjoitusrivillä Liite / Osoita / Toiminto jo ovat. Aktiivinen: numero = pelaajan id, 'dj:<id>' = Datajaon huone.
  const onDj = a => typeof a === 'string' && a.startsWith('dj:');
  const onKanava = a => typeof a === 'string' && a.startsWith('k:');
  const djHuoneet = () => { const u = djUI(); try { return u && typeof u.huoneet === 'function' ? u.huoneet() : null; } catch (e) { return null; } };
  function djRivi(h) {
    const aktiivi = T.aktiivinen === 'dj:' + h.id;
    const r = el('div', 'km-row' + (aktiivi ? ' is-active' : ''), null, { role: 'button', tabindex: '0' });
    r.onclick = () => { T.aktiivinen = 'dj:' + h.id; piirra(); };
    if (h.tyyppi === 'yv') { const f = [...T.kaverit.values()].find(x => x.nimi === h.vastapuoli); r.appendChild(avatar(f && f.asu, { nimi: h.vastapuoli || h.nimi, paikalla: h.mukana.length ? true : undefined })); }
    else { const w = el('div', 'km-avw'), a = el('div', 'km-av km-djav' + (h.tyyppi === 'ryhma' ? ' is-ryhma' : ''), h.tyyppi === 'ryhma' ? '' : '#'); w.appendChild(a); if (h.mukana.length) w.appendChild(el('span', 'km-dot is-online')); r.appendChild(w); }
    const nm = el('div', 'km-nm'); nm.appendChild(el('span', 'km-name', h.tyyppi === 'yv' ? (h.vastapuoli || h.nimi) : h.nimi));
    const v = h.viimeinen; nm.appendChild(el('small', null, v ? (v.oma ? 'Sinä: ' : (v.from ? v.from + ': ' : '')) + v.teksti : (h.mukana.length ? 'Paikalla: ' + h.mukana.join(', ') : (h.tyyppi === 'yv' ? 'Datajako 1:1, ei viestejä' : 'Ei viestejä'))));
    const meta = el('div', 'km-row-meta'); meta.appendChild(el('time', null, v && v.ts ? listaAika(v.ts) : ''));
    const m = merkkiEl(aktiivi ? 0 : h.lukematta); if (m) meta.appendChild(m);
    r.append(nm, meta); return r;
  }
  function viestiSivu(lista, dj) {
    const sivu = el('div', 'km-side');
    const sc = el('div', 'km-scroll', null, { 'data-kmv': 'ketjut' });
    sc.appendChild(el('div', 'km-sec', 'Yksityisviestit'));
    for (const k of lista) {
      const f = henkilo(k.id), aito = k.id > 0, aktiivi = k.id === T.aktiivinen;
      const r = el('div', 'km-row' + (aktiivi ? ' is-active' : '') + (aito && !f.paikalla ? ' is-offline' : ''), null, { role: 'button', tabindex: '0' });
      r.onclick = () => { T.aktiivinen = k.id; piirra(); };
      r.appendChild(avatar(f.asu, { paikalla: aito ? f.paikalla : undefined, nimi: f.nimi }));
      const nm = el('div', 'km-nm'); nm.appendChild(el('span', 'km-name', f.nimi));
      const v = k.viim; nm.appendChild(el('small', null, v ? (v.oma ? 'Sinä: ' : '') + (v.kutsu ? 'Kutsu huoneeseen' : ryhmaKutsu(v.teksti) ? 'Kutsu ryhmään' : v.teksti) : ''));
      const meta = el('div', 'km-row-meta'); meta.appendChild(el('time', null, v ? listaAika(v.t) : ''));
      const m = merkkiEl(aktiivi ? 0 : (T.lukematta.get(k.id) || 0)); if (m) meta.appendChild(m);
      r.append(nm, meta); sc.appendChild(r);
    }
    const yv = dj ? dj.filter(h => h.tyyppi === 'yv') : [];
    for (const h of yv) sc.appendChild(djRivi(h));
    if (!lista.length && !yv.length) sc.appendChild(el('div', 'km-empty is-inline', 'Ei vielä keskusteluja. Aloita Kaverit-välilehdeltä.'));
    if (T.kanavat.tuettu) ryhmaSektio(sc);   // palvelimen ryhmät korvaavat Datajaon ryhmät (Res 09:43)
    else { const ryhmaOts = el('div', 'km-sec', 'Ryhmät');
    if (dj) { const u = el('span', 'km-sec-action', '+ Uusi', { role: 'button', title: 'Uusi ryhmä tai liity salasanalla' });
      u.onclick = () => { const y = dj.find(h => h.tyyppi === 'yhteinen'); if (y) T.aktiivinen = 'dj:' + y.id; piirra(); const ui = djUI(); if (ui && ui.uusi) ui.uusi(); }; ryhmaOts.appendChild(u); }
    sc.appendChild(ryhmaOts);
    if (!dj) sc.appendChild(el('div', 'km-empty is-inline', 'Ryhmät ja kanavat tulevat Datajako-lisäosasta (0.21.0 tai uudempi).'));
    else { const r = dj.filter(h => h.tyyppi === 'ryhma'); if (!r.length) sc.appendChild(el('div', 'km-empty is-inline', 'Ei ryhmiä. Uusi ryhmä toimii salasanalla.')); r.forEach(h => sc.appendChild(djRivi(h))); } }
    if (T.kanavat.tuettu) kanavaSektio(sc);   // palvelimen kanavat korvaavat Datajaon kanavat (Res 09:00)
    else { sc.appendChild(el('div', 'km-sec', 'Kanavat'));
      if (dj) dj.filter(h => h.tyyppi === 'yhteinen' || h.tyyppi === 'kanava').forEach(h => sc.appendChild(djRivi(h)));
      else if (T.kanavat.tuettu === null) sc.appendChild(el('div', 'km-empty is-inline', 'Haetaan kanavia...')); }
    sivu.appendChild(sc); return sivu;
  }
  // ---------- Kanavat (palvelimen ChannelService; Res 13.10. 09:00) ----------
  // Rivi sivupalkissa, kanavan oma paneeli ja uuden kanavan dialogi (vain kun 3011 kertoi oikeudesta: isStaf = acc_channels_manage).
  const KANAVA_VIRHEET = { 400: 'Viesti tai nimi ei kelpaa (viesti 1-255 merkkiä, nimi 2-32).', 403: 'Ei oikeutta, tai olet mykistetty.',
    404: 'Kanavaa ei löydy.', 500: 'Palvelinvirhe, yritä uudelleen.' };
  // sama koodi tarkoittaa eri asiaa eri toimessa: avain "<paketti>:<koodi>" (K.toimi = viimeisin kanavaToimi)
  const RYHMA_VIRHEET = { '9421:400': 'Nimi 2-32 merkkiä (kirjaimet, numerot, välilyönti, - ja _).', '9421:403': 'Sinulla on jo 10 ryhmää. Poista jokin ennen uuden luomista.',
    '9422:403': 'Kutsun voi lähettää vain kaverille, ja ryhmällä voi olla enintään 50 avointa kutsua.', '9422:400': 'Hän on jo jäsen, tai kutsu odottaa jo vastausta.',
    '9417:404': 'Kutsua ei enää ole.', '9417:400': 'Olet jo ryhmän jäsen.', '9418:400': 'Omistaja ei voi poistua. Poista ryhmä, jos haluat lopettaa sen.',
    '9423:404': 'Häntä ei löydy ryhmästä eikä kutsuista.', '9420:404': 'Ryhmää ei löydy.' };
  const virheTeksti = v => RYHMA_VIRHEET[v.toimi + ':' + v.koodi] || KANAVA_VIRHEET[v.koodi] || 'Virhe ' + v.koodi;
  const tuoreVirhe = () => { const v = T.kanavat.virhe; return v && Date.now() - v.t < 15000 ? v : null; };
  const kanavaLukematta = () => T.kanavat.tuettu ? [...T.kanavat.lista.values()].reduce((a, k) => a + (T.kanavat.liitetyt.has(k.id) || T.kanavat.ryhmat.has(k.id) ? k.lukematta || 0 : 0), 0) : 0;
  const risuAvatar = ryhma => { const w = el('div', 'km-avw'); w.appendChild(el('div', 'km-av km-djav' + (ryhma ? ' is-ryhma' : ''), ryhma ? '' : '#')); return w; };
  function kanavaRivi(k) {
    const aktiivi = T.aktiivinen === 'k:' + k.id, liitetty = !!k.ryhma || T.kanavat.liitetyt.has(k.id);
    const r = el('div', 'km-row' + (aktiivi ? ' is-active' : '') + (liitetty ? '' : ' is-offline'), null, { role: 'button', tabindex: '0' });
    r.onclick = () => { T.aktiivinen = 'k:' + k.id; avaaKanava(k.id); piirra(); };
    r.appendChild(risuAvatar(k.ryhma));
    const nm = el('div', 'km-nm'); nm.appendChild(el('span', 'km-name', k.nimi));
    // listan 3001/3011 ei kanna viestin tekstiä: otetaan se ladatusta ketjusta, jos viimeinen näkyvä viesti on siellä
    const l = T.kanavat.viestit.get(k.id) || [], vv = l.filter(x => x.tila === 0).slice(-1)[0];
    const v = vv && (!k.viimeinen || vv.t >= k.viimeinen.t - 2000) ? { nimi: vv.nimi, t: vv.t, teksti: vv.teksti } : k.viimeinen;
    nm.appendChild(el('small', null, !liitetty ? (k.kuvaus || 'Et ole liittynyt') : v ? v.nimi + (v.teksti ? ': ' + v.teksti : '') : (k.kuvaus || 'Ei viestejä')));
    const meta = el('div', 'km-row-meta'); meta.appendChild(el('time', null, v && v.t ? listaAika(v.t) : ''));
    const m = merkkiEl(aktiivi || !liitetty ? 0 : k.lukematta); if (m) meta.appendChild(m);
    r.append(nm, meta); return r;
  }
  function kanavaSektio(sc) {
    const K = T.kanavat, ots = el('div', 'km-sec', 'Kanavat'); sc.appendChild(ots);
    if (K.hallinta) { const u = el('span', 'km-sec-action', '+ Uusi', { role: 'button', title: 'Uusi kanava' }); u.onclick = () => { T.dialogi = 'uusiKanava'; piirra(); }; ots.appendChild(u); }
    const l = [...K.lista.values()].filter(k => !k.ryhma).sort((a, b) => (K.liitetyt.has(b.id) - K.liitetyt.has(a.id)) || String(a.nimi).localeCompare(String(b.nimi), 'fi'));
    if (!l.length) sc.appendChild(el('div', 'km-empty is-inline', 'Ei vielä kanavia.'));
    l.forEach(k => sc.appendChild(kanavaRivi(k)));
  }
  // ---------- Ryhmät (palvelimen yksityiset kanavat; Res 13.10. 09:43-09:50) ----------
  function ryhmaSektio(sc) {
    const K = T.kanavat, ots = el('div', 'km-sec', 'Ryhmät'); sc.appendChild(ots);
    if (sallittu(9421)) { const u = el('span', 'km-sec-action', '+ Uusi', { role: 'button', title: 'Uusi ryhmä' }); u.onclick = () => { T.dialogi = 'uusiRyhma'; piirra(); }; ots.appendChild(u); }
    for (const k of K.kutsut.values()) sc.appendChild(kutsuRivi(k));
    const v = tuoreVirhe(); if (v && (v.toimi === 9417 || v.toimi === 9418) && !onKanava(T.aktiivinen)) sc.appendChild(el('div', 'km-empty is-inline', virheTeksti(v)));
    const l = [...K.ryhmat].map(id => K.lista.get(id)).filter(Boolean).sort((a, b) => String(a.nimi).localeCompare(String(b.nimi), 'fi'));
    if (!l.length && !K.kutsut.size) sc.appendChild(el('div', 'km-empty is-inline', 'Ei ryhmiä. Luo ryhmä ja kutsu kavereita.'));
    l.forEach(k => sc.appendChild(kanavaRivi(k)));
  }
  const kutsuNapit = id => { const k = T.kanavat.kutsut.get(id), odottaa = k && k.vastattu && Date.now() - k.vastattu < 5000, r = el('div', 'km-kutsu-napit');
    const ok = nappiEl('is-primary', 'Liity', null, () => { vastaaKutsuun(id, true); piirra(); }), ei = nappiEl('', 'Hylkää', null, () => { vastaaKutsuun(id, false); piirra(); });
    ok.disabled = ei.disabled = !!odottaa; r.appendChild(ok); if (sallittu(9418)) r.appendChild(ei); return r; };
  function kutsuRivi(k) {
    const r = el('div', 'km-row is-kutsu'); r.appendChild(risuAvatar(true));
    const nm = el('div', 'km-nm'); nm.appendChild(el('span', 'km-name', k.nimi)); nm.appendChild(el('small', null, 'Kutsu'));
    r.append(nm, kutsuNapit(k.id)); return r;
  }
  // Yksityisviesti joka päättyy "#ryhmakutsu:<id>": kortti hyväksyntänapeilla. Tila tulee palvelimen listoista, ei viestistä.
  function kutsuKortti(rk, kutsuja, t) {
    const K = T.kanavat, s = el('div', 'km-sys is-invite'); s.appendChild(el('span', 'messenger-notification-icon flex-shrink-0'));
    const tx = el('div', 'km-sys-text'), nimi = (K.kutsut.get(rk.id) || K.lista.get(rk.id) || rk).nimi;
    tx.appendChild(el('b', null, 'Ryhmäkutsu')); tx.appendChild(document.createTextNode(' (' + klo(t) + '): ' + kutsuja + ' kutsui sinut ryhmään ' + nimi + '.'));
    if (K.kutsut.has(rk.id)) tx.appendChild(kutsuNapit(rk.id));
    else if (K.ryhmat.has(rk.id)) { const r = el('div', 'km-kutsu-napit'); r.appendChild(nappiEl('', 'Avaa ryhmä', null, () => { T.aktiivinen = 'k:' + rk.id; avaaKanava(rk.id); piirra(); })); tx.appendChild(r); }
    else tx.appendChild(el('div', null, K.tuettu ? 'Kutsu ei ole enää voimassa.' : 'Ryhmät eivät ole vielä käytössä tällä palvelimella.'));
    s.appendChild(tx); return s;
  }
  function kanavaPaneeli(id) {
    const K = T.kanavat, k = K.lista.get(id) || { id, nimi: '#' + id, kuvaus: '' }, l = K.viestit.get(id) || [], onRyhma = !!k.ryhma, liitetty = onRyhma || K.liitetyt.has(id);
    // omistaja = jäsenlistan ensimmäinen (palvelin järjestää liittymisajan mukaan, ja omistaja liittyy luodessaan); palvelin tarkistaa joka tapauksessa
    const jasenet = K.jasenet.get(id) || [], omistaja = onRyhma && jasenet.length > 0 && jasenet[0].id === oma().id, moderoi = onRyhma ? !!k.moderoi : K.hallinta;
    const main = el('div', 'km-main');
    const mh = el('div', 'km-mh'); mh.appendChild(risuAvatar(onRyhma));
    const otsikko = el('div', 'km-mh-title'); otsikko.appendChild(el('b', null, k.nimi));
    otsikko.appendChild(el('span', null, k.kuvaus || (onRyhma ? (jasenet.length ? jasenet.length + ' jäsentä' : 'Ryhmä') : liitetty ? 'Liittynyt' : 'Et ole liittynyt')));
    const toim = el('div', 'km-mh-actions');
    if (onRyhma) {
      toim.appendChild(nappiEl('', 'Jäsenet', null, () => { T.dialogi = 'jasenet'; laheta(232, [-id, 0, 0, 100]); piirra(); }));
      if (!omistaja && sallittu(9418)) toim.appendChild(nappiEl('', 'Poistu', null, () => { poistuRyhmasta(id); piirra(); }));
      if (omistaja || K.hallinta) { const pk = nappiEl('is-square', null, 'remove', () => { T.dialogi = 'poistaKanava'; piirra(); }); pk.title = 'Poista ryhmä'; pk.setAttribute('aria-label', 'Poista ryhmä'); toim.appendChild(pk); }
    } else {
      if (!liitetty || sallittu(9418)) toim.appendChild(nappiEl(liitetty ? '' : 'is-primary', liitetty ? 'Poistu' : 'Liity', null, () => { liitetty ? poistuKanavasta(id) : liityKanavaan(id); piirra(); }));
      if (K.hallinta) { const pk = nappiEl('is-square', null, 'remove', () => { T.dialogi = 'poistaKanava'; piirra(); }); pk.title = 'Poista kanava'; pk.setAttribute('aria-label', 'Poista kanava'); toim.appendChild(pk); }
    }
    const sk = nappiEl('is-square', null, risti(), () => { T.aktiivinen = null; piirra(); }); sk.title = 'Sulje kanava'; sk.setAttribute('aria-label', 'Sulje kanava');
    toim.appendChild(sk); mh.append(otsikko, toim);
    const msgs = el('div', 'km-msgs', null, { 'data-kmv': 'kanava-' + id, 'data-kmv-alas': '1' });
    const huom = el('div', 'km-sys is-notice'); huom.appendChild(el('span', 'nitro-friends-spritesheet icon-warning flex-shrink-0'));
    huom.appendChild(el('div', 'km-sys-text', (onRyhma ? 'Ryhmän viestit näkyvät vain jäsenille.' : 'Kanavan viestit näkyvät kaikille.') + ' Henkilötietojen ja salasanan kertominen on sääntöjemme vastaista.'));
    msgs.appendChild(huom);
    if (!l.length) msgs.appendChild(el('div', 'km-empty is-inline', k.yhteensa ? 'Haetaan viestejä...' : 'Ei vielä viestejä. Kirjoita ensimmäinen.'));
    const o = oma(); let edPaiva = '', edLahettaja = null, edT = 0, ryhma = null;
    for (const v of l) {
      const pv = paivaNimi(v.t);
      if (pv !== edPaiva) { msgs.appendChild(el('div', 'km-day', pv)); edPaiva = pv; ryhma = null; }
      const omaV = v.lahettajaId === o.id;
      if (!ryhma || v.lahettajaId !== edLahettaja || v.t - edT > 5 * 60e3) {
        const m = el('div', 'km-m' + (omaV ? ' is-own' : ''));
        m.appendChild(avatar(v.asu, { iso: true, suunta: omaV ? 4 : 2, nimi: v.nimi }));
        const runko = el('div', 'km-m-body'); const who = el('div', 'km-who'); who.append(el('span', null, v.nimi), el('span', 'km-ts', klo(v.t)));
        runko.appendChild(who); m.appendChild(runko); msgs.appendChild(m); ryhma = runko; edLahettaja = v.lahettajaId;
      }
      const piilossa = v.tila !== 0;
      const rivi = el('div', 'km-txt' + (piilossa ? ' km-piilossa' : ''), piilossa ? 'Viesti piilotettu' + (v.moderoija ? ' (' + v.moderoija + ')' : '') + (v.teksti ? ': ' + v.teksti : '') : v.teksti);
      if (moderoi) { const mod = el('span', 'km-mod', piilossa ? 'Palauta' : 'Piilota', { role: 'button', title: piilossa ? 'Näytä viesti kaikille' : 'Piilota viesti muilta' });
        mod.onclick = () => moderoiKanavaViesti(id, v.id, piilossa ? 0 : 20); rivi.appendChild(mod); }
      ryhma.appendChild(rivi); edT = v.t;
    }
    if (tuoreVirhe() && T.dialogi !== 'jasenet') { const s = el('div', 'km-sys is-notice'); s.appendChild(el('div', 'km-sys-text', virheTeksti(K.virhe))); msgs.appendChild(s); }
    const inp = el('div', 'km-inp'), avain = 'k:' + id;
    const kentta = el('input', null, null, { type: 'text', maxlength: '255', placeholder: (onRyhma ? 'Viesti ryhmälle ' : 'Viesti kanavalle ') + k.nimi, 'data-km': 'kanava-' + id }); kentta.value = T.luonnos.get(avain) || '';
    const laskuri = el('span', 'km-counter'); const lb = nappiEl('is-primary', 'Lähetä');
    const paivLaskuri = () => { const n = kentta.value.length; laskuri.textContent = n + '/255'; laskuri.style.display = n >= 200 ? '' : 'none'; laskuri.classList.toggle('is-full', n >= 255); lb.disabled = !kentta.value.trim(); };
    kentta.addEventListener('input', () => { T.luonnos.set(avain, kentta.value); paivLaskuri(); });
    // ei omaa kaikua: palvelin työntää uuden viestin (2049) myös lähettäjälle, ja virheestä tulee 1004
    const tee = () => { const teksti = kentta.value.trim().slice(0, 255); if (!teksti) return; lahetaKanavaan(id, teksti); if (!onRyhma) K.liitetyt.add(id); T.luonnos.delete(avain); kentta.value = ''; piirra(); };
    kentta.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tee(); } });
    lb.onclick = tee; paivLaskuri(); inp.append(kentta, laskuri, lb);
    main.append(mh, msgs, inp);
    if (['uusiKanava', 'poistaKanava', 'uusiRyhma', 'jasenet'].includes(T.dialogi)) main.appendChild(kanavaDialogi(id));
    return main;
  }
  function kanavaDialogi(id) {
    const ov = el('div', 'km-overlay'); ov.onclick = () => { T.dialogi = null; piirra(); };
    const d = el('div', 'km-dialog'); d.onclick = e => e.stopPropagation();
    const peru = nappiEl('', 'Peruuta', null, () => { T.dialogi = null; piirra(); }), r = el('div', 'km-dialog-actions');
    if (T.dialogi === 'poistaKanava') {
      const k = T.kanavat.lista.get(id) || { nimi: '#' + id };
      d.append(el('h3', null, k.ryhma ? 'Poista ryhmä' : 'Poista kanava'), el('p', null, (k.ryhma ? 'Ryhmä ' + k.nimi + ' katoaa kaikilta jäseniltä.' : 'Kanava ' + k.nimi + ' katoaa kaikilta.') + ' Viestit jäävät tietokantaan.'));
      r.append(peru, nappiEl('is-danger', 'Poista', null, () => { poistaKanava(id); T.dialogi = null; T.aktiivinen = null; piirra(); }));
      d.appendChild(r);
    } else if (T.dialogi === 'jasenet') {
      jasenDialogi(d, id); r.appendChild(nappiEl('', 'Sulje', null, () => { T.dialogi = null; piirra(); })); d.appendChild(r);
    } else {
      const ryhmaksi = T.dialogi === 'uusiRyhma';
      d.append(el('h3', null, ryhmaksi ? 'Uusi ryhmä' : 'Uusi kanava'), el('p', null, 'Nimi 2-32 merkkiä (kirjaimet, numerot, välilyönti, - ja _). Kuvaus vapaaehtoinen.'
        + (ryhmaksi ? ' Ryhmän näkevät vain jäsenet, ja kaverit liittyvät kutsusta. Voit omistaa enintään 10 ryhmää.' : '')));
      const nimi = el('input', null, null, { type: 'text', maxlength: '32', placeholder: 'Nimi', 'data-km': 'kanava-nimi' }); nimi.value = T.kanavaNimi || '';
      const kuvaus = el('input', null, null, { type: 'text', maxlength: '255', placeholder: 'Kuvaus', 'data-km': 'kanava-kuvaus' }); kuvaus.value = T.kanavaKuvaus || '';
      const ok = nappiEl('is-primary', ryhmaksi ? 'Luo ryhmä' : 'Luo kanava', null, () => { const n = nimi.value.trim(); if (n.length < 2) return;
        (ryhmaksi ? luoRyhma : luoKanava)(n, kuvaus.value.trim()); T.kanavaNimi = ''; T.kanavaKuvaus = ''; T.dialogi = null; piirra(); });
      const tila = () => { T.kanavaNimi = nimi.value; T.kanavaKuvaus = kuvaus.value; ok.disabled = nimi.value.trim().length < 2; };
      nimi.addEventListener('input', tila); kuvaus.addEventListener('input', tila); tila();
      r.append(peru, ok); d.append(nimi, kuvaus, r);
    }
    ov.appendChild(d); return ov;
  }
  // Jäsenet ja kutsu: omistaja (tai staff) poistaa jäseniä ja kutsuu kavereita. Kutsu lähtee yksityisviestinä palvelimelta (9422).
  function jasenDialogi(d, id) {
    const K = T.kanavat, k = K.lista.get(id) || { nimi: '#' + id }, jasenet = K.jasenet.get(id) || [], o = oma();
    const hallitsee = (jasenet.length > 0 && jasenet[0].id === o.id) || K.hallinta;
    d.classList.add('km-dialog-jasenet');
    d.appendChild(el('h3', null, k.nimi + ' - jäsenet' + (jasenet.length ? ' (' + jasenet.length + ')' : '')));
    const lista = el('div', 'km-jasenet');
    jasenet.forEach((j, i) => { const r = el('div', 'km-jasen'); r.appendChild(avatar(j.asu, { nimi: j.nimi })); r.appendChild(el('span', 'km-name', j.nimi + (i === 0 ? ' (omistaja)' : '')));
      if (hallitsee && i > 0) { const x = el('span', 'km-mod', 'Poista', { role: 'button', title: 'Poista ryhmästä' }); x.onclick = () => poistaJasen(id, j.id); r.appendChild(x); }
      lista.appendChild(r); });
    if (!jasenet.length) lista.appendChild(el('div', 'km-empty is-inline', 'Haetaan jäseniä...'));
    d.appendChild(lista);
    if (hallitsee) {
      d.appendChild(el('p', null, 'Kutsu kaveri. Kutsu menee hänelle yksityisviestinä, ja hän liittyy kun hyväksyy.'));
      const haku = el('input', null, null, { type: 'text', maxlength: '32', placeholder: 'Hae kaveria', 'data-km': 'ryhma-kutsu-haku' }); haku.value = T.kutsuHaku || '';
      const ehd = el('div', 'km-jasenet'), kutsutut = T.kutsutut || (T.kutsutut = new Set());
      const paiv = () => { T.kutsuHaku = haku.value; ehd.textContent = ''; const q = haku.value.trim().toLowerCase(), jasen = new Set(jasenet.map(j => j.id));
        const l = [...T.kaverit.values()].filter(f => !jasen.has(f.id) && (!q || f.nimi.toLowerCase().includes(q))).sort(nimiJarjestys).slice(0, 8);
        for (const f of l) { const r = el('div', 'km-jasen'); r.appendChild(avatar(f.asu, { nimi: f.nimi, paikalla: f.paikalla })); r.appendChild(el('span', 'km-name', f.nimi));
          const tehty = kutsutut.has(id + ':' + f.id), b = el('span', 'km-mod', tehty ? 'Kutsuttu' : 'Kutsu', { role: 'button' });
          if (!tehty) b.onclick = () => { kutsuRyhmaan(id, f.id); kutsutut.add(id + ':' + f.id); paiv(); };
          r.appendChild(b); ehd.appendChild(r); }
        if (!l.length) ehd.appendChild(el('div', 'km-empty is-inline', q ? 'Ei kavereita haulla.' : 'Kaikki kaverisi ovat jo jäseniä.')); };
      haku.addEventListener('input', paiv); paiv(); d.append(haku, ehd);
    }
    const v = tuoreVirhe(); if (v) d.appendChild(el('p', 'km-virhe', virheTeksti(v)));
  }
  function piirraViestit(p) {
    const lista = ketjuLista(), dj = djHuoneet();
    if (onDj(T.aktiivinen) && !(dj && dj.some(h => 'dj:' + h.id === T.aktiivinen))) T.aktiivinen = null;
    if (onKanava(T.aktiivinen) && T.kanavat.tuettu && !T.kanavat.lista.has(+T.aktiivinen.slice(2))) T.aktiivinen = null;
    if (typeof T.aktiivinen === 'number' && !lista.some(k => k.id === T.aktiivinen)) lista.unshift({ id: T.aktiivinen, l: T.ketjut.get(T.aktiivinen) || [], viim: null });
    if (T.aktiivinen == null && lista.length) T.aktiivinen = lista[0].id;
    if (typeof T.aktiivinen === 'number') T.lukematta.delete(T.aktiivinen);
    if (onKanava(T.aktiivinen)) { const k = T.kanavat.lista.get(+T.aktiivinen.slice(2)); if (k && k.lukematta) merkitseKanavaLuetuksi(k.id); }
    // sivupalkki vaihdetaan aina; oikea palsta vain jos se on eri asia (Datajakon kirjoituskenttä ei saa menettää fokusta saapuvista paketeista)
    const sivu = viestiSivu(lista, dj), vanha = p.querySelector(':scope > .km-side');
    if (vanha) vanha.replaceWith(sivu); else p.prepend(sivu);
    const oikeat = [...p.children].filter(e => e !== sivu);
    if (onDj(T.aktiivinen)) {
      const id = T.aktiivinen.slice(3);
      if (!(oikeat.length === 1 && oikeat[0] === djPaikka)) { oikeat.forEach(e => e.remove()); p.appendChild(djPaikka); }
      upotaDj(djPaikka, 'chat:' + id, u => u.valitse(id));
    } else if (onKanava(T.aktiivinen)) {
      djPiiloon();
      oikeat.forEach(e => e.remove());
      p.appendChild(kanavaPaneeli(+T.aktiivinen.slice(2)));
    } else {
      djPiiloon();
      oikeat.forEach(e => e.remove());
      if (T.aktiivinen != null) p.appendChild(ketjuPaneeli(T.aktiivinen));
      else { const m = el('div', 'km-main'); m.appendChild(tyhja('Viestit näkyvät tässä, kun aloitat keskustelun.')); p.appendChild(m); }
    }
    if ((T.dialogi === 'uusiKanava' || T.dialogi === 'uusiRyhma') && !onKanava(T.aktiivinen)) p.appendChild(kanavaDialogi(0));
  }
  function ketjuPaneeli(id) {
    const f = henkilo(id), aito = id > 0, l = T.ketjut.get(id) || [], o = oma();
    const main = el('div', 'km-main');
    const mh = el('div', 'km-mh'); mh.appendChild(avatar(f.asu, { paikalla: aito ? f.paikalla : undefined, nimi: f.nimi }));
    const otsikko = el('div', 'km-mh-title'); otsikko.appendChild(el('b', null, f.nimi)); if (aito) otsikko.appendChild(el('span', null, f.paikalla ? 'Paikalla' : 'Ei paikalla'));
    const toim = el('div', 'km-mh-actions');
    if (aito) {
      const s = nappiEl('is-square', null, 'follow', () => laheta(3997, [id])); s.title = 'Seuraa'; s.setAttribute('aria-label', 'Seuraa'); s.disabled = !(f.paikalla && f.seurattava);
      const pr = nappiEl('is-square', null, 'profile', () => laheta(3265, [id, true])); pr.title = 'Profiili'; pr.setAttribute('aria-label', 'Profiili');
      toim.append(s, pr);
    }
    const sk = nappiEl('is-square', null, risti(), () => { T.suljetut.add(id); T.aktiivinen = null; piirra(); }); sk.title = 'Sulje keskustelu'; sk.setAttribute('aria-label', 'Sulje keskustelu');
    toim.appendChild(sk); mh.append(otsikko, toim);
    const msgs = el('div', 'km-msgs', null, { 'data-kmv': 'msgs-' + id, 'data-kmv-alas': '1' });
    const huom = el('div', 'km-sys is-notice'); huom.appendChild(el('span', 'nitro-friends-spritesheet icon-warning flex-shrink-0'));
    huom.appendChild(el('div', 'km-sys-text', 'Filtteröimme Chat-viestit turvallisuussyistä. Henkilötietojen ja salasanan kertominen on sääntöjemme vastaista.'));
    msgs.appendChild(huom);
    const poissa = l.filter(v => v.offline).length;
    let edPaiva = '', edLahettaja = null, edT = 0, ryhma = null, poissaNaytetty = false;
    for (const v of l) {
      const pv = paivaNimi(v.t);
      if (pv !== edPaiva) { msgs.appendChild(el('div', 'km-day', pv)); edPaiva = pv; ryhma = null; }
      if (v.offline && !poissaNaytetty) { poissaNaytetty = true; const s = el('div', 'km-sys'); s.appendChild(el('div', 'km-sys-text', poissa === 1 ? '1 viesti kun olit poissa' : poissa + ' viestiä kun olit poissa')); msgs.appendChild(s); ryhma = null; }
      if (v.kutsu) { const s = el('div', 'km-sys is-invite'); s.appendChild(el('span', 'messenger-notification-icon flex-shrink-0'));
        const t = el('div', 'km-sys-text'); t.appendChild(el('b', null, 'Kutsu huoneeseen')); t.appendChild(document.createTextNode(' (' + klo(v.t) + '): ' + v.teksti));
        s.appendChild(t); msgs.appendChild(s); ryhma = null; continue; }
      const rk = !v.oma && ryhmaKutsu(v.teksti);
      if (rk) { msgs.appendChild(kutsuKortti(rk, f.nimi, v.t)); ryhma = null; continue; }
      const lahettaja = v.oma ? 'oma' : id;
      if (!ryhma || lahettaja !== edLahettaja || v.t - edT > 5 * 60e3) {
        const m = el('div', 'km-m' + (v.oma ? ' is-own' : ''));
        m.appendChild(avatar(v.oma ? o.asu : f.asu, { iso: true, suunta: v.oma ? 4 : 2, nimi: v.oma ? o.nimi : f.nimi }));
        const runko = el('div', 'km-m-body'); const who = el('div', 'km-who'); who.append(el('span', null, v.oma ? o.nimi : f.nimi), el('span', 'km-ts', klo(v.t)));
        runko.appendChild(who); m.appendChild(runko); msgs.appendChild(m); ryhma = runko; edLahettaja = lahettaja;
      }
      ryhma.appendChild(el('div', 'km-txt', v.teksti + (v.virhe ? '  (ei lähtenyt)' : ''))); edT = v.t;
    }
    const inp = el('div', 'km-inp');
    const k = el('input', null, null, { type: 'text', maxlength: '255', placeholder: 'Viesti: ' + f.nimi, 'data-km': 'viesti-' + id }); k.value = T.luonnos.get(id) || '';
    const laskuri = el('span', 'km-counter'); const lb = nappiEl('is-primary', 'Lähetä');
    const paivLaskuri = () => { const n = k.value.length; laskuri.textContent = n + '/255'; laskuri.style.display = n >= 200 ? '' : 'none'; laskuri.classList.toggle('is-full', n >= 255); lb.disabled = !k.value.trim(); };
    k.addEventListener('input', () => { T.luonnos.set(id, k.value); paivLaskuri(); });
    const tee = () => { const teksti = k.value.trim().slice(0, 255); if (!teksti) return; const ok = laheta(3567, [id, teksti]);
      T.luonnos.delete(id); lisaaViesti(id, { oma: true, teksti, t: Date.now(), virhe: !ok }); piirra(); };
    k.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tee(); } });
    lb.onclick = tee; paivLaskuri(); inp.append(k, laskuri, lb);
    main.append(mh, msgs, inp); return main;
  }

  // ---------- Kaverit (MessengerFriendsTab) ----------
  const SUHTEET = [[0, 'icon-none'], [1, 'icon-heart'], [2, 'icon-smile'], [3, 'icon-bobba']];
  const suhdeIkoni = s => (SUHTEET.find(x => x[0] === s) || SUHTEET[0])[1];
  function kaveriRivi(f) {
    const valittu = T.valitut.has(f.id);
    const r = el('div', 'km-row' + (valittu ? ' is-selected' : '') + (f.paikalla ? '' : ' is-offline'), null, { role: 'button', tabindex: '0' });
    r.onclick = () => { if (f.id <= 0) return; valittu ? T.valitut.delete(f.id) : T.valitut.add(f.id); piirra(); };
    if (f.id > 0) r.appendChild(el('span', 'km-check' + (valittu ? ' is-on' : '')));
    r.appendChild(avatar(f.asu, { paikalla: f.paikalla, suunta: 4, nimi: f.nimi }));
    const nm = el('div', 'km-nm'); nm.appendChild(el('span', 'km-name', f.nimi)); if (f.motto) nm.appendChild(el('small', null, f.motto));
    const toim = el('div', 'km-row-actions'); toim.onclick = e => e.stopPropagation();
    if (f.id > 0) { const s = ib(el('span', 'nitro-friends-spritesheet ' + suhdeIkoni(f.suhde)), 'Suhde', () => { T.suhdeAuki = T.suhdeAuki === f.id ? null : f.id; piirra(); }); s.classList.add('km-suhde'); toim.appendChild(s); }
    if (f.paikalla && f.seurattava) toim.appendChild(ib('follow', 'Seuraa', () => laheta(3997, [f.id])));
    toim.appendChild(ib('start-chat', 'Lähetä viesti', () => avaaKetju(f.id)));
    r.append(nm, toim);
    if (T.suhdeAuki === f.id) {
      const v = el('div', 'km-rel'); v.onclick = e => e.stopPropagation();
      for (const [tyyppi, ik] of SUHTEET) v.appendChild(ib(el('span', 'nitro-friends-spritesheet ' + ik), 'Suhde', () => { laheta(3768, [f.id, tyyppi]); f.suhde = tyyppi; T.suhdeAuki = null; piirra(); }));
      r.appendChild(v);
    }
    return r;
  }
  function piirraKaverit(p) {
    p.textContent = '';
    const col = el('div', 'km-col');
    const tb = el('div', 'km-toolbar'); const lab = el('label', 'km-search'); lab.appendChild(el('span', 'km-icon search'));
    const q = el('input', null, null, { placeholder: 'Hae kavereista', 'data-km': 'kaverisuodatin' }); q.value = T.suodatin; q.addEventListener('input', () => { T.suodatin = q.value; piirra(); });
    lab.appendChild(q); tb.appendChild(lab);
    tb.appendChild(el('span', 'km-toolbar-meta', T.raja ? 'Kavereita ' + T.kaverit.size + '/' + T.raja : 'Kavereita ' + T.kaverit.size));
    const sc = el('div', 'km-scroll', null, { 'data-kmv': 'kaverit' });
    const suod = T.suodatin.trim().toLowerCase(), osuu = f => !suod || f.nimi.toLowerCase().includes(suod);
    const kaikki = [...T.kaverit.values()].sort(nimiJarjestys);
    const paikalla = kaikki.filter(f => f.paikalla && osuu(f)), poissa = kaikki.filter(f => !f.paikalla && osuu(f));
    if (T.kaverilistaSaatu <= 0) sc.appendChild(tyhja('Kaverilista latautuu...'));
    else if (!kaikki.length) sc.appendChild(tyhja('Sinulla ei ole vielä kavereita.', 'Etsi pelaajia Haku-välilehdeltä', () => vaihda('haku')));
    else {
      const valittavat = paikalla.filter(f => f.id > 0).map(f => f.id), kaikkiValittu = valittavat.length && valittavat.every(id => T.valitut.has(id));
      const osio = (nimi, auki, vaihdaAuki, lista, tyhjaTeksti, lisa) => {
        const b = el('button', 'km-sec is-toggle', null, { type: 'button' }); b.appendChild(el('span', 'km-caret' + (auki ? '' : ' is-closed'))); b.appendChild(document.createTextNode(nimi + ' (' + lista.length + ')'));
        if (lisa) b.appendChild(lisa); b.onclick = () => { vaihdaAuki(); piirra(); }; sc.appendChild(b);
        if (auki && !lista.length) sc.appendChild(el('div', 'km-empty is-inline', suod ? 'Ei osumia tällä haulla.' : tyhjaTeksti));
        if (auki) for (const f of lista) sc.appendChild(kaveriRivi(f));
      };
      let valitse = null;
      if (valittavat.length) { valitse = el('span', 'km-sec-action', kaikkiValittu ? 'Poista valinnat' : 'Valitse kaikki', { role: 'button' });
        valitse.onclick = e => { e.stopPropagation(); if (kaikkiValittu) valittavat.forEach(id => T.valitut.delete(id)); else valittavat.forEach(id => T.valitut.add(id)); piirra(); }; }
      osio('Paikalla', T.paikallaAuki, () => { T.paikallaAuki = !T.paikallaAuki; }, paikalla, 'Kukaan kavereistasi ei ole nyt paikalla.', valitse);
      osio('Poissa', T.poissaAuki, () => { T.poissaAuki = !T.poissaAuki; }, poissa, 'Kaikki kaverisi ovat paikalla.');
    }
    for (const id of [...T.valitut]) if (!T.kaverit.has(id)) T.valitut.delete(id);   // poistettu kaveri ei voi jäädä valituksi
    const n = T.valitut.size;
    const ala = el('div', 'km-footer');
    const kutsu = nappiEl('', 'Kutsu huoneeseen', 'invite', () => { T.dialogi = 'kutsu'; piirra(); }); kutsu.disabled = !n;
    const poista = nappiEl('is-danger', 'Poista', 'remove', () => { T.dialogi = 'poista'; piirra(); }); poista.disabled = !n;
    ala.append(kutsu, el('span', 'km-footer-spacer')); if (n) ala.appendChild(el('span', 'km-toolbar-meta', n + ' valittu')); ala.appendChild(poista);
    col.append(tb, sc, ala); p.appendChild(col);
    if (T.dialogi) p.appendChild(dialogi(n));
  }
  function dialogi(n) {
    const ov = el('div', 'km-overlay'); ov.onclick = () => { T.dialogi = null; piirra(); };
    const d = el('div', 'km-dialog'); d.onclick = e => e.stopPropagation();
    const peru = nappiEl('', 'Peruuta', null, () => { T.dialogi = null; piirra(); });
    const ids = [...T.valitut];
    if (T.dialogi === 'poista') {
      d.append(el('h3', null, 'Poista kavereita'), el('p', null, 'Haluatko varmasti poistaa nämä kaverit?'), el('div', 'km-dialog-list', ids.map(nimiId).join(', ')));
      const ok = nappiEl('is-danger', 'Poista', null, () => { laheta(1689, [ids.length, ...ids]); T.valitut.clear(); T.dialogi = null; piirra(); }); ok.disabled = !ids.length;
      const r = el('div', 'km-dialog-actions'); r.append(peru, ok); d.appendChild(r);
    } else {
      d.append(el('h3', null, 'Kutsu huoneeseen'), el('p', null, 'Kutsu ' + n + ' kaveria huoneeseen, jossa olet nyt.'));
      const ta = el('textarea', null, null, { maxlength: '255', placeholder: 'Kirjoita kutsuviesti', 'data-km': 'kutsuteksti' }); ta.value = T.kutsuteksti;
      const ok = nappiEl('is-primary', 'Lähetä kutsu', null, () => { const t = T.kutsuteksti.trim(); if (!t || !ids.length) return; laheta(1276, [ids.length, ...ids, t.slice(0, 255)]); T.kutsuteksti = ''; T.dialogi = null; piirra(); });
      ok.disabled = !T.kutsuteksti.trim() || !ids.length; ta.addEventListener('input', () => { T.kutsuteksti = ta.value; ok.disabled = !ta.value.trim() || !ids.length; });
      const r = el('div', 'km-dialog-actions'); r.append(peru, ok); d.append(ta, r);
    }
    ov.appendChild(d); return ov;
  }

  // ---------- Pyynnöt (MessengerRequestsTab) ----------
  function piirraPyynnot(p) {
    p.textContent = '';
    const col = el('div', 'km-col');
    const sec = el('div', 'km-sec', 'Kaveripyynnöt (' + T.pyynnot.size + ')');
    const paiv = el('span', 'km-sec-action', 'Päivitä', { role: 'button', title: 'Hae pyynnöt palvelimelta' }); paiv.onclick = () => laheta(2448, []); sec.appendChild(paiv);
    const sc = el('div', 'km-scroll', null, { 'data-kmv': 'pyynnot' });
    if (!T.pyynnot.size) sc.appendChild(tyhja('Ei uusia kaveripyyntöjä.'));
    for (const r of T.pyynnot.values()) {
      const row = el('div', 'km-row'); row.appendChild(avatar(r.asu, { suunta: 4, nimi: r.nimi }));
      const nm = el('div', 'km-nm'); const nimi = el('span', 'km-name', r.nimi, { role: 'button', title: 'Profiili' }); nimi.onclick = () => laheta(3265, [r.id, true]);
      nm.append(nimi, el('small', null, 'Haluaa kaveriksesi'));
      const toim = el('div', 'km-row-actions');
      toim.append(nappiEl('is-primary', 'Hyväksy', null, () => { laheta(137, [1, r.id]); T.pyynnot.delete(r.id); piirra(); }),
        nappiEl('', 'Hylkää', null, () => { laheta(2890, [false, 1, r.id]); T.pyynnot.delete(r.id); piirra(); }));
      row.append(nm, toim); sc.appendChild(row);
    }
    col.append(sec, sc); p.appendChild(col);
  }

  // ---------- Haku (MessengerSearchTab) ----------
  function piirraHaku(p) {
    p.textContent = '';
    const col = el('div', 'km-col');
    const lomake = el('form', 'km-toolbar'); const lab = el('label', 'km-search'); lab.appendChild(el('span', 'km-icon search'));
    const k = el('input', null, null, { maxlength: '50', placeholder: 'Hae pelaajaa nimellä', 'data-km': 'haku' }); k.value = T.hakusana; lab.appendChild(k);
    const hae = nappiEl('', 'Hae'); hae.type = 'submit'; hae.onclick = null; hae.disabled = !T.hakusana.trim();
    k.addEventListener('input', () => { T.hakusana = k.value; hae.disabled = !k.value.trim(); });
    lomake.onsubmit = e => { e.preventDefault(); const v = T.hakusana.trim(); if (!v) return; T.haku = null; T.hakuKaynnissa = true; laheta(1210, [v]); piirra(); };
    lomake.append(lab, hae);
    const sc = el('div', 'km-scroll', null, { 'data-kmv': 'haku' });
    const h = T.haku;
    if (!h) sc.appendChild(tyhja(T.hakuKaynnissa ? 'Haetaan...' : 'Kirjoita pelaajan nimi ja paina Hae.'));
    else if (!h.kaverit.length && !h.muut.length) sc.appendChild(tyhja('Haulla ei löytynyt pelaajia.'));
    else for (const [nimi, lista, onKaveri] of [['Kaverit', h.kaverit, true], ['Muut pelaajat', h.muut, false]]) {
      if (!lista.length) continue;
      sc.appendChild(el('div', 'km-sec', nimi + ' (' + lista.length + ')'));
      for (const x of lista) {
        // palvelimen hakutulos lähettää aina isAvatarOnline = false (v3:n havainto): kaverin tila kaverilistasta, muille ei pistettä
        const kf = onKaveri ? T.kaverit.get(x.id) : null, paikalla = kf ? kf.paikalla : undefined;
        const r = el('div', 'km-row' + (paikalla === false ? ' is-offline' : ''));
        r.appendChild(avatar((kf && kf.asu) || x.asu, { paikalla, suunta: 4, nimi: x.nimi }));
        const nm = el('div', 'km-nm'); const nn = el('span', 'km-name', x.nimi, { role: 'button', title: 'Profiili' }); nn.onclick = () => laheta(3265, [x.id, true]);
        nm.appendChild(nn); if (x.motto) nm.appendChild(el('small', null, x.motto));
        const toim = el('div', 'km-row-actions'); toim.appendChild(ib('profile', 'Profiili', () => laheta(3265, [x.id, true])));
        if (kf && kf.paikalla) toim.appendChild(ib('start-chat', 'Lähetä viesti', () => avaaKetju(x.id)));
        if (!onKaveri && x.id !== oma().id) {
          if (T.pyydetyt.has(x.id)) toim.appendChild(el('span', 'km-toolbar-meta', 'Pyyntö lähetetty'));
          else toim.appendChild(nappiEl('', 'Lisää kaveriksi', 'add', () => { laheta(3157, [x.nimi]); T.pyydetyt.add(x.id); piirra(); }));
        }
        r.append(nm, toim); sc.appendChild(r);
      }
    }
    col.append(lomake, sc); p.appendChild(col);
  }

  // ---------- Maininnat (lisäys v3:een: pelin omat 4801-4805) ----------
  function piirraMaininnat(p) {
    p.textContent = '';
    const col = el('div', 'km-col');
    const sec = el('div', 'km-sec', 'Maininnat (' + T.maininnat.length + ')');
    if (mainintojaUusia()) { const a = el('span', 'km-sec-action', 'Merkitse kaikki luetuiksi', { role: 'button' }); a.onclick = () => { laheta(4804, [0, 0]); T.maininnat.forEach(m => { m.luettu = true; }); piirra(); }; sec.appendChild(a); }
    const paiv = el('span', 'km-sec-action', 'Päivitä', { role: 'button', title: 'Hae maininnat palvelimelta' }); paiv.onclick = () => laheta(4803, []); sec.appendChild(paiv);
    const sc = el('div', 'km-scroll', null, { 'data-kmv': 'maininnat' });
    if (!T.maininnat.length) sc.appendChild(tyhja('Ei mainintoja tässä istunnossa.', 'Hae aiemmat maininnat', () => laheta(4803, [])));
    for (const m of T.maininnat) {
      const r = el('div', 'km-row km-mrow' + (m.luettu ? '' : ' is-active'), null, { role: 'button', tabindex: '0', title: m.luettu ? '' : 'Merkitse luetuksi' });
      r.onclick = () => { if (!m.luettu) { laheta(4804, [1, m.id]); m.luettu = true; piirra(); } };
      r.appendChild(avatar(m.asu, { suunta: 2, nimi: m.lahettaja }));
      const nm = el('div', 'km-nm'); nm.appendChild(el('span', 'km-name', m.lahettaja));
      nm.appendChild(el('small', null, (m.huone > 0 ? (m.huoneNimi || 'huone ' + m.huone) : 'Ei huonetta') + ', ' + mainintaAika(m.aika)));
      nm.appendChild(el('div', 'km-txt', m.viesti || '@-maininta ilman viestiä'));
      const toim = el('div', 'km-row-actions'); toim.appendChild(ib(risti(), 'Poista maininta', () => { laheta(4805, [m.id]); T.maininnat = T.maininnat.filter(x => x.id !== m.id); piirra(); }));
      r.append(nm, toim); sc.appendChild(r);
    }
    col.append(sec, sc); p.appendChild(col);
  }

  // ---------- Datajakon ikkuna upotettuna (Viestit: huoneen chat, Skriptit: lisäosat) ----------
  // Sama ikkuna siirretään sinne missä sitä tarvitaan. Datajako laskee lukemattomat vain kun sen ikkuna on piilossa (display),
  // joten se piilotetaan aina kun se ei ole näkyvissä messengerissä.
  const djPaikka = el('div', 'km-main km-djpaikka');
  let djNakyma = '';
  function upotaDj(sailio, nakyma, vaihda) {
    const u = djUI();
    if (!u || !u.ikkuna) { sailio.textContent = ''; sailio.appendChild(tyhja('Datajako-lisäosa ei ole päällä tässä selaimessa.')); return false; }
    const siirretty = u.ikkuna.parentElement !== sailio; if (siirretty) { sailio.textContent = ''; sailio.appendChild(u.ikkuna); }
    Object.assign(u.ikkuna.style, { position: 'relative', left: '0', top: '0', right: 'auto', bottom: 'auto', width: '100%', height: '100%', display: '', transform: 'none', zIndex: 'auto', maxWidth: 'none' });
    if (u.upotettu) u.upotettu(true);
    if (u.avaaja) u.avaaja.style.display = 'none';
    try { if (u.onPien && u.onPien()) u.pienenna(false); if (siirretty || djNakyma !== nakyma) { djNakyma = nakyma; vaihda(u); } } catch (e) {}
    return true;
  }
  function djPiiloon() { const u = djUI(); if (u && u.ikkuna && juuri && juuri.contains(u.ikkuna)) { u.ikkuna.style.display = 'none'; djNakyma = ''; } }

  // ---------- Skriptit (Res 08:35 "lisäosille oma skriptit tab johon otetaa myös packet tools macroja yms") ----------
  const skriptiPaikka = el('div', 'km-djpaikka');
  function piirraSkriptit(p) {
    if (!p.firstChild) {
      const col = el('div', 'km-col');
      const sec = el('div', 'km-sec', 'Lisäosat'); sec.appendChild(el('span', 'km-sec-ohje', 'Datajaon kautta jaetut, ajo aina vahvistuksella'));
      col.append(sec, skriptiPaikka, el('div', 'km-tulossa', 'Packet tools ja makrot tulevat tälle välilehdelle.'));
      p.appendChild(col);
    }
    upotaDj(skriptiPaikka, 'lisaosat', u => u.lisaosat && u.lisaosat());
  }
})();
