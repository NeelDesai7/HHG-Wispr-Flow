// High-accuracy capture: record a clip from the mic and turn it into a 16 kHz mono WAV (what
// Gemma's audio model wants), base64-encoded. The audio never leaves this function except as the
// WAV the caller sends to the local server for on-device transcription.

export function recordingSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start();
  return { rec, stream, chunks };
}

// Stops recording and returns { wavBase64, seconds }.
export function stopRecording(h) {
  return new Promise((resolve, reject) => {
    h.rec.onstop = async () => {
      try {
        h.stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(h.chunks, { type: h.rec.mimeType || 'audio/webm' });
        const out = await toWav16k(await blob.arrayBuffer());
        resolve(out);
      } catch (err) { reject(err); }
    };
    try { h.rec.stop(); } catch (err) { reject(err); }
  });
}

export function cancelRecording(h) {
  try { h.rec.stop(); } catch { /* */ }
  h.stream.getTracks().forEach((t) => t.stop());
}

async function toWav16k(arrayBuffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const decoded = await ac.decodeAudioData(arrayBuffer.slice(0));
  ac.close();
  const seconds = decoded.duration;
  const length = Math.max(1, Math.ceil(seconds * 16000));
  const off = new OfflineAudioContext(1, length, 16000); // 1 channel, 16 kHz → downmix + resample
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return { wavBase64: encodeWavBase64(rendered.getChannelData(0), 16000), seconds };
}

function encodeWavBase64(samples, rate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
