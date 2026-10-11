// Always-on microphone capture for the desktop app.
//
// This runs in a hidden window so Vachan hears you without any tab open or button pressed. It
// listens continuously but only emits a clip when you actually speak: a voice-activity detector
// waits for a sentence and the pause after it, then hands that clip (16 kHz mono WAV, what the
// on-device transcriber wants) to the caller. Silence produces nothing. The audio stays in this
// process and is dropped the moment the clip is built — only the WAV the caller sends onward exists.

export function captureSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));
}

const RATE = 16000;
const FRAME = 2048;                 // ~128 ms per processing frame at 16 kHz
const FRAME_MS = (FRAME / RATE) * 1000;
const SILENCE_MS = 700;             // this much quiet after speech ends a clip
const PREROLL_MS = 300;             // keep a little audio before speech starts so onsets aren't clipped
const MIN_SPEECH_MS = 350;          // ignore blips shorter than this (coughs, clicks)
const MAX_CLIP_SEC = 12;            // flush a long monologue in pieces so it still gets transcribed

export function createCapture({ onChunk, onLevel, onError }) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ac = null, stream = null, src = null, node = null;
  let running = false;

  // VAD state
  let noiseFloor = 0.01;            // slowly learns the room's quiet level
  let voiced = [];                  // frames of the current utterance
  let voicedMs = 0;
  let silenceMs = 0;
  let speaking = false;
  const preroll = [];               // ring of recent frames while quiet
  const prerollMax = Math.ceil(PREROLL_MS / FRAME_MS);

  function reset() { voiced = []; voicedMs = 0; silenceMs = 0; speaking = false; }

  function flush() {
    if (voicedMs >= MIN_SPEECH_MS && voiced.length) {
      const pcm = concat(voiced);
      try { onChunk?.({ wavBase64: encodeWavBase64(pcm, RATE), seconds: pcm.length / RATE }); } catch (e) { onError?.(e); }
    }
    reset();
  }

  function onFrame(input) {
    // RMS loudness of this frame.
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    onLevel?.(rms);

    const speakThresh = Math.max(0.018, noiseFloor * 3.0);
    const frame = input.slice(0); // copy — the underlying buffer is reused by the audio thread

    if (rms > speakThresh) {
      if (!speaking) { speaking = true; voiced.push(...preroll.splice(0)); } // prepend the pre-roll
      voiced.push(frame);
      voicedMs += FRAME_MS;
      silenceMs = 0;
      if (voicedMs >= MAX_CLIP_SEC * 1000) flush();
    } else {
      // learn the quiet level while not speaking
      noiseFloor = 0.97 * noiseFloor + 0.03 * rms;
      if (speaking) {
        voiced.push(frame); // keep the trailing quiet so words aren't cut short
        silenceMs += FRAME_MS;
        if (silenceMs >= SILENCE_MS) flush();
      } else {
        preroll.push(frame);
        while (preroll.length > prerollMax) preroll.shift();
      }
    }
  }

  async function start() {
    if (running) return;
    running = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ac = new AC({ sampleRate: RATE });
      if (ac.state === 'suspended') await ac.resume();
      src = ac.createMediaStreamSource(stream);
      node = ac.createScriptProcessor(FRAME, 1, 1);
      node.onaudioprocess = (e) => { if (running) onFrame(e.inputBuffer.getChannelData(0)); };
      src.connect(node);
      node.connect(ac.destination); // required for the processor to run; mic isn't played back
    } catch (err) {
      running = false;
      onError?.(err);
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    reset();
    preroll.length = 0;
    try { node?.disconnect(); src?.disconnect(); } catch { /* */ }
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { ac?.close(); } catch { /* */ }
    node = src = stream = ac = null;
  }

  return { start, stop, get active() { return running; } };
}

function concat(frames) {
  let n = 0;
  for (const f of frames) n += f.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}

// Float32 PCM → base64 16-bit mono WAV.
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
