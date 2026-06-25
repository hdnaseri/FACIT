# FACIT Edge TTS Proxy

سرویس سبک برای گرفتن صدای `Edge TTS` و برگرداندن مستقیم فایل صوتی بدون ذخیره‌سازی.

## چرا لازم است

استفاده مستقیم از `Edge TTS` در مرورگر برای همه مرورگرها قابل اتکا نیست. برای اینکه روی iPhone Web App و مرورگرهای مختلف کار کند، اپ باید صدا را از یک بک‌اند سبک بگیرد.

## اجرا محلی

```bash
cd tts-proxy
npm install
npm start
```

سرویس به‌صورت پیش‌فرض روی `http://localhost:8080` بالا می‌آید.

## مسیرها

- `GET /health`
- `POST /generatePronunciationAudio`

نمونه بدنه درخواست:

```json
{
  "term": "hello",
  "languageCode": "en-US"
}
```

## اتصال اپ

بعد از deploy این سرویس روی هاستی مثل `Render` یا `Railway`، در مرورگر این مقدار را ست کن:

```js
localStorage.setItem('facit_tts_proxy_url', 'https://YOUR-TTS-HOST');
```

یا قبل از لود شدن اپ این متغیر را تعریف کن:

```html
<script>
  window.FACIT_TTS_PROXY_URL = 'https://YOUR-TTS-HOST';
</script>
```

اپ به‌طور خودکار مسیر `generatePronunciationAudio` را به این آدرس اضافه می‌کند.
