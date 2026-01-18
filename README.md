# LedgerZero Personal Accounting (Offline PWA)

Bu proje: **kişisel muhasebe + yatırım takibi + trade journal** için offline çalışan bir PWA'dır.
Chrome (Android) üzerinde **Install/Uygulamayı Yükle** çıkar.

## Kurulum (lokalde)
1) Bu klasörü bir web sunucuda çalıştır.
   - Örn: VS Code Live Server
   - veya: `python -m http.server 8080`
2) Tarayıcıdan aç:
   - http://localhost:8080

## Telefon (Install)
- Android Chrome: siteyi aç -> menü (⋮) -> Install app / Add to Home Screen
- iOS: Safari -> Share -> Add to Home Screen

## Deploy (Ücretsiz)
- Netlify / Vercel / GitHub Pages ile deploy edebilirsin.
- Önemli: **HTTPS şart** (Install için).

## Veri
- IndexedDB kullanır.
- Settings bölümünden JSON Export/Import ile yedek al.

Not: Canlı fiyat API yok; yatırımların güncel değeri manuel girilir.
