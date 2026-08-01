/* eslint-disable require-jsdoc */
// کد کامل و نهایی برای functions/index.js

const functions = require("firebase-functions");
const functionsV1 = require("firebase-functions/v1");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

admin.initializeApp({
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET ||
    `${process.env.GCLOUD_PROJECT}.appspot.com`,
});

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

const EDGE_TTS_OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3";
let edgeTtsModulePromise = null;

function getAllowedOrigin(req) {
  return req.headers.origin || "*";
}

function applyCors(res, req) {
  res.set("Access-Control-Allow-Origin", getAllowedOrigin(req));
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Expose-Headers",
      "X-TTS-Provider, X-TTS-Voice, X-TTS-Language");
}

async function verifyFirebaseUserFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("UNAUTHORIZED_NO_TOKEN");
  }

  const idToken = authHeader.split("Bearer ")[1];
  return admin.auth().verifyIdToken(idToken);
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
  } else if (languageCode === "en-US" || languageCode === "en-GB" ||
    languageCode.startsWith("en")) {
    out = out.replace(/^(to|a|an|the)\s+/i, "").trim();
  }

  return out;
}

async function getEdgeTtsModule() {
  if (!edgeTtsModulePromise) {
    edgeTtsModulePromise = import("edge-tts-universal");
  }
  return edgeTtsModulePromise;
}

// Helper function for retry logic with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      const errorMessage = (error && error.message) ? error.message : "";
      const isRetryable =
        errorMessage.includes("429") || // Rate limit
        errorMessage.includes("503") || // Service unavailable
        errorMessage.includes("504") || // Gateway timeout
        errorMessage.includes("500") || // Internal server error
        errorMessage.includes("ETIMEDOUT") || // Connection timeout
        errorMessage.includes("ECONNRESET"); // Connection reset

      if (!isRetryable || i === maxRetries - 1) {
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = initialDelay * Math.pow(2, i) + Math.random() * 1000;
      console.log(`Retry attempt ${i + 1}/${maxRetries} after ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

exports.callGeminiAPI = functions.https.onRequest(async (req, res) => {
  applyCors(res, req);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  let decodedToken;
  try {
    decodedToken = await verifyFirebaseUserFromRequest(req);
  } catch (error) {
    console.error("No Firebase ID token was passed.");
    res.status(401).send("Unauthorized: No token provided.");
    return;
  }

  console.log("Successfully authenticated user with UID:", decodedToken.uid);

  // --- START OF FINAL CHANGE ---
  // خواندن کلید از متغیرهای محیطی جدید به جای functions.config()
  const geminiApiKey = process.env.GEMINI_KEY;
  // --- END OF FINAL CHANGE ---

  if (!geminiApiKey) {
    res.status(500).send("Internal Server Error: Gemini key not configured.");
    return;
  }

  let requestBody = req.body;

  // Remove model from requestBody if it exists.
  // Gemini API doesn't accept this field.
  const userSpecifiedModel = requestBody.model;
  if (requestBody.model) {
    requestBody = {...requestBody};
    delete requestBody.model;
  }

  // Try multiple models in order (fallback chain)
  // Strongest to weakest
  // NOTE: gemini-2.0-flash, gemini-1.5-* were deprecated/shut down by Google
  // in June 2026. Updated July 2026 to use current generation models.
  // Only confirmed active models are listed here.
  const modelsToTry = userSpecifiedModel ?
    [userSpecifiedModel] : // If user specified a model, only try that
    [
      "gemini-3.6-flash", // Newest GA flash (primary)
      "gemini-3.5-flash", // Previous GA flash
      "gemini-2.5-flash", // Legacy fallback (retiring Oct 2026)
      "gemini-3.1-pro-preview", // Flagship Pro (last resort)
    ];

  let lastError = null;
  let successfulModel = null;

  // Try each model until one works
  for (const modelName of modelsToTry) {
    try {
      console.log(`Attempting to use model: ${modelName}`);
      const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

      // Call Gemini API with retry logic for this model
      const result = await retryWithBackoff(async () => {
        const geminiResponse = await fetch(GEMINI_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify(requestBody),
          timeout: 30000, // 30 second timeout
        });

        if (!geminiResponse.ok) {
          const errorBody = await geminiResponse.json().catch(() => ({}));
          const errorMessage = (errorBody && errorBody.error &&
            errorBody.error.message) || "Unknown error";
          const statusCode = geminiResponse.status;

          console.error(
              `Gemini API Error [${statusCode}] with model ${modelName}:`,
              errorMessage,
          );

          // Throw error to trigger retry or model fallback
          throw new Error(`${statusCode}: ${errorMessage}`);
        }

        return await geminiResponse.json();
      });

      // Success! Send response and exit
      successfulModel = modelName;
      console.log(`Successfully used model: ${successfulModel}`);
      // Add the model name to the response
      const responseWithModel = {
        ...result,
        usedModel: modelName,
      };
      res.status(200).send(responseWithModel);
      return;
    } catch (error) {
      console.error(`Model ${modelName} failed:`, error.message);
      lastError = error;
      // Continue to next model
    }
  }

  // If we get here, all models failed
  console.error("All models failed after retries");
  res.status(503).send({
    error: true,
    statusCode: 503,
    message: "Service temporarily unavailable. " +
      "All models failed. Please try again later.",
    retryable: true,
    details: {
      timestamp: new Date().toISOString(),
      originalError: lastError && lastError.message,
      triedModels: modelsToTry,
    },
  });
});

exports.generatePronunciationAudio = functionsV1
    .region("us-central1")
    .https.onRequest(
        async (req, res) => {
          applyCors(res, req);

          if (req.method === "OPTIONS") {
            res.status(204).send("");
            return;
          }

          if (req.method !== "POST") {
            res.status(405).json({error: true, message: "Method not allowed"});
            return;
          }

          const body = req && req.body ? req.body : {};
          const rawTerm = String(body.term || "").trim();
          const voiceConfig = normalizeHighQualityVoice(body.languageCode);
          const speakText = cleanSpeakText(rawTerm, voiceConfig.languageCode);

          if (!speakText) {
            res.status(400).json({
              error: true,
              message: "Invalid term",
            });
            return;
          }

          if (speakText.length > 80) {
            res.status(400).json({
              error: true,
              message: "Term is too long for pronunciation audio",
            });
            return;
          }

          try {
            const edgeTtsModule = await getEdgeTtsModule();
            const EdgeTTS = edgeTtsModule && edgeTtsModule.EdgeTTS;
            if (typeof EdgeTTS !== "function") {
              throw new Error("EDGE_TTS_MODULE_UNAVAILABLE");
            }

            const tts = new EdgeTTS(speakText, voiceConfig.name, {
              rate: "-8%",
              pitch: "+0Hz",
              volume: "+0%",
              outputFormat: EDGE_TTS_OUTPUT_FORMAT,
            });
            const ttsResponse = await tts.synthesize();
            const audioContent = ttsResponse && ttsResponse.audio;
            if (
              !audioContent ||
              typeof audioContent.arrayBuffer !== "function"
            ) {
              throw new Error("TTS_EMPTY_AUDIO");
            }

            const audioBuffer = Buffer.from(await audioContent.arrayBuffer());
            res.set("Content-Type", "audio/mpeg");
            res.set("Cache-Control", "private, max-age=3600");
            res.set("X-TTS-Provider", "edge-tts");
            res.set("X-TTS-Voice", voiceConfig.name);
            res.set("X-TTS-Language", voiceConfig.languageCode);
            res.status(200).send(audioBuffer);
          } catch (error) {
            console.error("Edge TTS pronunciation generation failed:", error);
            res.status(500).json({
              error: true,
              message: "Failed to generate pronunciation audio",
            });
          }
        },
    );
