const textToSpeech = require('@google-cloud/text-to-speech');
async function test() {
  try {
    const client = new textToSpeech.TextToSpeechClient();
    const request = {
      input: {text: 'hello world'},
      voice: {languageCode: 'en-US', name: 'en-US-Journey-F'},
      audioConfig: {audioEncoding: 'MP3'},
    };
    const [response] = await client.synthesizeSpeech(request);
    console.log("Audio content length:", response.audioContent.length);
  } catch(e) {
    console.error(e);
  }
}
test();