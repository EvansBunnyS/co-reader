// ============================================================
//  Co-Reader v2.0  ·  SillyTavern 共读批注扩展
//  功能：文章导入 · 用户批注 · AI批注 · 多轮对话 · 全文自动批注
//        角色卡联动 · 书签 · 搜索 · 导出 · 触摸优化
// ============================================================

import {
  saveSettingsDebounced,
  getRequestHeaders,
  generateQuietPrompt,
} from "../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";

const EXT = "co-reader";

// ─────────────────────────────────────────────────────────────
//  默认数据结构
// ─────────────────────────────────────────────────────────────
function mkDef() {
  return {
    fileName: "",
    text: "",
    annotations: {},   // { key: Annotation }
    bookmarks: {},     // { pIdx: true }
    readPos: 0,
    settings: {
      bgColor:     "#1e1e2e",
      textColor:   "#cdd6f4",
      accentColor: "#cba6f7",
      font:        "Georgia,'Noto Serif SC',serif",
      fontSize:    "16px",
      annFont:     "'Noto Sans SC',Arial,sans-serif",
      annFontSize: "13px",
      lineHeight:  "1.9",
      autoAiReply: true,   // 用户批注后自动触发AI回复
      customApiUrl:"",
    },
  };
}

// Annotation 结构：
// { key, pIdx, selectedText, text, origin:"user"|"ai"|"auto", ts, thread:[] }
// thread item: { role:"user"|"ai", text, ts }

// ─────────────────────────────────────────────────────────────
//  状态管理（持久化到 settings.json，永不丢失）
// ─────────────────────────────────────────────────────────────
function S() {
  if (!extension_settings[EXT]) extension_settings[EXT] = mkDef();
  // 补全旧版缺失字段
  const d = mkDef();
  if (!extension_settings[EXT].settings) extension_settings[EXT].settings = d.settings;
  if (!extension_settings[EXT].bookmarks) extension_settings[EXT].bookmarks = {};
  return extension_settings[EXT];
}
const save = () => saveSettingsDebounced();

// ─────────────────────────────────────────────────────────────
//  角色卡联动
// ─────────────────────────────────────────────────────────────
function getCharSys() {
  try {
    const ctx = getContext();
    const id = ctx.characterId;
    if (id === undefined || id === null) return null;
    const c = ctx.characters[id];
    if (!c) return null;
    const pers = (c.personality || c.description || "").slice(0, 150);
    return {
      name: c.name,
      prompt: `你正在扮演"${c.name}"。角色性格：${pers}`,
    };
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
//  初始化
// ─────────────────────────────────────────────────────────────
jQuery(async () => {
  if (!extension_settings[EXT]) extension_settings[EXT] = mkDef();
  injectBall();
  injectPanel();
  applyTheme();
  if (S().text) setTimeout(renderText, 200);
});

// ─────────────────────────────────────────────────────────────
//  悬浮球 —— Pointer Events 统一鼠标 + 触摸
// ─────────────────────────────────────────────────────────────
function injectBall() {
  if (document.getElementById("cr-ball")) return;
  const ball = document.createElement("div");
  ball.id = "cr-ball";
  ball.innerHTML = "📖";
  document.body.appendChild(ball);

  let moved = false, ox = 0, oy = 0, sx = 0, sy = 0;

  ball.addEventListener("pointerdown", e => {
    ball.setPointerCapture(e.pointerId);
    const r = ball.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    sx = e.clientX; sy = e.clientY;
    moved = false;
    e.preventDefault();
  });

  ball.addEventListener("pointermove", e => {
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) moved = true;
    if (moved) {
      ball.style.right = ball.style.bottom = "auto";
      ball.style.left = `${e.clientX - ox}px`;
      ball.style.top  = `${e.clientY - oy}px`;
    }
  });

  ball.addEventListener("pointerup", () => { if (!moved) togglePanel(); });
}

// ─────────────────────────────────────────────────────────────
//  主面板 HTML
// ─────────────────────────────────────────────────────────────
function injectPanel() {
  if (document.getElementById("cr-panel")) return;
  const panel = document.createElement("div");
  panel.id = "cr-panel";
  panel.style.display = "none";
  panel.innerHTML = `
<div id="cri">

  <!-- 工具栏 -->
  <div id="cr-tb">
    <span id="cr-title">📖 共读批注</span>
    <div id="cr-acts">
      <label class="crb" title="导入TXT/MD">
        📂<span class="crl"> 导入</span>
        <input type="file" id="cr-file" accept=".txt,.md" style="display:none">
      </label>
      <button class="crb" id="cr-autoann" title="AI扫全文自动批注">
        🤖<span class="crl"> 全文批注</span>
      </button>
      <button class="crb" id="cr-ej">⬇<span class="crl"> JSON</span></button>
      <button class="crb" id="cr-et">⬇<span class="crl"> TXT</span></button>
      <button class="crb" id="cr-sb" title="搜索批注">🔍</button>
      <button class="crb" id="cr-sidtog" title="显示/隐藏批注栏">📋</button>
      <button class="crb" id="cr-cfgb" title="设置">⚙</button>
      <button class="crb" id="cr-clsb">✕</button>
    </div>
  </div>

  <!-- 搜索栏 -->
  <div id="cr-searchbar" style="display:none">
    <input id="cr-si" placeholder="搜索批注内容…" autocomplete="off">
    <button class="crb crb-sm" id="cr-sc">✕</button>
  </div>

  <!-- 主体：阅读区 + 侧边栏 -->
  <div id="cr-main">
    <div id="cr-cw">
      <div id="cr-c"><div class="cr-hint">点击 📂 导入 .txt 文件开始共读<br><small>选中文字可添加批注 · 长按段落可标书签</small></div></div>
    </div>
    <div id="cr-side">
      <div id="cr-side-hd">
        <span>批注列表</span>
        <select id="cr-flt">
          <option value="">全部</option>
          <option value="user">💬 我的</option>
          <option value="ai">🤖 AI选批</option>
          <option value="auto">✨ AI全文</option>
        </select>
      </div>
      <div id="cr-al"></div>
    </div>
  </div>

  <!-- 设置面板 -->
  <div id="cr-cfg" style="display:none">
    <h4>⚙ 界面设置</h4>
    <div class="cr-cg">
      <label>背景色<input type="color" data-k="bgColor"></label>
      <label>文字色<input type="color" data-k="textColor"></label>
      <label>强调色<input type="color" data-k="accentColor"></label>
      <label>正文字体<input type="text" data-k="font" placeholder="Georgia,serif"></label>
      <label>正文字号<input type="text" data-k="fontSize" placeholder="16px"></label>
      <label>批注字体<input type="text" data-k="annFont"></label>
      <label>批注字号<input type="text" data-k="annFontSize" placeholder="13px"></label>
      <label>行高<input type="text" data-k="lineHeight" placeholder="1.9"></label>
      <label>自定义API<input type="text" data-k="customApiUrl" placeholder="留空=ST当前API"></label>
    </div>
    <label class="cr-chkl">
      <input type="checkbox" data-k="autoAiReply">
      用户批注/回复后自动触发 AI 回应
    </label>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="crb crb-p" id="cr-csave">保存</button>
      <button class="crb" id="cr-crst">恢复默认</button>
      <button class="crb" id="cr-ccls">关闭</button>
    </div>
  </div>

</div>`;
  document.body.appendChild(panel);
  bindPanelEvents();
}

// ─────────────────────────────────────────────────────────────
//  事件绑定
// ─────────────────────────────────────────────────────────────
function bindPanelEvents() {
  // 工具栏
  document.getElementById("cr-clsb").addEventListener("click", togglePanel);
  document.getElementById("cr-file").addEventListener("change", importFile);
  document.getElementById("cr-autoann").addEventListener("click", autoAnnotate);
  document.getElementById("cr-ej").addEventListener("click", exportJson);
  document.getElementById("cr-et").addEventListener("click", exportTxt);
  document.getElementById("cr-cfgb").addEventListener("click", () => toggleCfg());
  document.getElementById("cr-csave").addEventListener("click", saveCfg);
  document.getElementById("cr-crst").addEventListener("click", resetCfg);
  document.getElementById("cr-ccls").addEventListener("click", () => toggleCfg(false));
  document.getElementById("cr-flt").addEventListener("change", renderList);
  document.getElementById("cr-sidtog").addEventListener("click", () => {
    document.getElementById("cr-side").classList.toggle("cr-side-open");
  });

  // 搜索
  document.getElementById("cr-sb").addEventListener("click", () => {
    const sb = document.getElementById("cr-searchbar");
    sb.style.display = sb.style.display === "none" ? "flex" : "none";
    if (sb.style.display !== "none") document.getElementById("cr-si").focus();
  });
  document.getElementById("cr-si").addEventListener("input", renderList);
  document.getElementById("cr-sc").addEventListener("click", () => {
    document.getElementById("cr-si").value = "";
    renderList();
  });

  // 文本选中（鼠标 + 触摸双支持）
  const content = document.getElementById("cr-c");
  content.addEventListener("mouseup",  () => setTimeout(onSelect, 20));
  content.addEventListener("touchend", () => setTimeout(onSelect, 250));
}

// ─────────────────────────────────────────────────────────────
//  面板开关 + 记录阅读位置
// ─────────────────────────────────────────────────────────────
function togglePanel() {
  const panel = document.getElementById("cr-panel");
  const cw    = document.getElementById("cr-cw");
  if (panel.style.display !== "none") {
    if (cw) { S().readPos = cw.scrollTop; save(); }
    panel.style.display = "none";
  } else {
    panel.style.display = "flex";
    if (S().text) setTimeout(() => { if (cw) cw.scrollTop = S().readPos || 0; }, 60);
  }
}

function toggleCfg(show) {
  const el = document.getElementById("cr-cfg");
  if (show === undefined) show = el.style.display === "none";
  el.style.display = show ? "block" : "none";
  if (show) loadCfgForm();
}

// ─────────────────────────────────────────────────────────────
//  文件导入
// ─────────────────────────────────────────────────────────────
function importFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    S().text      = ev.target.result;
    S().fileName  = file.name.replace(/\.(txt|md)$/i, "");
    S().annotations = {};
    S().bookmarks   = {};
    S().readPos     = 0;
    save();
    renderText();
    toast(`✓ 已导入《${S().fileName}》`);
  };
  reader.readAsText(file, "UTF-8");
  e.target.value = "";
}

// ─────────────────────────────────────────────────────────────
//  文本渲染
// ─────────────────────────────────────────────────────────────
function renderText() {
  const el = document.getElementById("cr-c");
  if (!el || !S().text) return;

  const paras = S().text.split(/\r?\n/);
  let html = "";

  paras.forEach((p, i) => {
    if (!p.trim()) {
      html += `<div class="crp cre" data-p="${i}"></div>`;
      return;
    }
    let line = esc(p);

    // 应用批注高亮（按段落过滤）
    Object.values(S().annotations)

      .filter(a => a.pIdx === i)

      .forEach(a => {
        const escaped = esc(a.selectedText);
        const cls = `crm crm-${a.origin}`;
        // 只替换第一次出现，避免重复嵌套
        line = line.replace(escaped, `<mark class="${cls}" data-k="${a.key}">${escaped}</mark>`);
      });

    const bk = S().bookmarks[i] ? " crp-bk" : "";
    html += `<div class="crp${bk}" data-p="${i}">${line}</div>`;
  });

  el.innerHTML = html;

  // 点击高亮 → 跳转对应批注卡片
  el.querySelectorAll(".crm").forEach(m => {
    m.addEventListener("click", () => {
      const card = document.getElementById(`ac-${m.dataset.k}`);
      if (!card) return;
      // 如果侧边栏在手机上是隐藏的，先打开它
      document.getElementById("cr-side").classList.add("cr-side-open");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      flashCard(card);
    });
  });

  // 长按段落 → 书签（移动端）
  el.querySelectorAll(".crp[data-p]").forEach(para => {
    let timer;
    para.addEventListener("touchstart", () => {
      timer = setTimeout(() => bkToggle(+para.dataset.p), 700);
    }, { passive: true });
    para.addEventListener("touchend",  () => clearTimeout(timer), { passive: true });
    para.addEventListener("touchmove", () => clearTimeout(timer), { passive: true });
  });

  renderList();
}

// ─────────────────────────────────────────────────────────────
//  书签
// ─────────────────────────────────────────────────────────────
function bkToggle(pIdx) {
  if (S().bookmarks[pIdx]) {
    delete S().bookmarks[pIdx];
    toast("已移除书签");
  } else {
    S().bookmarks[pIdx] = true;
    toast("★ 书签已添加");
    if (navigator.vibrate) navigator.vibrate(40);
  }
  save();
  renderText();
}

// ─────────────────────────────────────────────────────────────
//  文字选中处理（鼠标 + 触摸通用）
// ─────────────────────────────────────────────────────────────
function onSelect() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const txt = sel.toString().trim();
  if (!txt || txt.length < 2 || txt.length > 400) return;

  // 找到选中文字所在的 .crp 段落
  const range = sel.getRangeAt(0);
  let node = range.startContainer;
  while (node && node.id !== "cr-c") {
    if (node.classList?.contains("crp") && node.dataset?.p !== undefined) break;
    node = node.parentElement;
  }
  if (!node || node.id === "cr-c") return;

  showPopup(+node.dataset.p, txt);
}

// ─────────────────────────────────────────────────────────────
//  批注输入弹窗
// ─────────────────────────────────────────────────────────────
function showPopup(pIdx, selectedText) {
  document.getElementById("cr-pop")?.remove();

  const pop = document.createElement("div");
  pop.id = "cr-pop";
  pop.innerHTML = `
    <div class="cr-pop-hd">
      <span>📝 「${trunc(selectedText, 20)}」</span>
      <button class="crb crb-sm" id="cr-px">✕</button>
    </div>
    <textarea id="cr-pta" placeholder="写下你的批注…（留空可直接让 AI 批注）" rows="3"></textarea>
    <div class="cr-pop-ft">
      <button class="crb crb-sm crb-p"  id="cr-puser">💬 我来批注</button>
      <button class="crb crb-sm crb-ai" id="cr-pai">🤖 AI 来批注</button>
      <button class="crb crb-sm"        id="cr-pcan">取消</button>
    </div>`;
  document.getElementById("cr-cw").appendChild(pop);
  document.getElementById("cr-pta").focus();

  const close = () => {
    pop.remove();
    window.getSelection()?.removeAllRanges();
  };

  document.getElementById("cr-px").addEventListener("click", close);
  document.getElementById("cr-pcan").addEventListener("click", close);

  // ① 用户自己批注
  document.getElementById("cr-puser").addEventListener("click", async () => {
    const val = document.getElementById("cr-pta").value.trim();
    if (!val) { document.getElementById("cr-pta").focus(); return; }
    const key = addAnn(pIdx, selectedText, val, "user");
    close();
    // 自动AI回复开关
    if (S().settings.autoAiReply) await aiReply(key);
  });

  // ② 让 AI 批注
  document.getElementById("cr-pai").addEventListener("click", async () => {
    const hint = document.getElementById("cr-pta").value.trim();
    close();
    await aiAnnotSel(pIdx, selectedText, hint);
  });
}

// ─────────────────────────────────────────────────────────────
//  批注 CRUD
// ─────────────────────────────────────────────────────────────
function addAnn(pIdx, selectedText, text, origin) {
  const key = `ann_${pIdx}_${Date.now()}`;
  S().annotations[key] = {
    key, pIdx, selectedText, text, origin,
    ts: Date.now(), thread: [],
  };
  save();
  renderText();   // renderText 内部会调用 renderList
  return key;
}

function delAnn(key) {
  if (!confirm("确认删除这条批注？")) return;
  delete S().annotations[key];
  save();
  renderText();
}

// ─────────────────────────────────────────────────────────────
//  批注列表渲染
// ─────────────────────────────────────────────────────────────
function renderList() {
  const list = document.getElementById("cr-al");
  if (!list) return;

  const filter = document.getElementById("cr-flt")?.value || "";
  const query  = (document.getElementById("cr-si")?.value || "").trim().toLowerCase();

  let anns = Object.values(S().annotations);
  if (filter) anns = anns.filter(a => a.origin === filter);
  if (query)  anns = anns.filter(a =>
    a.text.toLowerCase().includes(query) ||
    a.selectedText.toLowerCase().includes(query) ||
    a.thread.some(r => r.text.toLowerCase().includes(query))

  );
  anns.sort((a, b) => a.pIdx - b.pIdx || a.ts - b.ts);

  if (!anns.length) {
    list.innerHTML = `<div class="cr-ae">${query ? "无匹配批注" : "暂无批注<br>选中正文文字即可添加"}</div>`;
    return;
  }

  list.innerHTML = anns.map(annCardHtml).join("");

  // 统一事件委托
  list.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", () => {
      const { act, key } = btn.dataset;
      if (act === "del")  delAnn(key);
      if (act === "send") userReply(key, btn.closest(".cr-ac"));
      if (act === "air")  aiReply(key);
    });
  });
}

function annCardHtml(a) {
  const ico = { user:"💬", ai:"🤖", auto:"✨" }[a.origin] || "💬";
  const lbl = { user:"用户批注", ai:"AI选批", auto:"AI全文" }[a.origin] || "";

  const threadHtml = a.thread.map(r => `
    <div class="cr-tr cr-tr-${r.role}">
      <span class="cr-tl">${r.role === "ai" ? "🤖" : "💬"}</span>
      <div class="cr-tt">${esc(r.text)}</div>
      <div class="cr-tm">${fmt(r.ts)}</div>
    </div>`).join("");

  return `
    <div class="cr-ac" id="ac-${a.key}">
      <div class="cr-ac-hd">
        <span class="cr-ao">${ico} ${lbl}</span>
        <span class="cr-am">${fmt(a.ts)}</span>
      </div>
      <div class="cr-aq">「${trunc(a.selectedText, 22)}」</div>
      <div class="cr-ab">${esc(a.text)}</div>
      ${threadHtml}
      <div class="cr-af">
        <textarea class="cr-rta" placeholder="继续对话…" rows="2"></textarea>
        <div class="cr-abtns">
          <button class="crb crb-sm"       data-act="send" data-key="${a.key}">💬 回复</button>
          <button class="crb crb-sm crb-ai" data-act="air"  data-key="${a.key}">🤖 AI回复</button>
          <button class="crb crb-sm crb-del"data-act="del"  data-key="${a.key}">🗑</button>
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
//  对话：用户回复
// ─────────────────────────────────────────────────────────────
function userReply(key, card) {
  const a = S().annotations[key];
  if (!a) return;
  const ta  = card.querySelector(".cr-rta");
  const val = ta.value.trim();
  if (!val) return;
  a.thread.push({ role: "user", text: val, ts: Date.now() });
  ta.value = "";
  save();
  renderList();
  if (S().settings.autoAiReply) aiReply(key);
}

// ─────────────────────────────────────────────────────────────
//  对话：AI 回复（含角色卡联动）
// ─────────────────────────────────────────────────────────────
async function aiReply(key) {
  const a = S().annotations[key];
  if (!a) return;

  // 按钮进入加载状态
  const btn = document.querySelector(`[data-act="air"][data-key="${key}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "⏳"; }

  const cs   = getCharSys();
  const sys  = cs?.prompt || "你是一位博学细腻的共读伙伴。";
  const name = cs?.name   || "AI";

  // 构建对话历史
  const histParts = a.thread.map(r =>
    `${r.role === "ai" ? name : "用户"}：${r.text}`
  ).join("\n");

  const annDesc = a.origin === "user"

    ? `用户批注：${a.text}`
    : `${name}的批注：${a.text}`;

  const prompt = `${sys}

你和用户正在共读文章《${S().fileName || "未知"}》，以下是一段批注对话。

【原文片段】「${a.selectedText}」

【${annDesc}】
${histParts ? `【对话记录】\n${histParts}` : ""}

请以"${name}"的角色视角自然地继续这段共读对话，可以深入分析、共情、联想或追问（80字以内）：`;

  try {
    const reply = await callAI(prompt);
    if (reply) {
      a.thread.push({ role: "ai", text: reply.trim(), ts: Date.now() });
      save();
      renderList();
    }
  } catch (err) {
    console.error("[Co-Reader] aiReply 失败:", err);
    toast("AI回复失败，请检查API连接");
  }
}

// ─────────────────────────────────────────────────────────────
//  AI 批注选中片段（用户选中 → AI 批注）
// ─────────────────────────────────────────────────────────────
async function aiAnnotSel(pIdx, selectedText, hint = "") {
  const cs   = getCharSys();
  const sys  = cs?.prompt || "你是一位博学细腻的共读伙伴。";
  const hintPart = hint ? `（用户提示：${hint}）` : "";

  const prompt = `${sys}

用户在阅读《${S().fileName || "未知"}》时选中了以下片段，请以你的角色视角为它写批注${hintPart}：

「${selectedText}」

给出50-100字的批注（文学分析、情感共鸣、联想延伸、追问等均可）：`;

  toast("🤖 AI 正在批注…");
  try {
    const reply = await callAI(prompt);
    if (reply) {
      addAnn(pIdx, selectedText, reply.trim(), "ai");
      toast("✓ AI 批注完成");
    }
  } catch (err) {
    toast("AI 批注失败");
    console.error(err);
  }
}

// ─────────────────────────────────────────────────────────────
//  AI 全文自动批注
// ─────────────────────────────────────────────────────────────
async function autoAnnotate() {
  if (!S().text) { toast("请先导入文本"); return; }

  const btn = document.getElementById("cr-autoann");
  btn.disabled = true;
  btn.innerHTML = "⏳<span class='crl'> 批注中…</span>";

  const cs    = getCharSys();
  const sys   = cs?.prompt || "你是一位博学细腻的共读伙伴。";
  const paras = S().text.split(/\r?\n/).map((t, i) => ({ i, t: t.trim() })).filter(p => p.t);

  // 抽取 3 段有代表性的片段（开头 / 中间 / 结尾）
  const chunkSz = 6;
  const chunks  = [];
  if (paras.length <= chunkSz) {
    chunks.push(paras);
  } else {
    const mid = Math.floor(paras.length / 2) - Math.floor(chunkSz / 2);
    chunks.push(paras.slice(0, chunkSz));
    chunks.push(paras.slice(Math.max(0, mid), mid + chunkSz));
    chunks.push(paras.slice(Math.max(0, paras.length - chunkSz)));
  }

  // 收集所有待添加的批注（批量添加，只渲染一次）
  const toAdd = [];

  for (const chunk of chunks) {
    const chunkText = chunk.map(p => `[${p.i}] ${p.t}`).join("\n");

    const prompt = `${sys}

请仔细阅读以下文段（来自《${S().fileName || "未知"}》），找出2-4处有价值的片段进行批注。

输出格式（每条一行，严格用 ||| 分隔，禁止换行）：
行号|||原文片段（≤20字，必须是原文存在的连续文字）|||批注内容（40-80字）

文段：
${chunkText}

只输出批注列表：`;

    try {
      const resp = await callAI(prompt);
      if (!resp) continue;

      resp.split("\n").forEach(line => {
        const pts = line.split("|||");
        if (pts.length < 3) return;
        const pIdxHint  = parseInt(pts[0].replace(/\D/g, "")) || 0;
        const selText   = pts[1].trim();
        const annText   = pts[2].trim();
        if (!selText || selText.length < 2 || !annText) return;
        const realIdx = findPara(selText, pIdxHint);
        if (realIdx === -1) return;
        toAdd.push({ pIdx: realIdx, selectedText: selText, text: annText });
      });
    } catch (err) {
      console.error("[Co-Reader] autoAnnotate chunk 失败:", err);
    }

    await wait(700); // 避免请求过于密集
  }

  // 批量写入，单次渲染
  toAdd.forEach(({ pIdx, selectedText, text }) => {
    const key = `ann_${pIdx}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    S().annotations[key] = {
      key, pIdx, selectedText, text, origin: "auto",
      ts: Date.now(), thread: [],
    };
  });
  save();
  renderText();

  btn.disabled = false;
  btn.innerHTML = "🤖<span class='crl'> 全文批注</span>";
  toast(`✓ AI 完成 ${toAdd.length} 条批注`);
}

// 在原文中找到包含指定文字的段落索引
function findPara(text, hintIdx) {
  const ps = S().text.split(/\r?\n/);
  const candidates = [hintIdx, hintIdx - 1, hintIdx + 1, hintIdx - 2, hintIdx + 2]
    .filter(i => i >= 0 && i < ps.length);
  for (const i of candidates) {
    if (ps[i]?.includes(text)) return i;
  }
  for (let i = 0; i < ps.length; i++) {
    if (ps[i]?.includes(text)) return i;
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────
//  AI 调用（自动选择 ST 内置 API 或自定义 URL）
// ─────────────────────────────────────────────────────────────
async function callAI(prompt) {
  const url = S().settings.customApiUrl;
  if (url) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getRequestHeaders() },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.8,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content ?? d.response ?? "";
  }
  // 使用 ST 当前连接的模型（quiet，不出现在聊天记录）
  return await generateQuietPrompt(prompt, false, false);
}

// ─────────────────────────────────────────────────────────────
//  导出
// ─────────────────────────────────────────────────────────────
function exportJson() {
  dl(
    `${S().fileName}_批注.json`,
    JSON.stringify({
      version: "2.0",
      fileName: S().fileName,
      exportTime: new Date().toISOString(),
      annotations: S().annotations,
      bookmarks: S().bookmarks,
    }, null, 2),
    "application/json"

  );
}

function exportTxt() {
  const ps  = S().text.split(/\r?\n/);
  let out   = `【共读：${S().fileName}】  ${new Date().toLocaleString()}\n${"─".repeat(40)}\n\n`;
  ps.forEach((p, i) => {
    if (S().bookmarks[i]) out += "★ ";
    out += p + "\n";
    Object.values(S().annotations)

      .filter(a => a.pIdx === i)

      .forEach(a => {
        const ic = { user:"💬", ai:"🤖", auto:"✨" }[a.origin] || "";
        out += `\n  [${ic}批注] 「${a.selectedText}」\n    ${a.text}\n`;
        a.thread.forEach(r => {
          out += `    ${r.role === "ai" ? "  🤖：" : "  💬："}${r.text}\n`;
        });
        out += "\n";
      });
  });
  dl(`${S().fileName}_含批注.txt`, out, "text/plain;charset=utf-8");
}

function dl(name, content, type) {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([content], { type })),
    download: name,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─────────────────────────────────────────────────────────────
//  设置
// ─────────────────────────────────────────────────────────────
function applyTheme() {
  const s = S().settings;
  const r = document.documentElement;
  r.style.setProperty("--cr-bg",  s.bgColor);
  r.style.setProperty("--cr-tx",  s.textColor);
  r.style.setProperty("--cr-ac",  s.accentColor);
  r.style.setProperty("--cr-fn",  s.font);
  r.style.setProperty("--cr-fs",  s.fontSize);
  r.style.setProperty("--cr-af",  s.annFont);
  r.style.setProperty("--cr-as",  s.annFontSize);
  r.style.setProperty("--cr-lh",  s.lineHeight);
}

function loadCfgForm() {
  document.querySelectorAll("#cr-cfg [data-k]").forEach(el => {
    const v = S().settings[el.dataset.k];
    if (el.type === "checkbox") el.checked = !!v;
    else if (v !== undefined) el.value = v;
  });
}

function saveCfg() {
  document.querySelectorAll("#cr-cfg [data-k]").forEach(el => {
    S().settings[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value;
  });
  applyTheme(); save(); toggleCfg(false); toast("✓ 设置已保存");
}

function resetCfg() {
  S().settings = mkDef().settings;
  applyTheme(); save(); loadCfgForm(); toast("已恢复默认设置");
}

// ─────────────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────────────
const esc   = s => s.replace(/&/g,"&").replace(/</g,"<").replace(/>/g,">").replace(/"/g,""");
const trunc = (s, n) => s.length > n ? s.slice(0, n) + "…" : s;
const fmt   = ts => new Date(ts).toLocaleString("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
const wait  = ms => new Promise(r => setTimeout(r, ms));

function flashCard(el) {
  el.classList.add("cr-flash");
  setTimeout(() => el.classList.remove("cr-flash"), 700);
}

function toast(msg, dur = 2400) {
  document.getElementById("cr-toast")?.remove();
  const el = Object.assign(document.createElement("div"), {
    id: "cr-toast", textContent: msg,
  });
  document.body.appendChild(el);
  setTimeout(() => el?.remove(), dur);
}
