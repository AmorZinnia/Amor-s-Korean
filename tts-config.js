// tts-config.js
// Google WaveNet via Cloudflare Worker + IndexedDB cache (超级省钱)

const WORKER_URL = "https://gentle-term-9239.ritacai20070808.workers.dev/";

// --- IndexedDB cache ---
const DB_NAME = "morandi_tts_cache_v1";
const STORE = "audio";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function playBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  a.play();
  a.onended = () => URL.revokeObjectURL(url);
}

// --- Public neural TTS hook ---
window.NEURAL_TTS = {
  async speak(text, lang) {
    const voiceName = "ko-KR-Wavenet-A"; // 你可以换 B/C/D 做“更像你喜欢的那个首尔人声线”
    const speakingRate = 0.98;          // 更口语自然：0.95~1.02 之间试
    const pitch = 0.0;

    const key = await sha256Hex(`${voiceName}|${speakingRate}|${pitch}|${text}`);

    // 1) cache hit
    const cached = await dbGet(key);
    if (cached instanceof Blob) {
      await playBlob(cached);
      return;
    }

    // 2) fetch from worker
    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang: "ko-KR", voiceName, speakingRate, pitch }),
    });
    if (!resp.ok) throw new Error(await resp.text());

    const blob = await resp.blob();

    // 3) store cache + play
    await dbSet(key, blob);
    await playBlob(blob);
  }
};
