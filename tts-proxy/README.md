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
- پاسخ این مسیر متن ساده `OK` است.
- `GET /`
- `POST /generatePronunciationAudio`

نمونه بدنه درخواست:

```json
{
  "term": "hello",
  "languageCode": "en-US"
}
```

## اتصال اپ

در نسخه فعلی اپ، مسیر تلفظ به‌صورت مستقیم به endpoint دیپلوی‌شده‌ی Render وصل می‌شود و دیگر از Firebase یا مسیرهای جایگزین برای TTS استفاده نمی‌کند.

اگر بعداً هاست TTS عوض شد، باید ثابت endpoint را در [index.html](file:///f:/FACIT/public/index.html) به‌روزرسانی کنی.
