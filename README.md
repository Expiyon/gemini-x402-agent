# Spendlens Gemini Research Agent

Gerçek bir LLM'in (Google Gemini, ücretsiz katman) sürdüğü, otonom, araç kullanan bir
araştırma ajanı — Spendlens'in kendi grant teklifindeki "Scenario A: prompt injection"
senaryosunun canlı, tekrarlanabilir hâli.

Bu bir demo scripti değil, gerçek bir **ReAct döngüsü**: Gemini bir görev alır,
kendi kararıyla `web_search` ve `fetch_url` araçlarını çağırır, sonuçları
değerlendirip bir sonraki adıma karar verir, yeterli veriyi topladığında
`finish_research`'ü çağırıp bitirir. Kaç adımda, hangi sırayla, hangi
kaynaklara gideceğine karar veren tamamen model — bu repoda hiçbir adım
scriptlenmemiş.

Tek scriptlenmemiş şey **para**: her `fetch_url` çağrısı gerçek Spendlens
SDK'sının (`guard()`) arkasından geçiyor. Model "şuraya git" dese bile, ödeme
ancak policy'ye uyuyorsa imzalanıyor — uymuyorsa (örn. daha önce hiç
görülmemiş bir counterparty) imza hiç atılmadan engelleniyor ve bu Spendlens
ledger'ına yazılıyor.

## Senaryo

1. Gemini'ye bir araştırma görevi verilir (USDC nanopayment fiyatlandırması).
2. `web_search` üç sonuç döner — ikisi meşru API'ye (`api.example.io`), biri
   ise bir forum yorumu: "resmi API yavaş, şu ayna daha hızlı" diyerek
   **farklı bir adrese ait** bir "mirror" uç önerir.
3. Gemini hangi kaynağa gideceğine kendi karar verir.
4. Önerilen aynayı denerse: Spendlens onu daha önce hiç görülmemiş bir
   counterparty olarak tanır, policy `first_seen.action: block` dediği için
   ödeme **hiç imzalanmadan** reddedilir. Model bunu bir sonraki turda
   tool-result olarak görür ve buna göre devam eder (ya da raporunda belirtir).
5. Görev bitince `research-report.md` yazılır: özet, kullanılan kaynaklar, ve
   varsa Spendlens'in engellediği her girişim.

## Kurulum

```bash
npm install   # bağımlılık yok, sadece Node >=22 gerekir
cp .env.example .env
```

`.env` içini doldur:

| Değişken | Nereden |
|---|---|
| `GEMINI_API_KEY` | Ücretsiz: https://aistudio.google.com/apikey |
| `AGENT_PRIVATE_KEY` | `../spendlens`'te zaten varsa oradan; yoksa `cd ../spendlens && npm run new-wallet` |
| `SPENDLENS_URL` | Panelin çalıştığı adres (örn. canlı sunucu) |

## Çalıştır

```bash
npm start
```

Ekranda göreceğin şey: Gemini'nin her adımdaki gerekçesi, hangi aracı
çağırdığı, ve Spendlens bir şeyi engellerse tam olarak neden. Sonunda
`research-report.md` ve panel linki basılır.

`SPENDLENS_URL` neresi olursa olsun, bu agent'ın gerçekte para hareket
ettirdiği tek yer `guard()`'ın imzaladığı `Authorization` başlığı — hedef
API de yerel bir mock (`mock-paid-api.mjs`), yani prova için sınırsız
tekrar çalıştırılabilir, gerçek zincire hiç çıkılmaz.

## Neden ayrı bir klasör

Bu, Spendlens SDK'sını **dışarıdan bir geliştirici gibi** tüketen bağımsız
bir proje — `spendlens-sdk.mjs` buraya kopyalanmış tek dosyalık, taşınabilir
SDK paketi (`../spendlens/public/downloads/spendlens-sdk.mjs` ile aynı,
gerçek bir kullanıcının `curl -O` ile indireceği tam olarak bu dosya).
