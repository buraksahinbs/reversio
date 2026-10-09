# reversio

**Belgelenmemiş web API'lerini, yakalanan trafikten OpenAPI spec'ine ve tipli SDK'ya dönüştürür.**

Bir web uygulamasını tarayıcıda kullanırsınız, trafiği HAR olarak kaydedersiniz.
reversio bu kayıttaki API çağrılarını ayıklar, yolları şablonlara dönüştürür
(`/users/42` → `/users/{userId}`), örneklerden JSON şemalarını çıkarır ve
geçerli bir **OpenAPI 3.1** belgesi üretir.

> Durum: erken geliştirme (v0.1). Şu an HAR → OpenAPI çalışıyor. Yol haritası aşağıda.

## Kurulum

```bash
npm install
npm run build
```

## Kullanım

1. Tarayıcıda DevTools → **Network** sekmesini açın, uygulamayı kullanın.
2. İstek listesine sağ tıklayın → **Save all as HAR with content**.
3. Çalıştırın:

```bash
node dist/cli.js openapi capture.har -o api.yaml
node dist/cli.js openapi a.har b.har --host api.example.com --yaml
```

| Seçenek | Açıklama |
| --- | --- |
| `-o, --output <dosya>` | Dosyaya yaz (`.yaml`/`.yml` → YAML, aksi halde JSON). Varsayılan: stdout'a JSON |
| `--yaml` | stdout'a YAML yaz |
| `--host <host>` | Yalnızca bu host'u dahil et (tekrarlanabilir) |
| `--title <başlık>` | Spec başlığı |
| `--examples` | Gözlenen örnek değerleri ekle (varsayılan kapalı) |

## Ne çıkarır?

- **API çağrısı ayıklama:** HTML, JS, CSS, görsel, font ve CORS preflight istekleri elenir.
- **Yol şablonları:** sayı, UUID, hex ve token segmentleri parametre olur. Aynı konumda
  3 veya daha fazla farklı değer görülen yollar da birleştirilir (`/repos/{repoId}/issues`).
  Farklı kaynaklar (`/api/users`, `/api/orders`) ayrı tutulur.
- **Şema çıkarımı:** tüm örnekler birleştirilir. Her örnekte bulunan alanlar `required`
  olur, `null` görülen alanlar nullable olur. `date-time`, `uuid`, `email` ve `uri`
  formatları tanınır. Kod benzeri tekrar eden değerler (`active`, `IN_PROGRESS`) `enum`
  olur. Kimlik anahtarlı nesneler map olarak (`additionalProperties`) temsil edilir.
- **Parametreler:** query ve path parametrelerinin tipi ve zorunluluğu çıkarılır.
- **Kimlik doğrulama:** Bearer/Basic, API key başlıkları ve oturum çerezleri
  `securitySchemes` olarak tespit edilir.
- **Birden fazla origin:** en yoğun origin ana sunucu olur, diğerleri path düzeyinde belirtilir.

## Gizlilik

HAR dosyaları token, çerez ve kişisel veri içerir. reversio varsayılan olarak
**hiçbir gözlenen değeri spec'e yazmaz**: kimlik bilgileri hiçbir zaman yazılmaz,
örnek değerler yalnızca `--examples` ile eklenir. Enum'lar yalnızca kod benzeri
değerlerden oluşturulur, böylece isim ve başlık gibi serbest metinler sızmaz.
Yine de üretilen spec'i paylaşmadan önce gözden geçirin.

Bu aracı yalnızca erişim yetkiniz olan sistemlerde, kendi hesabınızla ve ilgili
hizmet koşullarına uygun şekilde kullanın.

## Yol haritası

- [x] HAR → OpenAPI 3.1 (yol şablonları, şema çıkarımı, auth tespiti)
- [ ] mitmproxy akışlarını içe aktarma
- [ ] OpenAPI → tipli TypeScript ve Python SDK
- [ ] Kaydedilen trafiği tekrar oynatarak SDK doğrulama
- [ ] JS bundle'ında auth ve imzalama mantığını bulma (source map + AST)
- [ ] Playwright ile otomatik keşif, `reversio <url>` tek komutu
- [ ] MCP sunucusu (ajanlar için 4–5 araç)
- [ ] İki yakalama arasında API farkını raporlama

## Geliştirme

```bash
npm test          # vitest
npm run typecheck
npm run build
```

## Lisans

MIT
