// ==UserScript==
// @name         Kupla Camera Custom Image Uploader
// @namespace    http://tampermonkey.net/
// @version      4.2.1
// @description  Oma kuva Kuplan kamerakuvaksi (seinäjuliste): valitse tiedosto, vedä ja pudota tai liitä leikepöydältä (Ctrl+V), rajaa/sovita neliöksi esikatselussa, osta pelin omasta ostoikkunasta. Neliökamera (:neliökuva): 1:1-kuva chat-kuplineen, osto ja sijoitus heti, Alt+K = kopio viimeisimmästä. Kuvaselain inventaarioon (:kuvat). Kamerakuvapino uusin ensin. Komento :omakuva jos Kupla Komennot on päällä.
// @author       Antigravity (1.0–3.5), Herra-Robotti (4.0)
// @match        https://kupla.cc/*
// @grant        none
// ==/UserScript==
/*
 * 4.2.1 (kp 2026-10-01 22:12 Datajaossa: "neliökamera ... ei voi liikuttaa kameran framee vaa pitää liikuttaa pelii"):
 *   yläpalkki liikutti kehystä jo (mitattu CDP-hiirellä 120/80 px), mutta se oli ainoa tartuntakohta. Nyt kehyksen
 *   katkoviivareunat (10 px vyöhyke) ja alapaneelin tyhjä tausta raahaavat myös. Sisäosa pysyy läpiklikattavana,
 *   jotta pelin näkymää voi yhä siirtää.
 * 4.2.0 (kp 2026-09-30 06:39–06:41 #849 #850 #851 #852 #853 #854 #856, kp 07:30 "kamera aika unusable ku vika kuva ei tuu
 *   ekana invist", Res 06:40 #855 + 07:31 "natiivin mallin mukaan"). KAIKKI UNTESTED-LIVE:
 *   - Neliökamera (:neliökuva, :omakuva neliö): kehys ruudun päällä, rulla yläpalkissa = zoom, kaappaus Kuvakaappaus 1.2.0:n
 *     otaAlue()-rajapinnalla (pelin renderöijä + chat-kuplat) -> 320x320 -> pelin ostoikkuna -> Osta-nappi heti -> uusi id 2103:sta
 *     -> pelin oma sijoitustila (klikkaa seinää).
 *   - Alt+K / 🔁 Kopio / :omakuva kopio = osta uusi kopio viimeisimmästä kuvasta (2408 uudestaan).
 *   - Kamerakuvapinot järjestetään id:n mukaan -> "Sijoita" ja esikatselu ottavat uusimman.
 *   - Kuvaselain (:kuvat, "🔍 Selaa kuvia" inventaariossa): iso kuva, ←/→/rulla, "Sijoita tämä" (natiivin FurniView
 *     nextItemButton + viewItemButton -mallin mukaan, Habbo-Sky FurniView.as:241,686-723).
 *   - 5 s palvelinraja 3226:lle odotetaan itse (vieOstoikkunaan).
 * 4.1.0: (header-versio oli jo 4.1.0 ennen tätä; muutosriviä ei löytynyt tästä tiedostosta.)
 * 4.0.1 (kp 2026-09-28 04:38 "ei em dasheja valikoihin niist tulee nuottiavain"): pelin fontti piirtää ajatusviivan
 *   nuottiavaimena -> ilmoitusteksteistä ajatusviivat pois (piste + uusi lause).
 * 4.0.0 (2026-09-28, kurkkupomo 01:14 "tee parempi versio siitä kamera uploaderista jonka voi jakaa jossai vaiheessa" ·
 *   #613 "mulle komentoversio komennot-managerin kautta, muille stand alone"):
 *
 * MITÄ 3.5:SSÄ OLI VIALLA (luettu lähteestä, kupla-cc DarkUI CameraWidgetCheckoutView.tsx):
 *   - Ostoikkuna saa kuvan propsina base64Url ja LÄHETTÄÄ SEN ITSE (useEffect -> RoomEngine.saveBase64AsScreenshot ->
 *     3226), ja Osta-nappi aukeaa vasta kun palvelimen 3696-vastaus (CameraStorageUrlMessageEvent) saapuu ikkunan
 *     ollessa auki. 3.5 lähetti 3226:n itse ENNEN ikkunaa ja antoi ikkunalle palvelimen http-osoitteen base64Url:ksi ->
 *     RenderRoomMessageComposer hylkää ei-PNG:n ("rejected non-PNG image data") -> pictureUrl ei koskaan asetu -> nappi
 *     jäi harmaaksi. Sitä paikattiin 150 ms välein pyörivällä silmukalla joka pakotti napin päälle ja etsi ostoikkunan
 *     minifioidulla nimellä 'Kq' (vaihtuu joka buildissa) + oma 2408-lähetys capture-kuuntelijassa.
 *   - Nyt: ostoikkunalle annetaan 320x320 PNG data-URL, ja PELI hoitaa lähetyksen, hinnan, Osta / Osta toinen ja
 *     julkaisun itse. Ei socket-koukkua, ei silmukkaa, ei minifioituja nimiä.
 *   - Epäneliö kuva venytettiin neliöksi (confirm-dialogi). Nyt esikatselu + kolme tapaa: rajaa (vedä ja zoomaa),
 *     sovita (reunat valitulla värillä), venytä.
 * KOKORAJA: palvelin katkaisi yhteyden liian isosta 3226:sta (mitattu 2026-09-24, camera-photo.js --size=1200 -> "Bye").
 *   320x320 PNG on yleensä 50–250 kt; yli RAJA:n kuva pakataan vähentämällä värisyvyyttä kunnes se mahtuu.
 * KOMENTO :omakuva (EI :kuva — se on Kuvakaappaus-lisäosan, 2026-09-28).
 * RAJA: palvelin päättää hinnan ja oikeuden (acc_camera); kamera avataan työkalupalkin .icon-camera -ikonista.
 */
(function () {
  'use strict';
  const VW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (VW.__kuplaKameraUploader) return;
  VW.__kuplaKameraUploader = '4.2.1';

  const KOKO = 320;
  const RAJA = 380000; // tavua PNG:tä; katko mitattiin > 417792 t paketissa
  const KAMERA_SEL = '.nitro-camera-capture, .nitro-camera-checkout, .nitro-camera-editor';
  const LS = 'kuplaKameraUploader';
  const asetukset = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } })();
  const tallenna = () => { try { localStorage.setItem(LS, JSON.stringify(asetukset)); } catch (e) {} };

  const tila = { lahde: null, nimi: '', tapa: asetukset.tapa || 'rajaa', tausta: asetukset.tausta || '#000000', zoom: 1, px: 0, py: 0, png: null, bitit: 8 };

  // ---------- kuvan käsittely ----------
  function piirra() {
    const c = document.createElement('canvas'); c.width = KOKO; c.height = KOKO;
    const g = c.getContext('2d');
    const s = tila.lahde; if (!s) return c;
    const w = s.width, h = s.height;
    if (tila.tapa === 'venyta') { g.drawImage(s, 0, 0, KOKO, KOKO); return c; }
    if (tila.tapa === 'sovita') {
      if (tila.tausta !== 'lapinakyva') { g.fillStyle = tila.tausta; g.fillRect(0, 0, KOKO, KOKO); }
      const k = Math.min(KOKO / w, KOKO / h);
      g.drawImage(s, (KOKO - w * k) / 2, (KOKO - h * k) / 2, w * k, h * k); return c;
    }
    // rajaa: peitä neliö, zoom 1..4, px/py = keskipisteen siirto lähteen pikseleinä
    const k = Math.max(KOKO / w, KOKO / h) * tila.zoom;
    const vw = KOKO / k, vh = KOKO / k;
    const maxX = (w - vw) / 2, maxY = (h - vh) / 2;
    tila.px = Math.max(-maxX, Math.min(maxX, tila.px)); tila.py = Math.max(-maxY, Math.min(maxY, tila.py));
    g.drawImage(s, (w - vw) / 2 + tila.px, (h - vh) / 2 + tila.py, vw, vh, 0, 0, KOKO, KOKO);
    return c;
  }

  const pngTavut = url => Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);

  function pakkaa(c) {
    let url = c.toDataURL('image/png'); tila.bitit = 8;
    if (pngTavut(url) <= RAJA) return url;
    const g = c.getContext('2d'), alku = g.getImageData(0, 0, KOKO, KOKO);
    for (const b of [6, 5, 4, 3]) {
      const d = new ImageData(new Uint8ClampedArray(alku.data), KOKO, KOKO), m = 256 >> b, pois = 8 - b;
      for (let i = 0; i < d.data.length; i += 4) for (let j = 0; j < 3; j++) d.data[i + j] = ((d.data[i + j] >> pois) << pois) + (m >> 1);
      g.putImageData(d, 0, 0); url = c.toDataURL('image/png'); tila.bitit = b;
      if (pngTavut(url) <= RAJA) return url;
    }
    return null;
  }

  function lataaTiedosto(tiedosto) {
    if (!tiedosto || !/^image\//.test(tiedosto.type)) { ilmoita('Tuo ei ole kuva.', 'virhe'); return; }
    const img = new Image(), osoite = URL.createObjectURL(tiedosto);
    img.onload = () => { tila.lahde = img; tila.nimi = tiedosto.name || 'leikepöytä'; tila.zoom = 1; tila.px = tila.py = 0; naytaPaneeli(); URL.revokeObjectURL(osoite); };
    img.onerror = () => { ilmoita('Kuvaa ei voitu avata.', 'virhe'); URL.revokeObjectURL(osoite); };
    img.src = osoite;
  }

  async function liitaLeikepoydalta() {
    try {
      const esineet = await navigator.clipboard.read();
      for (const e of esineet) { const t = e.types.find(x => x.startsWith('image/')); if (t) { lataaTiedosto(new File([await e.getType(t)], 'leikepöytä', { type: t })); return; } }
      ilmoita('Leikepöydällä ei ole kuvaa.', 'virhe');
    } catch (x) { ilmoita('Selain ei antanut lukea leikepöytää. Paina Ctrl+V paneelin ollessa auki.', 'virhe'); }
  }

  // ---------- pelin kameraikkuna ----------
  // CameraWidgetView: hook0 = mode (0 kiinni, 1 kuvaus, 2 muokkaus, 3 osto), hook1 = checkoutData (null tai {pictureUrl,…}).
  // Tunnistetaan RAKENTEESTA, ei nimestä (nimet vaihtuvat joka buildissa).
  function kameraFiber() {
    const el = document.querySelector(KAMERA_SEL); if (!el) return null;
    const avain = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    for (let f = avain && el[avain]; f; f = f.return) {
      const h0 = f.memoizedState, h1 = h0 && h0.next;
      if (typeof f.type === 'function' && h0 && h0.queue && h1 && h1.queue && typeof h0.memoizedState === 'number' &&
          h0.memoizedState >= 1 && h0.memoizedState <= 3 && (h1.memoizedState === null || typeof h1.memoizedState === 'object')) return f;
    }
    return null;
  }
  const odota = (ehto, ms) => new Promise(ok => { const t0 = Date.now(); (function k() { const v = ehto(); if (v || Date.now() - t0 > ms) return ok(v); setTimeout(k, 100); })(); });

  // Vie PNG data-URL:n pelin ostoikkunaan; peli lähettää 3226:n itse. Palauttaa true kun palvelimen kuva (3696) on ikkunassa.
  // 4.2.0: erotettu avaaOstoikkunasta, jotta neliökamera käyttää samaa polkua. viesti(teksti, laji) = minne tila kerrotaan.
  let viimeisin3226 = 0;
  async function vieOstoikkunaan(url, viesti) {
    if (!document.querySelector(KAMERA_SEL)) {
      const ikoni = document.querySelector('.icon-camera');
      if (!ikoni) { viesti('Kameraikonia ei löytynyt. Mene ensin huoneeseen.', 'virhe'); return false; }
      ikoni.click();
    }
    const f = await odota(kameraFiber, 3000);
    if (!f) { viesti('Pelin kameraikkunaa ei löytynyt.', 'virhe'); return false; }
    const setMode = f.memoizedState.queue.dispatch, setData = f.memoizedState.next.queue.dispatch;
    // jos ostoikkuna oli jo auki toisella kuvalla, suljetaan ensin: muuten "ostettu N" -laskuri jäisi edellisestä
    if (f.memoizedState.memoizedState === 3) { setMode(0); await new Promise(r => setTimeout(r, 150)); }
    // 4.2.0: palvelin pudottaa 3226:n HILJAA jos edellisestä < 5 s (RenderRoomMessageEvent.getRatelimit() = 5000,
    //   mosaiikki-osta.js:8) -> odotetaan itse, muuten 12 s aikakatkaisu näyttäisi palvelimen viasta.
    const vali = Date.now() - viimeisin3226;
    if (vali < 5300) { viesti('Odotetaan palvelimen 5 s kuvaväliä…'); await new Promise(r => setTimeout(r, 5300 - vali)); }
    viimeisin3226 = Date.now();
    setData({ pictureUrl: url, scene: null, effects: [], isZoomed: false });
    setMode(3);
    viesti('Lähetetään kuva peliin…');
    // valmis kun ostoikkunan kuva vaihtuu data-URL:sta palvelimen osoitteeseen (pictureUrl asettuu 3696:sta)
    const ok = await odota(() => {
      const o = document.querySelector('.nitro-camera-checkout'); if (!o) return false;
      // VAIN <img>: ostoikkunassa on myös lompakon valuuttaikonit background-imageina (https:…/wallet/5.png) — ne eivät ole
      // palvelimen kuva (mitattu 2026-09-28 01:41: ensimmäinen versio luki niistä väärän "hyväksytty"-tuloksen 601 ms:ssa).
      return [...o.querySelectorAll('img')].some(e => /^https?:/.test(e.getAttribute('src') || ''));
    }, 12000);
    if (!ok) viesti('Palvelin ei vastannut 12 s:ssa (odota 5 s kuvien välillä ja kokeile uudestaan).', 'virhe');
    return !!ok;
  }

  async function avaaOstoikkuna() {
    if (!tila.lahde) { ilmoita('Valitse ensin kuva.', 'virhe'); return; }
    const url = tila.png; if (!url) { ilmoita('Kuva on liian yksityiskohtainen vielä 3-bittisenäkin. Kokeile rajata pienempi alue.', 'virhe'); return; }
    const ok = await vieOstoikkunaan(url, ilmoita);
    if (ok) { ilmoita('Kuva hyväksytty. Osta pelin ikkunasta.', 'ok'); piilota(); }
  }

  // ---------- käyttöliittymä ----------
  let paneeli = null, esik = null, tieto = null, viesti = null;
  function tyyli() {
    if (document.getElementById('kku-tyyli')) return;
    const s = document.createElement('style'); s.id = 'kku-tyyli';
    s.textContent = `#kku{position:fixed;left:90px;bottom:70px;z-index:99999;width:260px;background:#1e1f26;color:#eee;border:2px solid #4338ca;border-radius:10px;font:12px/1.4 Ubuntu,Arial,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.5);user-select:none}
#kku .ot{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#4338ca;border-radius:7px 7px 0 0;cursor:move;font-weight:bold}
#kku .ot b{cursor:pointer;padding:0 4px}
#kku .si{padding:8px 10px}
#kku canvas.esi{display:block;width:200px;height:200px;margin:0 auto 6px;border-radius:6px;background:repeating-conic-gradient(#333 0 25%,#2a2a2a 0 50%) 0 0/16px 16px;cursor:grab}
#kku .tyhja{width:200px;height:200px;margin:0 auto 6px;border:2px dashed #666;border-radius:6px;display:flex;align-items:center;justify-content:center;text-align:center;color:#aaa;cursor:pointer}
#kku .rivi{display:flex;gap:4px;margin:4px 0;align-items:center;flex-wrap:wrap}
#kku button{background:#374151;color:#fff;border:1px solid #555;border-radius:5px;padding:3px 7px;cursor:pointer;font:inherit}
#kku button.on{background:#6366f1;border-color:#818cf8}
#kku button.iso{width:100%;background:#10b981;border-color:#059669;font-weight:bold;padding:6px}
#kku input[type=range]{flex:1}
#kku .pieni{color:#aaa;font-size:11px}
#kku .viesti{margin-top:4px;min-height:14px}
#kku .viesti.virhe{color:#fca5a5}#kku .viesti.ok{color:#6ee7b7}
#kku-nappi{position:fixed;bottom:20px;left:80px;z-index:99999;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font-size:20px;line-height:1;background:rgb(17,26,38);color:#fff;border:2px solid #000;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18),0 2px 0 rgba(0,0,0,.5);border-radius:6px;cursor:grab;touch-action:none;user-select:none;padding:0}
#kku-nappi:hover{background:rgb(28,42,60)}
#kku-nappi.raahaa{cursor:grabbing;opacity:.85}`;
    document.head.appendChild(s);
  }

  function rakenna() {
    if (paneeli) return paneeli;
    tyyli();
    paneeli = document.createElement('div'); paneeli.id = 'kku'; paneeli.style.display = 'none';
    paneeli.innerHTML = `<div class="ot"><span>📷 Oma kuva kameraan</span><b title="Sulje">✕</b></div>
<div class="si"><div class="tyhja">Pudota kuva tähän,<br>paina Ctrl+V<br>tai klikkaa</div><canvas class="esi" width="${KOKO}" height="${KOKO}" style="display:none"></canvas>
<div class="rivi"><button data-t="valitse">Valitse…</button><button data-t="liita">Liitä leikepöydältä</button></div>
<div class="rivi"><button data-t="nelio" title="1:1-kuva huoneesta chat-kuplineen, osto ja sijoitus heti">📐 Neliökamera</button><button data-t="kopio" title="Osta uusi kopio viimeisimmästä kuvasta (Alt+K)">🔁 Kopio</button><button data-t="selaa" title="Inventaarion kamerakuvat isona">🔍 Kuvat</button></div>
<div class="rivi"><button data-tapa="rajaa">Rajaa</button><button data-tapa="sovita">Sovita</button><button data-tapa="venyta">Venytä</button></div>
<div class="rivi kku-zoom">Zoom <input type="range" min="1" max="4" step="0.05" value="1"></div>
<div class="rivi kku-tausta">Reunat <button data-tausta="#000000">musta</button><button data-tausta="#ffffff">valkoinen</button><button data-tausta="lapinakyva">läpinäkyvä</button></div>
<div class="pieni kku-tieto"></div>
<div class="rivi"><button class="iso" data-t="osta">Avaa pelin ostoikkuna →</button></div>
<div class="pieni viesti"></div>
<label class="pieni"><input type="checkbox" class="kku-nappiasetus"> näytä 📷-pikanappi ruudulla</label></div>`;
    document.body.appendChild(paneeli);
    esik = paneeli.querySelector('canvas.esi'); tieto = paneeli.querySelector('.kku-tieto'); viesti = paneeli.querySelector('.viesti');
    const syote = document.createElement('input'); syote.type = 'file'; syote.accept = 'image/*'; syote.style.display = 'none';
    syote.onchange = () => { if (syote.files[0]) lataaTiedosto(syote.files[0]); syote.value = ''; };
    paneeli.appendChild(syote);
    paneeli.querySelector('.ot b').onclick = piilota;
    paneeli.querySelector('.tyhja').onclick = () => syote.click();
    paneeli.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.t === 'valitse') syote.click();
      else if (b.dataset.t === 'liita') liitaLeikepoydalta();
      else if (b.dataset.t === 'osta') avaaOstoikkuna();
      else if (b.dataset.t === 'nelio') { piilota(); naytaKehys(); }
      else if (b.dataset.t === 'kopio') ostaKopio(ilmoita);
      else if (b.dataset.t === 'selaa') { piilota(); avaaSelain(); }
      else if (b.dataset.tapa) { tila.tapa = asetukset.tapa = b.dataset.tapa; tallenna(); paivita(); }
      else if (b.dataset.tausta) { tila.tausta = asetukset.tausta = b.dataset.tausta; tallenna(); paivita(); }
    });
    const zoom = paneeli.querySelector('.kku-zoom input');
    zoom.oninput = () => { tila.zoom = +zoom.value; paivita(); };
    // rajaus: vedä esikatselua, rulla zoomaa
    let veto = null;
    esik.addEventListener('pointerdown', e => { if (tila.tapa !== 'rajaa') return; veto = { x: e.clientX, y: e.clientY, px: tila.px, py: tila.py }; esik.setPointerCapture(e.pointerId); esik.style.cursor = 'grabbing'; });
    esik.addEventListener('pointermove', e => {
      if (!veto || !tila.lahde) return;
      const k = Math.max(KOKO / tila.lahde.width, KOKO / tila.lahde.height) * tila.zoom * (esik.clientWidth / KOKO);
      tila.px = veto.px - (e.clientX - veto.x) / k; tila.py = veto.py - (e.clientY - veto.y) / k; paivita(true);
    });
    esik.addEventListener('pointerup', () => { veto = null; esik.style.cursor = ''; paivita(); });
    esik.addEventListener('wheel', e => { if (tila.tapa !== 'rajaa') return; e.preventDefault(); tila.zoom = Math.max(1, Math.min(4, tila.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); zoom.value = tila.zoom; paivita(); }, { passive: false });
    // otsikosta siirto
    const ot = paneeli.querySelector('.ot');
    ot.addEventListener('pointerdown', e => {
      if (e.target.tagName === 'B') return;
      const r = paneeli.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const liiku = m => { paneeli.style.left = Math.max(0, Math.min(innerWidth - r.width, m.clientX - dx)) + 'px'; paneeli.style.top = Math.max(0, Math.min(innerHeight - 40, m.clientY - dy)) + 'px'; paneeli.style.bottom = 'auto'; };
      const irti = () => { removeEventListener('pointermove', liiku); removeEventListener('pointerup', irti); };
      addEventListener('pointermove', liiku); addEventListener('pointerup', irti);
    });
    const na = paneeli.querySelector('.kku-nappiasetus');
    na.checked = nappiNakyy(); na.onchange = () => { asetukset.nappi = na.checked; tallenna(); pikanappi(); };
    return paneeli;
  }

  function paivita(kevyt) {
    if (!paneeli) return;
    paneeli.querySelectorAll('[data-tapa]').forEach(b => b.classList.toggle('on', b.dataset.tapa === tila.tapa));
    paneeli.querySelectorAll('[data-tausta]').forEach(b => b.classList.toggle('on', b.dataset.tausta === tila.tausta));
    paneeli.querySelector('.kku-zoom').style.display = tila.tapa === 'rajaa' ? '' : 'none';
    paneeli.querySelector('.kku-tausta').style.display = tila.tapa === 'sovita' ? '' : 'none';
    const on = !!tila.lahde;
    paneeli.querySelector('.tyhja').style.display = on ? 'none' : '';
    esik.style.display = on ? '' : 'none';
    if (!on) { tieto.textContent = ''; return; }
    const c = piirra();
    const g = esik.getContext('2d'); g.clearRect(0, 0, KOKO, KOKO); g.drawImage(c, 0, 0);
    if (kevyt) return; // vedon aikana ei pakata joka liikkeellä
    tila.png = pakkaa(c);
    const kt = tila.png ? Math.round(pngTavut(tila.png) / 1024) : null;
    tieto.textContent = `${tila.nimi} ${tila.lahde.width}×${tila.lahde.height} → ${KOKO}×${KOKO}` +
      (kt === null ? ' · LIIAN ISO' : ` · ${kt} kt` + (tila.bitit < 8 ? ` (värit ${tila.bitit} bittiä)` : ''));
  }

  function ilmoita(teksti, laji) { rakenna(); viesti.textContent = teksti; viesti.className = 'pieni viesti ' + (laji || ''); if (paneeli.style.display === 'none') { naytaPaneeli(); } }
  function naytaPaneeli() { rakenna().style.display = ''; paivita(); }
  function piilota() { if (paneeli) paneeli.style.display = 'none'; }
  const auki = () => !!paneeli && paneeli.style.display !== 'none';
  function vaihda() { auki() ? piilota() : naytaPaneeli(); }

  // Pikanappi: oletuksena näkyy vain jos Kupla Komennot EI ole käytössä (silloin :omakuva riittää).
  function nappiNakyy() { return typeof asetukset.nappi === 'boolean' ? asetukset.nappi : !(VW.kuplaKomennot && VW.kuplaKomennot.__versio); }
  function pikanappi() {
    tyyli();
    let b = document.getElementById('kku-nappi');
    if (!nappiNakyy()) { if (b) b.remove(); return; }
    if (b) return;
    b = document.createElement('button'); b.id = 'kku-nappi'; b.textContent = '📷'; b.title = 'Oma kuva kamerakuvaksi (raahaa siirtääksesi)';
    // kp 2026-09-30 04:04 "ei oo draggable + ruma. ei pelin tyylinen": pelin tumma kortti (rgb(17,26,38), musta reuna),
    //   raahattava; sijainti muistetaan (asetukset.nappiXY). Klikkaus vain jos ei raahattu (>4 px = raahaus).
    if (asetukset.nappiXY) { b.style.left = asetukset.nappiXY[0] + 'px'; b.style.top = asetukset.nappiXY[1] + 'px'; b.style.bottom = 'auto'; }
    let alku = null, liikkui = false;
    b.addEventListener('pointerdown', e => { if (e.button !== 0) return; const r = b.getBoundingClientRect();
      alku = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top }; liikkui = false; b.setPointerCapture(e.pointerId); });
    b.addEventListener('pointermove', e => { if (!alku) return;
      if (!liikkui && Math.hypot(e.clientX - alku.x, e.clientY - alku.y) < 4) return;
      liikkui = true; b.classList.add('raahaa');
      const x = Math.max(0, Math.min(innerWidth - b.offsetWidth, e.clientX - alku.dx)), y = Math.max(0, Math.min(innerHeight - b.offsetHeight, e.clientY - alku.dy));
      b.style.left = x + 'px'; b.style.top = y + 'px'; b.style.bottom = 'auto'; });
    b.addEventListener('pointerup', () => { if (!alku) return; alku = null; b.classList.remove('raahaa');
      if (liikkui) { asetukset.nappiXY = [parseInt(b.style.left), parseInt(b.style.top)]; tallenna(); } });
    b.addEventListener('click', e => { if (liikkui) { e.preventDefault(); liikkui = false; return; } vaihda(); });
    document.body.appendChild(b);
  }

  // Ctrl+V ja pudotus vain kun paneeli on auki — muuten chatin oma kuvanliitos saa ne.
  document.addEventListener('paste', e => {
    if (!auki()) return;
    const f = [...(e.clipboardData && e.clipboardData.files || [])].find(x => /^image\//.test(x.type));
    if (!f) return;
    e.preventDefault(); e.stopImmediatePropagation(); lataaTiedosto(f);
  }, true);
  document.addEventListener('dragover', e => { if (auki() && [...(e.dataTransfer && e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); }, true);
  document.addEventListener('drop', e => {
    if (!auki()) return;
    const f = [...(e.dataTransfer && e.dataTransfer.files || [])].find(x => /^image\//.test(x.type));
    if (!f) return;
    e.preventDefault(); e.stopImmediatePropagation(); lataaTiedosto(f);
  }, true);

  // =====================================================================================================================
  // 4.2.0 NELIÖKAMERA, OSTO, SIJOITUS, KOPIO, KUVASELAIN (kp 2026-09-30 06:39–06:41 #849–#854 #856, Res 06:40 #855)
  // Kaikki UNTESTED-LIVE. Lähteet: DarkUI CameraWidgetCheckoutView.tsx, InventoryUtilities.ts:95 (attemptItemPlacement),
  //   useInventoryFurni.ts, InventoryFurnitureView.tsx; Habbo-Daybreak PurchasePhotoMessageEvent.java, CameraRenderManager.java.
  // =====================================================================================================================

  // ---------- lanka: 3696 (kuvan osoite), 2783 (osto kuitattu), 2103 (uuden esineen id) ----------
  // Sama kuuntelutapa kuin nitro/mosaiikki-osta.js:28-38 (mitattu 29.9): yhteysolio löytyy roomSessionManagerin alta
  //   _cryptoState-kentästä; saapuvat kehykset ovat [int32 pituus][int16 id][data]. Kuuntelija vain LUKEE.
  const lanka = { urls: 0, ok: 0, ids: [], conn: null, viimeUrl: 0 };
  function yhteys() {
    if (lanka.conn && lanka.conn._socket && lanka.conn._socket.readyState === 1) return lanka.conn;
    const re = VW.NitroDevTools && VW.NitroDevTools.roomEngine; if (!re) return null;
    const etsi = (o, s) => {
      if (!o || typeof o !== 'object' || s.has(o) || s.size > 20000) return null; s.add(o);
      if (Object.prototype.hasOwnProperty.call(o, '_cryptoState')) return o;
      for (const k of Object.getOwnPropertyNames(o)) { let v; try { v = o[k]; } catch (e) { continue; } if (v && typeof v === 'object') { const f = etsi(v, s); if (f) return f; } }
      return null;
    };
    const conn = etsi(re._roomSessionManager, new Set());
    if (!conn || !conn._socket) return null;
    lanka.conn = conn;
    if (!conn._socket.__kkuKuuntelija) {
      conn._socket.__kkuKuuntelija = 1;
      conn._socket.addEventListener('message', ev => {
        try {
          if (!(ev.data instanceof ArrayBuffer)) return;
          const v = new DataView(ev.data); let o = 0;
          while (o + 6 <= v.byteLength) {
            const len = v.getInt32(o), pid = v.getInt16(o + 4);
            if (pid === 3696) { lanka.urls++; lanka.viimeUrl = Date.now(); }
            else if (pid === 2783) lanka.ok++;
            else if (pid === 2103) {
              // UnseenItems: int kategorioita, per kategoria: int kategoria, int n, n × int id. Kalusteet = kategoria 1.
              let p = o + 6; const nk = v.getInt32(p); p += 4;
              for (let i = 0; i < nk && p + 8 <= o + 4 + len; i++) {
                const kat = v.getInt32(p), n = v.getInt32(p + 4); p += 8;
                for (let j = 0; j < n && p + 4 <= o + 4 + len; j++, p += 4) if (kat === 1) lanka.ids.push(v.getInt32(p));
              }
            }
            o += 4 + len;
          }
        } catch (e) {}
      });
    }
    return conn;
  }
  const odotaMs = ms => new Promise(r => setTimeout(r, ms));

  // Osto: pelin OMA Osta-nappi (ostoikkunan ensimmäinen .bg-muted-rivi = osto, toinen = julkaisu). Palauttaa uuden id:n tai null.
  // #854: palvelin lähettää 3696:n ENNEN kuin se kirjaa kuvan url:n photoJSON:iin (CameraRenderManager.commitPhoto :153-154),
  //   ja PurchasePhotoMessageEvent palaa HILJAA jos photoJSON:ssa on vielä %url% -> liian aikainen osto katoaa ilman 2783:a.
  //   Siksi: nappi päällä + VIIVE 3696:n jälkeen. Levyn palvelinlähde ei ole live-versio (3226 on siinä JSON-scene, livenä PNG),
  //   joten tämä on hypoteesi eikä mitattu. EI automaattista uusintaa: kadonnut kuittaus voi silti olla osto (raha).
  function ostoNappi() {
    const o = document.querySelector('.nitro-camera-checkout'); if (!o) return null;
    const rivi = o.querySelector('.bg-muted'); return rivi && rivi.querySelector('button');
  }
  // Palauttaa { ostettu, id }. id = null jos 2103 ei tullut; ostettu = null jos lankaa ei voitu kuunnella (tila tuntematon).
  async function odotaOsto(ok0, id0, viesti) {
    if (!lanka.conn) { viesti('Osto lähetetty, mutta kuittausta ei voi lukea (yhteysoliota ei löytynyt). Katso inventaario.', 'virhe'); return { ostettu: null, id: null }; }
    const kuitattu = await odota(() => lanka.ok > ok0, 8000);
    if (!kuitattu) { viesti('Ostoa ei kuitattu 8 s:ssa. Tarkista kolikot ja inventaario ennen kuin ostat uudestaan.', 'virhe'); return { ostettu: false, id: null }; }
    // #853: uusin id tulee 2103:sta heti 2783:n perään (PurchasePhotoMessageEvent.java: 2783 -> 2103 -> FurniListInvalidate),
    //   EI inventaarion pinon järjestyksestä
    await odota(() => lanka.ids.length > id0, 3000);
    return { ostettu: true, id: lanka.ids.length > id0 ? lanka.ids[lanka.ids.length - 1] : null };
  }
  async function ostaAuki(viesti) {
    yhteys();
    const nappi = await odota(() => { const b = ostoNappi(); return b && !b.disabled ? b : null; }, 6000);
    if (!nappi) { viesti('Osta-nappi ei auennut (kuva ei valmis?).', 'virhe'); return { ostettu: false, id: null }; }
    const viive = 700 - (Date.now() - lanka.viimeUrl);
    if (lanka.viimeUrl && viive > 0) await odotaMs(viive);
    const ok0 = lanka.ok, id0 = lanka.ids.length;
    nappi.click();
    viesti('Ostetaan…');
    return odotaOsto(ok0, id0, viesti);
  }

  // #856: osta kopio viimeisimmästä kuvasta. Palvelin ostaa AINA viimeisimmän 3226:n (PurchasePhotoMessageEvent: photoJSON),
  //   joten kopio = sama 2408 uudestaan. Ostoikkuna auki -> sen "Osta toinen" -nappi; muuten sama composer jonka peli rakentaa
  //   (PurchasePhotoMessageComposer(''), id 2408), lähetettynä pelin omalla yhteydellä. Vaatii että tällä latauksella on nähty
  //   3696 (muuten emme tiedä onko palvelimella kuvaa, tai se on jonkun muun lisäosan).
  async function ostaKopio(viesti) {
    viesti = viesti || kViesti;
    if (ostoNappi() && !ostoNappi().disabled) {
      const t = await ostaAuki(viesti);
      if (t.ostettu) await ostonJalkeen(t.id, viesti, true);
      return t.id;
    }
    const conn = yhteys();
    if (!conn) { viesti('Pelin yhteyttä ei löytynyt.', 'virhe'); return null; }
    if (!lanka.urls) { viesti('Tällä latauksella ei ole otettu kuvaa, joten kopioitavaa ei tunneta. Ota ensin kuva.', 'virhe'); return null; }
    let C = null; try { for (const [k, v] of conn._messages._messageIdByComposer) if (v === 2408) C = k; } catch (e) {}
    if (!C) { viesti('Ostopakettia ei löytynyt pelistä.', 'virhe'); return null; }
    const ok0 = lanka.ok, id0 = lanka.ids.length;
    conn.send(new C(''));
    viesti('Ostetaan kopio viimeisimmästä kuvasta…');
    const t = await odotaOsto(ok0, id0, viesti);
    if (t.ostettu) await ostonJalkeen(t.id, viesti, false);
    return t.id;
  }

  // ---------- #852 sijoitus: uusi kuva valituksi -> klikkaus seinään sijoittaa ----------
  // Pelin oma polku: inventaarion ruudun tuplaklikkaus -> attemptItemPlacement(groupItem) (InventoryUtilities.ts:95), joka ottaa
  //   pinon items-taulukon VIIMEISEN lukitsemattoman. Kamerakuvat ovat yksi pino, ja järjestys tulee palvelimen listasta -> #853.
  //   Siksi uusi esine siirretään pinon loppuun ennen tuplaklikkausta. Lista päivittyy vain inventaarion ollessa auki
  //   (useInventoryFurni.ts:273-280), joten inventaario avataan hetkeksi; attemptItemPlacement sulkee sen itse.
  const fiberOf = el => { const k = el && Object.keys(el).find(x => x.startsWith('__reactFiber')); return k ? el[k] : null; };
  function kayFiberit(juuri, ehto) {
    const pino = [juuri]; let n = 0;
    while (pino.length && n++ < 50000) {
      const f = pino.pop(); if (!f) continue;
      if (ehto(f)) return f;
      if (f.sibling && f !== juuri) pino.push(f.sibling);
      if (f.child) pino.push(f.child);
    }
    return null;
  }
  const inventaario = () => document.querySelector('.nitro-inventory');
  function ryhmat() {
    const inv = inventaario(); const f = fiberOf(inv); if (!f) return null;
    const g = kayFiberit(f, x => x.memoizedProps && Array.isArray(x.memoizedProps.groupItems) && typeof x.memoizedProps.setGroupItems === 'function');
    return g ? g.memoizedProps.groupItems : null;
  }
  async function avaaInventaario() {
    if (!inventaario()) {
      const ikoni = document.querySelector('.side-toolbar-item .icon-inventory') || document.querySelector('.icon-inventory');
      if (!ikoni) return false;
      ikoni.click();
      if (!await odota(inventaario, 3000)) return false;
    }
    // kalusteet-välilehti = ensimmäinen (InventoryView.tsx TABS: furni, bots, pets, badges)
    const tab = inventaario().querySelector('.nav-item');
    if (tab && !tab.classList.contains('active')) { tab.click(); await odotaMs(200); }
    return true;
  }
  async function sijoita(id, viesti) {
    viesti = viesti || kViesti;
    if (!await avaaInventaario()) { viesti('Inventaariota ei saatu auki.', 'virhe'); return false; }
    const loyda = () => { const gs = ryhmat(); if (!gs) return null; for (const g of gs) { const it = g.getItemById && g.getItemById(id); if (it) return { g, it }; } return null; };
    const l = await odota(loyda, 8000);
    if (!l) { viesti('Uutta kuvaa (id ' + id + ') ei vielä näy inventaariossa. Sijoita se käsin.', 'virhe'); return false; }
    const { g, it } = l;
    try { g.items = [...g.items.filter(x => x !== it), it]; } catch (e) {}
    // pelin oma ruutu: oX-näkymän lapsen props.onDoubleClick({type:'dblclick'}) -> attemptItemPlacement(g)
    const ruutu = kayFiberit(fiberOf(inventaario()), x => x.memoizedProps && x.memoizedProps.groupItem === g);
    const kasittelija = ruutu && kayFiberit(ruutu.child, x => x.memoizedProps && typeof x.memoizedProps.onDoubleClick === 'function');
    if (kasittelija) {
      kasittelija.memoizedProps.onDoubleClick({ type: 'dblclick', preventDefault() {}, stopPropagation() {} });
    } else {
      // varapolku (esim. haku rajaa ruudun pois): moottorin oma sijoitus suoraan, kuten attemptItemPlacement tekee julisteille
      //   (processRoomObjectPlacement(INVENTORY, id, WALL=20, tyyppi, legacy, stuffData)). Pelin jonoa ei päivitetä.
      const re = VW.NitroDevTools && VW.NitroDevTools.roomEngine;
      let ok = false;
      try { const legacy = it.stuffData && it.stuffData.getLegacyString ? it.stuffData.getLegacyString() : ''; ok = re.processRoomObjectPlacement('inventory', it.id, 20, it.type, legacy, it.stuffData); } catch (e) {}
      const ikoni = document.querySelector('.side-toolbar-item .icon-inventory');
      if (inventaario() && ikoni) ikoni.click();
      if (!ok) { viesti('Sijoitustilaa ei saatu päälle. Sijoita kuva inventaariosta.', 'virhe'); return false; }
    }
    viesti('Kuva valittu. Klikkaa seinää niin se ripustetaan.', 'ok');
    return true;
  }
  async function ostonJalkeen(id, viesti, suljeIkkuna) {
    if (!id) { viesti('Ostettu, mutta uuden kuvan id jäi saamatta. Löydät sen inventaariosta.', 'ok'); return; }
    if (suljeIkkuna) { const f = kameraFiber(); if (f) try { f.memoizedState.queue.dispatch(0); } catch (e) {} }
    if (asetukset.sijoita !== false) await sijoita(id, viesti);
    else viesti('Ostettu. Kuva on inventaariossa.', 'ok');
  }

  // ---------- #849/#850 neliökamera: kehys ruudun päällä, kaappaus kuplineen, 320x320 ----------
  // Kaappaus = Kuvakaappaus-lisäosan otaAlue (1.2.0): pelin renderöijä + chat-kuplat. Kehyksen koko on zoom:
  //   pienempi kehys = suurempi suurennos. Pelin oma zoom tulee mukaan sellaisenaan.
  let kehys = null, kViestiEl = null, kKiire = false;
  function kViesti(t, laji) { if (!kehys) { console.log('[kamera]', t); return; } kViestiEl.textContent = t; kViestiEl.style.color = laji === 'virhe' ? '#fca5a5' : laji === 'ok' ? '#6ee7b7' : '#eee'; }
  function rakennaKehys() {
    if (kehys && kehys.isConnected) return kehys;
    tyyli();
    if (!document.getElementById('kku-kehys-tyyli')) {
      const s = document.createElement('style'); s.id = 'kku-kehys-tyyli';
      s.textContent = `#kku-kehys{position:fixed;z-index:99998;border:2px dashed #fbbf24;box-shadow:0 0 0 9999px rgba(0,0,0,.25);pointer-events:none;box-sizing:content-box}
#kku-kehys .kp{position:absolute;left:-2px;right:-2px;top:100%;margin-top:2px;pointer-events:auto;background:rgb(17,26,38);border:2px solid #000;border-radius:0 0 6px 6px;color:#eee;font:12px/1.4 Ubuntu,Arial,sans-serif;padding:4px 6px;user-select:none}
#kku-kehys .kp .r{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
#kku-kehys .kp button{background:#374151;color:#fff;border:1px solid #555;border-radius:5px;padding:2px 7px;cursor:pointer;font:inherit}
#kku-kehys .kp button.ota{background:#10b981;border-color:#059669;font-weight:bold}
#kku-kehys .kp label{display:flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap}
#kku-kehys .veto{position:absolute;left:0;right:0;top:0;height:22px;pointer-events:auto;cursor:move;background:rgba(251,191,36,.25);color:#000;font:bold 11px Ubuntu,Arial,sans-serif;text-align:center;line-height:22px}
#kku-kehys .reuna{position:absolute;pointer-events:auto;cursor:move}
#kku-kehys .reuna.y{left:-7px;right:-7px;top:-7px;height:10px}#kku-kehys .reuna.a{left:-7px;right:-7px;bottom:-7px;height:10px}
#kku-kehys .reuna.v{top:-7px;bottom:-7px;left:-7px;width:10px}#kku-kehys .reuna.o{top:-7px;bottom:-7px;right:-7px;width:10px}
#kku-kehys .kp{cursor:move}#kku-kehys .kp button,#kku-kehys .kp label{cursor:pointer}
#kku-kehys .kulma{position:absolute;right:-8px;bottom:-8px;width:14px;height:14px;background:#fbbf24;pointer-events:auto;cursor:nwse-resize;border-radius:3px}`;
      document.head.appendChild(s);
    }
    kehys = document.createElement('div'); kehys.id = 'kku-kehys';
    const koko = Math.max(80, Math.min(900, asetukset.kehysKoko || 320));
    const x = asetukset.kehysXY ? asetukset.kehysXY[0] : Math.round(innerWidth / 2 - koko / 2), y = asetukset.kehysXY ? asetukset.kehysXY[1] : Math.round(innerHeight / 2 - koko / 2 - 40);
    Object.assign(kehys.style, { left: x + 'px', top: y + 'px', width: koko + 'px', height: koko + 'px' });
    kehys.innerHTML = `<div class="veto" title="raahaa · rulla = koko (zoom)">⠿ neliökamera · rulla = zoom</div><div class="reuna y"></div><div class="reuna a"></div><div class="reuna v"></div><div class="reuna o"></div><div class="kulma" title="raahaa = koko"></div>
<div class="kp"><div class="r"><button class="ota">📷 Ota</button><button class="kopio" title="Osta uusi kopio viimeisimmästä kuvasta (Alt+K)">🔁 Kopio</button><button class="kiinni">✕</button><span class="zoom"></span></div>
<div class="r"><label><input type="checkbox" class="o-kuplat"> kuplat</label><label><input type="checkbox" class="o-minua"> ilman minua</label><label><input type="checkbox" class="o-osta"> osta heti</label><label><input type="checkbox" class="o-sijoita"> sijoita heti</label></div>
<div class="viesti" style="min-height:14px"></div></div>`;
    document.body.appendChild(kehys);
    kViestiEl = kehys.querySelector('.viesti');
    const ruksi = (sel, avain, oletus) => { const cb = kehys.querySelector(sel); cb.checked = typeof asetukset[avain] === 'boolean' ? asetukset[avain] : oletus; cb.onchange = () => { asetukset[avain] = cb.checked; tallenna(); }; };
    ruksi('.o-kuplat', 'kuplat', true); ruksi('.o-minua', 'ilmanMinua', false); ruksi('.o-osta', 'ostaHeti', true); ruksi('.o-sijoita', 'sijoita', true);
    kehys.querySelector('.ota').onclick = () => otaNelio();
    kehys.querySelector('.kopio').onclick = () => ostaKopio(kViesti);
    kehys.querySelector('.kiinni').onclick = () => { kehys.style.display = 'none'; };
    const nayttoZoom = () => { kehys.querySelector('.zoom').textContent = 'zoom ×' + (KOKO / (Math.max(1, kehys.offsetWidth - 4) * (devicePixelRatio || 1))).toFixed(2); };
    const muistaPaikka = () => { asetukset.kehysXY = [parseInt(kehys.style.left), parseInt(kehys.style.top)]; asetukset.kehysKoko = kehys.offsetWidth - 4; tallenna(); nayttoZoom(); };
    const asetaKoko = k => { k = Math.max(80, Math.min(Math.min(innerWidth, innerHeight) - 60, Math.round(k))); kehys.style.width = kehys.style.height = k + 'px'; };
    const veto = kehys.querySelector('.veto');
    // 4.2.1: sama raahaus yläpalkista, reunavyöhykkeistä ja alapaneelin tyhjästä taustasta (ei napeista/ruksista)
    const aloitaVeto = e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = kehys.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const liiku = m => { kehys.style.left = Math.max(0, Math.min(innerWidth - r.width, m.clientX - dx)) + 'px'; kehys.style.top = Math.max(0, Math.min(innerHeight - 60, m.clientY - dy)) + 'px'; };
      const irti = () => { removeEventListener('pointermove', liiku); removeEventListener('pointerup', irti); muistaPaikka(); };
      addEventListener('pointermove', liiku); addEventListener('pointerup', irti);
    };
    veto.addEventListener('pointerdown', aloitaVeto);
    kehys.querySelectorAll('.reuna').forEach(el => el.addEventListener('pointerdown', aloitaVeto));
    kehys.querySelector('.kp').addEventListener('pointerdown', e => { if (!e.target.closest('button,label,input')) aloitaVeto(e); });
    veto.addEventListener('wheel', e => { e.preventDefault(); const r = kehys.getBoundingClientRect(), k0 = r.width - 4, k1 = k0 * (e.deltaY < 0 ? 1 / 1.1 : 1.1);
      asetaKoko(k1); const k2 = kehys.offsetWidth - 4; kehys.style.left = (r.left + (k0 - k2) / 2) + 'px'; kehys.style.top = (r.top + (k0 - k2) / 2) + 'px'; muistaPaikka(); }, { passive: false });
    kehys.querySelector('.kulma').addEventListener('pointerdown', e => {
      e.preventDefault(); const r = kehys.getBoundingClientRect();
      const liiku = m => asetaKoko(Math.max(m.clientX - r.left, m.clientY - r.top));
      const irti = () => { removeEventListener('pointermove', liiku); removeEventListener('pointerup', irti); muistaPaikka(); };
      addEventListener('pointermove', liiku); addEventListener('pointerup', irti);
    });
    nayttoZoom();
    return kehys;
  }
  function naytaKehys() { rakennaKehys().style.display = ''; }
  const kehysAuki = () => !!kehys && kehys.isConnected && kehys.style.display !== 'none';

  async function otaNelio() {
    if (kKiire) return; kKiire = true;
    try {
      const kk = VW.kuplaKuvakaappaus;
      if (!kk || typeof kk.otaAlue !== 'function') { kViesti('Tarvitaan Kuvakaappaus-lisäosa 1.2.0 tai uudempi.', 'virhe'); return; }
      yhteys();
      const r = kehys.getBoundingClientRect();
      // sisäalue: reunaviivan (2 px) sisäpuoli
      const rect = { left: r.left + 2, top: r.top + 2, width: r.width - 4, height: r.height - 4 };
      rect.right = rect.left + rect.width; rect.bottom = rect.top + rect.height;
      kViesti('Otetaan kuvaa…');
      let tulos;
      try { tulos = await kk.otaAlue({ chat: asetukset.kuplat !== false, ilmanMinua: !!asetukset.ilmanMinua }, rect, KOKO); }
      catch (e) { kViesti('Kuvan otto epäonnistui: ' + ((e && e.message) || e), 'virhe'); return; }
      const png = pakkaa(tulos.canvas);
      if (!png) { kViesti('Kuva on liian yksityiskohtainen. Pienennä kehystä tai ota ilman kuplia.', 'virhe'); return; }
      VW.__kuplaNelioViimeisin = { png, tiedot: tulos.tiedot, aika: new Date().toLocaleTimeString('fi') };
      const ok = await vieOstoikkunaan(png, kViesti);
      if (!ok) return;
      if (asetukset.ostaHeti === false) { kViesti('Kuva hyväksytty. Osta pelin ikkunasta.', 'ok'); return; }
      const t = await ostaAuki(kViesti);
      if (t.ostettu) await ostonJalkeen(t.id, kViesti, true);
    } finally { kKiire = false; }
  }

  // Alt+K = kopio viimeisimmästä (#856). Ei kun kirjoitetaan kenttään.
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key || '').toLowerCase() !== 'k') return;
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault(); e.stopPropagation();
    ostaKopio(kehysAuki() ? kViesti : (t, laji) => { if (laji === 'virhe' || laji === 'ok') ilmoitaLyhyt(t, laji); });
  }, true);
  // lyhyt ilmoitus ilman paneelia (Alt+K kun kehys kiinni)
  function ilmoitaLyhyt(t, laji) {
    let el = document.getElementById('kku-lyhyt');
    if (!el) { el = document.createElement('div'); el.id = 'kku-lyhyt'; el.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:99999;background:rgb(17,26,38);border:2px solid #000;border-radius:6px;color:#eee;font:12px Ubuntu,Arial,sans-serif;padding:5px 10px;pointer-events:none'; document.body.appendChild(el); }
    el.textContent = '📷 ' + t; el.style.color = laji === 'virhe' ? '#fca5a5' : '#6ee7b7'; el.style.display = '';
    clearTimeout(el._t); el._t = setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  // ---------- #855 (Res) kuvaselain: inventaarion kamerakuvat isona, selaus nuolilla/rullalla ----------
  // Kuvan osoite on esineen legacy-JSON:n "w"-kentässä (nitro/mosaiikki-seina.js:29, mitattu 29.9). Lista luetaan pelin omasta
  //   inventaariotilasta (groupItems-props, InventoryFurnitureSearchView), joten inventaarion täytyy olla auki kerran.
  function kuvaTiedot(it) {
    let s = '', d = null; try { d = it.stuffData && it.stuffData._data; s = String((d && typeof d === 'string' ? d : (it.stuffData.getLegacyString && it.stuffData.getLegacyString())) || ''); } catch (e) {}
    let j = null; try { j = JSON.parse(s); } catch (e) {}
    if (!j && d && typeof d.get === 'function') { try { const w0 = d.get('w'); if (w0) j = { w: w0, t: d.get('t') }; } catch (e) {} }   // MapStuffData (varmuuden vuoksi)
    const w = (j && j.w) || ((/"w":"([^"]+)"/.exec(s) || [])[1]);
    if (!w) return null;
    let url = w.replace(/\\\//g, '/');
    try { const u = new URL(url, location.origin); if (/^(www\.)?kuplahotelli\.com$/i.test(u.hostname) && /^\/(swf\/)?camera(\/|$)/i.test(u.pathname)) url = location.origin + '/camera/' + u.pathname.replace(/^\/(swf\/)?camera\/?/i, ''); } catch (e) {}
    const t = j && (j.t || j.timestamp);
    return { id: it.id, url, aika: t ? new Date((t > 1e12 ? t : t * 1000)).toLocaleString('fi') : '' };
  }
  function kaikkiKuvat() {
    const gs = ryhmat(); if (!gs) return null;
    const out = [];
    for (const g of gs) for (const it of (g.items || [])) { if (!it || !it.isWallItem) continue; const k = kuvaTiedot(it); if (k) out.push(k); }
    out.sort((a, b) => b.id - a.id);   // uusin ensin
    return out;
  }
  function valittuId() {
    const inv = inventaario(); if (!inv) return null;
    const f = kayFiberit(fiberOf(inv), x => x.memoizedProps && x.memoizedProps.itemActive === true && x.return && x.return.memoizedProps && x.return.memoizedProps.groupItem);
    const g = f && f.return.memoizedProps.groupItem; const it = g && g.getLastItem && g.getLastItem();
    return it ? it.id : null;
  }
  let selain = null;
  async function avaaSelain(alkuId) {
    if (!inventaario()) await avaaInventaario();
    const kuvat = await odota(() => { const k = kaikkiKuvat(); return k && k.length ? k : null; }, 4000);
    if (!kuvat) { ilmoitaLyhyt('Inventaariossa ei ole kamerakuvia (tai sitä ei saatu luettua).', 'virhe'); return; }
    let i = Math.max(0, kuvat.findIndex(k => k.id === (alkuId || valittuId())));
    if (selain) selain.remove();
    selain = document.createElement('div');
    selain.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#eee;font:13px Ubuntu,Arial,sans-serif;user-select:none';
    selain.innerHTML = `<div style="display:flex;align-items:center;gap:14px"><button class="ed" style="font-size:28px;background:none;border:0;color:#fff;cursor:pointer">◀</button>
<img style="max-width:min(85vw,960px);max-height:80vh;min-width:320px;image-rendering:pixelated;background:#111;border:2px solid #000;box-shadow:0 6px 24px #000">
<button class="se" style="font-size:28px;background:none;border:0;color:#fff;cursor:pointer">▶</button></div>
<div class="ala" style="margin-top:8px;display:flex;gap:10px;align-items:center"><span class="lk"></span>
<button class="sij" style="background:#10b981;border:1px solid #059669;color:#fff;border-radius:5px;padding:3px 8px;cursor:pointer">Sijoita tämä</button>
<a class="av" target="_blank" rel="noreferrer" style="color:#93c5fd">avaa uuteen välilehteen</a>
<button class="x" style="background:#374151;border:1px solid #555;color:#fff;border-radius:5px;padding:3px 8px;cursor:pointer">Sulje (Esc)</button></div>`;
    document.body.appendChild(selain);
    const img = selain.querySelector('img'), lk = selain.querySelector('.lk'), av = selain.querySelector('.av');
    const nayta = () => { const k = kuvat[i]; img.src = k.url; av.href = k.url; lk.textContent = (i + 1) + ' / ' + kuvat.length + (k.aika ? ' · ' + k.aika : ''); };
    const siirra = d => { i = (i + d + kuvat.length) % kuvat.length; nayta(); };
    const sulje = () => { removeEventListener('keydown', nappain, true); if (selain) { selain.remove(); selain = null; } };
    function nappain(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); sulje(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); siirra(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); siirra(-1); }
    }
    addEventListener('keydown', nappain, true);
    selain.addEventListener('wheel', e => { e.preventDefault(); siirra(e.deltaY > 0 ? 1 : -1); }, { passive: false });
    selain.querySelector('.ed').onclick = e => { e.stopPropagation(); siirra(-1); };
    selain.querySelector('.se').onclick = e => { e.stopPropagation(); siirra(1); };
    selain.querySelector('.x').onclick = sulje;
    selain.querySelector('.sij').onclick = e => { e.stopPropagation(); const id = kuvat[i].id; sulje(); sijoita(id, (t, laji) => ilmoitaLyhyt(t, laji || 'ok')); };
    selain.addEventListener('click', e => { if (e.target === selain) sulje(); });
    nayta();
  }
  // #853/#854 (kp 07:30 "kamera aika unusable ku vika kuva ei tuu ekana invist"): kamerakuvapinon järjestys = palvelimen listan
  //   järjestys. Palvelin (Habbo-Daybreak ItemsComponent.java:30) pitää repun TIntObjectHashMapissa -> lista tulee HASH-
  //   järjestyksessä, ei id-järjestyksessä. DarkUI GroupItem.push lisää loppuun (GroupItem.ts:120-152) ja sijoitus/esikatselu
  //   ottavat pinon VIIMEISEN (InventoryUtilities.ts:99, InventoryFurnitureView.tsx getLastItem). Kun reppu ladataan ensimmäistä
  //   kertaa (tai uudelleen FurniListInvalidaten jälkeen tyhjästä), uusin kuva on satunnaisessa kohdassa.
  //   Natiivi (Habbo-Sky GroupItem.as:379 _Str_3205 = viimeinen, FurniModel.as:715-727) toimii samoin, mutta siinä on lisäksi
  //   pinon esikatseluindeksi + "seuraava"-nappi (FurniView.as:241, 686-690). Tässä: kamerakuvapinot järjestetään id:n mukaan
  //   nousevasti -> viimeinen = uusin -> tuplaklikkaus / "Sijoita huoneeseen" ottaa uusimman. Vain kamerakuvapinot.
  //   Järjestys muuttaa vain selaimen muistissa olevaa taulukkoa; palvelimelle ei lähde mitään.
  let jarjestetty = 0;
  function jarjestaKuvat() {
    const gs = ryhmat(); if (!gs) return 0;
    let n = 0;
    for (const g of gs) {
      const its = g && g.items; if (!its || its.length < 2 || !its[0] || !its[0].isWallItem || !kuvaTiedot(its[0])) continue;
      let jarjestyksessa = true; for (let i = 1; i < its.length; i++) if (its[i - 1].id > its[i].id) { jarjestyksessa = false; break; }
      if (jarjestyksessa) continue;
      try { g.items = [...its].sort((a, b) => a.id - b.id); n++; } catch (e) {}
    }
    jarjestetty += n;
    return n;
  }
  // Järjestys myös juuri ennen jokaista painallusta inventaariossa (capture-vaihe document-tasolla ehtii ennen Reactin juuren
  //   kuuntelijaa), jottei sekunnin välein tarkistus jää jälkeen kun lista on juuri latautunut.
  document.addEventListener('pointerdown', e => {
    if (asetukset.jarjesta === false || !e.target || !e.target.closest || !e.target.closest('.nitro-inventory')) return;
    try { jarjestaKuvat(); } catch (x) {}
  }, true);
  // "🔍 Selaa kuvia" -nappi inventaarioon (vain kun se on auki). Kevyt tarkistus sekunnin välein, ei MutationObserveria.
  setInterval(() => {
    const inv = inventaario(); if (!inv) return;
    if (asetukset.jarjesta !== false) { try { jarjestaKuvat(); } catch (e) {} }
    if (inv.querySelector('.kku-selaa')) return;
    const b = document.createElement('button'); b.className = 'kku-selaa btn btn-sm btn-primary'; b.textContent = '🔍 Selaa kuvia';
    b.title = 'Kamerakuvat isona, selaus nuolilla tai rullalla';
    b.style.cssText = 'position:absolute;right:40px;top:6px;z-index:5;padding:1px 6px;font-size:11px';
    b.onclick = e => { e.stopPropagation(); avaaSelain(); };
    const ot = inv.querySelector('.nitro-card-header-text'); (ot && ot.parentElement || inv).appendChild(b);
  }, 1000);

  (VW.kuplaKomennotJono = VW.kuplaKomennotJono || []).push([['neliökuva', 'neliokuva', 'kamera2'], () => { if (kehysAuki()) { kehys.style.display = 'none'; return 'neliökamera kiinni'; } naytaKehys(); return 'neliökamera auki: aseta kehys, paina Ota (rulla kehyksen yläpalkissa = zoom) · Alt+K = kopio viimeisimmästä'; },
    'neliökamera: 1:1-kuva kuplineen, osto ja sijoitus heti · Alt+K = kopio viimeisimmästä', 'Kamera-uploader']);
  (VW.kuplaKomennotJono = VW.kuplaKomennotJono || []).push([['kuvat', 'valokuvat'], () => { avaaSelain(); return 'kuvaselain: ← → tai rulla, Esc sulkee'; },
    'selaa inventaarion kamerakuvia isona', 'Kamera-uploader']);

  (VW.kuplaKomennotJono = VW.kuplaKomennotJono || []).push([['omakuva', 'kamerakuva'], (teksti, sanat) => {
    const a = (sanat && sanat[1] || '').toLowerCase();
    if (a === 'neliö' || a === 'nelio') { naytaKehys(); return 'neliökamera auki'; }
    if (a === 'kopio') { ostaKopio(ilmoitaLyhyt); return 'ostetaan kopio viimeisimmästä kuvasta…'; }
    if (a === 'selaa' || a === 'kuvat') { avaaSelain(); return 'kuvaselain auki'; }
    if (a === 'liitä' || a === 'liita') { naytaPaneeli(); liitaLeikepoydalta(); return 'kamerakuva: luetaan leikepöytää…'; }
    if (a === 'nappi') { asetukset.nappi = !nappiNakyy(); tallenna(); pikanappi(); return '📷-pikanappi ' + (asetukset.nappi ? 'näkyviin' : 'piiloon'); }
    vaihda(); return auki() ? 'kamerakuva-paneeli auki: pudota, liitä (Ctrl+V) tai valitse kuva' : 'kamerakuva-paneeli kiinni';
  }, 'oma kuva kamerakuvaksi · :omakuva liitä = suoraan leikepöydältä · :omakuva nappi = pikanappi päälle/pois', 'Kamera-uploader']);

  // Komennot latautuu rinnakkain -> päätetään pikanapista vasta hetken päästä.
  setTimeout(pikanappi, 4000);
  VW.__kuplaKameraUploaderApi = { naytaPaneeli, piilota, lataaTiedosto, avaaOstoikkuna, tila, piirra, pakkaa,
    naytaKehys, otaNelio, ostaKopio, sijoita, avaaSelain, jarjestaKuvat, kaikkiKuvat, lanka, jarjestetty: () => jarjestetty };
})();
