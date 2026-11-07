/**
 * Instagram Beğeni Temizleyici — content script
 *
 * Çalıştığı sayfa: https://www.instagram.com/your_activity/interactions/likes/
 *
 * Akış:
 *  1. Sayfada "Seç" linkine tıklanınca seçim modu açılır (metin "İptal"e döner).
 *  2. Her gönderi/reels thumbnail'ine tıklamak onu seçer (sağ üstte mavi tik belirir).
 *  3. En az 1 öğe seçiliyken alt tarafta "X seçildi" + kırmızı
 *     "Beğenmekten Vazgeç" butonu içeren bir çubuk belirir.
 *
 * ÖNEMLİ: Bu script SADECE SEÇER, otomatik olarak kaldırmaz.
 * "Beğenmekten Vazgeç" butonuna (ve açılan onay penceresindeki kırmızı
 * butona) kullanıcı kendi kontrolünde, istediği zaman elle basar. Script
 * sürekli aşağı kaydırıp görünen tüm gönderi/reels'leri seçmeye devam eder.
 *
 * Güvenlik notu: Bir tile'a tıkladıktan sonra "X seçildi" sayacının
 * GERÇEKTEN arttığı doğrulanmadan o tile seçilmiş sayılmaz.
 */

(function () {
  let running = false;
  let selectedCount = 0; // bu oturumda scriptin seçtiği öğe sayısı

  const MAX_NO_PROGRESS = 6; // büyük bir kaldırma sonrası grid'in yeniden render olması için pay

  // --- yardımcılar -----------------------------------------------------

  function delay(min, max) {
    return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
  }

  async function saveProgress(status) {
    try {
      await chrome.storage.local.set({ selectedCount, status: status || 'running' });
    } catch (e) {
      /* popup kapalıysa yoksay */
    }
  }

  // Metni DOĞRUDAN taşıyan (çocuğu olmayan) elemanlar arasında tam eşleşme arar.
  function findByExactText(text) {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length > 0) continue;
      if (el.textContent.trim() === text) return el;
    }
    return null;
  }

  // "12 seçildi" gibi bir metni regex ile arar.
  function findByRegex(regex) {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length > 0) continue;
      if (regex.test(el.textContent.trim())) return el;
    }
    return null;
  }

  // "X seçildi" elemanını bulduktan sonra referansını saklar; her
  // çağrıda tüm sayfayı yeniden taramak yerine (yavaş) sadece o
  // elemanın metnini okur (hızlı). Eleman DOM'dan düşerse yeniden arar.
  let selectedCounterEl = null;
  const SELECTED_RE = /^(\d+)\s*seçildi$/;

  function getSelectedCount() {
    if (selectedCounterEl && document.contains(selectedCounterEl)) {
      const m = selectedCounterEl.textContent.trim().match(SELECTED_RE);
      if (m) return parseInt(m[1], 10);
      selectedCounterEl = null; // metin artık uymuyor, yeniden ara
    }
    const el = findByRegex(SELECTED_RE);
    if (!el) return 0;
    selectedCounterEl = el;
    const m = el.textContent.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function findClickableAncestor(el) {
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || node.tagName === 'A') {
        return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  // Beğeni grid'indeki thumbnail "tile"larını bulur (img'den yukarı doğru
  // en yakın position:relative/absolute ataya çıkarak tile sınırını tahmin eder).
  function findTiles() {
    const imgs = Array.from(document.querySelectorAll('img'));
    const tiles = [];
    const seen = new Set();
    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      if (rect.width < 80 || rect.width > 500) continue; // profil foto/ikon vb. filtrele
      let node = img;
      let tile = null;
      for (let i = 0; i < 6 && node && node.parentElement; i++) {
        node = node.parentElement;
        const style = window.getComputedStyle(node);
        if (style.position === 'relative' || style.position === 'absolute') {
          tile = node;
          break;
        }
      }
      if (!tile) tile = img.parentElement;
      if (tile && !seen.has(tile)) {
        seen.add(tile);
        tiles.push(tile);
      }
    }
    return tiles;
  }

  function getScrollContainer() {
    const candidates = document.querySelectorAll('main, section, article, div');
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 100
      ) {
        return el;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  // DİKKAT: konteyneri HER ÇAĞRIDA taze bulur (parametre olarak almaz).
  // Seçim modundan çıkılıp girildiğinde veya kaldırma sonrası sayfa
  // yeniden render edildiğinde eski bir referans artık DOM'da olmayabilir
  // (detached) — bu durumda scrollTop'u değiştirmek sessizce hiçbir şey
  // yapmaz ve script yanlışlıkla "daha fazla içerik yok" sanır.
  async function scrollForMore() {
    const container = getScrollContainer();
    const isWindowScroll = container === document.scrollingElement || container === document.documentElement;
    const before = isWindowScroll ? document.documentElement.scrollHeight : container.scrollHeight;
    const amount = Math.round((container.clientHeight || window.innerHeight) * 0.8);

    if (isWindowScroll) {
      window.scrollBy(0, amount);
    } else {
      container.scrollTop += amount;
    }
    // İkisini de deneyelim: bazı durumlarda doğru konteyner window'un
    // kendisi değil ama yine de window scroll'u da tetiklemek zararsız
    // ve Instagram'ın intersection-observer tabanlı lazy-load'ını
    // tetiklemeye yardımcı olabilir.
    window.scrollBy(0, Math.round(amount / 4));

    await delay(800, 1200);

    const containerAfter = getScrollContainer(); // tekrar taze bul, DOM değişmiş olabilir
    const after = containerAfter === document.scrollingElement || containerAfter === document.documentElement
      ? document.documentElement.scrollHeight
      : containerAfter.scrollHeight;
    return after > before;
  }

  async function ensureSelectMode() {
    if (findByExactText('İptal')) return true; // zaten seçim modunda
    const selectBtn = findByExactText('Seç');
    if (!selectBtn) {
      console.warn('[IG Unliker] "Seç" linki bulunamadı. Sayfa yapısı değişmiş olabilir.');
      return false;
    }
    findClickableAncestor(selectBtn).click();
    await delay(500, 700);
    return !!findByExactText('İptal');
  }

  const CONFIRM_HEADING = 'Gönderileri beğenmekten vazgeç?';

  // Onay penceresinin kapsayıcısını bulur. `role="dialog"` güvenilir
  // olmayabileceğinden, önce onu dener, olmazsa başlık metninden
  // ("Gönderileri beğenmekten vazgeç?") yukarı doğru, hem başlığı hem
  // "İptal" metnini içeren en yakın ortak atayı bulur.
  function findConfirmDialog() {
    const byRole = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (byRole && byRole.textContent.includes(CONFIRM_HEADING)) return byRole;

    const heading = findByExactText(CONFIRM_HEADING);
    if (!heading) return null;
    let node = heading;
    for (let i = 0; i < 8 && node && node.parentElement; i++) {
      node = node.parentElement;
      const text = node.textContent;
      if (text.includes(CONFIRM_HEADING) && text.includes('İptal')) {
        return node;
      }
    }
    return null;
  }

  // Alt çubuktaki "Beğenmekten Vazgeç"'e basar, açılan onay penceresindeki
  // "Beğenmekten Vazgeç"'e de basarak seçili tüm öğeleri gerçekten kaldırır.
  // Doğru pencere/buton bulunamazsa YANLIŞ bir şeye tıklamak yerine
  // açıkça false döner (mainLoop bunu görünce durur).
  async function confirmRemoval() {
    const barBtn = findByExactText('Beğenmekten Vazgeç');
    if (!barBtn) {
      console.warn('[IG Unliker] Alt çubuktaki "Beğenmekten Vazgeç" bulunamadı, kaldırma tetiklenemedi.');
      return false;
    }
    findClickableAncestor(barBtn).click();
    await delay(700, 1000);

    const dialog = findConfirmDialog();
    if (!dialog) {
      console.warn('[IG Unliker] Onay penceresi bulunamadı (başlık: "' + CONFIRM_HEADING + '"). Güvenlik için durduruluyor.');
      return false;
    }

    let confirmBtn = null;
    for (const el of dialog.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      if (el.textContent.trim() === 'Beğenmekten Vazgeç') {
        confirmBtn = el;
        break;
      }
    }

    if (!confirmBtn) {
      console.warn('[IG Unliker] Onay penceresi bulundu ama içindeki "Beğenmekten Vazgeç" butonu bulunamadı. Güvenlik için durduruluyor.');
      return false;
    }

    findClickableAncestor(confirmBtn).click();
    await delay(400, 700);

    // Doğrulama: pencere gerçekten kapandı mı? Kapanmadıysa bir kez daha dene.
    if (findConfirmDialog()) {
      console.warn('[IG Unliker] Onay penceresi hâlâ açık görünüyor, tekrar deneniyor...');
      const retryDialog = findConfirmDialog();
      let retryBtn = null;
      if (retryDialog) {
        for (const el of retryDialog.querySelectorAll('*')) {
          if (el.children.length > 0) continue;
          if (el.textContent.trim() === 'Beğenmekten Vazgeç') {
            retryBtn = el;
            break;
          }
        }
      }
      if (retryBtn) {
        findClickableAncestor(retryBtn).click();
        await delay(500, 800);
      }
      if (findConfirmDialog()) {
        console.error('[IG Unliker] Onay penceresi 2 denemeden sonra hâlâ açık. Durduruluyor — lütfen manuel kapat.');
        return false;
      }
    }

    console.log('[IG Unliker] ✅ Kaldırma onaylandı, Instagram listeyi yeniden yüklüyor, bekleniyor...');
    // Büyük bir toplu kaldırmadan sonra Instagram'ın listeyi yeniden
    // çekmesi/render etmesi uzun sürebiliyor (gözlemle 10sn+). "Seç"
    // linkinin geri gelmesi için cömert bir süre tanıyoruz.
    await delay(4000, 6000);
    selectedCounterEl = null; // "X seçildi" çubuğu kayboldu, referans geçersiz
    return true;
  }

  // --- ana işlem: görünen tile'ları seç --------------------------------
  // Instagram seçimi belirli bir sayıda (gözlemle ~100) durdurur; bu
  // sınıra ulaşılınca otomatik olarak kaldırma tetiklenir ki seçime
  // kaldığı yerden devam edilebilsin.

  async function selectBatch() {
    const inSelectMode = await ensureSelectMode();
    if (!inSelectMode) return { selected: 0, blocked: true, capReached: false };

    const tiles = findTiles().filter((t) => t.dataset.igHandled !== '1');
    if (tiles.length === 0) return { selected: 0, blocked: false, capReached: false };

    let selected = 0;
    let capReached = false;

    for (const tile of tiles) {
      if (!running) break;

      const before = getSelectedCount();
      tile.click();
      await delay(60, 150); // hızlandırılmış seçim gecikmesi
      const after = getSelectedCount();

      if (after > before) {
        tile.dataset.igHandled = '1';
        selected++;
        selectedCount++;
      } else {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          // Beklenmedik bir pencere açılmış (örn. kaldırma onayı DEĞİL,
          // başka bir uyarı) — kapat ve bu tile'ı bir daha deneme.
          console.warn('[IG Unliker] Tile tıklaması bir pencere açtı, kapatılıyor (Escape).');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          await delay(300, 500);
          tile.dataset.igHandled = '1';
        } else {
          // Pencere yok ama sayaç da artmadı → seçim üst sınırına
          // ulaşılmış olabilir. Bu tile'ı İŞARETLEME (handled koyma),
          // kaldırma sonrası tekrar denenecek.
          console.log(`[IG Unliker] Seçim üst sınırına ulaşılmış olabilir (şu an: ${after}). Otomatik kaldırma tetiklenecek.`);
          capReached = true;
          break;
        }
      }
    }

    if (selected > 0) {
      console.log(`[IG Unliker] Bu pass'te seçilen: ${selected}. Toplam (kümülatif) seçilen: ${selectedCount}`);
      await saveProgress('running');
    }

    return { selected, blocked: false, capReached };
  }

  // --- ana döngü ---------------------------------------------------------

  // Art arda kaç başarısız (kurtarılamayan) denemeden sonra script
  // gerçekten pes edip dursun. Bundan önce kendi kendine toparlanmayı
  // dener — kullanıcının popup'ı tekrar açıp "Başlat"a basmasına gerek
  // kalmasın diye.
  // Kademeli bekleme ile birlikte (tryRecover) bu, pes etmeden önce
  // toplamda ~2 dakikaya yakın bir toparlanma payı anlamına gelir —
  // büyük bir toplu kaldırmadan sonra Instagram'ın listeyi yeniden
  // yüklemesi için yeterli olmalı.
  const MAX_CONSECUTIVE_ERRORS = 8;

  // Herhangi bir açık pencere/overlay'i kapatmayı dener (kurtarma adımı).
  // attempt: kaçıncı deneme olduğumuzu belirtir, bekleme süresini buna
  // göre kademeli olarak artırır (büyük bir toplu kaldırmadan sonra
  // Instagram'ın listeyi yeniden yüklemesi uzun sürebiliyor).
  async function tryRecover(attempt) {
    // Escape'i SADECE gerçekten açık bir pencere/overlay varsa gönder;
    // yoksa sayfanın başka bir yerini (ör. tüm "Hareketlerin" panelini)
    // yanlışlıkla kapatma riskini almayalım.
    const hasDialog = document.querySelector('[role="dialog"], [role="alertdialog"]') || findConfirmDialog();
    if (hasDialog) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
    // Kademeli bekleme: 1. denemede ~3sn, sonrakilerde giderek artar.
    const base = 3000 + (attempt - 1) * 2500;
    await delay(base, base + 1500);
  }

  // --- sekmeyi arka planda "aktif" tutma ---------------------------------
  // Chrome, arka plandaki (odakta olmayan) sekmeleri bir süre sonra
  // dondurabilir/yavaşlatabilir — bu da scriptin durmuş gibi görünmesine
  // yol açar. Ses çalan sekmeler bu dondurmadan genelde muaf tutulur;
  // bu yüzden duyulmayacak kadar kısık, döngüde çalan sessiz bir ses
  // başlatıyoruz. Bu SADECE sekmeyi "meşgul" göstermek için, kullanıcıya
  // hiçbir şey duyurmaz.
  let keepAwakeStarted = false;
  function startKeepAwakeAudio() {
    if (keepAwakeStarted) return;
    try {
      let audio = document.getElementById('ig-unliker-keepawake');
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'ig-unliker-keepawake';
        audio.loop = true;
        audio.volume = 0.15; // çok kısık ama GERÇEK (sıfır olmayan) sinyal — macOS App Nap gibi işletim sistemi seviyesindeki yavaşlatmaları da atlatmak için şart
        audio.src = 'data:audio/wav;base64,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';
        audio.style.display = 'none';
        (document.body || document.documentElement).appendChild(audio);
      }
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          console.warn('[IG Unliker] Arka plan-aktif-kalma sesi başlatılamadı (tarayıcı otomatik oynatmayı engellemiş olabilir). Sekme uzun süre arka planda kalırsa yavaşlayabilir. Hata:', err);
        });
      }
      keepAwakeStarted = true;
    } catch (e) {
      console.warn('[IG Unliker] Arka plan-aktif-kalma sesi kurulamadı:', e);
    }
  }

  async function mainLoop() {
    startKeepAwakeAudio();
    let noProgressStrikes = 0;
    let consecutiveErrors = 0;

    while (running) {
      const { selected, blocked, capReached } = await selectBatch();
      if (!running) break;

      if (blocked) {
        consecutiveErrors++;
        console.warn(`[IG Unliker] Seçim moduna girilemedi (deneme ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}). Kendi kendine tekrar denenecek.`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          running = false;
          await saveProgress('error');
          await chrome.storage.local.set({ running: false });
          console.error('[IG Unliker] Çok sayıda başarısız denemeden sonra durduruldu. Sayfayı kontrol et.');
          break;
        }
        await tryRecover(consecutiveErrors);
        continue;
      }

      if (capReached) {
        const ok = await confirmRemoval();
        if (!ok) {
          consecutiveErrors++;
          console.warn(`[IG Unliker] Otomatik kaldırma başarısız oldu (deneme ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}). Kurtarma deneniyor, kendi kendine tekrar denenecek...`);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            running = false;
            await saveProgress('error');
            await chrome.storage.local.set({ running: false });
            console.error('[IG Unliker] Çok sayıda başarısız kaldırma denemesinden sonra durduruldu. Sayfayı kontrol et.');
            break;
          }
          await tryRecover(consecutiveErrors);
          continue;
        }
        consecutiveErrors = 0; // başarılı oldu, hata sayacı sıfırlansın
        await saveProgress('running');
        noProgressStrikes = 0;
        await delay(500, 800);
        continue;
      }

      consecutiveErrors = 0; // bu pass normal geçti

      if (selected > 0) {
        noProgressStrikes = 0;
        await delay(150, 300);
        continue;
      }

      const grew = await scrollForMore();
      noProgressStrikes = grew ? 0 : noProgressStrikes + 1;

      if (noProgressStrikes >= MAX_NO_PROGRESS) {
        await delay(1500, 2000);
        const stillTiles = findTiles().filter((t) => t.dataset.igHandled !== '1');
        console.log(`[IG Unliker] "Bitti" kontrolü: bulunan işlenmemiş tile = ${stillTiles.length}, toplam img = ${document.querySelectorAll('img').length}, scrollContainer scrollHeight = ${getScrollContainer().scrollHeight}`);
        if (stillTiles.length === 0) {
          // Yeni öğe yok ama henüz kaldırılmamış seçili öğe kalmış olabilir — temizle.
          const remaining = getSelectedCount();
          if (remaining > 0) {
            console.log(`[IG Unliker] Son ${remaining} seçili öğe için kaldırma tetikleniyor...`);
            const ok = await confirmRemoval();
            if (!ok) {
              console.warn('[IG Unliker] Son kaldırma başarısız oldu, biraz sonra tekrar denenecek.');
              await tryRecover(consecutiveErrors);
              noProgressStrikes = 0;
              continue;
            }
            await delay(800, 1200);
          }
          running = false;
          await saveProgress('done');
          await chrome.storage.local.set({ running: false });
          console.log('[IG Unliker] 🎉 Tamamlandı! Toplam kaldırılan beğeni:', selectedCount);
          break;
        }
        noProgressStrikes = 0;
      }
    }
  }

  // --- başlatma / durum senkronizasyonu ----------------------------------

  chrome.storage.local.get(['running', 'selectedCount'], (data) => {
    selectedCount = data.selectedCount || 0;
    if (data.running) {
      running = true;
      mainLoop();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.running) {
      const newVal = changes.running.newValue;
      if (newVal && !running) {
        running = true;
        mainLoop();
      } else if (!newVal) {
        running = false;
      }
    }
  });
})();
