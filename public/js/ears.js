// On-device speech recognition in Chrome. Audio stays inside the browser's local
// recogniser; only the recognised text ever reaches our code.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const LANGS = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'hi-IN', label: 'हिन्दी · Hindi' },
  // Chrome has no on-device Marathi pack, but Marathi and Hindi share Devanagari and Gemma reads
  // Marathi, so fall back to the Hindi recogniser and tag the words as Marathi.
  { code: 'mr-IN', label: 'मराठी · Marathi', fallback: 'hi-IN' },
  { code: 'en-US', label: 'English (US)' },
];
const fallbackOf = (lang) => LANGS.find((l) => l.code === lang)?.fallback ?? null;

// Errors that won't fix themselves by restarting.
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'network']);

// Contextual biasing: names Chrome's recogniser should favour. Newer Chrome only, so feature-detect.
const Phrase = window.SpeechRecognitionPhrase;
let phrasesWork = Boolean(SR && Phrase && 'phrases' in SR.prototype);
export const phrasesSupported = () => phrasesWork;

export function speechSupport() {
  if (!SR) return { ok: false, why: 'This browser has no speech recognition. Open Vachan in Google Chrome.' };
  if (typeof SR.available !== 'function' || !('processLocally' in SR.prototype)) {
    return { ok: false, why: 'This browser cannot promise on-device recognition. Update Chrome.' };
  }
  return { ok: true };
}

// 'available' | 'downloadable' | 'downloading' | 'unavailable'
export async function languageState(lang) {
  if (!speechSupport().ok) return 'unavailable';
  try {
    return await SR.available({ langs: [lang], processLocally: true });
  } catch {
    return 'unavailable';
  }
}

// How to actually listen in `lang`: use its own on-device pack, or a related one (Marathi via
// Hindi) when Chrome has none. Returns { usable, recognizerLang, via, state }.
export async function planFor(lang) {
  const s = await languageState(lang);
  if (s === 'available') return { usable: true, recognizerLang: lang, via: null, state: s };
  const fb = fallbackOf(lang);
  if (s === 'unavailable' && fb && (await languageState(fb)) === 'available') {
    return { usable: true, recognizerLang: fb, via: fb, state: 'fallback' };
  }
  return { usable: false, recognizerLang: lang, via: null, state: s };
}

// Downloads Chrome's on-device language pack. Must be called from a click.
export async function installLanguage(lang) {
  return SR.install({ langs: [lang], processLocally: true });
}

export function createEars({ onState, onInterim, onFinal, onError, getPhrases = () => [] }) {
  let rec = null;
  let wanted = false;
  let lang = LANGS[0].code; // the language we tag text with (what the user is speaking)
  let recLang = lang; // the on-device recogniser we actually run (may differ, e.g. Marathi via Hindi)
  let restarts = [];

  function begin() {
    const r = new SR();
    r.lang = recLang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 4; // keep the other guesses so Gemma can pick the right words
    // The privacy rule. With this set, Chrome errors instead of sending audio to Google.
    r.processLocally = true;
    if (r.processLocally !== true) throw new Error('Chrome ignored processLocally; refusing to listen.');
    const phrases = phrasesWork ? getPhrases() : [];
    if (phrases.length) {
      try {
        r.phrases = phrases.map((p) => new Phrase(p, 3.0));
      } catch {
        phrasesWork = false;
      }
    }

    r.onstart = () => onState('listening');
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          const guesses = [];
          for (let k = 0; k < res.length; k++) {
            const t = res[k].transcript.trim();
            if (t && !guesses.includes(t)) guesses.push(t);
          }
          if (guesses[0]) onFinal(guesses[0], lang, guesses.slice(1, 4));
        } else {
          interim += res[0].transcript;
        }
      }
      onInterim(interim.trim());
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      // This language can't take name hints; carry on without them (onend restarts).
      if (e.error === 'phrases-not-supported') {
        phrasesWork = false;
        return;
      }
      if (FATAL.has(e.error)) wanted = false;
      onError(e.error, e.message);
    };
    r.onend = () => {
      rec = null;
      onInterim('');
      if (!wanted) return onState('idle');
      // Chrome closes a session after a long pause; reopen it at once so no words fall in the
      // gap, but give up if it keeps dying immediately.
      const now = Date.now();
      restarts = restarts.filter((t) => now - t < 10_000).concat(now);
      if (restarts.length > 6) {
        wanted = false;
        onError('restart-loop', 'Recognition keeps stopping immediately.');
        return onState('idle');
      }
      setTimeout(() => {
        if (wanted && !rec) safeBegin();
      }, restarts.length > 2 ? 300 : 0);
    };
    rec = r;
    r.start();
  }

  function safeBegin() {
    try {
      begin();
    } catch (err) {
      rec = null;
      wanted = false;
      onError('start-failed', err.message);
      onState('idle');
    }
  }

  return {
    get listening() {
      return wanted;
    },
    start(nextLang, nextRecLang = nextLang) {
      lang = nextLang;
      recLang = nextRecLang;
      wanted = true;
      restarts = [];
      if (!rec) safeBegin();
    },
    // stop() lets Chrome deliver the last final phrase before ending.
    stop() {
      wanted = false;
      rec?.stop();
    },
    // Restarts the session in the new language; onend picks it up.
    switchLang(nextLang, nextRecLang = nextLang) {
      lang = nextLang;
      recLang = nextRecLang;
      rec?.stop();
    },
  };
}

// For the UI note: the recogniser actually used for a chosen language.
export function viaLabel(lang, recognizerLang) {
  if (!recognizerLang || recognizerLang === lang) return '';
  const name = LANGS.find((l) => l.code === recognizerLang)?.label?.split(' · ')[1] ?? recognizerLang;
  return `via ${name}`;
}
