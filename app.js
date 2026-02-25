/* Morandi Korean SRS
   - LocalStorage persistence
   - Ebbinghaus intervals: 0,1,2,3,5,7,10,15,30 days
   - Rating mapping: again/hard/good/easy
   - TTS engines:
       worker   -> Cloudflare Worker (TTS_ENDPOINT)
       webspeech-> Browser speechSynthesis
       neural   -> window.NEURAL_TTS.speak(text, lang) (optional hook)
*/

const STORAGE_KEY = "morandi_korean_srs_v1";
const SETTINGS_KEY = "morandi_korean_srs_settings_v1";

const EBBINGHAUS_DAYS = [0, 1, 2, 3, 5, 7, 10, 15, 30];

// ✅ 你的 Cloudflare Worker TTS（你已经跑通 200 的那个）
const TTS_ENDPOINT = "https://gentle-term-9239.ritacai20070808.workers.dev/";

// ===================== Utils =====================
function nowMs(){ return Date.now(); }
function addDaysMs(days){ return nowMs() + days * 24 * 60 * 60 * 1000; }
function fmtTime(ts){
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"
  });
}
function uid(){
  return Math.random().toString(16).slice(2) + "-" + Math.random().toString(16).slice(2);
}

// ===================== Storage =====================
function loadState(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { items: [] };
  try { return JSON.parse(raw); } catch { return { items: [] }; }
}
function saveState(state){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadSettings(){
  const raw = localStorage.getItem(SETTINGS_KEY);
  // ✅ 默认用 worker（更自然）
  const def = { voiceEngine: "worker" };
  if (!raw) return def;
  try { return { ...def, ...JSON.parse(raw) }; } catch { return def; }
}
function saveSettings(s){
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let state = loadState();
let settings = loadSettings();

// ===================== Data Model =====================
function normalizeItem(obj){
  const base = {
    id: uid(),
    ko: "",
    zh: "",
    koSentence: "",
    zhSentence: "",
    pron: "",
    img: "",
    createdAt: nowMs(),
    lastReviewedAt: null,
    stageIndex: 0,
    nextReviewAt: nowMs()
  };
  return { ...base, ...obj };
}

function computeNext(stageIndex){
  const idx = Math.max(0, Math.min(EBBINGHAUS_DAYS.length - 1, stageIndex));
  return addDaysMs(EBBINGHAUS_DAYS[idx]);
}

function applyRating(item, rate){
  let idx = item.stageIndex ?? 0;

  if (rate === "again") idx = 1; // tomorrow
  if (rate === "hard")  idx = Math.max(1, idx);
  if (rate === "good")  idx = Math.min(EBBINGHAUS_DAYS.length - 1, idx + 1);
  if (rate === "easy")  idx = Math.min(EBBINGHAUS_DAYS.length - 1, idx + 2);

  item.stageIndex = idx;
  item.lastReviewedAt = nowMs();
  item.nextReviewAt = computeNext(idx);
}

function getDueItems(){
  const t = nowMs();
  return state.items
    .filter(it => (it.nextReviewAt ?? 0) <= t)
    .sort((a,b)=>(a.nextReviewAt ?? 0)-(b.nextReviewAt ?? 0));
}
function getNextReviewTime(){
  const upcoming = state.items
    .filter(it => (it.nextReviewAt ?? Infinity) > nowMs())
    .sort((a,b)=>(a.nextReviewAt ?? Infinity)-(b.nextReviewAt ?? Infinity))[0];
  return upcoming?.nextReviewAt ?? null;
}
function masteredCount(){
  return state.items.filter(it => (it.stageIndex ?? 0) >= EBBINGHAUS_DAYS.length - 1).length;
}

/* =====================================================
   ✅ NEW: Delete / Reset progress helpers
   - delete item
   - reset review progress (clear review record)
===================================================== */
function deleteItemById(id){
  const idx = state.items.findIndex(x => x.id === id);
  if (idx < 0) return;
  state.items.splice(idx, 1);
  saveState(state);
  renderAll();
}

function resetItemProgressById(id){
  const idx = state.items.findIndex(x => x.id === id);
  if (idx < 0) return;
  const it = state.items[idx];
  it.stageIndex = 0;
  it.lastReviewedAt = null;
  it.nextReviewAt = nowMs(); // reset to due now (day0)
  state.items[idx] = it;
  saveState(state);
  renderAll();
}

// ===================== TTS (Worker with cache + robust play) =====================

// ⭐ 让“同一个词重复播放”变快：内存缓存（不走网络）
const _ttsCache = new Map(); // key -> { url, type, t }
const _ttsCacheOrder = [];   // LRU
const TTS_CACHE_MAX = 80;

function _cacheGet(key){
  const hit = _ttsCache.get(key);
  if (!hit) return null;
  hit.t = nowMs();
  return hit;
}
function _cacheSet(key, val){
  if (_ttsCache.has(key)) {
    _ttsCache.set(key, { ...val, t: nowMs() });
    return;
  }
  _ttsCache.set(key, { ...val, t: nowMs() });
  _ttsCacheOrder.push(key);
  while (_ttsCacheOrder.length > TTS_CACHE_MAX) {
    const k = _ttsCacheOrder.shift();
    const v = _ttsCache.get(k);
    if (v?.url) URL.revokeObjectURL(v.url);
    _ttsCache.delete(k);
  }
}

function _timeout(ms){
  const controller = new AbortController();
  const id = setTimeout(()=>controller.abort(), ms);
  return { controller, clear: ()=>clearTimeout(id) };
}

// ✅ 尽量避免 NotSupportedError：先用 <audio>，失败再用 WebAudio 解码
async function _playFromObjectURL(url){
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = url;

  try {
    audio.load();
    await audio.play();
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e };
  }
}

async function _playViaWebAudio(arrayBuffer){
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error("No AudioContext");
  const ctx = new Ctx();

  try { await ctx.resume?.(); } catch {}

  const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  src.onended = () => { try { ctx.close?.(); } catch {} };
}

async function playKoreanTTS(text){
  if (!text) return;

  const key = `ko|${text.trim()}`;

  const cached = _cacheGet(key);
  if (cached?.url) {
    const res = await _playFromObjectURL(cached.url);
    if (res.ok) return;
  }

  console.time?.("[TTS] fetch");

  const t = _timeout(12000);
  let r;
  try {
    r = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: t.controller.signal
    });
  } finally {
    t.clear();
  }

  console.timeEnd?.("[TTS] fetch");

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`TTS failed: ${r.status} ${errText}`);
  }

  const ct = (r.headers.get("content-type") || "").toLowerCase();

  const blob = await r.blob();

  if (!ct.includes("audio") && blob.type && !blob.type.includes("audio")) {
    console.warn("[TTS] content-type not audio:", ct, "blob.type:", blob.type);
  }

  const url = URL.createObjectURL(blob);
  _cacheSet(key, { url, type: ct || blob.type || "" });

  const res = await _playFromObjectURL(url);
  if (res.ok) return;

  try {
    const ab = await blob.arrayBuffer();
    await _playViaWebAudio(ab);
    return;
  } catch (e) {
    console.warn("[TTS] audio play failed:", res.err);
    throw e;
  }
}

// Web Speech
async function speakKoWebSpeech(text){
  if (!text) return;
  if (!("speechSynthesis" in window)) {
    alert("此设备不支持浏览器语音合成。");
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR";
  u.rate = 0.95;
  u.pitch = 1.0;

  const voices = speechSynthesis.getVoices?.() ?? [];
  const koVoices = voices.filter(v => (v.lang || "").toLowerCase().startsWith("ko"));
  if (koVoices.length) u.voice = koVoices[0];

  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

async function speakKo(text){
  if (!text) return;

  if (settings.voiceEngine === "worker") {
    try {
      await playKoreanTTS(text);
      return;
    } catch (e) {
      console.warn("[TTS] worker failed, fallback:", e);
    }
  }

  if (settings.voiceEngine === "neural" && window.NEURAL_TTS?.speak) {
    try {
      await window.NEURAL_TTS.speak(text, "ko-KR");
      return;
    } catch (e) {
      console.warn("[TTS] neural failed, fallback:", e);
    }
  }

  await speakKoWebSpeech(text);
}

/* =====================================================
   ✅ NEW: sentence playback
===================================================== */
async function speakKoSentenceByItem(item){
  if (!item) return;
  const s = (item.koSentence || "").trim();
  if (s) return speakKo(s);
  return speakKo((item.ko || "").trim());
}

// ===================== UI =====================
const $ = (sel)=>document.querySelector(sel);

const statDueToday = $("#statDueToday");
const statNextTime = $("#statNextTime");
const statTotal = $("#statTotal");
const statMastered = $("#statMastered");

const wordList = $("#wordList");
const toggleShowZh = $("#toggleShowZh");

const reviewPanel = $("#reviewPanel");
const btnStartReview = $("#btnStartReview");
const btnStudyNew = $("#btnStudyNew");

const cardKo = $("#cardKo");
const cardZh = $("#cardZh");
const cardKoSent = $("#cardKoSent");
const cardZhSent = $("#cardZhSent");
const cardPron = $("#cardPron");
const btnSpeak = $("#btnSpeak");
const reveal = $("#reveal");
const nextInfo = $("#nextInfo");
const btnNext = $("#btnNext");

const importModal = $("#importModal");
const settingsModal = $("#settingsModal");

const btnOpenImport = $("#btnOpenImport");
const btnExport = $("#btnExport");
const btnSettings = $("#btnSettings");

const inKo = $("#inKo");
const inZh = $("#inZh");
const inKoSent = $("#inKoSent");
const inZhSent = $("#inZhSent");
const inPron = $("#inPron");
const btnAddOne = $("#btnAddOne");

const csvFile = $("#csvFile");
const csvText = $("#csvText");
const btnImportCsv = $("#btnImportCsv");

const voiceEngine = $("#voiceEngine");

// ===================== Image Upload UI (no HTML edits) =====================
let inImgFile = null;     // <input type="file">
let inImgPreview = null;  // <img preview>
let inImgClearBtn = null; // clear button

function ensureImageInputUI(){
  // 把图片选择器插在 inPron 的下面（不改 HTML）
  if (!inPron) return;
  if (document.getElementById("inImgFile")) return;

  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "8px";
  wrap.style.marginTop = "10px";

  const label = document.createElement("div");
  label.textContent = "图片（可选）：";
  label.style.fontSize = "12px";
  label.style.opacity = "0.8";

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "10px";
  row.style.flexWrap = "wrap";

  const file = document.createElement("input");
  file.id = "inImgFile";
  file.type = "file";
  file.accept = "image/*";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "清除图片";
  clearBtn.style.cursor = "pointer";

  const preview = document.createElement("img");
  preview.id = "inImgPreview";
  preview.alt = "preview";
  preview.style.width = "96px";
  preview.style.height = "96px";
  preview.style.objectFit = "cover";
  preview.style.borderRadius = "12px";
  preview.style.border = "1px solid rgba(0,0,0,0.15)";
  preview.style.display = "none";

  row.appendChild(file);
  row.appendChild(clearBtn);
  row.appendChild(preview);

  wrap.appendChild(label);
  wrap.appendChild(row);

  // 插到发音输入框 inPron 的下面
  inPron.insertAdjacentElement("afterend", wrap);

  inImgFile = file;
  inImgPreview = preview;
  inImgClearBtn = clearBtn;

  file.addEventListener("change", async ()=>{
    const f = file.files?.[0];
    if (!f) return;
    const dataUrl = await fileToDataURL(f, 640); // 压缩，避免 localStorage 爆
    preview.src = dataUrl;
    preview.style.display = "block";
    file.dataset.img = dataUrl; // 临时存着，addOne 时取
  });

  clearBtn.addEventListener("click", ()=>{
    file.value = "";
    delete file.dataset.img;
    preview.src = "";
    preview.style.display = "none";
  });
}

function fileToDataURL(file, maxW=640){
  return new Promise((resolve, reject)=>{
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const out = c.toDataURL("image/jpeg", 0.85);
        resolve(out);
      };
      img.onerror = reject;
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
let sessionQueue = [];
let currentItem = null;
let showingReveal = false;

function renderStats(){
  const due = getDueItems().length;
  statDueToday.textContent = String(due);
  statTotal.textContent = String(state.items.length);
  statMastered.textContent = String(masteredCount());
  statNextTime.textContent = fmtTime(getNextReviewTime());
}

/* =====================================================
   ✅ NEW: inject "🔊例句" button next to existing btnSpeak
   - no need to edit HTML
===================================================== */
function ensureSentenceSpeakButton(){
  if (!btnSpeak) return;
  if (document.getElementById("btnSpeakSentence")) return;

  const b = document.createElement("button");
  b.id = "btnSpeakSentence";
  b.type = "button";
  b.textContent = "🔊例句";
  b.style.marginLeft = "8px";
  b.style.cursor = "pointer";

  b.addEventListener("click", ()=>{
    // Prefer currentItem. Fallback to DOM text.
    const it = currentItem || {
      ko: (cardKo?.textContent || ""),
      koSentence: (cardKoSent?.textContent || "")
    };
    speakKoSentenceByItem(it);
  });

  btnSpeak.insertAdjacentElement("afterend", b);
}

/* =====================================================
   ✅ NEW: helper to build action buttons in list
===================================================== */
function _makeSmallBtn(text){
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.style.cursor = "pointer";
  b.style.padding = "4px 8px";
  b.style.borderRadius = "8px";
  b.style.border = "1px solid rgba(0,0,0,0.12)";
  b.style.background = "rgba(255,255,255,0.7)";
  b.style.fontSize = "12px";
  return b;
}

function renderList(){
  const showZh = toggleShowZh.checked;
  wordList.innerHTML = "";

  const items = [...state.items].sort((a,b)=>(b.createdAt ?? 0)-(a.createdAt ?? 0));

  if (items.length === 0){
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "还没有单词。点“导入”添加一些吧。";
    wordList.appendChild(empty);
    return;
  }

  for (const it of items){
    const div = document.createElement("div");
    div.className = "item";

    const left = document.createElement("div");
    const ko = document.createElement("div");
    ko.className = "ko";
    ko.textContent = it.ko || "—";
    left.appendChild(ko);

    const zh = document.createElement("div");
    zh.className = "zh";
    zh.textContent = showZh ? (it.zh || "—") : "（中文已隐藏）";
    left.appendChild(zh);

    const right = document.createElement("div");
    right.className = "meta";
    const dueAt = it.nextReviewAt ? fmtTime(it.nextReviewAt) : "—";
    right.innerHTML = `阶段：${it.stageIndex ?? 0}/${EBBINGHAUS_DAYS.length-1}<br/>下次：${dueAt}`;
    div.appendChild(left);
    div.appendChild(right);

    // 点击词条发音
    div.addEventListener("click", ()=> speakKo(it.ko));

    /* ===================== ✅ NEW: per-item action buttons ===================== */
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "6px";
    actions.style.marginTop = "6px";
    actions.style.justifyContent = "flex-end";

    // 🔊词
    const bWord = _makeSmallBtn("🔊词");
    bWord.addEventListener("click", (e)=>{
      e.stopPropagation();
      speakKo(it.ko);
    });

    // 🔊句
    const bSent = _makeSmallBtn("🔊句");
    bSent.addEventListener("click", (e)=>{
      e.stopPropagation();
      speakKoSentenceByItem(it);
    });

    // ♻️重置复习
    const bReset = _makeSmallBtn("♻️重置");
    bReset.addEventListener("click", (e)=>{
      e.stopPropagation();
      const ok = confirm(`要清除「${it.ko}」的复习记录吗？\n（会变回新词：阶段=0，立刻可复习）`);
      if (!ok) return;
      resetItemProgressById(it.id);
    });

    // 🗑删除
    const bDel = _makeSmallBtn("🗑删除");
    bDel.addEventListener("click", (e)=>{
      e.stopPropagation();
      const ok = confirm(`确定删除「${it.ko}」吗？\n（删除后不可恢复）`);
      if (!ok) return;
      deleteItemById(it.id);
    });

    actions.appendChild(bWord);
    actions.appendChild(bSent);
    actions.appendChild(bReset);
    actions.appendChild(bDel);
    right.appendChild(actions);
    /* ===================== end actions ===================== */

    wordList.appendChild(div);
  }
}

function openReview(mode){
  const due = getDueItems();
  if (mode === "due"){
    sessionQueue = due;
  } else {
    const fresh = state.items
      .filter(it => (it.lastReviewedAt == null))
      .sort((a,b)=>(a.createdAt ?? 0)-(b.createdAt ?? 0));
    sessionQueue = fresh.length ? fresh : due;
  }

  if (!sessionQueue.length){
    alert("目前没有需要复习的卡片。可以先导入一些单词。");
    return;
  }

  reviewPanel.hidden = false;
  nextCard();
}

function nextCard(){
  currentItem = sessionQueue.shift() || null;
  showingReveal = false;

  if (!currentItem){
    reveal.hidden = true;
    cardKo.textContent = "完成 ✅";
    $("#cardStageArea").hidden = true;
    btnSpeak.disabled = true;
    // ✅ disable sentence button too
    const bSent = document.getElementById("btnSpeakSentence");
    if (bSent) bSent.disabled = true;

    nextInfo.textContent = "—";
    btnNext.textContent = "返回";
    btnNext.onclick = ()=>{
      reviewPanel.hidden = true;
      $("#cardStageArea").hidden = false;
      btnSpeak.disabled = false;
      const bSent2 = document.getElementById("btnSpeakSentence");
      if (bSent2) bSent2.disabled = false;

      btnNext.textContent = "下一张";
      btnNext.onclick = nextCard;
      renderAll();
    };
    return;
  }

  $("#cardStageArea").hidden = false;
  reveal.hidden = true;
  btnSpeak.disabled = false;
  const bSent = document.getElementById("btnSpeakSentence");
  if (bSent) bSent.disabled = false;

  cardKo.textContent = currentItem.ko || "—";
  cardZh.textContent = currentItem.zh || "—";
  cardKoSent.textContent = currentItem.koSentence || "—";
  cardZhSent.textContent = currentItem.zhSentence || "—";
  cardPron.textContent = currentItem.pron || "—";

  nextInfo.textContent =
    `当前阶段：${currentItem.stageIndex ?? 0}（间隔 ${EBBINGHAUS_DAYS[currentItem.stageIndex ?? 0]} 天）`;
}

function revealCard(){
  showingReveal = true;
  reveal.hidden = false;
}

function onRate(rate){
  if (!currentItem) return;
  applyRating(currentItem, rate);

  const idx = state.items.findIndex(x => x.id === currentItem.id);
  if (idx >= 0) state.items[idx] = currentItem;
  saveState(state);

  revealCard();
  const nextAt = fmtTime(currentItem.nextReviewAt);
  nextInfo.textContent = `下一次复习：${nextAt}（阶段 ${currentItem.stageIndex} / ${EBBINGHAUS_DAYS.length-1}）`;
}

function renderAll(){
  renderStats();
  renderList();
}

function addOneFromInputs(){
  const ko = (inKo.value || "").trim();
  const zh = (inZh.value || "").trim();
  const koSentence = (inKoSent.value || "").trim();
  const zhSentence = (inZhSent.value || "").trim();
  const pron = (inPron.value || "").trim();

  if (!ko) { alert("请填写韩语单词"); return; }

  const item = normalizeItem({ ko, zh, koSentence, zhSentence, pron });
  state.items.unshift(item);
  saveState(state);

  inKo.value = "";
  inZh.value = "";
  inKoSent.value = "";
  inZhSent.value = "";
  inPron.value = "";

  renderAll();
}

function parseCSV(text){
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!lines.length) return [];

  const rows = lines.map(line => {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i=0; i<line.length; i++){
      const ch = line[i];
      if (ch === '"' ) {
        if (inQ && line[i+1] === '"'){ cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ){
        out.push(cur); cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map(x=>x.trim());
  });

  const header = rows[0].map(s=>s.toLowerCase());
  const looksHeader =
    header.includes("ko") || header.includes("korean") || header.includes("zh") || header.includes("ko_sentence");
  const dataRows = looksHeader ? rows.slice(1) : rows;

  return dataRows.map(cols => {
    const [ko, zh, koSentence, zhSentence, pron] = cols;
    return normalizeItem({
      ko: (ko || "").trim(),
      zh: (zh || "").trim(),
      koSentence: (koSentence || "").trim(),
      zhSentence: (zhSentence || "").trim(),
      pron: (pron || "").trim()
    });
  }).filter(it => it.ko);
}

async function importCSVFromFile(file){
  const text = await file.text();
  return parseCSV(text);
}

function exportJSON(){
  const blob = new Blob([JSON.stringify({ ...state, exportedAt: nowMs() }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `morandi-korean-srs-backup-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ===================== Events =====================
btnOpenImport.addEventListener("click", ()=> importModal.showModal());
btnSettings.addEventListener("click", ()=>{
  // ✅ 若你的 HTML select 里没有 worker 选项，也不会炸；只是 UI 显示不了
  voiceEngine.value = settings.voiceEngine || "worker";
  settingsModal.showModal();
});
btnExport.addEventListener("click", exportJSON);

btnStartReview.addEventListener("click", ()=> openReview("due"));
btnStudyNew.addEventListener("click", ()=> openReview("new"));

// 发音按钮
btnSpeak.addEventListener("click", ()=> speakKo(currentItem?.ko || cardKo.textContent));

btnNext.addEventListener("click", ()=>{
  if (!showingReveal){
    alert("请先选择掌握程度（不会/模糊/会/简单）");
    return;
  }
  nextCard();
});

document.querySelectorAll("[data-rate]").forEach(btn=>{
  btn.addEventListener("click", ()=> onRate(btn.dataset.rate));
});

toggleShowZh.addEventListener("change", renderList);

document.querySelectorAll(".tab").forEach(tab=>{
  tab.addEventListener("click", ()=>{
    document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    $("#tab-manual").hidden = which !== "manual";
    $("#tab-csv").hidden = which !== "csv";
  });
});

btnAddOne.addEventListener("click", (e)=>{
  e.preventDefault();
  addOneFromInputs();
});

btnImportCsv.addEventListener("click", async (e)=>{
  e.preventDefault();

  let imported = [];
  const file = csvFile.files?.[0];
  if (file){
    imported = await importCSVFromFile(file);
  } else if (csvText.value.trim()){
    imported = parseCSV(csvText.value.trim());
  } else {
    alert("请上传CSV或粘贴CSV内容");
    return;
  }

  if (!imported.length){
    alert("没有解析到有效单词。请检查CSV格式。");
    return;
  }

  state.items = [...imported, ...state.items];
  saveState(state);

  csvFile.value = "";
  csvText.value = "";

  renderAll();
  importModal.close();
  alert(`导入完成：${imported.length} 个`);
});

settingsModal.addEventListener("close", ()=>{
  const v = voiceEngine.value;
  settings.voiceEngine = v || "worker";
  saveSettings(settings);
});

// iOS needs voices ready sometimes
if ("speechSynthesis" in window){
  speechSynthesis.onvoiceschanged = ()=>{};
}

/* =====================================================
   ✅ NEW: ensure sentence speak button exists
===================================================== */
ensureSentenceSpeakButton();

ensureImageInputUI();
renderAll();
