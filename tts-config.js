// tts-config.js
// Gemini Pro TTS (Algenib) via Cloudflare Worker + IndexedDB cache

const WORKER_URL = "https://YOUR_WORKER_SUBDOMAIN.workers.dev";

const DB_NAME = "morandi_tts_cache_gemini_v1";
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
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function playBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  a.play();
  a.onended = () => URL.revokeObjectURL(url);
}

// 你现在 Worker 已经“锁死”模型/voice/prompt
// 网页端只传 text 即可；这样最稳，也不会被意外改掉
window.NEURAL_TTS = {
  async speak(text, lang) {
    const clean = (text || "").trim();
    if (!clean) return;

    // cache key：同一句话只生成一次，后续反复播放不花钱
    const key = await sha256Hex(`gemini-pro-tts-algenib|${clean}`);

    const cached = await dbGet(key);
    if (cached instanceof Blob) {
      await playBlob(cached);
      return;
    }

    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean }),
    });

    if (!resp.ok) throw new Error(await resp.text());

    const blob = await resp.blob();
    await dbSet(key, blob);
    await playBlob(blob);
  },
};
