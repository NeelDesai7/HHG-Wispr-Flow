// Drives the always-on microphone from the desktop app's hidden window. It captures clips of
// speech and posts each to the local server, which transcribes it on-device and turns it into
// tasks. Nothing here touches the network beyond this laptop's own loopback server.

import { createCapture, captureSupported } from './capture.js';

let paused = false;

async function post(path, body) {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const cap = createCapture({
  async onChunk({ wavBase64, seconds }) {
    if (paused) return;
    try {
      await post('/api/capture', { audio: wavBase64, seconds, saidAt: new Date().toISOString() });
    } catch { /* a dropped clip is fine; the next one will come */ }
  },
  onError(err) {
    // Most likely the OS microphone permission. Tell the server so the UI can surface it.
    post('/api/listen/error', { error: err?.name || String(err) }).catch(() => {});
  },
});

function setPaused(p) {
  paused = p;
  if (p) cap.stop();
  else if (captureSupported()) cap.start();
}

// Follow the Pause/Resume button in the main window.
try {
  const es = new EventSource('/api/events');
  es.addEventListener('listen', (e) => { try { setPaused(!!JSON.parse(e.data).paused); } catch { /* */ } });
} catch { /* */ }

// Start listening immediately, unless the user had it paused.
fetch('/api/health').then((r) => r.json()).then((h) => setPaused(!!h.capture?.paused)).catch(() => setPaused(false));
