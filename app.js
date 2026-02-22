/* Morandi Korean SRS
   - LocalStorage persistence
   - Ebbinghaus intervals: 0,1,2,3,5,7,10,15,30 days
   - Rating mapping: again/hard/good/easy
   - Default TTS: Web Speech API
   - Optional Neural TTS hook: window.NEURAL_TTS.speak(text, lang)
*/
const TTS_ENDPOINT = "https://gentle-term-9239.ritacai20070808.workers.dev/";

async function playKoreanTTS(text) {
  const r = await fetch(TTS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`TTS failed: ${r.status} ${errText}`);
  }

  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);

  audio.onended = () => URL.revokeObjectURL(url);
  audio.play();
}
const STORAGE_KEY = "morandi_korean_srs_v1";
const SETTINGS_KEY = "morandi_korean_srs_settings_v1";

const EBBINGHAUS_DAYS = [0, 1, 2, 3, 5, 7, 10, 15, 30];

function nowMs(){ return Date.now(); }
function addDaysMs(days){ return nowMs() + days * 24 * 60 * 60 * 1000; }
function fmtTime(ts){
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
}
function uid(){
  return Math.random().toString(16).slice(2) + "-" + Math.random().toString(16).slice(2);
}

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
  const def = { voiceEngine: "worker" };
  if (!raw) return def;
  try { return { ...def, ...JSON.parse(raw) }; } catch { return def; }
}
function saveSettings(s){
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let state = loadState();
let settings = loadSettings();

function normalizeItem(obj){
  const base = {
    id: uid(),
    ko: "",
    zh: "",
    koSentence: "",
    zhSentence: "",
    pron: "",
    createdAt: nowMs(),
    lastReviewedAt: null,
    stageIndex: 0,        // index in EBBINGHAUS_DAYS
    nextReviewAt: nowMs() // due now for new words (day0)
  };
  return { ...base, ...obj };
}

function computeNext(stageIndex){
  const idx = Math.max(0, Math.min(EBBINGHAUS_DAYS.length - 1, stageIndex));
  return addDaysMs(EBBINGHAUS_DAYS[idx]);
}

function applyRating(item, rate){
  // Logic:
  // again (不会): reset to 1-day interval (index 1)
  // hard  (模糊): step back 1 (min 1) then forward 0 (i.e., cautious)
  // good  (会): forward 1
  // easy  (简单): forward 2
  let idx = item.stageIndex ?? 0;

  if (rate === "again") idx = 1;            // tomorrow
  if (rate === "hard")  idx = Math.max(1, idx); // keep at least 1
  if (rate === "good")  idx = Math.min(EBBINGHAUS_DAYS.length - 1, idx + 1);
  if (rate === "easy")  idx = Math.min(EBBINGHAUS_DAYS.length - 1, idx + 2);

  item.stageIndex = idx;
  item.lastReviewedAt = nowMs();
  item.nextReviewAt = computeNext(idx);
}

function getDueItems(){
  const t = nowMs();
  return state.items.filter(it => (it.nextReviewAt ?? 0) <= t)
                    .sort((a,b)=>(a.nextReviewAt ?? 0)-(b.nextReviewAt ?? 0));
}
function getNextReviewTime(){
  const upcoming = state.items
    .filter(it => (it.nextReviewAt ?? Infinity) > nowMs())
    .sort((a,b)=>(a.nextReviewAt ?? Infinity)-(b.nextReviewAt ?? Infinity))[0];
  return upcoming?.nextReviewAt ?? null;
}
function masteredCount(){
  // mastered = stageIndex at last interval (30 days) AND nextReviewAt is set beyond that stage
  return state.items.filter(it => (it.stageIndex ?? 0) >= EBBINGHAUS_DAYS.length - 1).length;
}

// ---------- TTS ----------
async function speakKo(text){
  if (!text) return;
  // ⭐ 使用你的 Worker TTS（首尔自然音）
  if (settings.voiceEngine === "worker") {
    try {
      await playKoreanTTS(text);
      return;
    } catch (e) {
      console.warn("Worker TTS failed, fallback:", e);
    }
  }
  if (settings.voiceEngine === "neural" && window.NEURAL_TTS?.speak) {
    try {
      await window.NEURAL_TTS.speak(text, "ko-KR");
      return;
    } catch (e) {
      console.warn("Neural TTS failed, fallback to WebSpeech:", e);
    }
  }

  // Web Speech fallback
  if (!("speechSynthesis" in window)) {
    alert("此设备不支持浏览器语音合成。");
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR";
  u.rate = 0.95;
  u.pitch = 1.0;

  // try choose best Korean voice
  const voices = speechSynthesis.getVoices?.() ?? [];
  const koVoices = voices.filter(v => (v.lang || "").toLowerCase().startsWith("ko"));
  if (koVoices.length) u.voice = koVoices[0];

  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------- UI ----------
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

    div.addEventListener("click", ()=> speakKo(it.ko));

    wordList.appendChild(div);
  }
}

function openReview(mode){
  // mode: "due" or "new"
  const due = getDueItems();
  if (mode === "due"){
    sessionQueue = due;
  } else {
    // new words = stageIndex 0 and never reviewed, or recently added
    const t = nowMs();
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
    nextInfo.textContent = "—";
    btnNext.textContent = "返回";
    btnNext.onclick = ()=>{
      reviewPanel.hidden = true;
      $("#cardStageArea").hidden = false;
      btnSpeak.disabled = false;
      btnNext.textContent = "下一张";
      btnNext.onclick = nextCard;
      renderAll();
    };
    return;
  }

  $("#cardStageArea").hidden = false;
  reveal.hidden = true;
  btnSpeak.disabled = false;

  cardKo.textContent = currentItem.ko || "—";
  cardZh.textContent = currentItem.zh || "—";
  cardKoSent.textContent = currentItem.koSentence || "—";
  cardZhSent.textContent = currentItem.zhSentence || "—";
  cardPron.textContent = currentItem.pron || "—";

  nextInfo.textContent = `当前阶段：${currentItem.stageIndex ?? 0}（间隔 ${EBBINGHAUS_DAYS[currentItem.stageIndex ?? 0]} 天）`;
}

function revealCard(){
  showingReveal = true;
  reveal.hidden = false;
}

function onRate(rate){
  if (!currentItem) return;
  applyRating(currentItem, rate);

  // persist update
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
  // Simple CSV parser: handles quoted commas minimally
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

  // If first row looks like header, skip it
  const header = rows[0].map(s=>s.toLowerCase());
  const looksHeader = header.includes("ko") || header.includes("korean") || header.includes("zh") || header.includes("ko_sentence");
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

// ---------- Events ----------
btnOpenImport.addEventListener("click", ()=> importModal.showModal());
btnSettings.addEventListener("click", ()=>{
  voiceEngine.value = settings.voiceEngine || "webspeech";
  settingsModal.showModal();
});
btnExport.addEventListener("click", exportJSON);

btnStartReview.addEventListener("click", ()=> openReview("due"));
btnStudyNew.addEventListener("click", ()=> openReview("new"));

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

// Tabs in import modal
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

// Settings save on close
settingsModal.addEventListener("close", ()=>{
  const v = voiceEngine.value;
  settings.voiceEngine = v;
  saveSettings(settings);
});

// iOS needs voices ready sometimes
if ("speechSynthesis" in window){
  speechSynthesis.onvoiceschanged = ()=>{};
}

renderAll();
