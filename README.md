# reversio

**Belgelenmemiş web API'lerini, yakalanan trafikten OpenAPI spec'ine ve doğrulanmış, tipli bir SDK'ya dönüştürür.**

Bir web uygulamasını tarayıcıda kullanırsınız, trafiği HAR olarak kaydedersiniz.
reversio bu kayıttaki API çağrılarını ayıklar, yolları şablonlara dönüştürür
(`/users/42` → `/users/{userId}`), örneklerden JSON şemalarını çıkarır ve şunları üretir:

1. geçerli bir **OpenAPI 3.1** belgesi,
2. bağımlılıksız, tek dosyalık bir **TypeScript SDK**,
3. bir **doğrulama raporu**: kaydedilen her çağrı SDK üzerinden yeniden oynatılır ve
   SDK'nın aynı isteği gönderip aynı yanıtı döndürdüğü kanıtlanır.

> Durum: erken geliştirme (v0.2). Yol haritası aşağıda.

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
node dist/cli.js generate capture.har -o out/
```

Örnek çıktı (`tests/fixtures/demo.har` için):

```
7 requests → 6 API calls → 3 operations
  ok   GET /repos/octo/x/issues/{issueId}  2/2
  ok   PATCH /repos/octo/x/issues/{issueId}  1/1
  ok   GET /users/{userId}/repos  3/3
Replay: 6/6 recorded calls reproduced by the SDK
Wrote out/openapi.yaml, client.ts, verify-report.json
```

```ts
import { ApiClient } from "./out/client.ts";

const api = new ApiClient({ auth: { bearerAuth: process.env.TOKEN } });
const repos = await api.getUsersRepos({ userId: "octo", query: { per_page: 30 } }); // tam tipli
```

### Komutlar

| Komut | Ne yapar |
| --- | --- |
| `generate <har>... -o <dizin>` | Spec, SDK ve doğrulama raporunu tek adımda üretir |
| `openapi <har>... [-o dosya]` | Yalnızca OpenAPI spec'i üretir |
| `sdk <spec> -o client.ts` | Herhangi bir OpenAPI 3 spec'inden TypeScript SDK üretir |
| `verify <spec> <har>...` | Spec'i ve SDK'yı yeni bir yakalamaya karşı doğrular |

**API değişikliklerini yakalamak (drift):** Spec'i bir kez üretin, sonra yeni kayıtları
`verify` ile kontrol edin. Yeni endpoint'ler, parametreler, alan tipi değişiklikleri ve
yeni durum kodları raporlanır. Çıkış kodu 1 olur; `--strict` ile kapsanmayan çağrılar da
hata sayılır.

```
  FAIL GET /users/{userId}/repos  2/3
         - query differs (not sent: sort)
  Not covered by the spec (1 calls):
         GET https://api.demo.dev/user/emails
```

| Seçenek | Açıklama |
| --- | --- |
| `-o, --output <dosya>` | Dosyaya yaz (`.yaml`/`.yml` → YAML, aksi halde JSON). Varsayılan: stdout'a JSON |
| `--yaml` | stdout'a YAML yaz |
| `--host <host>` | Yalnızca bu host'u dahil et (tekrarlanabilir) |
| `--title <başlık>` | Spec başlığı |
| `--examples` | Gözlenen örnek değerleri ekle (varsayılan kapalı) |
| `--class <ad>` | Üretilen istemci sınıfının adı (varsayılan `ApiClient`) |
| `--yaml` | `openapi`: stdout'a YAML yaz |
| `--json` | `verify`: raporu JSON olarak yaz |
| `--strict` | `verify`: spec'in kapsamadığı çağrılarda da başarısız ol |

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

## SDK

- Tek dosya ve sıfır bağımlılık: yalnızca standart `fetch` kullanır. Node 18+, Deno, Bun ve
  tarayıcılarda çalışır.
- Her operasyon için tipli argümanlar (`path` parametreleri, `query`, `body`) ve yanıt tipleri üretir.
- Auth için `auth: { bearerAuth: "..." }` verilir; Basic, API key başlığı ve çerez de desteklenir.
- 2xx dışı yanıtlarda, ayrıştırılmış gövdeyle birlikte `ApiError` fırlatır.
- `fetch` enjekte edilebilir (proxy, retry, test), `servers` ile ikincil sunucular yönlendirilebilir.
- Yalnızca silinebilir TypeScript sözdizimi kullanır, bu yüzden tip temizleme ve her bundler ile uyumludur.

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
- [x] OpenAPI → tipli TypeScript SDK
- [x] Kaydedilen trafiği tekrar oynatarak SDK doğrulama ve drift raporu
- [ ] Python SDK
- [ ] mitmproxy akışlarını içe aktarma
- [ ] Playwright ile otomatik keşif, `reversio <url>` tek komutu
- [ ] MCP sunucusu (ajanlar için 4–5 araç)

## Geliştirme

```bash
npm test          # vitest (üretilen SDK katı TypeScript ayarlarıyla derlenerek test edilir)
npm run typecheck
npm run build
```

## Lisans

MIT
