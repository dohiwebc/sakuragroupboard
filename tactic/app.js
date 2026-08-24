/**
 * SAKURA Group 戦術ボード
 * 論理座標系: BOARD_W x BOARD_H（コート・描画・コマで共通）
 */
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

/* コート画像 684×1024 に合わせた論理座標 */
const BOARD_W = 684;
const BOARD_H = 1024;
const LOCAL_KEY = "sakuraTactics_v1";
const INK_PREFS_KEY = "sakuraTactics_inkPrefs";
const FIRESTORE_ROOT = "sakuraTactics";
const INK_TOOLS = ["pen", "arrow", "line", "ellipse"];
/** スタイルポップオーバーを出すツール（消しゴム含む） */
const STYLE_TOOLS = ["pen", "arrow", "line", "ellipse", "eraser"];

function defaultInkPrefs() {
  return {
    pen: { color: "#ff3b30", width: 3.5, opacity: 1 },
    arrow: { color: "#ff3b30", width: 3.5, opacity: 1, style: "straight" },
    line: { color: "#007aff", width: 3.5, opacity: 1 },
    ellipse: { color: "#34c759", width: 3.5, opacity: 1 },
    eraser: { width: 3.5 }
  };
}

function loadInkPrefs() {
  try {
    const raw = localStorage.getItem(INK_PREFS_KEY);
    if (!raw) return defaultInkPrefs();
    const parsed = JSON.parse(raw);
    const base = defaultInkPrefs();
    for (const t of [...INK_TOOLS, "eraser"]) {
      if (parsed[t]) base[t] = { ...base[t], ...parsed[t] };
    }
    return base;
  } catch {
    return defaultInkPrefs();
  }
}

function saveInkPrefs() {
  try {
    localStorage.setItem(INK_PREFS_KEY, JSON.stringify(inkPrefs));
  } catch (_) {}
}

let inkPrefs = loadInkPrefs();

const ROSTER = [
  "平岡 頼樹", "山田 興", "佐藤 陸翔", "光田 明紗",
  "乘松 孝明", "須賀 瑞輝", "和田 龍生", "藤原 一聖",
  "二神 聖空", "乘松 瑞希", "平岡 咲希", "上田 詩織",
  "佐藤 里虹", "大北 悠真", "奥田 竜朗", "藤崎 萌々香"
];

const MODES = ["attack", "defense", "free"];
const MODE_LABEL = { attack: "攻撃", defense: "守備", free: "自由" };

// ---------- ユーティリティ ----------
const uid = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const deepClone = (o) => JSON.parse(JSON.stringify(o));

function splitName(name) {
  const parts = String(name).split(/[\s\u3000]+/).filter(Boolean);
  return parts.length ? parts : [name];
}

function emptyRoles() {
  return { infield: [], attackers: [], outfield: [] };
}

function emptyBoard() {
  return {
    pieces: [],
    drawings: [],
    zoom: 1,
    roles: emptyRoles()
  };
}

/** まだ布陣未設定（コマも役割もない）か */
function isBoardUnset(b) {
  if (!b) return true;
  const hasPieces = Array.isArray(b.pieces) && b.pieces.length > 0;
  const r = b.roles || emptyRoles();
  const hasRoles =
    (r.infield && r.infield.length > 0) ||
    (r.attackers && r.attackers.length > 0) ||
    (r.outfield && r.outfield.length > 0);
  return !hasPieces && !hasRoles;
}

/**
 * 先に作った布陣を、まだ空のモードへ初期コピーする。
 * 描画はコピーしない。選手・相手・ボール・役割・ズームのみ。
 */
function seedEmptyModesFrom(sourceKey) {
  const src = state.modes[sourceKey];
  if (!src || isBoardUnset(src)) return false;
  let seeded = false;
  for (const m of MODES) {
    if (m === sourceKey) continue;
    if (!isBoardUnset(state.modes[m])) continue;
    state.modes[m] = {
      pieces: deepClone(src.pieces),
      drawings: [],
      zoom: src.zoom || 1,
      roles: deepClone(src.roles || emptyRoles())
    };
    // 自動シードは Undo 対象にせず、そのモードの履歴基準だけ更新
    syncHistoryTip(m);
    seeded = true;
  }
  return seeded;
}

function createInitialState() {
  const pen = inkPrefs.pen || defaultInkPrefs().pen;
  return {
    currentMode: "attack",
    piecesLocked: false,
    presentMode: false,
    drawingsVisible: true,
    tool: "select",
    penColor: pen.color,
    penWidth: pen.width,
    penOpacity: pen.opacity ?? 1,
    arrowStyle: (inkPrefs.arrow && inkPrefs.arrow.style) || "straight",
    modes: {
      attack: emptyBoard(),
      defense: emptyBoard(),
      free: emptyBoard()
    },
    templates: [],
    snapshots: [],
    // モードごとの Undo/Redo（今見ているモードだけ戻す）
    _hist: {
      attack: { stack: [], index: -1 },
      defense: { stack: [], index: -1 },
      free: { stack: [], index: -1 }
    }
  };
}

/** 指定モードの盤面スナップショット（Undo用） */
function boardSnap(mode = state.currentMode) {
  const b = state.modes[mode];
  return {
    mode,
    pieces: deepClone(b.pieces),
    drawings: deepClone(b.drawings),
    roles: deepClone(b.roles || emptyRoles())
  };
}

function applyBoardSnap(snap) {
  if (!snap || !state.modes[snap.mode]) return;
  state.modes[snap.mode].pieces = deepClone(snap.pieces);
  state.modes[snap.mode].drawings = deepClone(snap.drawings);
  state.modes[snap.mode].roles = deepClone(snap.roles || emptyRoles());
}

function emptyModeHist() {
  return { stack: [], index: -1 };
}

function ensureHistShape() {
  if (!state._hist || typeof state._hist !== "object" || Array.isArray(state._hist.stack)) {
    state._hist = {};
  }
  for (const m of MODES) {
    if (!state._hist[m] || !Array.isArray(state._hist[m].stack)) {
      state._hist[m] = emptyModeHist();
    }
  }
}

function modeHist(mode = state.currentMode) {
  ensureHistShape();
  return state._hist[mode];
}

/** 各モードの基準状態で履歴を初期化（または指定モードのみ） */
function resetHistory(mode) {
  ensureHistShape();
  const modes = mode ? [mode] : MODES;
  for (const m of modes) {
    state._hist[m] = { stack: [boardSnap(m)], index: 0 };
  }
  updateHistoryButtons();
}

/** 指定モードの現在位置スナップを置き換え（Undo スタックは増やさない） */
function syncHistoryTip(mode) {
  const h = modeHist(mode);
  if (!h.stack.length || h.index < 0) {
    state._hist[mode] = { stack: [boardSnap(mode)], index: 0 };
    return;
  }
  h.stack = h.stack.slice(0, h.index + 1);
  h.stack[h.index] = boardSnap(mode);
}

// ---------- 状態 ----------
let state = createInitialState();
let db = null;
let firestoreReady = false;
let saveTimer = null;
let suppressSave = false;
let toastTimer = null;

// ポインタ操作
let activePointers = new Map();
let pinchStartDist = 0;
let pinchStartZoom = 1;
let drawing = null; // { id, type, ... }
let dragPiece = null; // { id, offsetX, offsetY } or group drag
let benchDrag = null; // ベンチ→コートのドラッグ状態
let liveInkEl = null; // 描画中のライブSVG要素
let eraserSession = null; // ドラッグ消しゴム用
let selectedPieceId = null; // 相手・ボールの選択
let multiSelectedIds = new Set(); // 一括選択中のコマID
let longPressTimer = null;
let marquee = null; // { pointerId, x0, y0, x1, y1 }

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const els = {
  app: $("#app"),
  viewport: $("#board-viewport"),
  stage: $("#board-stage"),
  draw: $("#draw-layer"),
  pieces: $("#pieces-layer"),
  playerPool: $("#player-pool"),
  syncBadge: $("#sync-badge"),
  lockLabel: $("#lock-label"),
  lockLabelPresent: $("#lock-label-present"),
  btnLock: $("#btn-lock"),
  btnLockPresent: $("#btn-lock-present"),
  btnZoomReset: $("#btn-zoom-reset"),
  btnUndo: $("#btn-undo"),
  btnRedo: $("#btn-redo"),
  toast: $("#toast"),
  membersList: $("#members-list"),
  membersHint: $("#members-hint"),
  templateList: $("#template-list"),
  snapshotList: $("#snapshot-list"),
  templateName: $("#template-name"),
  snapshotName: $("#snapshot-name")
};

function board() {
  return state.modes[state.currentMode];
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2200);
}

function getRole(name) {
  const r = board().roles;
  if (r.attackers.includes(name)) return "attacker";
  if (r.outfield.includes(name)) return "outfield";
  if (r.infield.includes(name)) return "infield";
  return "none";
}

function roleClass(name) {
  return `role-${getRole(name)}`;
}

// ---------- 座標変換 ----------
/** クライアント座標 → 論理ボード座標 */
function clientToBoard(clientX, clientY) {
  const rect = els.stage.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * BOARD_W;
  const y = ((clientY - rect.top) / rect.height) * BOARD_H;
  return { x: clamp(x, 0, BOARD_W), y: clamp(y, 0, BOARD_H) };
}

function applyZoom() {
  const z = board().zoom;
  els.stage.style.transform = `scale(${z})`;
  els.btnZoomReset.textContent = `${Math.round(z * 100)}%`;
  layoutSidePanels();
}

function fitStage() {
  const vp = els.viewport;
  const vw = vp.clientWidth;
  const vh = vp.clientHeight;
  if (vw < 10 || vh < 10) return;
  const ratio = BOARD_W / BOARD_H;
  let w = vw;
  let h = w / ratio;
  if (h > vh) {
    h = vh;
    w = h * ratio;
  }
  els.stage.style.width = `${w}px`;
  els.stage.style.height = `${h}px`;
  layoutSidePanels();
}

/** コート左右（または上下）の余白にツール／ベンチを配置 */
function layoutSidePanels() {
  const area = document.querySelector(".board-area");
  const toolbar = document.getElementById("toolbar");
  const bench = document.getElementById("bench-panel");
  if (!area || !els.stage) return;

  const ar = area.getBoundingClientRect();
  const sr = els.stage.getBoundingClientRect();
  const leftGap = Math.max(0, sr.left - ar.left);
  const rightGap = Math.max(0, ar.right - sr.right);
  const topGap = Math.max(0, sr.top - ar.top);
  const bottomGap = Math.max(0, ar.bottom - sr.bottom);
  const useVertical = topGap + bottomGap > leftGap + rightGap + 40;

  area.classList.toggle("gutter-vertical", useVertical);

  const pad = 6;
  if (useVertical) {
    // 上下余白モード：CSSクラスに任せる（幅は自動）
    if (toolbar) {
      toolbar.style.left = `${pad}px`;
      toolbar.style.right = `${pad}px`;
      toolbar.style.top = `${Math.max(pad, 4)}px`;
      toolbar.style.bottom = "auto";
      toolbar.style.width = "";
      toolbar.style.height = "";
      toolbar.style.maxHeight = `${Math.max(48, topGap - pad)}px`;
    }
    if (bench) {
      bench.style.left = `${pad}px`;
      bench.style.right = `${pad}px`;
      bench.style.top = "auto";
      bench.style.bottom = `${pad}px`;
      bench.style.width = "";
      bench.style.height = "";
      bench.style.maxHeight = `${Math.max(100, bottomGap - pad)}px`;
    }
  } else {
    // 左右余白モード：余白幅いっぱいにパネルを置く
    const toolW = Math.max(44, Math.min(72, leftGap - pad * 2));
    const benchW = Math.max(120, Math.min(220, rightGap - pad * 2));
    if (toolbar) {
      toolbar.style.left = `${Math.max(pad, (leftGap - toolW) / 2)}px`;
      toolbar.style.right = "auto";
      toolbar.style.top = `${pad}px`;
      toolbar.style.bottom = "auto";
      toolbar.style.width = `${toolW}px`;
      toolbar.style.height = "auto";
      toolbar.style.maxHeight = `calc(100% - ${pad * 2}px)`;
    }
    if (bench) {
      const bw = benchW;
      bench.style.right = `${Math.max(pad, (rightGap - bw) / 2)}px`;
      bench.style.left = "auto";
      bench.style.top = `${pad}px`;
      bench.style.bottom = `${pad}px`;
      bench.style.width = `${bw}px`;
      bench.style.height = "";
      bench.style.maxHeight = "";
    }
  }
  syncExpandButtonPositions();
}

/** 展開ボタンを、折りたたみボタンと同じ位置に合わせる */
function syncExpandButtonPositions() {
  const area = document.querySelector(".board-area");
  const toolbar = document.getElementById("toolbar");
  const bench = document.getElementById("bench-panel");
  const expandTools = document.getElementById("btn-expand-tools");
  const expandBench = document.getElementById("btn-expand-bench");
  if (!area) return;

  const vertical = area.classList.contains("gutter-vertical");

  if (expandTools && toolbar) {
    // ツールバーの配置（折りたたみ時の transform に依存しない）
    // ※ transform は CSS の is-visible アニメに任せる
    expandTools.style.left = toolbar.style.left || "6px";
    expandTools.style.top = toolbar.style.top || "8px";
    expandTools.style.right = "auto";
    expandTools.style.bottom = "auto";
    expandTools.style.removeProperty("transform");
    expandTools.style.width = vertical ? "44px" : (toolbar.style.width || "48px");
    expandTools.style.height = "36px";
  }

  if (expandBench && bench) {
    expandBench.style.left = "auto";
    expandBench.style.right = bench.style.right || "6px";
    expandBench.style.removeProperty("transform");
    expandBench.style.width = "34px";
    expandBench.style.height = "34px";
    if (vertical) {
      expandBench.style.top = "auto";
      expandBench.style.bottom = bench.style.bottom || "6px";
    } else {
      expandBench.style.top = bench.style.top || "8px";
      expandBench.style.bottom = "auto";
    }
  }
}

function setZoom(z, save = true) {
  board().zoom = clamp(z, 0.5, 3);
  applyZoom();
  if (save) scheduleSave();
}

// ---------- 履歴（モードごと・今見ているモードだけ Undo） ----------
function pushHistory(mode = state.currentMode) {
  const h = modeHist(mode);
  const snap = boardSnap(mode);
  h.stack = h.stack.slice(0, h.index + 1);
  h.stack.push(snap);
  if (h.stack.length > 120) {
    const drop = h.stack.length - 120;
    h.stack.splice(0, drop);
    h.index = h.stack.length - 1;
  } else {
    h.index++;
  }
  updateHistoryButtons();
}

function canUndo() {
  const h = modeHist();
  return h.index > 0;
}

function canRedo() {
  const h = modeHist();
  return h.index >= 0 && h.index < h.stack.length - 1;
}

function undo() {
  if (!canUndo()) return;
  const h = modeHist();
  h.index--;
  applyBoardSnap(h.stack[h.index]);
  renderPieces();
  renderDrawings();
  renderPlayerPool();
  updateHistoryButtons();
  scheduleSave();
}

function redo() {
  if (!canRedo()) return;
  const h = modeHist();
  h.index++;
  applyBoardSnap(h.stack[h.index]);
  renderPieces();
  renderDrawings();
  renderPlayerPool();
  updateHistoryButtons();
  scheduleSave();
}

function updateHistoryButtons() {
  if (els.btnUndo) els.btnUndo.disabled = !canUndo();
  if (els.btnRedo) els.btnRedo.disabled = !canRedo();
}

/**
 * 陣形コピー（コマ・役割のみ。描画・ズームはコピーしない）
 * コピー元は必ず今開いているモード。コピー先モードの Undo で戻せる。
 */
function copyFormation(from, to) {
  if (!MODES.includes(from) || !MODES.includes(to) || from === to) return;
  if (from !== state.currentMode) {
    toast("今開いているモードの陣形だけコピーできます");
    return;
  }
  const src = state.modes[from];
  const dst = state.modes[to];
  if (isBoardUnset(src)) {
    toast(`${MODE_LABEL[from]}にコピーする陣形がありません`);
    return;
  }
  if (!isBoardUnset(dst)) {
    if (!confirm(`${MODE_LABEL[to]}の陣形を上書きしますか？（描画はそのまま残ります）`)) return;
  }
  dst.pieces = deepClone(src.pieces);
  dst.roles = deepClone(src.roles || emptyRoles());
  pushHistory(to);
  if (state.currentMode === to) {
    renderPieces();
    renderPlayerPool();
  }
  scheduleSave();
  toast(`${MODE_LABEL[from]} → ${MODE_LABEL[to]} に陣形をコピーしました`);
}

function renderCopyFormationMenu() {
  const menu = $("#copy-formation-menu");
  if (!menu) return;
  const from = state.currentMode;
  menu.innerHTML = "";
  for (const to of MODES) {
    if (to === from) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.dataset.from = from;
    btn.dataset.to = to;
    btn.textContent = `→ ${MODE_LABEL[to]}`;
    btn.addEventListener("click", () => {
      setCopyMenuOpen(false);
      copyFormation(from, to);
    });
    menu.appendChild(btn);
  }
}

function setCopyMenuOpen(open) {
  const menu = $("#copy-formation-menu");
  const btn = $("#btn-copy-formation");
  if (!menu || !btn) return;
  if (open) renderCopyFormationMenu();
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function pointsToSmoothPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  d += ` Q ${prev.x} ${prev.y} ${last.x} ${last.y}`;
  return d;
}

function applyInkAttrs(el, color, width, opacity = 1) {
  el.setAttribute("stroke", color);
  el.setAttribute("stroke-width", width);
  el.setAttribute("fill", "none");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.setAttribute("stroke-opacity", clamp(opacity, 0.05, 1));
}

// ---------- 描画 SVG ----------
function renderDrawings() {
  const svg = els.draw;
  svg.innerHTML = `<defs></defs>`;
  for (const d of board().drawings) {
    svg.appendChild(createShapeEl(d));
  }
  if (drawing?.preview) {
    const preview = createShapeEl(drawing.preview);
    preview.style.opacity = "0.85";
    svg.appendChild(preview);
    liveInkEl = preview.querySelector("path, line, ellipse, polyline");
  } else {
    liveInkEl = null;
  }
  updateDrawLayerClass();
}

function updateLiveInk() {
  if (!drawing?.preview || !liveInkEl) {
    renderDrawings();
    return;
  }
  const d = drawing.preview;
  if ((d.type === "pen" || (d.type === "arrow" && d.free)) && liveInkEl.tagName === "path") {
    liveInkEl.setAttribute("d", pointsToSmoothPath(d.points));
    if (d.type === "arrow" && d.free) {
      liveInkEl.setAttribute("marker-end", `url(#${ensureMarker(d.color)})`);
    }
  } else if ((d.type === "line" || (d.type === "arrow" && !d.free)) && liveInkEl.tagName === "line") {
    liveInkEl.setAttribute("x1", d.x1);
    liveInkEl.setAttribute("y1", d.y1);
    liveInkEl.setAttribute("x2", d.x2);
    liveInkEl.setAttribute("y2", d.y2);
    if (d.type === "arrow") {
      liveInkEl.setAttribute("marker-end", `url(#${ensureMarker(d.color)})`);
    }
  } else if (d.type === "ellipse" && liveInkEl.tagName === "ellipse") {
    liveInkEl.setAttribute("cx", d.cx);
    liveInkEl.setAttribute("cy", d.cy);
    liveInkEl.setAttribute("rx", Math.abs(d.rx));
    liveInkEl.setAttribute("ry", Math.abs(d.ry));
  } else {
    renderDrawings();
  }
}

function updateDrawLayerClass() {
  const hidden = state.drawingsVisible === false ? " drawings-hidden" : "";
  els.draw.setAttribute("class", `draw-layer tool-${state.tool}${hidden}`);
  if (isPieceTool()) {
    els.draw.style.pointerEvents = "none";
  } else {
    els.draw.style.pointerEvents = state.drawingsVisible === false ? "none" : "auto";
  }
  document.body.classList.toggle("ink-tool", !isPieceTool());
  document.body.classList.toggle("tool-eraser", state.tool === "eraser");
  document.body.classList.toggle("tool-multiselect", state.tool === "multiselect");
}

function ensureMarker(color) {
  const id = `arrowhead-${String(color).replace("#", "")}`;
  let m = document.getElementById(id);
  if (!m) {
    const defs = els.draw.querySelector("defs") || els.draw.appendChild(
      document.createElementNS("http://www.w3.org/2000/svg", "defs")
    );
    m = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    m.id = id;
    m.setAttribute("markerWidth", "8");
    m.setAttribute("markerHeight", "8");
    m.setAttribute("refX", "6");
    m.setAttribute("refY", "3");
    m.setAttribute("orient", "auto");
    m.setAttribute("markerUnits", "strokeWidth");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M0,0 L6,3 L0,6 Z");
    p.setAttribute("fill", color);
    m.appendChild(p);
    defs.appendChild(m);
  }
  return id;
}

function createShapeEl(d) {
  const ns = "http://www.w3.org/2000/svg";
  const color = d.color || "#ff3b30";
  const width = d.width || state.penWidth || 3.5;
  const g = document.createElementNS(ns, "g");
  g.classList.add("shape");
  g.dataset.id = d.id;

  let el;
  if (d.type === "pen" || (d.type === "arrow" && d.free && d.points)) {
    el = document.createElementNS(ns, "path");
    el.setAttribute("d", pointsToSmoothPath(d.points || []));
    if (d.type === "arrow") {
      el.setAttribute("marker-end", `url(#${ensureMarker(color)})`);
    }
  } else if (d.type === "line" || d.type === "arrow") {
    el = document.createElementNS(ns, "line");
    el.setAttribute("x1", d.x1); el.setAttribute("y1", d.y1);
    el.setAttribute("x2", d.x2); el.setAttribute("y2", d.y2);
    if (d.type === "arrow") {
      el.setAttribute("marker-end", `url(#${ensureMarker(color)})`);
    }
  } else if (d.type === "ellipse") {
    el = document.createElementNS(ns, "ellipse");
    el.setAttribute("cx", d.cx); el.setAttribute("cy", d.cy);
    el.setAttribute("rx", Math.abs(d.rx)); el.setAttribute("ry", Math.abs(d.ry));
  } else {
    return g;
  }

  applyInkAttrs(el, color, width, d.opacity ?? 1);
  el.style.pointerEvents = "none";
  g.appendChild(el);

  return g;
}

function eraseDrawing(id) {
  const before = board().drawings.length;
  board().drawings = board().drawings.filter((d) => d.id !== id);
  if (board().drawings.length !== before) {
    pushHistory();
    renderDrawings();
    scheduleSave();
  }
}

/** なぞった付近だけ消す（図形全体は消さない） */
function eraseNearPoint(pt) {
  const hitR = Math.max(state.penWidth * 5, 14);
  let changed = false;
  const next = [];

  for (const d of board().drawings) {
    const parts = eraseShapePartial(d, pt, hitR);
    if (parts === null) {
      changed = true;
      continue;
    }
    if (parts.length === 1 && parts[0] === d) {
      next.push(d);
    } else {
      changed = true;
      next.push(...parts);
    }
  }

  if (changed) {
    board().drawings = next;
    renderDrawings();
    return true;
  }
  return false;
}

function eraseShapePartial(d, pt, r) {
  if (d.type === "pen" || (d.type === "arrow" && d.free && Array.isArray(d.points))) {
    return eraseStrokePoints(d, pt, r);
  }
  if (d.type === "line" || d.type === "arrow") {
    return eraseStraightPartial(d, pt, r);
  }
  if (d.type === "ellipse") {
    // 楕円は点列に分解して部分消去
    const sampled = {
      ...d,
      type: "pen",
      points: sampleEllipsePoints(d, 56)
    };
    delete sampled.cx;
    delete sampled.cy;
    delete sampled.rx;
    delete sampled.ry;
    return eraseStrokePoints(sampled, pt, r);
  }
  return [d];
}

function sampleEllipsePoints(d, n = 48) {
  const pts = [];
  const rx = Math.abs(d.rx) || 1;
  const ry = Math.abs(d.ry) || 1;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({
      x: d.cx + Math.cos(a) * rx,
      y: d.cy + Math.sin(a) * ry
    });
  }
  // 閉じる
  pts.push({ ...pts[0] });
  return pts;
}

function eraseStrokePoints(d, pt, r) {
  const pts = d.points || [];
  if (pts.length < 2) {
    return pts.some((p) => dist(p, pt) <= r) ? null : [d];
  }

  let anyRemoved = false;
  const keep = pts.map((p) => {
    const ok = dist(p, pt) > r;
    if (!ok) anyRemoved = true;
    return ok;
  });
  if (!anyRemoved) return [d];

  const segments = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) {
      cur.push({ x: pts[i].x, y: pts[i].y });
    } else if (cur.length) {
      if (cur.length >= 2) segments.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) segments.push(cur);
  if (!segments.length) return null;

  return segments.map((seg, i) => {
    const shape = deepClone(d);
    shape.id = i === 0 ? d.id : uid();
    shape.type = d.type === "arrow" && d.free ? "arrow" : "pen";
    if (shape.type === "arrow") shape.free = true;
    shape.points = seg;
    return shape;
  });
}

/** 直線・直線矢印の一部を削る */
function eraseStraightPartial(d, pt, r) {
  const a = { x: d.x1, y: d.y1 };
  const b = { x: d.x2, y: d.y2 };
  const len = dist(a, b);
  if (len < 1) return dist(pt, a) <= r ? null : [d];

  const dx = (b.x - a.x) / len;
  const dy = (b.y - a.y) / len;
  const t = clamp((pt.x - a.x) * dx + (pt.y - a.y) * dy, 0, len);
  const closest = { x: a.x + dx * t, y: a.y + dy * t };
  if (dist(pt, closest) > r) return [d];

  const eraseHalf = Math.max(r * 1.15, 10);
  const t0 = t - eraseHalf;
  const t1 = t + eraseHalf;
  const parts = [];

  if (t0 > 10) {
    const left = deepClone(d);
    left.id = uid();
    left.x1 = a.x;
    left.y1 = a.y;
    left.x2 = a.x + dx * t0;
    left.y2 = a.y + dy * t0;
    // 矢印の手前側はただの線に
    if (left.type === "arrow") {
      left.type = "line";
      delete left.free;
    }
    parts.push(left);
  }
  if (len - t1 > 10) {
    const right = deepClone(d);
    right.id = parts.length ? uid() : d.id;
    right.x1 = a.x + dx * t1;
    right.y1 = a.y + dy * t1;
    right.x2 = b.x;
    right.y2 = b.y;
    parts.push(right);
  }

  if (!parts.length) return null;
  if (parts.length === 1) parts[0].id = d.id;
  return parts;
}

/** 消しゴムでコマの上を擦っているとき案内 */
function noteEraserOverPiece(pt) {
  if (!eraserSession) return;
  const hitR = 48;
  const over = board().pieces.some((p) => dist(p, pt) <= hitR);
  if (!over) return;
  eraserSession.pieceHits = (eraserSession.pieceHits || 0) + 1;
  if (eraserSession.pieceHits < 10) return;
  const now = Date.now();
  if (now - (eraserSession.lastHint || 0) < 4500) return;
  eraserSession.lastHint = now;
  eraserSession.pieceHits = 0;
  toast("消しゴムモードです。消えるのは描画だけです（コマは選択ツールで移動）");
}

function shapeHitsPoint(d, pt, r) {
  if (d.type === "pen" || (d.type === "arrow" && d.free && d.points)) {
    return (d.points || []).some((p) => dist(p, pt) <= r);
  }
  if (d.type === "line" || d.type === "arrow") {
    return distToSegment(pt, { x: d.x1, y: d.y1 }, { x: d.x2, y: d.y2 }) <= r;
  }
  if (d.type === "ellipse") {
    const nx = (pt.x - d.cx) / Math.max(Math.abs(d.rx), 1);
    const ny = (pt.y - d.cy) / Math.max(Math.abs(d.ry), 1);
    const ring = Math.hypot(nx, ny);
    return Math.abs(ring - 1) * Math.max(Math.abs(d.rx), Math.abs(d.ry)) <= r;
  }
  return false;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

// ---------- コマ描画 ----------
function pieceAnimKey(p) {
  if (p.kind === "player") return `player:${p.name}`;
  return `${p.kind}:${p.id}`;
}

function capturePiecePositions(pieces) {
  const map = new Map();
  for (const p of pieces || []) {
    map.set(pieceAnimKey(p), { x: p.x, y: p.y });
  }
  return map;
}

function renderPieces() {
  const layer = els.pieces;
  layer.classList.remove("animating");
  layer.innerHTML = "";
  for (const p of board().pieces) {
    layer.appendChild(createPieceEl(p));
  }
}

/** モード切替時など、前位置から新位置へスムーズに移動 */
function renderPiecesAnimated(prevPos) {
  renderPieces();
  if (!prevPos || !prevPos.size) return;

  const layer = els.pieces;
  layer.classList.add("animating");
  const targets = [];

  for (const p of board().pieces) {
    const el = layer.querySelector(`[data-id="${p.id}"]`);
    if (!el) continue;
    const prev = prevPos.get(pieceAnimKey(p));
    if (!prev) {
      el.classList.add("piece-enter");
      targets.push({ el, enter: true, x: p.x, y: p.y });
      continue;
    }
    if (Math.hypot(prev.x - p.x, prev.y - p.y) < 0.8) continue;
    el.style.transition = "none";
    el.style.left = `${(prev.x / BOARD_W) * 100}%`;
    el.style.top = `${(prev.y / BOARD_H) * 100}%`;
    targets.push({ el, enter: false, x: p.x, y: p.y });
  }

  if (!targets.length) {
    layer.classList.remove("animating");
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const t of targets) {
        if (t.enter) {
          t.el.classList.add("piece-enter-active");
        } else {
          t.el.style.transition = "";
          t.el.style.left = `${(t.x / BOARD_W) * 100}%`;
          t.el.style.top = `${(t.y / BOARD_H) * 100}%`;
        }
      }
      window.setTimeout(() => {
        layer.classList.remove("animating");
        for (const t of targets) {
          t.el.classList.remove("piece-enter", "piece-enter-active");
          t.el.style.transition = "";
        }
      }, 520);
    });
  });
}

function createPieceEl(p) {
  const el = document.createElement("div");
  el.className = `piece piece-${p.kind}`;
  el.dataset.id = p.id;
  el.style.left = `${(p.x / BOARD_W) * 100}%`;
  el.style.top = `${(p.y / BOARD_H) * 100}%`;

  if (p.kind === "player") {
    el.classList.add(roleClass(p.name));
    const name = document.createElement("div");
    name.className = "name";
    for (const part of splitName(p.name)) {
      const span = document.createElement("span");
      span.textContent = part;
      name.appendChild(span);
    }
    el.appendChild(name);
    el.title = p.name;
  }

  if (isPieceVisuallyLocked(p)) el.classList.add("locked");
  if (p.kind === "ball" && p.locked) el.classList.add("piece-locked");
  if (selectedPieceId === p.id) el.classList.add("selected-piece");
  if (multiSelectedIds.has(p.id)) el.classList.add("multi-selected");

  // 選択／一括選択時のみコマ操作可能
  el.style.pointerEvents = isPieceTool() ? "auto" : "none";

  el.addEventListener("pointerdown", onPiecePointerDown);
  return el;
}

/** 全体のコマ固定は選手・相手のみ対象（ボールは除外） */
function isPieceGloballyFrozen(piece) {
  if (!piece) return true;
  if (piece.kind === "ball") return false;
  return Boolean(state.piecesLocked);
}

/** ボール単体の固定 */
function isPieceIndividuallyLocked(piece) {
  return Boolean(piece?.locked);
}

function isPieceMovable(piece) {
  if (!piece) return false;
  if (isPieceIndividuallyLocked(piece)) return false;
  if (isPieceGloballyFrozen(piece)) return false;
  return true;
}

function isPieceVisuallyLocked(piece) {
  return isPieceIndividuallyLocked(piece) || isPieceGloballyFrozen(piece);
}

function toggleBallLock(id) {
  const p = board().pieces.find((x) => x.id === id);
  if (!p || p.kind !== "ball") return;
  p.locked = !p.locked;
  pushHistory();
  renderPieces();
  scheduleSave();
  toast(p.locked ? "ボールを固定しました" : "ボールの固定を解除しました");
  requestAnimationFrame(() => {
    const el = els.pieces.querySelector(`[data-id="${id}"]`);
    if (el) showPieceActions(p, el);
  });
}

function removePiece(id) {
  const before = board().pieces.length;
  board().pieces = board().pieces.filter((p) => p.id !== id);
  if (board().pieces.length === before) return;
  if (selectedPieceId === id) hidePieceActions();
  multiSelectedIds.delete(id);
  pushHistory();
  renderPieces();
  renderPlayerPool();
  scheduleSave();
}

function duplicatePiece(id) {
  const src = board().pieces.find((p) => p.id === id);
  if (!src || src.kind === "player") return;
  const copy = deepClone(src);
  copy.id = uid();
  copy.x = clamp(src.x + 36, 0, BOARD_W);
  copy.y = clamp(src.y + 36, 0, BOARD_H);
  if (copy.kind === "ball") copy.locked = false;
  board().pieces.push(copy);
  pushHistory();
  selectedPieceId = copy.id;
  renderPieces();
  scheduleSave();
  // 新しいコマの位置にメニューを出す
  requestAnimationFrame(() => {
    const el = els.pieces.querySelector(`[data-id="${copy.id}"]`);
    if (el) showPieceActions(copy, el);
  });
}

function showPieceActions(piece, pieceEl) {
  const menu = $("#piece-actions");
  if (!menu) return;
  selectedPieceId = piece.id;
  const rect = pieceEl.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = `${rect.left + rect.width / 2}px`;
  menu.style.top = `${Math.max(12, rect.top - 8)}px`;
  menu.dataset.pieceId = piece.id;

  const lockBtn = menu.querySelector('[data-act="lock"]');
  if (lockBtn) {
    const isBall = piece.kind === "ball";
    lockBtn.hidden = !isBall;
    if (isBall) {
      lockBtn.textContent = piece.locked ? "固定解除" : "固定";
      lockBtn.classList.toggle("is-locked", Boolean(piece.locked));
    }
  }

  $$(".piece").forEach((el) => {
    el.classList.toggle("selected-piece", el.dataset.id === piece.id);
  });
}

function hidePieceActions() {
  selectedPieceId = null;
  const menu = $("#piece-actions");
  if (menu) {
    menu.hidden = true;
    delete menu.dataset.pieceId;
  }
  $$(".piece.selected-piece").forEach((el) => el.classList.remove("selected-piece"));
}

function isPieceTool() {
  return state.tool === "select" || state.tool === "multiselect";
}

function clearLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function syncMultiSelectVisual() {
  $$(".piece").forEach((el) => {
    el.classList.toggle("multi-selected", multiSelectedIds.has(el.dataset.id));
  });
  updateMultiSelectActions();
}

function updateMultiSelectActions() {
  const box = $("#multi-select-actions");
  if (!box) return;
  const open = state.tool === "multiselect";
  box.hidden = false;
  box.classList.toggle("is-open", open);
  box.setAttribute("aria-hidden", open ? "false" : "true");
}

function clearMultiSelection() {
  multiSelectedIds.clear();
  syncMultiSelectVisual();
}

function selectAllPieces() {
  multiSelectedIds = new Set(board().pieces.map((p) => p.id));
  syncMultiSelectVisual();
  toast(`${multiSelectedIds.size}個を選択`);
}

function toggleMultiSelectId(id) {
  if (multiSelectedIds.has(id)) multiSelectedIds.delete(id);
  else multiSelectedIds.add(id);
  syncMultiSelectVisual();
}

function enterMultiSelectWith(id) {
  state.tool = "multiselect";
  hideInkStylePopover();
  hidePieceActions();
  multiSelectedIds = new Set(id ? [id] : []);
  updateToolUI();
  updateDrawLayerClass();
  els.pieces.querySelectorAll(".piece").forEach((el) => {
    el.style.pointerEvents = "auto";
  });
  syncMultiSelectVisual();
  toast("一括選択モード");
}

function hideMarquee() {
  marquee = null;
  const el = $("#marquee-rect");
  if (el) {
    el.hidden = true;
    el.style.width = "0";
    el.style.height = "0";
  }
}

function updateMarqueeEl() {
  const el = $("#marquee-rect");
  if (!el || !marquee) return;
  const x = Math.min(marquee.x0, marquee.x1);
  const y = Math.min(marquee.y0, marquee.y1);
  const w = Math.abs(marquee.x1 - marquee.x0);
  const h = Math.abs(marquee.y1 - marquee.y0);
  el.hidden = false;
  el.style.left = `${(x / BOARD_W) * 100}%`;
  el.style.top = `${(y / BOARD_H) * 100}%`;
  el.style.width = `${(w / BOARD_W) * 100}%`;
  el.style.height = `${(h / BOARD_H) * 100}%`;
}

function applyMarqueeSelection() {
  if (!marquee) return;
  const x0 = Math.min(marquee.x0, marquee.x1);
  const y0 = Math.min(marquee.y0, marquee.y1);
  const x1 = Math.max(marquee.x0, marquee.x1);
  const y1 = Math.max(marquee.y0, marquee.y1);
  // 小さすぎる矩形は「空き地タップ」扱い → 解除
  if (x1 - x0 < 8 && y1 - y0 < 8) {
    clearMultiSelection();
    return;
  }
  multiSelectedIds = new Set(
    board().pieces
      .filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)
      .map((p) => p.id)
  );
  syncMultiSelectVisual();
  if (multiSelectedIds.size) toast(`${multiSelectedIds.size}個を選択`);
}

function onPiecePointerDown(e) {
  if (!isPieceTool()) return;
  if (e.button !== undefined && e.button !== 0) return;

  e.preventDefault();
  e.stopPropagation();

  const el = e.currentTarget;
  const id = el.dataset.id;
  const piece = board().pieces.find((p) => p.id === id);
  if (!piece) return;

  if (activePointers.size >= 1 && e.pointerType === "touch") return;

  const canMove = isPieceMovable(piece);

  // 動かせないコマ：選択ツールならタップでメニュー（相手・ボール）
  if (!canMove) {
    if (isPieceGloballyFrozen(piece) && (piece.kind === "player" || piece.kind === "opponent")) {
      toast("コマが固定されています。「配置編集」に切り替えてください");
      return;
    }
    if (piece.kind === "ball" && isPieceIndividuallyLocked(piece) && state.tool === "multiselect") {
      toast("このボールは個別に固定されています");
      return;
    }
    if (state.tool === "select" && (piece.kind === "ball" || piece.kind === "opponent")) {
      clearLongPress();
      hideMarquee();
      dragPiece = {
        id,
        ids: [id],
        starts: { [id]: { x: piece.x, y: piece.y } },
        kind: piece.kind,
        offsetX: 0,
        offsetY: 0,
        moved: false,
        startX: piece.x,
        startY: piece.y,
        pointerStartX: e.clientX,
        pointerStartY: e.clientY,
        pendingReplace: false,
        willToggle: false,
        isMulti: false,
        moveLocked: true
      };
      el.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        if (!dragPiece || dragPiece.id !== id) return;
        const travel = Math.hypot(
          ev.clientX - dragPiece.pointerStartX,
          ev.clientY - dragPiece.pointerStartY
        );
        if (travel > 8) dragPiece.moved = true;
      };
      const onUp = (ev) => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
        const moved = dragPiece?.moved;
        dragPiece = null;
        if (!moved) {
          if (selectedPieceId === id) hidePieceActions();
          else showPieceActions(piece, el);
        }
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    }
    return;
  }

  clearLongPress();
  hideMarquee();

  const pt = clientToBoard(e.clientX, e.clientY);
  const isMulti = state.tool === "multiselect";

  // 通常選択中：2秒長押しで一括選択へ
  if (state.tool === "select") {
    longPressTimer = setTimeout(() => {
      if (dragPiece?.id === id && !dragPiece.moved) {
        enterMultiSelectWith(id);
        dragPiece.ids = [id];
        dragPiece.starts = { [id]: { x: piece.x, y: piece.y } };
        dragPiece.pendingReplace = false;
        dragPiece.willToggle = false;
        dragPiece.isMulti = true;
        syncMultiSelectVisual();
      }
    }, 2000);
  }

  let ids;
  let pendingReplace = false;
  let willToggle = false;

  if (isMulti) {
    willToggle = true;
    if (multiSelectedIds.has(id)) {
      ids = [...multiSelectedIds].filter((pid) => {
        const p = board().pieces.find((x) => x.id === pid);
        return p && isPieceMovable(p);
      });
      if (!ids.includes(id)) ids.push(id);
      pendingReplace = false;
    } else {
      ids = [id];
      pendingReplace = true;
    }
  } else {
    ids = [id];
  }

  const starts = {};
  for (const pid of ids) {
    const p = board().pieces.find((x) => x.id === pid);
    if (p) starts[pid] = { x: p.x, y: p.y };
  }

  dragPiece = {
    id,
    ids,
    starts,
    kind: piece.kind,
    offsetX: piece.x - pt.x,
    offsetY: piece.y - pt.y,
    moved: false,
    startX: piece.x,
    startY: piece.y,
    pointerStartX: e.clientX,
    pointerStartY: e.clientY,
    pendingReplace,
    willToggle,
    isMulti,
    moveLocked: false
  };

  el.classList.add("dragging");
  el.setPointerCapture(e.pointerId);
  setBenchDropHighlight(false);

  const onMove = (ev) => {
    if (!dragPiece || dragPiece.id !== id) return;
    ev.preventDefault();
    const travel = Math.hypot(
      ev.clientX - dragPiece.pointerStartX,
      ev.clientY - dragPiece.pointerStartY
    );
    if (travel > 8) {
      dragPiece.moved = true;
      dragPiece.willToggle = false;
      clearLongPress();
      if (dragPiece.pendingReplace) {
        multiSelectedIds = new Set([id]);
        dragPiece.ids = [id];
        dragPiece.starts = { [id]: { x: dragPiece.startX, y: dragPiece.startY } };
        dragPiece.pendingReplace = false;
        syncMultiSelectVisual();
      }
    }

    const overBench = isOverBench(ev.clientX, ev.clientY);
    const singlePlayer = dragPiece.ids.length === 1 && piece.kind === "player";
    setBenchDropHighlight(overBench && singlePlayer && !dragPiece.isMulti);

    if (overBench && singlePlayer && !dragPiece.isMulti) {
      el.style.opacity = "0.35";
      return;
    }
    el.style.opacity = "";

    const p = clientToBoard(ev.clientX, ev.clientY);
    const anchorX = clamp(p.x + dragPiece.offsetX, 0, BOARD_W);
    const anchorY = clamp(p.y + dragPiece.offsetY, 0, BOARD_H);
    const dx = anchorX - dragPiece.startX;
    const dy = anchorY - dragPiece.startY;

    for (const pid of dragPiece.ids) {
      const pc = board().pieces.find((x) => x.id === pid);
      const st = dragPiece.starts[pid];
      if (!pc || !st || !isPieceMovable(pc)) continue;
      pc.x = clamp(st.x + dx, 0, BOARD_W);
      pc.y = clamp(st.y + dy, 0, BOARD_H);
      const node = els.pieces.querySelector(`[data-id="${pid}"]`);
      if (node) {
        node.style.left = `${(pc.x / BOARD_W) * 100}%`;
        node.style.top = `${(pc.y / BOARD_H) * 100}%`;
      }
    }

    if (selectedPieceId === id) {
      showPieceActions(piece, el);
    }
  };

  const onUp = (ev) => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.classList.remove("dragging");
    el.style.opacity = "";
    try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
    setBenchDropHighlight(false);
    clearLongPress();

    const returnToBench = !dragPiece?.isMulti
      && piece.kind === "player"
      && isOverBench(ev.clientX, ev.clientY);
    const moved = dragPiece?.moved;
    const willToggle = dragPiece?.willToggle;
    const wasMulti = dragPiece?.isMulti || state.tool === "multiselect";
    dragPiece = null;

    if (returnToBench) {
      hidePieceActions();
      removePiece(id);
      toast("ベンチに戻しました");
      return;
    }

    if (wasMulti && willToggle && !moved) {
      toggleMultiSelectId(id);
      return;
    }

    if (!wasMulti && !moved && (piece.kind === "opponent" || piece.kind === "ball")) {
      if (selectedPieceId === id) {
        hidePieceActions();
      } else {
        showPieceActions(piece, el);
      }
      return;
    }

    if (piece.kind === "player") hidePieceActions();

    if (moved) {
      hidePieceActions();
      pushHistory();
      scheduleSave();
    }
  };

  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
}

function isOverBench(clientX, clientY) {
  const bench = document.querySelector("#bench-panel");
  if (!bench || bench.classList.contains("collapsed")) return false;
  if (bench.offsetParent === null && getComputedStyle(bench).display === "none") return false;
  const r = bench.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return false;
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

function isOverCourt(clientX, clientY) {
  const r = els.viewport.getBoundingClientRect();
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

function setBenchDropHighlight(on) {
  const pool = els.playerPool;
  const bench = document.querySelector("#bench-panel");
  pool?.classList.toggle("drop-hover", on);
  bench?.classList.toggle("drop-hover", on);
}

function setCourtDropHighlight(on) {
  els.viewport?.classList.toggle("drop-hover", on);
}

function createPlayerGhost(name, role) {
  const ghost = document.createElement("div");
  ghost.className = `drag-ghost role-${role}`;
  ghost.style.background =
    role === "attacker" ? "var(--piece-attacker)"
      : role === "outfield" ? "var(--piece-outfield)"
        : role === "infield" ? "var(--piece-infield)"
          : "#d1d1d6";
  const nameEl = document.createElement("div");
  nameEl.className = "name";
  for (const part of splitName(name)) {
    const span = document.createElement("span");
    span.textContent = part;
    nameEl.appendChild(span);
  }
  ghost.appendChild(nameEl);
  document.body.appendChild(ghost);
  return ghost;
}

function moveGhost(ghost, clientX, clientY) {
  if (!ghost) return;
  ghost.style.left = `${clientX}px`;
  ghost.style.top = `${clientY}px`;
}

// ---------- プレイヤープール ----------
function renderPlayerPool() {
  const onBoard = new Set(
    board().pieces.filter((p) => p.kind === "player").map((p) => p.name)
  );
  els.playerPool.innerHTML = "";
  for (const name of ROSTER) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pool-chip ${roleClass(name)}`;
    if (onBoard.has(name)) btn.classList.add("on-board");
    btn.textContent = name.replace(/[\s\u3000]/g, "");
    btn.title = onBoard.has(name)
      ? `${name}（配置済み・コートからドラッグで戻せます）`
      : `${name}（コートへドラッグ）`;
    btn.dataset.name = name;
    if (!onBoard.has(name)) {
      btn.addEventListener("pointerdown", onBenchPointerDown);
    }
    els.playerPool.appendChild(btn);
  }
}

function onBenchPointerDown(e) {
  if (state.piecesLocked) return;
  if (state.tool !== "select") {
    toast("選択ツールに切り替えてから配置してください");
    return;
  }
  if (e.button !== undefined && e.button !== 0) return;

  const btn = e.currentTarget;
  const name = btn.dataset.name;
  if (!name || board().pieces.some((p) => p.kind === "player" && p.name === name)) return;

  e.preventDefault();
  btn.setPointerCapture(e.pointerId);
  btn.classList.add("dragging-source");

  benchDrag = {
    name,
    role: getRole(name),
    startX: e.clientX,
    startY: e.clientY,
    dragging: false,
    ghost: null,
    btn
  };

  const onMove = (ev) => {
    if (!benchDrag) return;
    ev.preventDefault();
    const dx = ev.clientX - benchDrag.startX;
    const dy = ev.clientY - benchDrag.startY;
    if (!benchDrag.dragging && Math.hypot(dx, dy) > 8) {
      benchDrag.dragging = true;
      benchDrag.ghost = createPlayerGhost(benchDrag.name, benchDrag.role);
    }
    if (benchDrag.dragging) {
      moveGhost(benchDrag.ghost, ev.clientX, ev.clientY);
      setCourtDropHighlight(isOverCourt(ev.clientX, ev.clientY));
    }
  };

  const onUp = (ev) => {
    btn.removeEventListener("pointermove", onMove);
    btn.removeEventListener("pointerup", onUp);
    btn.removeEventListener("pointercancel", onUp);
    try { btn.releasePointerCapture(ev.pointerId); } catch (_) {}
    btn.classList.remove("dragging-source");
    setCourtDropHighlight(false);

    const drag = benchDrag;
    benchDrag = null;
    if (drag?.ghost) drag.ghost.remove();

    if (!drag) return;

    if (drag.dragging) {
      if (isOverCourt(ev.clientX, ev.clientY)) {
        const pt = clientToBoard(ev.clientX, ev.clientY);
        addPlayerAt(drag.name, pt.x, pt.y);
      }
      return;
    }

    // タップ：中央付近に配置
    addPlayer(drag.name);
  };

  btn.addEventListener("pointermove", onMove);
  btn.addEventListener("pointerup", onUp);
  btn.addEventListener("pointercancel", onUp);
}

function addPlayerAt(name, x, y) {
  if (board().pieces.some((p) => p.kind === "player" && p.name === name)) {
    toast("すでに配置されています");
    return;
  }
  board().pieces.push({
    id: uid(),
    kind: "player",
    name,
    x: clamp(x, 0, BOARD_W),
    y: clamp(y, 0, BOARD_H)
  });
  pushHistory();
  renderPieces();
  renderPlayerPool();
  seedEmptyModesFrom(state.currentMode);
  scheduleSave();
}

function addPlayer(name) {
  if (board().pieces.some((p) => p.kind === "player" && p.name === name)) {
    toast("すでに配置されています");
    return;
  }
  const count = board().pieces.filter((p) => p.kind === "player").length;
  addPlayerAt(
    name,
    180 + (count % 4) * 100,
    280 + Math.floor(count / 4) * 100
  );
}

function addOpponent() {
  const n = board().pieces.filter((p) => p.kind === "opponent").length;
  board().pieces.push({
    id: uid(),
    kind: "opponent",
    x: 380 + (n % 3) * 70,
    y: 620 + Math.floor(n / 3) * 70
  });
  pushHistory();
  renderPieces();
  seedEmptyModesFrom(state.currentMode);
  scheduleSave();
}

function addBall() {
  const n = board().pieces.filter((p) => p.kind === "ball").length;
  board().pieces.push({
    id: uid(),
    kind: "ball",
    x: 342 + n * 24,
    y: 512
  });
  pushHistory();
  renderPieces();
  seedEmptyModesFrom(state.currentMode);
  scheduleSave();
}

function clearPieces() {
  if (!board().pieces.length) return;
  if (!confirm("盤上のコマをすべて削除しますか？")) return;
  board().pieces = [];
  pushHistory();
  renderPieces();
  renderPlayerPool();
  scheduleSave();
}

// ---------- モード切替 ----------
function switchMode(mode) {
  if (!MODES.includes(mode) || mode === state.currentMode) return;
  const prevPos = capturePiecePositions(board().pieces);
  // 切替前：現在の布陣を、まだ空のモードへコピー（描画は除く）
  seedEmptyModesFrom(state.currentMode);
  scheduleSave(true);
  state.currentMode = mode;
  clearMultiSelection();
  hideMarquee();
  $$(".mode-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.mode === mode);
  });
  fitStage();
  applyZoom();
  renderPiecesAnimated(prevPos);
  renderDrawings();
  renderPlayerPool();
  updateHistoryButtons();
  updateLockUI();
  updateToolUI();
  updateDrawLayerClass();
  scheduleSave();
}

function fullRender() {
  fitStage();
  applyZoom();
  renderPieces();
  renderDrawings();
  renderPlayerPool();
  updateHistoryButtons();
  updateLockUI();
  updateToolUI();
  updateDrawLayerClass();
  applyDrawingsVisibility();
}

// ---------- ツール ----------
function setTool(tool, { fromClick = false } = {}) {
  const wasSame = state.tool === tool;
  const isStyle = STYLE_TOOLS.includes(tool);

  // 一括選択を再度押したら通常の選択ツールへ戻る
  if (fromClick && wasSame && tool === "multiselect") {
    setTool("select");
    return;
  }

  if (fromClick && wasSame && isStyle) {
    toggleInkStylePopover();
    return;
  }

  const prev = state.tool;
  state.tool = tool;
  hidePieceActions();
  clearLongPress();
  hideMarquee();

  if (prev === "multiselect" && tool !== "multiselect") {
    clearMultiSelection();
  }

  if (isStyle) {
    applyInkPrefsToState(tool);
    // 描画ツール使用時は非表示なら自動で再表示
    if (!state.drawingsVisible) setDrawingsVisible(true, { silent: true });
    showInkStylePopover();
  } else {
    hideInkStylePopover();
  }

  updateToolUI();
  updateDrawLayerClass();
  syncColorUI();
  els.pieces.querySelectorAll(".piece").forEach((el) => {
    el.style.pointerEvents = isPieceTool() ? "auto" : "none";
  });
  syncMultiSelectVisual();
  renderDrawings();
}

function applyInkPrefsToState(tool) {
  const p = inkPrefs[tool] || defaultInkPrefs()[tool] || {};
  if (tool === "eraser") {
    state.penWidth = p.width ?? 3.5;
    return;
  }
  state.penColor = p.color;
  state.penWidth = p.width;
  state.penOpacity = p.opacity ?? 1;
  if (tool === "arrow") {
    state.arrowStyle = p.style === "free" ? "free" : "straight";
  }
}

function persistCurrentInkPrefs() {
  if (state.tool === "eraser") {
    inkPrefs.eraser = { width: state.penWidth };
    saveInkPrefs();
    return;
  }
  if (!INK_TOOLS.includes(state.tool)) return;
  const data = {
    color: state.penColor,
    width: state.penWidth,
    opacity: state.penOpacity
  };
  if (state.tool === "arrow") data.style = state.arrowStyle || "straight";
  inkPrefs[state.tool] = data;
  saveInkPrefs();
}

function setArrowStyle(style) {
  state.arrowStyle = style === "free" ? "free" : "straight";
  updateInkPopoverSections();
  persistCurrentInkPrefs();
}

function updateToolUI() {
  $$(".tool-btn[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === state.tool);
  });
  $$(".stroke-btn").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.width) === Number(state.penWidth));
  });
  const opacityInput = $("#ink-opacity");
  const opacityLabel = $("#ink-opacity-label");
  if (opacityInput) opacityInput.value = String(state.penOpacity ?? 1);
  if (opacityLabel) opacityLabel.textContent = `${Math.round((state.penOpacity ?? 1) * 100)}%`;
  updateInkPopoverSections();
  updateMultiSelectActions();
  updateInkChrome();
}

/** 色パレットは描画ペン系ツールのときだけ表示（高さアニメ） */
function updateInkChrome() {
  const panel = $("#ink-chrome-panel");
  if (!panel) return;
  panel.classList.toggle("is-open", INK_TOOLS.includes(state.tool));
}

/** ツールに応じてポップオーバー内の表示を切替（直線/自由線は矢印のみ） */
function updateInkPopoverSections() {
  const isEraser = state.tool === "eraser";
  const isArrow = state.tool === "arrow";
  const opacityBlock = $("#ink-opacity-block");
  const arrowBlock = $("#ink-arrow-mode");
  const title = $("#ink-style-popover .ink-style-title");
  if (opacityBlock) opacityBlock.hidden = isEraser;
  // 直線 / 自由線は矢印ペン専用（他ツールでは完全非表示）
  if (arrowBlock) {
    arrowBlock.hidden = !isArrow;
    if (!isArrow) arrowBlock.setAttribute("hidden", "");
    else arrowBlock.removeAttribute("hidden");
  }
  if (title) {
    title.textContent = isEraser ? "消しゴム" : isArrow ? "矢印" : "スタイル";
  }
  $$("[data-arrow-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.arrowMode === (state.arrowStyle || "straight"));
  });
}

function setPenWidth(w) {
  state.penWidth = Number(w) || 3.5;
  $$(".stroke-btn").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.width) === Number(state.penWidth));
  });
  persistCurrentInkPrefs();
}

function setPenOpacity(v) {
  state.penOpacity = clamp(Number(v) || 1, 0.05, 1);
  const opacityLabel = $("#ink-opacity-label");
  if (opacityLabel) opacityLabel.textContent = `${Math.round(state.penOpacity * 100)}%`;
  persistCurrentInkPrefs();
}

function setPenColor(color) {
  if (!color) return;
  let c = String(color).toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) {
    c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  state.penColor = c;
  syncColorUI();
  persistCurrentInkPrefs();
}

function syncColorUI() {
  const c = state.penColor?.toLowerCase();
  $$(".color-swatch").forEach((s) => {
    s.classList.toggle("active", s.dataset.color?.toLowerCase() === c);
  });
  const picker = $("#pen-color-picker");
  if (picker && picker.value.toLowerCase() !== c) {
    try { picker.value = c; } catch (_) {}
  }
  // 透明度バーを選択中の色に合わせる
  const opacityInput = $("#ink-opacity");
  if (opacityInput && c) {
    opacityInput.style.setProperty("--ink-color", c);
    opacityInput.style.accentColor = c;
  }
}

function showInkStylePopover() {
  const pop = $("#ink-style-popover");
  if (!pop) return;
  pop.hidden = false;
  updateToolUI();
  // ツールバー右隣に寄せる
  const toolbar = $("#toolbar");
  const btn = $(`.tool-btn[data-tool="${state.tool}"]`);
  if (toolbar && btn && !toolbar.classList.contains("collapsed")) {
    const area = document.querySelector(".board-area")?.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    if (area) {
      pop.style.left = `${Math.min(area.width - 180, br.right - area.left + 8)}px`;
      pop.style.top = `${Math.max(8, br.top - area.top - 8)}px`;
    }
  }
}

function hideInkStylePopover() {
  const pop = $("#ink-style-popover");
  if (pop) pop.hidden = true;
}

function toggleInkStylePopover() {
  const pop = $("#ink-style-popover");
  if (!pop) return;
  if (pop.hidden) showInkStylePopover();
  else hideInkStylePopover();
}

function toggleLock() {
  state.piecesLocked = !state.piecesLocked;
  updateLockUI();
  renderPieces();
  scheduleSave();
}

function updateLockUI() {
  const locked = state.piecesLocked;
  els.btnLock.classList.toggle("locked", locked);
  els.lockLabel.textContent = locked ? "コマ固定" : "配置編集";
  if (els.lockLabelPresent) {
    els.lockLabelPresent.textContent = locked ? "コマ固定" : "配置編集";
  }
  const unlock = els.btnLock.querySelector(".icon-unlock");
  const lock = els.btnLock.querySelector(".icon-lock");
  if (unlock && lock) {
    unlock.hidden = locked;
    lock.hidden = !locked;
  }
}

function setPresentMode(on) {
  state.presentMode = on;
  document.body.classList.toggle("present-mode", on);
  // 説明モードではベンチを隠し、コートを最大化
  if (on) {
    document.getElementById("bench-panel")?.classList.add("collapsed");
  } else {
    applyPanelPrefs();
  }
  updatePanelToggles();
  requestAnimationFrame(() => fitStage());
  scheduleSave();
}

const PANEL_PREFS_KEY = "sakuraTactics_panels";

function loadPanelPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePanelPrefs() {
  const prefs = {
    toolsCollapsed: document.getElementById("toolbar")?.classList.contains("collapsed") || false,
    benchCollapsed: document.getElementById("bench-panel")?.classList.contains("collapsed") || false
  };
  try { localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
}

function applyPanelPrefs() {
  const prefs = loadPanelPrefs();
  const toolbar = document.getElementById("toolbar");
  const bench = document.getElementById("bench-panel");
  toolbar?.classList.toggle("collapsed", Boolean(prefs.toolsCollapsed));
  if (!document.body.classList.contains("present-mode")) {
    bench?.classList.toggle("collapsed", Boolean(prefs.benchCollapsed));
  }
  updatePanelToggles();
}

function setPanelCollapsed(which, collapsed) {
  const toolbar = document.getElementById("toolbar");
  const bench = document.getElementById("bench-panel");
  if (which === "tools") toolbar?.classList.toggle("collapsed", collapsed);
  if (which === "bench") bench?.classList.toggle("collapsed", collapsed);
  updatePanelToggles();
  savePanelPrefs();
  requestAnimationFrame(() => fitStage());
}

function updatePanelToggles() {
  const toolsCollapsed = document.getElementById("toolbar")?.classList.contains("collapsed");
  const benchCollapsed = document.getElementById("bench-panel")?.classList.contains("collapsed");
  const expandTools = document.getElementById("btn-expand-tools");
  const expandBench = document.getElementById("btn-expand-bench");
  const showTools = Boolean(toolsCollapsed);
  const showBench = !document.body.classList.contains("present-mode") && Boolean(benchCollapsed);

  if (expandTools) {
    expandTools.hidden = false;
    expandTools.classList.toggle("is-visible", showTools);
    expandTools.setAttribute("aria-hidden", showTools ? "false" : "true");
  }
  if (expandBench) {
    expandBench.hidden = false;
    expandBench.classList.toggle("is-visible", showBench);
    expandBench.setAttribute("aria-hidden", showBench ? "false" : "true");
  }
  syncExpandButtonPositions();
}

// ---------- ボードポインタ（描画・ピンチ） ----------
function onViewportPointerDown(e) {
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // 空き地タップでアクションメニューを閉じる／一括選択解除・囲み開始
  if (isPieceTool() && activePointers.size === 1) {
    hidePieceActions();
    if (state.tool === "multiselect" && !dragPiece) {
      e.preventDefault();
      const pt = clientToBoard(e.clientX, e.clientY);
      marquee = {
        pointerId: e.pointerId,
        x0: pt.x,
        y0: pt.y,
        x1: pt.x,
        y1: pt.y,
        moved: false,
        pointerStartX: e.clientX,
        pointerStartY: e.clientY
      };
      updateMarqueeEl();
      try { els.viewport.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
  }

  // 2本指 → ピンチ開始
  if (activePointers.size === 2) {
    drawing = null;
    liveInkEl = null;
    eraserSession = null;
    dragPiece = null;
    hideMarquee();
    clearLongPress();
    const pts = [...activePointers.values()];
    pinchStartDist = dist(pts[0], pts[1]);
    pinchStartZoom = board().zoom;
    return;
  }

  if (dragPiece) return;

  // ドラッグ消しゴム（なぞった部分だけ消す）
  if (state.tool === "eraser") {
    e.preventDefault();
    eraserSession = {
      erased: false,
      pointerId: e.pointerId,
      pieceHits: 0,
      lastHint: 0
    };
    const pt = clientToBoard(e.clientX, e.clientY);
    if (eraseNearPoint(pt)) eraserSession.erased = true;
    noteEraserOverPiece(pt);
    try { els.viewport.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  if (isPieceTool()) return;

  // 描画開始
  e.preventDefault();
  const pt = clientToBoard(e.clientX, e.clientY);
  const id = uid();
  // Apple Pencil の筆圧を反映（なければ既定）
  const pressure = e.pointerType === "pen" && e.pressure > 0
    ? clamp(e.pressure, 0.25, 1)
    : 1;
  const width = state.penWidth * (0.7 + pressure * 0.5);
  const base = {
    id,
    color: state.penColor,
    width,
    opacity: state.penOpacity ?? 1
  };

  if (state.tool === "pen") {
    drawing = {
      type: "pen",
      shape: { ...base, type: "pen", points: [pt] },
      preview: null
    };
  } else if (state.tool === "arrow" && state.arrowStyle === "free") {
    drawing = {
      type: "arrow",
      shape: { ...base, type: "arrow", free: true, points: [pt] },
      preview: null
    };
  } else if (state.tool === "line" || state.tool === "arrow") {
    drawing = {
      type: state.tool,
      shape: { ...base, type: state.tool, free: false, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y },
      preview: null
    };
  } else if (state.tool === "ellipse") {
    drawing = {
      type: "ellipse",
      start: pt,
      shape: { ...base, type: "ellipse", cx: pt.x, cy: pt.y, rx: 0, ry: 0 },
      preview: null
    };
  }

  if (drawing) {
    drawing.preview = deepClone(drawing.shape);
    try { els.viewport.setPointerCapture(e.pointerId); } catch (_) {}
    renderDrawings();
  }
}

function appendStrokePoint(pt) {
  if (!drawing?.shape?.points) return;
  const pts = drawing.shape.points;
  const last = pts[pts.length - 1];
  // 近い点は間引き、遠すぎる点は補間して滑らかに
  if (last && dist(last, pt) < 1.2) return;
  if (last && dist(last, pt) > 28) {
    const steps = Math.min(4, Math.floor(dist(last, pt) / 14));
    for (let i = 1; i <= steps; i++) {
      const t = i / (steps + 1);
      pts.push({
        x: last.x + (pt.x - last.x) * t,
        y: last.y + (pt.y - last.y) * t
      });
    }
  }
  pts.push(pt);
}

function onViewportPointerMove(e) {
  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  // ピンチズーム
  if (activePointers.size === 2) {
    const pts = [...activePointers.values()];
    const d = dist(pts[0], pts[1]);
    if (pinchStartDist > 0) {
      setZoom(pinchStartZoom * (d / pinchStartDist), false);
    }
    return;
  }

  // 囲み選択ドラッグ
  if (marquee && e.pointerId === marquee.pointerId) {
    e.preventDefault();
    const travel = Math.hypot(e.clientX - marquee.pointerStartX, e.clientY - marquee.pointerStartY);
    if (travel > 6) marquee.moved = true;
    const pt = clientToBoard(e.clientX, e.clientY);
    marquee.x1 = pt.x;
    marquee.y1 = pt.y;
    updateMarqueeEl();
    return;
  }

  // 消しゴムドラッグ
  if (eraserSession && e.pointerId === eraserSession.pointerId) {
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ce of events) {
      const pt = clientToBoard(ce.clientX, ce.clientY);
      if (eraseNearPoint(pt)) eraserSession.erased = true;
      noteEraserOverPiece(pt);
    }
    return;
  }

  // 描画中
  if (!drawing) return;
  e.preventDefault();

  const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
  for (const ce of events) {
    const pt = clientToBoard(ce.clientX, ce.clientY);
    if (drawing.type === "pen" || (drawing.type === "arrow" && drawing.shape.free)) {
      appendStrokePoint(pt);
    } else if (drawing.type === "line" || drawing.type === "arrow") {
      drawing.shape.x2 = pt.x;
      drawing.shape.y2 = pt.y;
    } else if (drawing.type === "ellipse") {
      const s = drawing.start;
      drawing.shape.cx = (s.x + pt.x) / 2;
      drawing.shape.cy = (s.y + pt.y) / 2;
      drawing.shape.rx = Math.abs(pt.x - s.x) / 2;
      drawing.shape.ry = Math.abs(pt.y - s.y) / 2;
    }
  }

  drawing.preview = deepClone(drawing.shape);
  updateLiveInk();
}

function onViewportPointerUp(e) {
  activePointers.delete(e.pointerId);

  if (activePointers.size < 2) {
    pinchStartDist = 0;
  }

  if (marquee && e.pointerId === marquee.pointerId) {
    if (marquee.moved) {
      applyMarqueeSelection();
    } else {
      clearMultiSelection();
    }
    hideMarquee();
    return;
  }

  if (eraserSession && e.pointerId === eraserSession.pointerId) {
    if (eraserSession.erased) {
      pushHistory();
      scheduleSave();
    }
    eraserSession = null;
    return;
  }

  if (drawing) {
    const shape = deepClone(drawing.shape);
    drawing = null;
    liveInkEl = null;
    if (isValidShape(shape)) {
      board().drawings.push(shape);
      pushHistory();
      scheduleSave();
    }
    renderDrawings();
  }
}

function isValidShape(s) {
  if (s.type === "pen" || (s.type === "arrow" && s.free)) {
    return s.points && s.points.length >= 2;
  }
  if (s.type === "line" || s.type === "arrow") {
    return dist({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) > 8;
  }
  if (s.type === "ellipse") return Math.abs(s.rx) > 4 || Math.abs(s.ry) > 4;
  return false;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ホイールズーム
function onWheel(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.08 : 0.08;
  setZoom(board().zoom + delta);
}

// ---------- メンバー設定 ----------
let memberStep = 1;
let draftRoles = emptyRoles();

function openMembers() {
  memberStep = 1;
  draftRoles = deepClone(board().roles);
  $("#modal-members").hidden = false;
  renderMembersStep();
}

function closeModal(name) {
  $(`#modal-${name}`).hidden = true;
}

function renderMembersStep() {
  $$(".step-tab").forEach((t) => {
    t.classList.toggle("active", Number(t.dataset.step) === memberStep);
  });
  const prev = $("#btn-members-prev");
  const next = $("#btn-members-next");
  const done = $("#btn-members-done");
  prev.disabled = memberStep === 1;
  next.hidden = memberStep === 3;
  done.hidden = memberStep !== 3;

  const list = els.membersList;
  list.innerHTML = "";

  if (memberStep === 1) {
    els.membersHint.textContent = `内野メンバーを選択（現在 ${draftRoles.infield.length} 人 / 目安7人）`;
    for (const name of ROSTER) {
      const btn = makeMemberBtn(name, draftRoles.infield.includes(name), "infield");
      btn.addEventListener("click", () => {
        toggleInArray(draftRoles.infield, name);
        // 内野から外したらアタッカーからも外す
        if (!draftRoles.infield.includes(name)) {
          draftRoles.attackers = draftRoles.attackers.filter((n) => n !== name);
        }
        renderMembersStep();
      });
      list.appendChild(btn);
    }
  } else if (memberStep === 2) {
    els.membersHint.textContent = `アタッカーを選択（現在 ${draftRoles.attackers.length} 人）※ 内野から選択`;
    const source = draftRoles.infield.length ? draftRoles.infield : ROSTER;
    if (!draftRoles.infield.length) {
      els.membersHint.textContent = "内野が未選択です。全員からアタッカーを選べます。";
    }
    for (const name of source) {
      const btn = makeMemberBtn(name, draftRoles.attackers.includes(name), "attacker");
      btn.addEventListener("click", () => {
        toggleInArray(draftRoles.attackers, name);
        if (draftRoles.attackers.includes(name) && !draftRoles.infield.includes(name)) {
          draftRoles.infield.push(name);
        }
        renderMembersStep();
      });
      list.appendChild(btn);
    }
    if (!source.length) {
      list.innerHTML = `<p class="empty-note">先に内野を選択してください</p>`;
    }
  } else {
    els.membersHint.textContent = `外野を選択（現在 ${draftRoles.outfield.length} 人 / 目安1人）`;
    for (const name of ROSTER) {
      const btn = makeMemberBtn(name, draftRoles.outfield.includes(name), "outfield");
      btn.addEventListener("click", () => {
        toggleInArray(draftRoles.outfield, name);
        renderMembersStep();
      });
      list.appendChild(btn);
    }
  }
}

function makeMemberBtn(name, selected, kind) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "member-item" + (selected ? ` selected ${kind}` : "");
  btn.textContent = splitName(name).join(" ");
  return btn;
}

function toggleInArray(arr, item) {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(item);
}

function applyMembers() {
  board().roles = deepClone(draftRoles);
  closeModal("members");
  renderPieces();
  renderPlayerPool();
  pushHistory();
  seedEmptyModesFrom(state.currentMode);
  scheduleSave();
  toast("メンバー設定を反映しました");
}

// ---------- テンプレート ----------
function openTemplates() {
  $("#modal-templates").hidden = false;
  renderTemplateList();
}

function renderTemplateList() {
  const list = els.templateList;
  list.innerHTML = "";
  if (!state.templates.length) {
    list.innerHTML = `<li class="empty-note">保存されたテンプレートはありません</li>`;
    return;
  }
  for (const t of state.templates) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="item-info">
        <div class="item-name">${escapeHtml(t.name)}</div>
        <div class="item-meta">${MODE_LABEL[t.mode] || ""} · 選手 ${t.pieces?.filter(p => p.kind === "player").length || 0}人</div>
      </div>
      <div class="item-actions">
        <button type="button" data-act="load">読込</button>
        <button type="button" data-act="rename">改名</button>
        <button type="button" class="danger" data-act="del">削除</button>
      </div>
    `;
    li.querySelector('[data-act="load"]').onclick = () => loadTemplate(t.id);
    li.querySelector('[data-act="rename"]').onclick = () => renameTemplate(t.id);
    li.querySelector('[data-act="del"]').onclick = () => deleteTemplate(t.id);
    list.appendChild(li);
  }
}

function saveTemplate() {
  const name = els.templateName.value.trim();
  if (!name) {
    toast("テンプレート名を入力してください");
    return;
  }
  state.templates.unshift({
    id: uid(),
    name,
    mode: state.currentMode,
    pieces: deepClone(board().pieces.filter((p) => p.kind === "player")),
    roles: deepClone(board().roles),
    createdAt: Date.now()
  });
  els.templateName.value = "";
  renderTemplateList();
  scheduleSave(true);
  toast("テンプレートを保存しました");
}

function loadTemplate(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  // 選手配置のみ反映（相手・ボール・描画は維持しない仕様：テンプレ＝基本布陣）
  const others = board().pieces.filter((p) => p.kind !== "player");
  board().pieces = [...deepClone(t.pieces), ...others];
  if (t.roles) board().roles = deepClone(t.roles);
  pushHistory();
  seedEmptyModesFrom(state.currentMode);
  fullRender();
  closeModal("templates");
  scheduleSave();
  toast(`「${t.name}」を読み込みました`);
}

function renameTemplate(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  const name = prompt("新しい名前", t.name);
  if (!name || !name.trim()) return;
  t.name = name.trim();
  renderTemplateList();
  scheduleSave(true);
}

function deleteTemplate(id) {
  if (!confirm("このテンプレートを削除しますか？")) return;
  state.templates = state.templates.filter((t) => t.id !== id);
  renderTemplateList();
  scheduleSave(true);
}

// ---------- スナップ ----------
function openSnapshots() {
  $("#modal-snapshots").hidden = false;
  renderSnapshotList();
}

function renderSnapshotList() {
  const list = els.snapshotList;
  list.innerHTML = "";
  if (!state.snapshots.length) {
    list.innerHTML = `<li class="empty-note">保存されたスナップはありません</li>`;
    return;
  }
  for (const s of state.snapshots) {
    const li = document.createElement("li");
    const date = new Date(s.createdAt).toLocaleString("ja-JP");
    li.innerHTML = `
      <div class="item-info">
        <div class="item-name">${escapeHtml(s.name)}</div>
        <div class="item-meta">${MODE_LABEL[s.mode] || ""} · ${date}</div>
      </div>
      <div class="item-actions">
        <button type="button" data-act="load">読込</button>
        <button type="button" data-act="rename">改名</button>
        <button type="button" class="danger" data-act="del">削除</button>
      </div>
    `;
    li.querySelector('[data-act="load"]').onclick = () => loadSnapshot(s.id);
    li.querySelector('[data-act="rename"]').onclick = () => renameSnapshot(s.id);
    li.querySelector('[data-act="del"]').onclick = () => deleteSnapshot(s.id);
    list.appendChild(li);
  }
}

function saveSnapshot() {
  const name = els.snapshotName.value.trim();
  if (!name) {
    toast("スナップ名を入力してください");
    return;
  }
  state.snapshots.unshift({
    id: uid(),
    name,
    mode: state.currentMode,
    piecesLocked: state.piecesLocked,
    board: deepClone(board()),
    createdAt: Date.now()
  });
  els.snapshotName.value = "";
  renderSnapshotList();
  scheduleSave(true);
  toast("スナップを保存しました");
}

function loadSnapshot(id) {
  const s = state.snapshots.find((x) => x.id === id);
  if (!s) return;
  // スナップのモードへ切替して盤面全体を復元
  state.currentMode = s.mode;
  $$(".mode-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.mode === s.mode);
  });
  state.modes[s.mode] = deepClone(s.board);
  if (typeof s.piecesLocked === "boolean") state.piecesLocked = s.piecesLocked;
  resetHistory(s.mode);
  fullRender();
  closeModal("snapshots");
  scheduleSave();
  toast(`「${s.name}」を読み込みました`);
}

function renameSnapshot(id) {
  const s = state.snapshots.find((x) => x.id === id);
  if (!s) return;
  const name = prompt("新しい名前", s.name);
  if (!name || !name.trim()) return;
  s.name = name.trim();
  renderSnapshotList();
  scheduleSave(true);
}

function deleteSnapshot(id) {
  if (!confirm("このスナップを削除しますか？")) return;
  state.snapshots = state.snapshots.filter((s) => s.id !== id);
  renderSnapshotList();
  scheduleSave(true);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clearDrawings() {
  if (!board().drawings.length) return;
  if (!confirm("描画をすべて消去しますか？")) return;
  board().drawings = [];
  pushHistory();
  renderDrawings();
  scheduleSave();
}

function toggleDrawingsVisible() {
  setDrawingsVisible(!state.drawingsVisible);
}

function setDrawingsVisible(on, { silent = false } = {}) {
  state.drawingsVisible = Boolean(on);
  applyDrawingsVisibility();
  scheduleSave();
  if (!silent) {
    toast(state.drawingsVisible ? "描画を表示しました" : "描画を非表示にしました（データは残っています）");
  }
}

function applyDrawingsVisibility() {
  const visible = state.drawingsVisible !== false;
  els.draw?.classList.toggle("drawings-hidden", !visible);
  const btn = $("#btn-toggle-draw");
  if (btn) {
    btn.classList.toggle("is-off", !visible);
    btn.setAttribute("aria-pressed", visible ? "true" : "false");
    btn.title = visible ? "描画を非表示" : "描画を表示";
  }
}

// ---------- 永続化 ----------
function serializableState() {
  return {
    currentMode: state.currentMode,
    piecesLocked: state.piecesLocked,
    drawingsVisible: state.drawingsVisible !== false,
    penColor: state.penColor,
    modes: {
      attack: deepClone(state.modes.attack),
      defense: deepClone(state.modes.defense),
      free: deepClone(state.modes.free)
    },
    templates: deepClone(state.templates),
    snapshots: deepClone(state.snapshots),
    updatedAt: Date.now()
  };
}

function applyLoaded(data) {
  if (!data || typeof data !== "object") return;
  suppressSave = true;
  try {
    if (data.modes) {
      for (const m of MODES) {
        if (data.modes[m]) {
          state.modes[m] = {
            pieces: data.modes[m].pieces || [],
            drawings: data.modes[m].drawings || [],
            zoom: data.modes[m].zoom || 1,
            roles: data.modes[m].roles || emptyRoles()
          };
        }
      }
    }
    if (MODES.includes(data.currentMode)) state.currentMode = data.currentMode;
    if (typeof data.piecesLocked === "boolean") state.piecesLocked = data.piecesLocked;
    if (typeof data.drawingsVisible === "boolean") state.drawingsVisible = data.drawingsVisible;
    if (data.penColor) state.penColor = data.penColor;
    if (Array.isArray(data.templates)) state.templates = data.templates;
    if (Array.isArray(data.snapshots)) state.snapshots = data.snapshots;

    state._hist = {
      attack: emptyModeHist(),
      defense: emptyModeHist(),
      free: emptyModeHist()
    };
    resetHistory();

    $$(".mode-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.mode === state.currentMode);
    });
    syncColorUI();
    updateToolUI();
    fullRender();
  } finally {
    suppressSave = false;
  }
}

function scheduleSave(immediate = false) {
  if (suppressSave) return;
  clearTimeout(saveTimer);
  const run = () => persist();
  if (immediate) run();
  else saveTimer = setTimeout(run, 400);
}

async function persist() {
  const data = serializableState();
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("localStorage save failed", e);
  }

  if (!firestoreReady || !db) {
    updateSyncBadge("local");
    return;
  }

  try {
    const { doc, setDoc } = await import(
      "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"
    );
    await setDoc(doc(db, FIRESTORE_ROOT, "current"), data, { merge: false });
    // テンプレート・スナップも別ドキュメントに（サイズ対策）
    await setDoc(doc(db, FIRESTORE_ROOT, "templates"), { items: data.templates, updatedAt: data.updatedAt });
    await setDoc(doc(db, FIRESTORE_ROOT, "snapshots"), { items: data.snapshots, updatedAt: data.updatedAt });
    updateSyncBadge("cloud");
  } catch (e) {
    console.warn("Firestore save failed", e);
    updateSyncBadge("error");
  }
}

function updateSyncBadge(kind) {
  const b = els.syncBadge;
  b.classList.remove("cloud", "error");
  if (kind === "cloud") {
    b.textContent = "クラウド同期";
    b.classList.add("cloud");
  } else if (kind === "error") {
    b.textContent = "同期エラー";
    b.classList.add("error");
  } else if (kind === "offline-cfg") {
    b.textContent = "ローカル（未設定）";
  } else {
    b.textContent = "ローカル";
  }
}

async function initFirebase() {
  if (!isFirebaseConfigured()) {
    updateSyncBadge("offline-cfg");
    return;
  }
  try {
    const { initializeApp } = await import(
      "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"
    );
    const { getFirestore, doc, getDoc } = await import(
      "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"
    );
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);

    const snap = await getDoc(doc(db, FIRESTORE_ROOT, "current"));
    if (snap.exists()) {
      const remote = snap.data();
      // テンプレ・スナップが分離されている場合マージ
      try {
        const tSnap = await getDoc(doc(db, FIRESTORE_ROOT, "templates"));
        if (tSnap.exists() && Array.isArray(tSnap.data().items)) {
          remote.templates = tSnap.data().items;
        }
        const sSnap = await getDoc(doc(db, FIRESTORE_ROOT, "snapshots"));
        if (sSnap.exists() && Array.isArray(sSnap.data().items)) {
          remote.snapshots = sSnap.data().items;
        }
      } catch (_) {}

      const localRaw = localStorage.getItem(LOCAL_KEY);
      let useRemote = true;
      if (localRaw) {
        try {
          const local = JSON.parse(localRaw);
          if ((local.updatedAt || 0) > (remote.updatedAt || 0)) useRemote = false;
        } catch (_) {}
      }
      if (useRemote) {
        applyLoaded(remote);
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify(serializableState())); } catch (_) {}
      }
    }
    firestoreReady = true;
    updateSyncBadge("cloud");
  } catch (e) {
    console.warn("Firebase init failed", e);
    firestoreReady = false;
    updateSyncBadge("error");
    toast("Firebase接続に失敗しました。ローカル保存で継続します");
  }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return; // 初回は空のコート
    applyLoaded(JSON.parse(raw));
  } catch (e) {
    console.warn("local load failed", e);
  }
}

// ---------- イベントバインド ----------
function bindEvents() {
  $$(".mode-tab").forEach((t) => {
    t.addEventListener("click", () => switchMode(t.dataset.mode));
  });

  const copyBtn = $("#btn-copy-formation");
  const copyMenu = $("#copy-formation-menu");
  copyBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    setCopyMenuOpen(copyMenu?.hidden !== false);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!copyMenu || copyMenu.hidden) return;
    if (e.target.closest?.(".mode-copy-wrap")) return;
    setCopyMenuOpen(false);
  });

  $$(".tool-btn[data-tool]").forEach((b) => {
    b.addEventListener("click", () => setTool(b.dataset.tool, { fromClick: true }));
  });

  $$(".color-swatch").forEach((s) => {
    s.addEventListener("click", () => setPenColor(s.dataset.color));
  });
  $$(".stroke-btn").forEach((b) => {
    b.addEventListener("click", () => setPenWidth(b.dataset.width));
  });
  $$("[data-arrow-mode]").forEach((b) => {
    b.addEventListener("click", () => setArrowStyle(b.dataset.arrowMode));
  });
  $("#ink-opacity")?.addEventListener("input", (e) => {
    setPenOpacity(e.target.value);
  });
  $("#pen-color-picker")?.addEventListener("input", (e) => {
    setPenColor(e.target.value);
  });
  $("#pen-color-picker")?.addEventListener("change", (e) => {
    setPenColor(e.target.value);
  });

  // 余白タップでスタイルポップを閉じる
  document.querySelector(".board-area")?.addEventListener("pointerdown", (e) => {
    const pop = $("#ink-style-popover");
    if (!pop || pop.hidden) return;
    if (e.target.closest("#ink-style-popover")) return;
    if (e.target.closest(".tool-btn[data-tool]")) return;
    if (e.target.closest(".pen-color-row")) return;
    hideInkStylePopover();
  });

  const pieceActions = $("#piece-actions");
  pieceActions?.addEventListener("pointerdown", (e) => e.stopPropagation());
  pieceActions?.querySelector('[data-act="dup"]')?.addEventListener("click", () => {
    const id = pieceActions.dataset.pieceId;
    if (id) duplicatePiece(id);
  });
  pieceActions?.querySelector('[data-act="lock"]')?.addEventListener("click", () => {
    const id = pieceActions.dataset.pieceId;
    if (id) toggleBallLock(id);
  });
  pieceActions?.querySelector('[data-act="del"]')?.addEventListener("click", () => {
    const id = pieceActions.dataset.pieceId;
    if (id) {
      hidePieceActions();
      removePiece(id);
    }
  });

  els.btnUndo?.addEventListener("click", undo);
  els.btnRedo?.addEventListener("click", redo);
  $("#btn-clear-draw")?.addEventListener("click", clearDrawings);
  $("#btn-toggle-draw")?.addEventListener("click", toggleDrawingsVisible);
  $("#btn-zoom-in")?.addEventListener("click", () => setZoom(board().zoom + 0.15));
  $("#btn-zoom-out")?.addEventListener("click", () => setZoom(board().zoom - 0.15));
  $("#btn-zoom-reset")?.addEventListener("click", () => setZoom(1));

  els.btnLock?.addEventListener("click", toggleLock);
  els.btnLockPresent?.addEventListener("click", toggleLock);
  $("#btn-add-opponent")?.addEventListener("click", addOpponent);
  $("#btn-add-ball")?.addEventListener("click", addBall);
  $("#btn-clear-pieces")?.addEventListener("click", clearPieces);
  $("#btn-select-all")?.addEventListener("click", selectAllPieces);
  $("#btn-deselect-all")?.addEventListener("click", () => {
    clearMultiSelection();
    toast("選択を解除しました");
  });
  $("#btn-members")?.addEventListener("click", openMembers);
  $("#btn-templates")?.addEventListener("click", openTemplates);
  $("#btn-snapshots")?.addEventListener("click", openSnapshots);
  $("#btn-present")?.addEventListener("click", () => setPresentMode(true));
  $("#btn-exit-present")?.addEventListener("click", () => setPresentMode(false));

  $("#btn-collapse-tools")?.addEventListener("click", () => setPanelCollapsed("tools", true));
  $("#btn-expand-tools")?.addEventListener("click", () => setPanelCollapsed("tools", false));
  $("#btn-collapse-bench")?.addEventListener("click", () => setPanelCollapsed("bench", true));
  $("#btn-expand-bench")?.addEventListener("click", () => setPanelCollapsed("bench", false));

  // メンバー
  $$(".step-tab").forEach((t) => {
    t.addEventListener("click", () => {
      memberStep = Number(t.dataset.step);
      renderMembersStep();
    });
  });
  $("#btn-members-prev").addEventListener("click", () => {
    memberStep = Math.max(1, memberStep - 1);
    renderMembersStep();
  });
  $("#btn-members-next").addEventListener("click", () => {
    memberStep = Math.min(3, memberStep + 1);
    renderMembersStep();
  });
  $("#btn-members-done").addEventListener("click", applyMembers);
  $("#btn-save-template").addEventListener("click", saveTemplate);
  $("#btn-save-snapshot").addEventListener("click", saveSnapshot);

  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.dataset.close));
  });

  // ポインタ
  els.viewport.addEventListener("pointerdown", onViewportPointerDown);
  els.viewport.addEventListener("pointermove", onViewportPointerMove);
  els.viewport.addEventListener("pointerup", onViewportPointerUp);
  els.viewport.addEventListener("pointercancel", onViewportPointerUp);
  els.viewport.addEventListener("wheel", onWheel, { passive: false });

  // ジェスチャー拡大防止
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("gesturechange", (e) => e.preventDefault());

  // キーボード
  window.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    if (meta && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    if (e.key === "Escape") {
      setCopyMenuOpen(false);
      setPresentMode(false);
      closeModal("members");
      closeModal("templates");
      closeModal("snapshots");
    }
  });

  // ページ離脱前に保存
  window.addEventListener("pagehide", () => persist());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persist();
  });

  window.addEventListener("resize", () => fitStage());
  if (window.ResizeObserver) {
    new ResizeObserver(() => fitStage()).observe(els.viewport);
  }
}

// ---------- 起動 ----------
async function boot() {
  try {
    resetHistory();
    // DOM参照の再取得（安全のため）
    for (const key of Object.keys(els)) {
      const map = {
        app: "#app",
        viewport: "#board-viewport",
        stage: "#board-stage",
        draw: "#draw-layer",
        pieces: "#pieces-layer",
        playerPool: "#player-pool",
        syncBadge: "#sync-badge",
        lockLabel: "#lock-label",
        lockLabelPresent: "#lock-label-present",
        btnLock: "#btn-lock",
        btnLockPresent: "#btn-lock-present",
        btnZoomReset: "#btn-zoom-reset",
        btnUndo: "#btn-undo",
        btnRedo: "#btn-redo",
        toast: "#toast",
        membersList: "#members-list",
        membersHint: "#members-hint",
        templateList: "#template-list",
        snapshotList: "#snapshot-list",
        templateName: "#template-name",
        snapshotName: "#snapshot-name"
      };
      if (map[key]) els[key] = $(map[key]);
    }
    const missing = Object.entries(els).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      console.error("Missing DOM elements:", missing);
    }
    bindEvents();
    applyPanelPrefs();
    loadLocal();
    fullRender();
    await initFirebase();
    requestAnimationFrame(() => fitStage());
  } catch (e) {
    console.error("boot failed", e);
    alert("戦術ボードの初期化に失敗しました: " + e.message);
  }
}

boot();
