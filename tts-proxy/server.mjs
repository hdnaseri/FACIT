import http from "node:http";
import { EdgeTTS } from "edge-tts-universal";

const PORT = Number(process.env.PORT || 8080);
const EDGE_TTS_OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3";

const HIGH_QUALITY_TTS_VOICES = {
  "da-DK": {
    languageCode: "da-DK",
    name: "da-DK-ChristelNeural",
  },
  "en-US": {
    languageCode: "en-US",
    name: "en-US-EmmaMultilingualNeural",
  },
  "en-GB": {
    languageCode: "en-GB",
    name: "en-GB-SoniaNeural",
  },
};

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-TTS-Provider, X-TTS-Voice, X-TTS-Language",
  );
}

function sendJson(res, statusCode, payload) {
  applyCors(res);
  res.writeHead(statusCode, {"Content-Type": "application/json; charset=utf-8"});
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, body) {
  applyCors(res);
  res.writeHead(statusCode, {"Content-Type": "text/plain; charset=utf-8"});
  res.end(body);
}

function normalizeHighQualityVoice(languageCode) {
  const normalized = String(languageCode || "").trim();
  if (HIGH_QUALITY_TTS_VOICES[normalized]) {
    return HIGH_QUALITY_TTS_VOICES[normalized];
  }
  if (normalized.startsWith("da")) return HIGH_QUALITY_TTS_VOICES["da-DK"];
  if (normalized.startsWith("en-GB")) return HIGH_QUALITY_TTS_VOICES["en-GB"];
  return HIGH_QUALITY_TTS_VOICES["en-US"];
}

function cleanSpeakText(text, languageCode) {
  let out = String(text || "").trim().replace(/\s+/g, " ");
  if (!out) return "";

  if (languageCode === "da-DK" || languageCode.startsWith("da")) {
    out = out.replace(/^(at|en|et)\s+/i, "").trim();
  } else if (
    languageCode === "en-US" ||
    languageCode === "en-GB" ||
    languageCode.startsWith("en")
  ) {
    out = out.replace(/^(to|a|an|the)\s+/i, "").trim();
  }

  return out;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error("INVALID_JSON");
  }
}

async function handleGeneratePronunciationAudio(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, {error: true, message: "Invalid JSON body"});
    return;
  }

  const rawTerm = String(body.term || "").trim();
  const voiceConfig = normalizeHighQualityVoice(body.languageCode);
  const speakText = cleanSpeakText(rawTerm, voiceConfig.languageCode);

  if (!speakText) {
    sendJson(res, 400, {error: true, message: "Invalid term"});
    return;
  }

  if (speakText.length > 80) {
    sendJson(res, 400, {
      error: true,
      message: "Term is too long for pronunciation audio",
    });
    return;
  }

  try {
    const tts = new EdgeTTS(speakText, voiceConfig.name, {
      rate: "-8%",
      pitch: "+0Hz",
      volume: "+0%",
      outputFormat: EDGE_TTS_OUTPUT_FORMAT,
    });
    const ttsResponse = await tts.synthesize();
    const audioContent = ttsResponse && ttsResponse.audio;
    if (!audioContent || typeof audioContent.arrayBuffer !== "function") {
      throw new Error("TTS_EMPTY_AUDIO");
    }

    const audioBuffer = Buffer.from(await audioContent.arrayBuffer());
    applyCors(res);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-TTS-Provider": "edge-tts",
      "X-TTS-Voice": voiceConfig.name,
      "X-TTS-Language": voiceConfig.languageCode,
    });
    res.end(audioBuffer);
  } catch (error) {
    console.error("Edge TTS pronunciation generation failed:", error);
    sendJson(res, 500, {
      error: true,
      message: "Failed to generate pronunciation audio",
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    applyCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendText(res, 200, "OK");
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendJson(res, 200, {
      ok: true,
      service: "facit-edge-tts-proxy",
      routes: ["/health", "/generatePronunciationAudio"],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/generatePronunciationAudio") {
    await handleGeneratePronunciationAudio(req, res);
    return;
  }

  sendJson(res, 404, {error: true, message: "Not found"});
});

server.listen(PORT, () => {
  console.log(`FACIT Edge TTS proxy listening on port ${PORT}`);
});
