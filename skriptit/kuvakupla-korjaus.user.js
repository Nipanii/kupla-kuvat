// ==UserScript==
// @name         Kupla Kuvakupla-korjaus
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      0.3.21
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/kuvakupla-korjaus.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/kuvakupla-korjaus.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Gif/kuvakuplat eivät jää päällekkäin livechatissa eivätkä yläveto-historiassa, ja historian tekstikuplat pinoutuvat ilman päällekkäisyyksiä.
// @kupla-oletus on
// @author       re-lab
// ==/UserScript==
//
// kp 2026-10-04 16:20 (Datajako, kuvat): "aika pahasti menee giffit ja puhekuplat" · 16:31 "no tee lisäosa alkuun".
// 0.2.0 kp 17:52 "laita tänne testiin kans uusin versio fixeistä" — sama kuin PR 0-es/kupla-cc#142.
//
// 1) LIVECHAT. SYY: ChatWidgetMessageView.tsx mittaa kuplan korkeuden KERRAN mountissa; kuva <img loading="lazy"> ei varaa
//    korkeutta -> kupla kasvaa alaspäin uusien kuplien päälle. KORJAUS: ResizeObserver; kasvu -> chat.height päivitetään ja tämä
//    kupla + kaikki vanhemmat (pienempi chat.id) ylös kasvun verran (chat.top-setteri kirjoittaa style.topin itse).
//    0.3.19: EI enää kaikkia vanhempia (toisen sarakkeen kuplat hyppivät) -> kasvanut kupla ylös + pelin free-flow I() törmääville.
// 2) YLÄVETO-HISTORIA. SYY a: layoutChatPulldown mittaa kuplat ennen lazy-kuvan latausta eikä mikään asettele uudelleen.
//    SYY b: se pinoaa VANHALLA rekursiolla, jonka livechat on jo korvannut (checkOverlappingChats) -> tekstikuplatkin päällekkäin.
//    KORJAUS (selaimessa, koska layout-funktioon ei pääse): aina kun yläveto asettelee (kanvaasin korkeus vaihtuu) tai kuva latautuu,
//    lasketaan pystypaikat uudelleen PR:n algoritmilla nykyisistä korkeuksista ja kirjoitetaan style.bottom + kanvaasin korkeus.
//    x (style.left) jätetään pelin laskemaksi. Mitattu robolla: vanha 2 päällekkäin / uusi 0 (150 kuplaa), kuvat välimuisti pois 9 -> 0.
// 🔴 MITTAUSANSA (4.10. 21:33): ResizeObserver EI LAUKEA piilotetussa välilehdessä (robon client: hidden, tila.ro 0) -> robolla
//    mitattu ei koskaan testannut kasvu-/keskityspolkua, vain erota()-polun. Testaa näkyvässä clientissa (kp :9222: korjauksia 12).
// 0.3.0 kp 23:42 "Tarviiko kuuntelijaa eikö voi olla älykäs trigger ... Ilman pollaamista ja jatkuvaa kuuntelua/mittausta?":
//    koko sivun MutationObserver (heräsi JOKAISESTA style/class-muutoksesta) POISTETTU. Triggerit nyt:
//    livechat = kuvan load-tapahtuma (vain silloin kupla kasvaa) -> ResizeObserver VAIN siihen kuplaan; tekstikupliin ei kosketa.
//    yläveto = .nitro-chat-widget saa luokan chat-pulldown-open (ChatWidgetView.tsx:234) -> MutationObserver VAIN historian
//    kanvaasiin ja vain auki ollessa; sulkeutuessa irti. Widgetin vaihtuminen (huoneenvaihto) tarkistetaan pointerdownista.
// 0.3.1 kp 00:05 "entä jos on joku ääritilanne jossa chat kuplan koko muuttuu ... jos me katsottaisiin vaan giffejä": kupla voi kasvaa
//    ilman kuvaa (toistolaskuri x2, emoji-kuva, myöhään latautuva fontti) -> 0.3.0 ei olisi huomannut. Nyt JOKAINEN kupla saa
//    ResizeObserverin, ja uudet kuplat löydetään widgetin childList-muutoksesta (herää kerran per chat-viesti, ei style/class-muutoksista).
//    Sama kattavuus kuin PR #142:ssa (ChatWidgetMessageView observoi jokaisen kuplan).
// RAJA: vain kasvu korjataan livechatissa. Yläveto: React kirjoittaa omat paikkansa joka asettelussa, tämä korjaa ne heti perään.
// 0.3.18 (kp 5.10. 02:51-03:30 "sun viestin välii tulee outo gap mitä ei oo livessä" / "koska ne kuvat saa ne bubblet hyppii"):
//   historia käyttää livessä nähtyjen viestien OIKEITA livepaikkoja (liven oma 6 s worker otetaan kiinni START-viestistä), xN kuten livessä,
//   kuvakuplan korkeus varataan ennen latausta, vierekkäisten väli lukitaan. Tarkat muutokset ja mittaukset: PR-MUISTIO-0.3.18.md.
//   Livepaikat alkavat vasta kun skripti oli asennettuna huoneeseen tullessa (loader sivun latauksessa = aina).
// 0.3.19 (kp 5.10. 03:54 kuvakaappaus "mun client": kk-testi kp 2 ja kp 3 päällekkäin LIVESSÄ). Mitattu tmp/top-loki.js:llä (pelin
//   hl.top-setteri käärittynä, siirron tekijä pinosta): päällekkäisyys ja hypyt olivat TÄMÄN skriptin. Livechatissa:
//   a) erota() ajoi 0.3.13:sta asti jarjesta()-säännön (KELLON 6 s raja, sarakkeista välittämättä): robon kuvan saapuessa kp:n sarake
//      hyppäsi 162-191 px ylös vaikka peli ei liikuttanut sitä (sarakkeet eivät törmää), ja joka uusi rivi nosti toisen sarakkeen gifiä ~28 px.
//   b) kasvukorjaus nosti KAIKKI vanhemmat kuplat (myös toisen sarakkeen) kasvun verran.
//   c) kumpikaan ei antanut skipMovement-lippua -> askeleella alempi kupla nousi 15 px ylemmän (skip) päälle.
//   KORJAUS (pelin free-flow-logiikka, ei omaa sääntöä): liven jarjesta pois; kasvu = kupla ylös kasvun verran ja pelin I()-työntö
//   (vain törmäävät vanhemmat, kosketus = törmäys); siirretty kupla saa sen kuplan skipin jonka päälle se asettuu; askeleen alussa
//   skip-kupla, jonka alla alle 15 px:n päässä on ei-skip-kupla samalla vaakasuoralla, menettää skipin (liikkuvat yhdessä).
// 0.3.20 (5.10. 04:4x, löytyi kahden tilin testin jälkeen): 0.3.19:n poistuneen kuplan ankkuri (r.ank/r.rel) EI tallentunut
//   localStorageen (tallenna() kirjoitti vain n,x,t,y,s,i,d,h,p; mitattu: robo 139 tietuetta / kp 99, ankkurillisia 0) -> sivun
//   uudelleenlatauksen jälkeen poistuneet kuplat palasivat jäädytettyyn y:hyn, eli muutoksen 12 päällekkäisyys palasi. Nyt mukana.
//   Kertaluonteinen raja: päivitys vanhasta versiosta tallentaa vielä vanhalla tallenna():lla (pagehide / __kuvakuplaPois).
(() => {
  'use strict';
  const VW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (VW.__kuvakuplaPois) { try { VW.__kuvakuplaPois(); } catch (e) {} }   // vanha versio pois ennen uutta
  // 0.3.21 (kp 05:10 "laitetaan pr jo nyt, res voi testata sen ennen mergeä"): kun sama korjaus on clientissa (PR 0-es/kupla-cc#142),
  //   client asettaa window.__kuplaChatFix -> tämä ei asennu. Muuten molemmat korjaisivat: kasvava kuva nousisi kahdesti, historia
  //   aseteltaisiin kahdesti. Kenenkään ei tarvitse muistaa poistaa skriptiä deployn jälkeen.
  if (VW.__kuplaChatFix) { VW.__kuvakuplaPois = null; VW.__kuplaKuvakupla = false;
    VW.__kuvakuplaTila = { versio: '0.3.21', ohitettu: 'client sisältää korjauksen (__kuplaChatFix ' + VW.__kuplaChatFix + ')' }; return; }
  VW.__kuplaKuvakupla = true;
  const fiberProp = (el, key) => {
    const k = Object.keys(el).find(x => x.startsWith('__reactFiber$')); let f = k && el[k];
    for (let i = 0; i < 10 && f; i++) { const v = f.memoizedProps && f.memoizedProps[key]; if (v) return v; f = f.return; }
    return null;
  };

  // ---- 1) livechat ----
  const seurattu = new WeakSet();
  const chatOf = el => { const c = fiberProp(el, 'chat'); return c && typeof c.id === 'number' ? c : null; };
  const kuplat = () => [...document.querySelectorAll('.nitro-chat-widget > .bubble-container')];
  const tila = VW.__kuvakuplaTila = { versio: '0.3.21', korjauksia: 0, keskitetty: 0, ro: 0, seurattu: 0, erotettu: 0, viimeisin: null, historia: 0 };
  // 0.2.2: kasvu siirtää kuvakuplan JA vanhemmat saman verran, joten vanhempi joka oli jo SAMALLA korkeudella (peli ei erottanut
  // niitä, kuva oli mountissa ~0 px) jäi päällekkäin pysyvästi. Mitattu kp:n clientissa 4.10. 21:06: "prööt" ja gif molemmat top 352,
  // "pioas" ja gif molemmat 369. Siksi kasvun jälkeen jokainen vanhempi kupla, joka on uudemman päällä, nostetaan sen yläpuolelle
  // (vain ylöspäin, kuten pelin oma pinoaminen).
  // 0.3.12 järjestyssääntö, sama funktio liveen ja historiaan. c = vanhin ensin. Vanhempi nostetaan (ei koskaan lasketa) niin, että sen
  //   alareuna on uudemman alareunan tasolla tai ylempänä, ja 15 px ylempänä jos välissä on 6 s raja. Nosto voi osua vielä vanhempaan
  //   samassa kohdassa -> se työnnetään sen yläpuolelle kuten pelin oma I()/g.
  const jarjesta = (c, aika, top, aseta, kork, osuu, kiintea) => {
    const raja = (a, b) => !!(a && b && Math.floor(b / 6000) > Math.floor(a / 6000));
    let n = 0;
    for (let k = c.length - 2; k >= 0; k--) {
      const it = c[k];
      if (kiintea && kiintea(it)) continue;   // 0.3.18: livessä nähty kupla pysyy livepaikallaan (0.3.19: liven järjestys on pelin oma)
      // 0.3.13 kp 02:41 "mut jos ne oli ajallisesti kuitenkin selkeessä järjestyksessä" / "onko se bugi että niiden y on overlapping":
      //   jos välissä on 6 s raja, aiempi KOKONAAN uudemman yläpuolelle (alareuna <= uudemman yläreuna), x:stä riippumatta.
      //   Saman 6 s askeleen sisällä: aiempi ei alempana (alareuna <= alareuna), eli rinnakkain saa olla.
      let ylin = Infinity;
      for (let j = k + 1; j < c.length; j++) { const w = c[j]; ylin = Math.min(ylin, raja(aika(it), aika(w)) ? top(w) : top(w) + kork(w)); }
      if (top(it) + kork(it) > ylin) { aseta(it, ylin - kork(it)); n++; }
      if (osuu) for (let g = 0; g <= c.length; g++) {   // päällekkäin uudemman kanssa samassa kohdassa -> sen yläpuolelle
        const w = c.slice(k + 1).find(w => osuu(it, w) && top(it) + kork(it) > top(w) && top(it) < top(w) + kork(w)); if (!w) break; aseta(it, top(w) - kork(it)); }
    }
    tila.jarjestetty = (tila.jarjestetty || 0) + n; return n;
  };
  let asennettu = false;
  const saapui = new WeakMap();   // live-kuplan saapumisaika (havaittu childList-muutoksesta); ennen asennusta tulleilla ei ole

  // ---- 0.3.18 livepaikat ----
  // kp 02:51 "sun viestin välii tulee outo gap mitä ei oo livessä" / 02:52 "kyl tämäkin versio pistää hypyn sun viimesen späm 1 ja 2 väliin".
  //   SYY (mitattu chat-puskurista): 0.3.10-0.3.13 arvasi liven 6 s askeleet KELLOSTA (floor(aika/6000)), mutta live liikkuu oman
  //   workerinsa tahdissa (yte: b=new dte(ute); b.onmessage=()=>m(15); b.postMessage({action:"START",content:6e3}) -> joka viestillä
  //   kaikki top -= 15, skipMovement-kupla jättää yhden väliin). Workerin vaihe on satunnainen (käynnistyy kun widget mountataan, joka
  //   clientissa eri hetkellä) -> spam 1 (02:50:23.24) ja spam 2 (02:50:24.63) osuivat kellorajan eri puolille = historiaan +15 px rako,
  //   jota livessä ei ollut. Ja kahden clientin live eroaa siksi itsekin.
  //   KORJAUS (ei arvausta): START tunnistetaan sisällöstä ja workerin askeleet otetaan kiinni. Jokaisen livekuplan paikka tallennetaan
  //   koordinaatissa y = chat.top + F, missä F kasvaa 15 joka askeleella (ja yte:n ikkunan koonmuutos-siirron verran). Askel siirtää
  //   kaikkia yhtä paljon, joten y muuttuu vain kun live oikeasti siirtää kuplaa muihin nähden (työntö I(), skipMovement, kuvan kasvu).
  //   Historiassa livessä nähty viesti saa tämän y:n -> täsmälleen sama keskinäinen asettelu kuin livessä oli.
  const NN = s => String(s || '').replace(/<[^>]*>/g, '').trim().slice(0, 200);   // pelin NN (eK:n tekstivertailu) + pituusraja
  const LP_KEY = 'kuvakupla-livepaikat-v1', LP_MAX = 900;
  let paikat = [];
  try { const v = JSON.parse(localStorage.getItem(LP_KEY) || '[]'); if (Array.isArray(v)) paikat = v.filter(r => r && typeof r.y === 'number' && r.t > Date.now() - 864e5).map(r => Object.assign(r, { v: 1 })); } catch (e) {}
  // 0.3.18 kuvakuplien lopullinen korkeus (kp 02:1x "koska ne kuvat saa ne bubblet hyppii"; mitattu 03:22 tmp/pd-frames.js: avauksessa gif
  //   latautui 128 ms, 155 ms kohdalla kaikki sitä vanhemmat 124 kuplaa nousivat 151 px). Historian kuva latautuu vasta avauksen jälkeen
  //   (lazy), joten ensimmäinen asettelu laskee sen pienenä. Talletetaan kerran ladatun kuvakuplan korkeus ja varataan se seuraavalla kerralla.
  const KK_KEY = 'kuvakupla-korkeudet-v1';
  let korkeudet = {}; try { const v = JSON.parse(localStorage.getItem(KK_KEY) || '{}'); if (v && typeof v === 'object') korkeudet = v; } catch (e) {}
  let korkMuuttui = false;
  const tallenna = () => { try { localStorage.setItem(LP_KEY, JSON.stringify(paikat.filter(r => typeof r.y === 'number').slice(-LP_MAX).map(r => ({ n: r.n, x: r.x, t: r.t, y: r.y, s: r.s, i: r.i, d: r.d, h: r.h, p: r.p, ank: r.ank, rel: r.rel })))); } catch (e) {}
    if (korkMuuttui) { const k = Object.keys(korkeudet); if (k.length > 600) for (const x of k.slice(0, k.length - 600)) delete korkeudet[x];
      try { localStorage.setItem(KK_KEY, JSON.stringify(korkeudet)); korkMuuttui = false; } catch (e) {} } };
  const rek = new WeakMap(), kuplanChat = new WeakMap();   // live chat -> tietue, live-elementti -> chat (poiston jälkeen fiber voi olla irti)
  let F = 0, jakso = 0, tunnetaan = false, kesken = false, wH = 0, askelia = 0, kWorker = null, kAlku = null, viim = 0, valiMs = 6000;
  const elavat = () => kuplat().map(el => ({ el, c: chatOf(el) })).filter(x => x.c && typeof x.c.top === 'number');
  const tietue = (el, c) => {
    let r = rek.get(c); if (r) return r; if (!tunnetaan) return null;
    r = paikat.find(p => p.s === jakso && p.i === c.id) || null;   // uudelleenasennus kesken huoneen: sama jakso, sama chat.id
    if (!r) { if (!saapui.has(el)) return null;
      r = { n: String(c.username || ''), x: NN(c.formattedText), t: saapui.get(el), s: jakso, i: c.id, d: 1, y: null, a: askelia };
      paikat.push(r); if (paikat.length > LP_MAX * 1.2) paikat = paikat.slice(-LP_MAX); }
    rek.set(c, r); return r;
  };
  const kirjaa = (c, r) => { r.y = c.top + F; r.d = c.duplicateCount || 1;
    // wte asettaa uuden kuplan paikan useEffectissä ja makeRoom (I()-työntö, skipMovement=true) ajetaan VASTA seuraavassa renderissä
    if (!r.v && (c.skipMovement || askelia !== r.a || Date.now() - r.t > 150)) r.v = 1; };
  // 0.3.18 vahti (vain kirjaus, ei korjaa): 03:31 jakson 17331 tietueet olivat 131-338 px väärin eikä syytä saatu toistettua.
  //   Jos jo kirjatun kuplan y = top + F muuttuu askelten välillä ilman uutta saapumista tai kuvan kasvua, se kirjataan tila.poikkeamat.
  const vahti = { tila: null };
  const vahtiTila = () => ({ n: paikat.length, k: tila.korjauksia, e: tila.erotettu, j: tila.liveJarj || 0, H: widget ? parseFloat(widget.style.height) || 0 : 0 });
  const valvo = () => {   // edellisen askeleen jälkeen otettu tila vs nyt: jos mitään selittävää ei tapahtunut, y:n pitää täsmätä
    const ed = vahti.tila; if (!ed || !tunnetaan || kesken || !widget) return; const t = vahtiTila();
    if (ed.n !== t.n || ed.k !== t.k || ed.e !== t.e || ed.j !== t.j || ed.H !== t.H) return;
    const v = []; for (const { el, c } of elavat()) { if (c.elementRef !== el) continue; const r = rek.get(c); if (!r || !r.v || typeof r.y !== 'number') continue;
      const d = Math.round(c.top + F - r.y); if (d) v.push([c.id, d]); }
    if (v.length) { const p = tila.poikkeamat = tila.poikkeamat || []; p.push([new Date().toTimeString().slice(0, 8), F, v]); if (p.length > 20) p.shift(); }
  };
  const nayte = () => {
    if (!tunnetaan || kesken || !widget) return 0;
    // yte resize: d.current.style.height=E; kaikki top -= (vanha - E) -> sama siirto F:ään. Luetaan pelin oma inline-korkeus, ei offsetHeight
    const H = parseFloat(widget.style.height) || 0; if (wH && H && H !== wH) F += wH - H; if (H) wH = H;
    let n = 0;
    for (const { el, c } of elavat()) { if (c.elementRef !== el) continue; const r = tietue(el, c); if (!r) continue; kirjaa(c, r); r.h = el.offsetHeight; n++; }
    tila.paikkoja = paikat.length; tila.F = F; return n;
  };
  const kiinni = (w, uusi) => {
    const f = w.onmessage; if (typeof f !== 'function') return false;
    kWorker = w; kAlku = f;
    if (uusi) { jakso = Date.now(); F = 0; wH = 0; viim = Date.now(); }
    tunnetaan = true; kesken = false; tila.tunnetaan = true; tila.jakso = jakso;
    w.onmessage = function (e) {
      kesken = false; let ref = null, ennen = 0, skipit = []; const ennenTop = new Map();
      try { valvo(); nayte(); puraSkip(); const L = elavat(); const v = L.find(x => !x.c.skipMovement); if (v) { ref = v.c; ennen = ref.top; }
        for (const x of L) ennenTop.set(x.c, x.c.top);
        skipit = L.filter(x => x.c.skipMovement).map(x => rek.get(x.c)).filter(r => r && typeof r.y === 'number'); } catch (x) {}
      const tulos = f.call(this, e);   // pelin m(15)
      F += TICK_PX; askelia++; tila.askeleet = askelia; viim = Date.now();
      // skipMovement-kupla jää paikalleen kun muut siirtyvät -> sen y kasvaa 15 HETI, vaikka React tekisi siirron myöhemmin (kesken).
      //   Ennen tätä tietue oli askeleen jäljessä seuraavaan askeleeseen asti, ja väliin osunut asettelu näytti kuplan 15 px väärin.
      for (const r of skipit) r.y += TICK_PX;
      vahti.tila = vahtiTila();
      // React laskee päivityksen yleensä heti (eager); jos ei, siirto tulee myöhemmin -> ei näytteitä ennen seuraavaa askelta
      if (ref && ref.top !== ennen - TICK_PX) { kesken = true; tila.kesken = (tila.kesken || 0) + 1; }
      // 0.3.19: pelin m() ajaa A():n samassa päivityksessä -> kupla joka nyt ylitti rajan (top <= -2*korkeus) poistuu ilman että sitä
      //   koskaan piirretään siirrettynä. Viimeksi nähty väli on siis ASKELTA EDELTÄVÄ. Ankkuroidaan tässä niillä paikoilla (mitattu
      //   04:24: askeleen jälkeen otettu väli oli 14-15 px väärin, kun ankkuri oli skip-kupla ja jäi paikalleen).
      if (!kesken) try { const lahtevat = elavat().map(x => x.c).filter(c => c.height > 0 && !(c.top > -c.height * 2));
        if (lahtevat.length) ankkuroi(lahtevat, c => ennenTop.has(c) ? ennenTop.get(c) : c.top, askelia); } catch (x) {}
      if (askelia % 10 === 0) tallenna();
      return tulos;
    };
    return true;
  };
  const WP = VW.Worker && VW.Worker.prototype, alkuPM = WP && WP.postMessage;
  const omaPM = function (msg) {
    try {
      if (msg && msg.action === 'START' && typeof msg.content === 'number' && this !== kWorker) { tila.startit = (tila.startit || 0) + 1;
        // START ajetaan yte:n useEffectissä -> uusi widget on jo DOMissa: seurataan sitä heti, ei vasta seuraavasta pointerdownista
        valiMs = msg.content; if (kiinni(this, true)) kiinnita(); }
      else if (msg && msg.action === 'STOP' && this === kWorker) { tunnetaan = false; tila.tunnetaan = false; tallenna(); }
    } catch (e) {}
    return alkuPM.apply(this, arguments);
  };
  if (WP && typeof alkuPM === 'function') WP.postMessage = omaPM;
  { const ed = VW.__kuvakuplaWorker; VW.__kuvakuplaWorker = null;   // edellinen asennus jätti workerin (sama huone jatkuu)
    // Jatketaan samaa jaksoa vain jos yhtään askelta ei jäänyt laskematta (välissä ajettu vanha versio ei laske niitä) -> muuten uusi jakso
    if (ed && ed.w && ed.w.onmessage === ed.f) { valiMs = ed.valiMs || 6000; askelia = ed.askelia || 0;
      if (Date.now() - (ed.viim || 0) < valiMs - 50) { jakso = ed.jakso; F = ed.F; wH = ed.wH; viim = ed.viim; kiinni(ed.w, false); } else { kiinni(ed.w, true); tila.jaksoUusi = 1; } } }
  // 0.3.19: liven jarjesta() (kellon 6 s raja kaikille sarakkeille) POISTETTU, ks. otsake. Jäljelle jää päällekkäisyyden erottelu
  //   (kasvu, leveyden keskitys): vanhempi kupla uudemman päälle -> sen yläpuolelle, ja se saa ALEMMAN skipin, jotta seuraavalla
  //   askeleella ne liikkuvat yhdessä (pelin I() antaa työnnetylle skipin, koska sen kantaja on uusi skip-kupla: sama sääntö).
  const erota = () => {
    const L = kuplat().map(el => ({ el, c: chatOf(el), r: el.getBoundingClientRect() })).filter(x => x.c && typeof x.c.top === 'number').sort((a, b) => b.c.id - a.c.id);
    for (let i = 1; i < L.length; i++) {
      const x = L[i], h = x.el.offsetHeight;
      for (let n = 0; n < L.length; n++) {
        const este = L.slice(0, i).find(y => x.r.left < y.r.right && x.r.right > y.r.left && x.c.top + h > y.c.top && x.c.top < y.c.top + y.el.offsetHeight);
        if (!este) break;
        x.c.top = este.c.top - h; x.c.skipMovement = !!este.c.skipMovement; tila.erotettu++;
      }
    }
  };
  // pelin tK ja free-flow I() (live-App: I=(m,b,h)=>{for(E=e.indexOf(m)-1..0){N=e[E]; if(!(...||N.top+N.height-b>m.top+m.height)&&tK(m,N,-b,0))
  //   {w=|N.top+N.height-m.top|; N.top-=w; N.skipMovement=!0; I(N,w,h)}}}). Ainoa ero: skip = kantajan skip (pelissä kantaja on aina uusi
  //   skip-kupla, joten sama arvo). Käytetään kasvukorjauksessa: kasvanut kupla nousee ja työntää VAIN törmäävät vanhemmat.
  const tK = (t, e, r) => !(t.left + t.width < e.left || t.left > e.left + e.width || t.top + t.height < e.top + r || t.top > e.top + r + e.height);
  //   Rekursiossa EI pelin -b-siirtymää: peli testaa ylempää kuplaa työnnetyn kuplan VANHAA paikkaa vasten (kosketti ennen -> työnnetään),
  //   mikä toimii pelin pienillä työnnöillä (~29 px) mutta ei kasvussa (130 px): mitattu 04:07 robolla, varoituskupla jäi 1 px raon takia
  //   työntämättä ja kuvan alle ~30 ms (erota korjasi). Tässä törmäys testataan työnnetyn kuplan UUTTA paikkaa vasten.
  const tyonna = m => {
    const E = kuplat().map(el => chatOf(el)).filter(c => c && typeof c.top === 'number').sort((a, b) => a.id - b.id);
    const I = (m, h) => { for (let k = E.indexOf(m) - 1; k >= 0; k--) { const N = E[k];
      if (!(!N || m === N || h.indexOf(N) >= 0 || N.top + N.height > m.top + m.height) && tK(m, N, 0)) {
        const w = Math.abs(N.top + N.height - m.top); h.push(N); N.top -= w; N.skipMovement = !!m.skipMovement; tila.tyonnetty = (tila.tyonnetty || 0) + 1; I(N, h); } } };
    I(m, [m]);
  };
  // askeleen alussa: skip-kupla jää paikalleen ja muut nousevat 15 -> jos sen alla (sama vaakasuora alue) on alle 15 px:n päässä
  //   ei-skip-kupla, se nousisi päälle (mitattu 03:52 kp:n clientissa: kp 2 skip, kp 3 ei -> 14 px päällekkäin). Skip pois -> yhdessä.
  const puraSkip = () => {
    const L = kuplat().map(el => ({ el, c: chatOf(el), r: el.getBoundingClientRect() })).filter(x => x.c && typeof x.c.top === 'number');
    let n = 0, muuttui = true;
    while (muuttui) { muuttui = false;
      for (const a of L) { if (!a.c.skipMovement) continue; const ala = a.c.top + a.el.offsetHeight;
        if (L.some(b => b !== a && !b.c.skipMovement && b.r.left < a.r.right && b.r.right > a.r.left && b.c.top >= a.c.top && b.c.top - ala < TICK_PX)) {
          a.c.skipMovement = false; n++; muuttui = true; } } }
    if (n) tila.skipPurettu = (tila.skipPurettu || 0) + n;
    return n;
  };
  VW.__kuvakuplaErota = erota;
  VW.__kuvakuplaDebug = () => ({ F, jakso, kesken, askelia, tunnetaan, paikat: paikat.slice(-30), elavat: elavat().map(({ el, c }) => ({ id: c.id, top: c.top, skip: c.skipMovement, ref: c.elementRef === el, h: el.offsetHeight, r: rek.get(c) || null })) });   // testeille
  // 0.2.3 kp 21:18 "normi viesti oli hetken giffin pääl, mut korjaantu": 0.2.2 erotteli vain 600 ms uuden kuplan jälkeen ja kasvussa,
  // mutta kasvupolku ei lauennut kertaakaan (korjauksia 0) -> myöhään latautuva gif jäi päälle seuraavaan viestiin asti.
  let erotaVaraus = 0;
  const erotaPian = () => { if (!erotaVaraus) erotaVaraus = setTimeout(() => { erotaVaraus = 0; erota(); }, 30); };
  const ro = new ResizeObserver(entries => {
    tila.ro++;
    for (const en of entries) {
      const el = en.target; if (!el.isConnected) { ro.unobserve(el); continue; }
      const c = chatOf(el); if (!c || c.elementRef !== el) continue;
      // 0.2.4 kp 21:30 "se on keskitetty oikein, mut leveys muuttuu": left = puhujaX - leveys/2 lasketaan mountissa, kun lataamaton
      // gif on vain nimen levyinen (138 px) -> leveneminen (288) meni kokonaan oikealle (+75 px). Leveyden muutos -> keskitetään uudestaan.
      const lev = el.offsetWidth;
      if (c.width && lev && lev !== c.width) { c.left = Math.round(c.left - (lev - c.width) / 2); tila.keskitetty++; }
      if (lev) c.width = lev;
      const uusi = el.offsetHeight, delta = uusi - c.height;
      if (!(delta > 0) || !c.height) { if (!c.height) c.height = uusi; continue; }
      c.height = uusi;
      // 0.3.19: ennen tämä kupla + KAIKKI vanhemmat (myös toisen sarakkeen) ylös deltan verran. Nyt kuten pelin free-flow: kasvanut
      //   kupla ylös (alareuna takaisin paikalleen) ja pelin I()-työntö vain törmääville vanhemmille, skip kasvaneelta kuplalta.
      c.top = c.top - delta; tyonna(c);
      tila.korjauksia++; tila.viimeisin = { id: c.id, delta, t: Date.now() };
    }
    erotaPian();   // 0.2.3: jokainen koonmuutos (myös ensimmäinen mittaus, jota yllä ohitetaan) -> erottelu
  });
  // 0.3.0: vain kuvan sisältävä kupla seurataan, ja vasta kun kuva latautuu (ResizeObserverin ensimmäinen kutsu korjaa kasvun).
  const seuraa = img => { const b = img.closest('.nitro-chat-widget > .bubble-container'); if (b && !seurattu.has(b)) { seurattu.add(b); ro.observe(b); tila.seurattu++; } };

  // ---- 2) yläveto ----
  const TICK_MS = 6000, TICK_PX = 15, MAX_TICKS = 4, MIN_GAP = 13, TOP_OFFSET = 42;
  const overlaps = (a, b) => !((a.left + a.width) < b.left || a.left > (b.left + b.width) || (a.top + a.height) <= b.top || a.top >= (b.top + b.height));
  let kirjoitan = false, ajastettu = 0;
  // 0.3.9: live-chatin paikat vedon alkuhetkeltä; sama kupla tunnistetaan tekstistä (tmp/live-vs-hist.js: 28/29 paria)
  const avain = el => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);   // 0.3.18: oli /s+/ (s-kirjaimet pois), molemmilla puolilla sama
  let liveKuva = null;
  const muokatut = new Set();   // historian kuplat joihin kirjoitettiin display/visibility tai xN-merkki (palautetaan poistossa)
  const otaLiveKuva = () => kuplat().map(el => { const r = el.getBoundingClientRect(); return { key: avain(el), top: r.top, h: r.height }; }).filter(x => x.h > 0 && x.key);
  const asettele = () => {
    ajastettu = 0;
    const canvas = document.querySelector('.chat-pulldown-canvas'); if (!canvas) return;
    const els = [...canvas.querySelectorAll('.chat-pulldown-bubble:not(.chat-pulldown-measure)')]; if (!els.length) return;
    uudetKuplat(); nayte();   // 0.3.18: kanvaasin vahti herää ennen widgetin vahtia -> uudet livekuplat tietueiksi ja tuoreet paikat ensin
    const kaikki = els.map(el => { const e = fiberProp(el, 'entry'); return { el, e, n: e ? String(e.name || '') : '', x: e ? NN(e.message) : '', top: 0, at: e && Number.isFinite(e.cachedAt) ? e.cachedAt : 0 }; });
    // 0.3.18 paritus livetietueeseen: sama lähettäjä + sama teksti (pelin NN) + lähin aika (cachedAt vs livekuplan havaintohetki, ms-luokkaa)
    const K = (n, x) => n + '\u0001' + x, avaimet = new Map(), kaytetty = new Set();
    for (const r of paikat) { let a = avaimet.get(K(r.n, r.x)); if (!a) avaimet.set(K(r.n, r.x), a = []); a.push(r); }
    for (const it of kaikki) { if (!it.at) continue; const a = avaimet.get(K(it.n, it.x)); if (!a) continue;
      let best = null, bd = 2500; for (const r of a) { if (kaytetty.has(r)) continue; const d = Math.abs(r.t - it.at); if (d < bd) { bd = d; best = r; } }
      if (best) { it.r = best; kaytetty.add(best); } }
    // 0.3.18 toistot kuten livessä. Live (eK): sama lähettäjä + teksti, edellisen putki voimassa (3 s, JATKUU jokaisesta toistosta) -> ei
    //   uutta kuplaa vaan "xN". Historia (addChatEntry): hylkää saman viestin vain 2 s sisällä SÄILYTETYSTÄ rivistä (mitattu: kk-testi 3/7,
    //   väli <1.5 s -> historiassa 1 rivi). Joten 2-3 s toisto ja pidentynyt putki jäävät historiaan erillisinä kuplina, joita livessä ei
    //   ollut, ja ne työnsivät muita. Ne piilotetaan, ja alkuperäiseen tulee sama span kuin livessä (kp 02:47 "nyt katoo historiassa toi
    //   x2"). Montako yhdistettiin luetaan livekuplan omasta duplicateCountista (tietue.d). Rivi jolla on oma livekupla ei piiloudu koskaan.
    const putki = new Map();
    for (const it of kaikki) { const k = K(it.n, it.x), p = putki.get(k);
      if (p && !(it.r && it.r.v) && p.m < (p.r.d || 1) - 1 && it.at && it.at <= p.loppu + 300) { it.piilo = true; p.m++; p.loppu = it.at + 3000; continue; }
      if (it.r && it.r.v) putki.set(k, { r: it.r, m: 0, loppu: it.at + 3000 }); else putki.delete(k); }
    // uusi rivi, jonka livekupla ei ole vielä paikallaan (wte: paikka useEffectissä, makeRoom seuraavassa renderissä): odottaa näkymättömänä
    //   muutaman framen, ettei se näy ensin arvatulla paikalla ja hyppää (0.3.17: 36 hyppyä). Ilman workeria ei odoteta.
    const nyt = Date.now();
    kirjoitan = true;
    for (const it of kaikki) {
      it.odota = !it.piilo && tunnetaan && it.at > nyt - 1500 && !(it.r && it.r.v);   // max 1.5 s, sitten V3 kuten ilman tietuetta
      const disp = it.piilo ? 'none' : '', vis = it.odota ? 'hidden' : '';
      if (it.el.style.display !== disp) it.el.style.display = disp;
      if (it.el.style.visibility !== vis) it.el.style.visibility = vis;
      if (disp || vis) muokatut.add(it.el);
      const cc = it.el.querySelector('.chat-content'); if (!cc) continue;
      let sp = cc.querySelector(':scope > .kuvakupla-dup'); const d = it.r && !it.piilo ? (it.r.d || 1) : 1;
      if (d > 1) { if (!sp) { sp = document.createElement('span'); sp.className = 'duplicate-count kuvakupla-dup'; sp.style.cssText = 'color:red;margin-left:6px;font-weight:bold'; cc.appendChild(sp); muokatut.add(it.el); }
        if (sp.textContent !== 'x' + d) sp.textContent = 'x' + d; }
      else if (sp) sp.remove();
    }
    tila.piilossa = kaikki.filter(x => x.piilo).length; tila.odottaa = kaikki.filter(x => x.odota).length; tila.osui = kaikki.filter(x => x.r && x.r.v).length;
    const items = kaikki.filter(it => !it.piilo && !it.odota);
    if (!items.length) { kanvaasiMo.takeRecords(); kirjoitan = false; if (tila.odottaa) ajasta(); return; }
    for (const it of items) { it.left = parseFloat(it.el.style.left) || 0; it.width = it.el.offsetWidth; it.height = it.el.offsetHeight;
      // 0.3.18 kuvan tila varataan ennen latausta: kerran ladatun korkeus (korkeudet) tai saman viestin livekuplan korkeus (tietue.h).
      //   Kupla on asetettu alareunastaan (style.bottom), joten latautuva kuva kasvaa varattuun tilaan eikä siirrä muita.
      const kuvat = [...it.el.querySelectorAll('img')].filter(i => !i.classList.contains('twemoji-chat')); if (!kuvat.length) continue;
      const ka = it.n + '\u0001' + String(it.e && it.e.message || '').slice(0, 400);
      if (kuvat.every(i => i.complete && i.naturalHeight > 0)) { if (korkeudet[ka] !== it.height) { korkeudet[ka] = it.height; korkMuuttui = true; } continue; }
      if (kuvat.some(i => i.complete && !i.naturalHeight)) continue;   // rikki kuva: ei varata
      const v = Math.max(korkeudet[ka] || 0, it.r && it.r.v && it.r.h || 0); if (v > it.height) { tila.varattu = (tila.varattu || 0) + 1; it.height = v; } }
    // 0.3.8 kp 02:20 "copy the logic, dont arbitrarily make your own": TÄSMÄKOPIO pelin omasta yläveto-asettelusta
    //   (live-App-8b4cdc0d.js V3: L3=6e3 TICK_MS, P3=15 TICK_PX, F3=4 MAX_TICKS, HR=13, VR=42; törmäys G3, rekursiivinen työntö g).
    //   Ainoa ero peliin: korkeudet/leveydet mitataan NYT (kuva latautunut), ei mountissa. Omat säännöt 0.3.2/0.3.6/0.3.7 poistettu.
    const G3 = (t, e, r) => !(t.left + t.width < e.left || t.left > e.left + e.width || t.top + t.height < e.top + r || t.top > e.top + r + e.height);
    const c = items;
    const nakyvaH = (widget && widget.offsetHeight) || 600;   // live-chatin alue (yte: body * chat.viewer.height.percentage)
    // 0.3.10 kp 02:27 "tulin uusiks huoneesee ja sun viestit ja mun viestit on rinnakkain": V3 laskee askeleet floor(väli/6 s),
    //   joten alle 6 s välein tulleet rivit jäävät samalle riville. Live (ChatWidget yte) liikkuu KELLON mukaan: worker 6 s välein
    //   -> kaikki top -= 15, paitsi skipMovement-kupla (uusi tai juuri työnnetty) joka jättää yhden askeleen väliin (I(): N.skipMovement=!0).
    //   Kopioitu se: askeleet = montako 6 s rajaa viestien välissä (vaihe tuntematon -> 0), skipMovement mukana. Katto F3=4 pelin V3:sta.
    const g = (m, b, h) => { const E = c[m]; for (let N = m - 1; N >= 0; N--) { const w = c[N];
      if (!(h.includes(N) || w.top + w.height - b > E.top + E.height) && G3(E, w, -b)) { const k = Math.abs(w.top + w.height - E.top); h.push(N); w.top -= k; w.skip = true; g(N, k, h); } } };
    for (let m = 0; m < c.length; m++) {
      // 0.3.11 kp 02:31 "miks et vaa saa toimii samanlail yläveto historiaa" / "just fix it": pelin V3:n katto F3=4 (60 px) puristi
      //   jo yli 24 s tauon, mutta live liikkuu 15 px / 6 s ilman kattoa -> robon myöhempi rivi nousi kp:n aiempien yli. Nyt askeleet
      //   täsmälleen kuten livessä niin kauan kuin vanhempi kupla olisi vielä näkynyt livessä (askeleet * 15 <= chat-alueen korkeus);
      //   vasta pidempi tauko (vanhemmat jo kadonneet livestä) puristetaan pelin omalla katolla.
      if (m > 0) { let n = c[m].at && c[m - 1].at ? Math.max(0, Math.floor(c[m].at / TICK_MS) - Math.floor(c[m - 1].at / TICK_MS)) : 0;
        if (n * TICK_PX > nakyvaH) n = MAX_TICKS;
        for (let t = 0; t < n; t++) for (let E = 0; E < m; E++) { if (c[E].skip) c[E].skip = false; else c[E].top -= TICK_PX; } }
      c[m].top = -c[m].height; c[m].skip = true; g(m, 0, [m]);
      // 0.3.18: vierekkäisten väli LUKITAAN kun uudempi asetellaan. V3 lisää askeleet laiskasti vasta seuraavan rivin tullessa (ja edellinen
      //   uusin jättää yhden väliin), joten koko listan T-erot muuttuivat jokaisen uuden rivin myötä -> 15 px hyppy jaksojen rajalla (mitattu
      //   03:33 tmp/pd-frames.js --sano: 1 epäyhtenäinen frame). Lukittu väli ei riipu myöhemmistä riveistä.
      if (m > 0) c[m - 1].rel = c[m - 1].top - c[m].top;
    }
    // 0.3.9 kp 02:23 "jos toimis niinku livessä ois ok / mut ku ei toimi ylhäältävedossa": V3 arvioi livechatin liikkeen viestien
    //   väleistä (max 4 askelta = 60 px), mutta live liikkuu kellon mukaan 15 px / 6 s ilman kattoa ja skipMovement-askelin -> paikat
    //   eivät voi osua. Siksi livessä vedon alkaessa olleet kuplat saavat TÄSMÄLLEEN livepaikkansa (kopio, ei oma sääntö); vanhemmat
    //   pelin V3:lla niiden yläpuolelle, ja päällekkäin osuva vanhempi työnnetään ylös kuten pelin g/I() tekee.
    // 0.3.18: sama ankkurointi yleistettynä: jokainen livessä nähty viesti saa tietueensa y:n. Sama jakso (= sama worker = sama
    //   koordinaatisto) -> erot täsmälleen kuten livessä. Jakson uusin sijoitetaan pelin V3:n paikalle ja muut sen suhteen. Eri jaksojen
    //   välillä (huoneeseen uudelleen tulo) live ei koskaan näyttänyt molempia -> väli pelin V3:sta, kuten tietueettomilla riveillä.
    //   Ilman workerin askelia (lisäosa ladattu kesken huoneen) vedon alun livekuva on yksi jakso, kuten 0.3.9.
    if (!VW.__kuvakuplaEiAnkkuria) {
      if (liveKuva && liveKuva.length) { const vapaat = liveKuva.slice();
        for (let k = c.length - 1; k >= Math.max(0, c.length - liveKuva.length - 3); k--) { if (c[k].r && c[k].r.v) continue; const key = avain(c[k].el); if (!key) continue;
          const j = vapaat.map(v => v.key).lastIndexOf(key); if (j >= 0) { c[k].lk = { y: vapaat[j].top, s: 'L' }; vapaat.splice(j, 1); } } }
      // Lohko = kuplat jotka olivat livessä yhtä aikaa elossa. Jos kaikki saman jakson aiemmat olivat jo poistuneet (r.p) kun tämä tuli,
      //   live ei koskaan näyttänyt niitä yhdessä -> uusi lohko, ja väli tulee V3:sta (0.3.13:n katto). Muuten pitkä hiljaisuus antoi
      //   livepaikoista ison raon (mitattu 03:16: 2.5 min tauko = 346 px).
      const lohkot = new Map();
      for (const it of c) { const r = it.r; if (!(r && r.v && typeof r.y === 'number')) continue;
        let z = lohkot.get(r.s); if (!z) lohkot.set(r.s, z = { maxP: null, n: 0 });
        if (z.maxP !== null && z.maxP < r.t) z.n++;
        it.lohko = r.s + ':' + z.n; z.maxP = Math.max(z.maxP === null ? -Infinity : z.maxP, r.p || Infinity); }
      const T = c.map(x => x.top), base = new Map(); let n = 0;
      // 0.3.19: poistuneen kuplan paikka ankkurista (ks. ankkuroi): ankkurin paikka + viimeksi ruudulla nähty väli, ketjuna
      const rI = new Map(); for (const r of paikat) rI.set(r.s + ':' + r.i, r);
      const yOf = (r, syv) => { if (!r.ank || syv > 60) return r.y; const b = rI.get(r.ank[0] + ':' + r.ank[1]);
        return b && b.v && typeof b.y === 'number' && typeof r.rel === 'number' ? yOf(b, syv + 1) + r.rel : r.y; };
      // 0.3.20: ankkuroitu kupla seuraa ankkurinsa LOPULLISTA paikkaa tässä asettelussa (haamutyöntö mukaan lukien), ei sen tietueen y:tä.
      //   Ankkuri on aina uudempi, joten se on jo asetettu. Ilman haamutyöntöä tulos on sama kuin yOf:lla (y + base); haamutyönnön jälkeen
      //   vanhempi ketju liikkuu ankkurinsa mukana sen sijaan että väli kutistuisi.
      const asetettu = new Map();
      const wYla = widget ? widget.getBoundingClientRect().top : 0;   // 14b: "ruudun yläpuolella" = viewportin yläreunan yläpuolella (mitattu 05:04: widget top 0 molemmissa)
      for (let k = c.length - 1; k >= 0; k--) { const it = c[k], p = it.lohko ? { y: yOf(it.r, 0), s: it.lohko } : it.lk;
        if (p && base.has(p.s)) { const ak = it.lohko && it.r.ank && typeof it.r.rel === 'number' ? asetettu.get(it.r.ank[0] + ':' + it.r.ank[1]) : null;
          it.top = ak ? ak.top + it.r.rel : p.y + base.get(p.s); it.kiinni = true; n++;
          // 0.3.19 haamu: POISTUNUT kupla ei saa jäädä uudemman päälle. Mitattu 04:22 robolla: robo 1 (ankkuri KUVA2 -30) ja GIF
          //   (ankkuri KUVA2 -222) päällekkäin 28 px, koska livessä robo 1:n poistuttua KUVA2 työntyi sen paikalle ja GIF:n kiinni.
          //   Livessä robo 1 olisi ollut ketjussa välissä -> pelin I(): vanhempi uudemman yläpuolelle. Elossa olevia ei siirretä.
          // 0.3.20 (a): ehto oli "alareuna uudemman sisällä", joten korkea kupla joka PEITTI pienen kokonaan jäi nostamatta. Mitattu 04:47
          //   robolla: poke-013 (221 px, ankkuri jengi-keikka -222) kk-testi 10 robo 1:n (29 px, ankkuri jengi-keikka -60) päällä 29 px,
          //   koska robo 1 ja 2 poistuivat ensin (pieni kupla osuu -2*korkeus-rajaan aiemmin) ja jengi-keikka työntyi niiden paikalle.
          //   Nyt mikä tahansa pystysuora päällekkäisyys. (b): siirrettävä on myös ELOSSA oleva kupla, joka on avaushetkellä kokonaan ruudun
          //   yläpuolella (y - F + h <= 0). Saman sarakkeen poistuneen kuplan yläpuolella oleva on aina siellä (pieni poistuu kun top <= -2h),
          //   joten sen siirto ei näy hyppynä avatessa; ilman tätä poistunut uudempi jäi elossa olevan vanhemman päälle.
          const liikkuva = it.r && (it.r.p || (typeof it.r.h === 'number' && wYla + it.r.y - F + it.r.h <= 0));
          if (liikkuva) for (let q = 0; q <= c.length; q++) {
            const este = c.slice(k + 1).find(w => G3(it, w, 0) && it.top + it.height > w.top && it.top < w.top + w.height);
            if (!este) break; it.top = este.top - it.height; tila.haamu = (tila.haamu || 0) + 1; if (!it.r.p) tila.haamuElossa = (tila.haamuElossa || 0) + 1; }
          if (it.lohko) asetettu.set(it.r.s + ':' + it.r.i, it);
          continue; }
        it.top = k < c.length - 1 ? c[k + 1].top + (typeof it.rel === 'number' ? it.rel : T[k] - T[k + 1]) : T[k];
        for (let q = 0; q <= c.length; q++) { const este = c.slice(k + 1).find(w => G3(it, w, 0) && it.top + it.height > w.top); if (!este) break; it.top = este.top - it.height; }
        if (p) { base.set(p.s, it.top - p.y); it.kiinni = true; n++; if (it.lohko) asetettu.set(it.r.s + ':' + it.r.i, it); } }
      tila.ankkuroitu = n; tila.jaksoja = base.size;
    }
    // 0.3.12 kp 02:30 "no kokeillaan" (rinnakkaisuus saa jäädä): pelin live-logiikka itsekin vaihtaa järjestyksen — mitattu
    //   tmp/live-sim.js: robon 221 px kuvakupla 02:28:31 työnsi robon 02:26:44 rivin kp:n 02:25 rivien tasalle ja myöhemmät sen yli.
    //   Livessä se ei näy (kp:n rivit ehtivät yli ruudun), historiassa näkyy. Sääntö: jos kahden viestin välissä on 6 s raja (live
    //   ehti liikkua), aiemman alareuna on vähintään 15 px uudemman alareunan yläpuolella. Saman askeleen sisällä rinnakkain saa olla.
    jarjesta(c, x => x.at, x => x.top, (x, v) => { x.top = v; }, x => x.height, (a, b) => !(a.left + a.width < b.left || a.left > b.left + b.width), x => !!x.kiinni);
    const newest = items[items.length - 1];
    const minTop = Math.min(...items.map(x => x.top));
    const pad = Math.max(MIN_GAP, TOP_OFFSET - newest.height);
    const newestBottom = newest.top + newest.height;
    const list = canvas.closest('.chat-pulldown-list');
    const pohjassa = list && (list.scrollHeight - list.scrollTop - list.clientHeight) < 4;
    const keep = list ? list.scrollHeight - list.scrollTop : 0;
    kirjoitan = true;
    for (const it of items) { const b = (pad + newestBottom - (it.top + it.height)) + 'px'; if (it.el.style.bottom !== b) it.el.style.bottom = b; }
    const h = ((newestBottom - minTop) + pad + 8) + 'px'; if (canvas.style.height !== h) canvas.style.height = h;
    if (list) list.scrollTop = pohjassa ? list.scrollHeight : list.scrollHeight - keep;
    kanvaasiMo.takeRecords();   // 0.3.4: omat style-kirjoitukset eivät laukaise uutta asettelua
    kirjoitan = false; tila.historia++;
    if (tila.odottaa) ajasta();   // odottava uusi rivi: uudestaan seuraavassa framessa kunnes livepaikka on tiedossa (tai 1.5 s)
  };
  // 0.2.1: piilotetussa välilehdessä rAF ei laukea ennen kuin välilehti näkyy -> asettelu odotti koko piilon ajan
  //   (mitattu robolla 18:03: visibilityState hidden, historia jumissa 18:ssa, yläveto 21 päällekkäin). Piilossa setTimeout.
  const ajasta = () => { if (!kirjoitan && !ajastettu) ajastettu = document.hidden ? -setTimeout(asettele, 50) : requestAnimationFrame(asettele); };
  const onLoad = e => { const t = e.target; if (!(t instanceof HTMLImageElement) || t.classList.contains('twemoji-chat')) return;
    if (t.closest('.chat-pulldown-canvas')) ajasta();
    else if (t.closest('.nitro-chat-widget')) { tila.kuvia = (tila.kuvia || 0) + 1; seuraa(t); erotaPian(); } };
  document.addEventListener('load', onLoad, true);
  // yläveto: kanvaasin vahti vain kun historia on auki
  // 0.3.4 (kp 02:03 "joo bugaa", historia auki + uusi viesti): mitattu kp:n clientissä — uuden rivin tullessa peli renderöi koko
  //   historian omalla asettelullaan ja YKSI frame maalautui ennen meidän rAF-asettelua (abortin "@res" +944 px, dogin rivit
  //   +254..+578, takaisin 26 ms myöhemmin). MutationObserverin kutsu ajetaan ennen maalausta -> asettelu heti siinä, ei rAF:ssa.
  //   Omat kirjoitukset nielaistaan takeRecords():lla asettelun lopussa, joten silmukkaa ei synny.
  const kanvaasiMo = new MutationObserver(() => { if (kirjoitan) return; if (ajastettu > 0) cancelAnimationFrame(ajastettu); else if (ajastettu) clearTimeout(-ajastettu); asettele(); });
  let widget = null;
  let yrita = 0;   // kanvaasi mountataan samassa renderissä kuin luokka, mutta varmuuden vuoksi max 20 x 50 ms (ei ikuista silmukkaa)
  // 0.3.3 (kp 01:47 "harjis message keeps jumping when it is opened / every time"): mitattu 01:53 robolla per-frame —
  //   historia on ruudulla jo VETOVAIHEESSA (kanvaasi mountataan heti kun veto alkaa), mutta asettelu odotti chat-pulldown-open
  //   -luokkaa -> 0-460 ms näkyi clientin oma asettelu (Resin vanhemmat rivit uudempien ALLA) ja sitten hyppy. kp:n 0.3.1:ssä
  //   sama korjautui vasta kuvien latautuessa ~2.2 s kohdalla (4/4 avausta). Nyt laukaisu = kanvaasin ilmestyminen, ja
  //   ensimmäinen asettelu ajetaan synkronisesti MutationObserverin kutsussa -> ennen ensimmäistä maalausta.
  let kanvas = null, pdEl = null;
  const avoin = () => { tila.auki = !!(widget && widget.classList.contains('chat-pulldown-open'));
    const c = document.querySelector('.chat-pulldown-canvas');
    if (c === kanvas) { if (c) ajasta(); return; }
    kanvaasiMo.disconnect(); if (!c && kanvas) tallenna();   // historia suljettiin: kuvakorkeudet ja paikat talteen
    kanvas = c; muokatut.clear(); liveKuva = c ? otaLiveKuva() : null; if (!c) return;
    kanvaasiMo.observe(c, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    if (ajastettu > 0) cancelAnimationFrame(ajastettu); else if (ajastettu) clearTimeout(-ajastettu);
    asettele(); };
  // historian juuri (.nitro-chat-pulldown) on widgetin sisarus; vain sen lapsilista + juuren sisus kunnes kanvaasi löytyy (ei koko huonetta)
  const pdMo = new MutationObserver(() => { const pd = widget && widget.parentElement && widget.parentElement.querySelector(':scope > .nitro-chat-pulldown');
    if (pd !== pdEl) { pdEl = pd; if (pd) pdMo.observe(pd, { childList: true, subtree: true }); } avoin(); });
  const uudetKuplat = () => { if (!widget) return; for (const b of widget.querySelectorAll(':scope > .bubble-container')) if (!seurattu.has(b)) { seurattu.add(b); if (asennettu) saapui.set(b, Date.now()); ro.observe(b); tila.seurattu++; }
    for (const b of widget.querySelectorAll(':scope > .bubble-container')) if (!kuplanChat.has(b)) { const c = chatOf(b); if (c) { kuplanChat.set(b, c); tietue(b, c); } } };
  // 0.3.19 ankkuri (mitattu 04:12 robolla, tietueet: KUVA1 y 5591 h 221 ja GIF1 y 5605 = päällekkäin historiassa, livessä ei koskaan):
  //   poistunut kupla jäätyy maailmakoordinaattiin, mutta samassa sarakkeessa elossa olevat työntyvät myöhemmin (pelin makeRoom joka
  //   saapuvasta, kasvukorjaus) -> historiassa ne nousivat poistuneen päälle (kuvan kasvu 193 px). Livessä poistunut olisi seurannut.
  //   Poistuessa kupla sidotaan samassa sarakkeessa lähimpään alempaan kuplaan sillä välillä joka niillä oli VIIMEKSI ruudulla yhdessä,
  //   ja historia laskee sen paikan ankkurista (ketjuna). Ilman alempaa sarakekumppania paikka jää jäädytetyksi kuten ennen.
  //   topOf: askeleella poistuvat saavat askelta EDELTÄVÄT paikat (askel = askelia); poistokäsittelijä ei silloin ankkuroi uudestaan.
  const ankkuroi = (pois, topOf = c => c.top, askel = 0) => {
    const ehdokkaat = elavat().map(x => x.c); for (const c of pois) if (!ehdokkaat.includes(c)) ehdokkaat.push(c);
    for (const A of pois) { const rA = rek.get(A); if (!rA || !rA.v) continue; if (!askel && rA.ankAskel === askelia) continue;
      let B = null; const tA = topOf(A);
      for (const c of ehdokkaat) { if (c === A || !(topOf(c) > tA) || c.left + c.width < A.left || c.left > A.left + A.width) continue;
        const rc = rek.get(c); if (!rc || !rc.v) continue; if (!B || topOf(c) < topOf(B)) B = c; }
      if (B) { const rB = rek.get(B); rA.ank = [rB.s, rB.i]; rA.rel = Math.round(tA - topOf(B)); tila.ankkuri = (tila.ankkuri || 0) + 1; }
      else { delete rA.ank; delete rA.rel; }
      if (askel) rA.ankAskel = askel; } };
  const widgetMo = new MutationObserver(muts => { let attr = false, lapset = false;
    for (const m of muts) { if (m.type === 'attributes') attr = true; else { lapset = true;
      // 0.3.18: poistuva kupla (A(): top <= -2*korkeus, tai makeRoom-työnnön jälkeen) -> viimeinen paikka talteen ennen kuin se katoaa
      if (tunnetaan) { const pois = [];
        for (const n of m.removedNodes) { const c = n.nodeType === 1 && kuplanChat.get(n); const r = c && rek.get(c); if (!r) continue;
          r.p = Date.now(); if (r.v && !kesken) { r.y = c.top + F; pois.push(c); } }   // r.p: poistumishetki -> asettelu tietää mitkä kuplat olivat livessä yhtä aikaa
        if (pois.length) ankkuroi(pois); } } }
    if (lapset) uudetKuplat(); if (attr) avoin(); });
  const kiinnita = () => { const w = document.querySelector('.nitro-chat-widget'); if (w === widget) return; widget = w; widgetMo.disconnect(); pdMo.disconnect(); pdEl = null;
    if (w) { widgetMo.observe(w, { attributes: true, attributeFilter: ['class'], childList: true }); if (w.parentElement) pdMo.observe(w.parentElement, { childList: true }); uudetKuplat(); avoin(); } };
  const onPointer = () => { if (!widget || !widget.isConnected) kiinnita(); };
  document.addEventListener('pointerdown', onPointer, true);
  kiinnita();
  asennettu = true;
  // jo näkyvillä olevat kuvakuplat (lisäosa ladattiin kesken) -> seurantaan
  for (const img of document.querySelectorAll('.nitro-chat-widget img:not(.twemoji-chat)')) seuraa(img);
  // pois ilman sivun päivitystä (Datajako-kortin ⏹ Kumoa ja lisäosan poisto kutsuvat tätä)
  window.addEventListener('pagehide', tallenna);
  VW.__kuvakuplaPois = () => {
    try { nayte(); } catch (e) {} tallenna(); window.removeEventListener('pagehide', tallenna);
    if (WP && WP.postMessage === omaPM) WP.postMessage = alkuPM;
    if (kWorker && kAlku && tunnetaan && kWorker.onmessage && kWorker.onmessage !== kAlku) {   // pelin oma käsittelijä takaisin; seuraava versio jatkaa samaa jaksoa
      kWorker.onmessage = kAlku; VW.__kuvakuplaWorker = { w: kWorker, f: kAlku, F, jakso, wH, askelia, viim, valiMs }; }
    for (const el of muokatut) if (el.isConnected) { el.style.display = ''; el.style.visibility = ''; const sp = el.querySelector('.kuvakupla-dup'); if (sp) sp.remove(); }
    muokatut.clear();
    clearTimeout(erotaVaraus); ro.disconnect(); kanvaasiMo.disconnect(); widgetMo.disconnect(); pdMo.disconnect(); document.removeEventListener('load', onLoad, true); document.removeEventListener('pointerdown', onPointer, true); if (ajastettu > 0) cancelAnimationFrame(ajastettu); else if (ajastettu) clearTimeout(-ajastettu); VW.__kuplaKuvakupla = false; return 'kuvakupla-korjaus pois'; };
})();
