/**
 * SAKURA Group 戦術ボード
 * 論理座標系: BOARD_W x BOARD_H（コート・描画・コマで共通）
 */
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js?v=20260825j";

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
    eraser: { width: 3.5, mode: "partial" }
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
    panX: 0,
    panY: 0,
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
      panX: 0,
      panY: 0,
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
    eraserMode: (inkPrefs.eraser && inkPrefs.eraser.mode) === "stroke" ? "stroke" : "partial",
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
let pinchLastMid = null;
let drawing = null; // { id, type, ... }
let dragPiece = null; // { id, offsetX, offsetY } or group drag
let dragDrawing = null; // 描画1本の移動 { id, pointerId, startBoard, origin, moved }
let selectedDrawingId = null;
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

function getRole(name, roles = board().roles) {
  const r = roles || emptyRoles();
  // 旧データで重複がある場合は外野を優先
  if (r.outfield?.includes(name)) return "outfield";
  if (r.attackers?.includes(name)) return "attacker";
  if (r.infield?.includes(name)) return "infield";
  return "none";
}

function roleClass(name) {
  return `role-${getRole(name)}`;
}

/** 1人1役割に正規化（外野 > アタッカー > 内野） */
function normalizeRoles(roles) {
  const out = [];
  const atk = [];
  const inf = [];
  const seen = new Set();
  for (const name of roles?.outfield || []) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  for (const name of roles?.attackers || []) {
    if (seen.has(name)) continue;
    seen.add(name);
    atk.push(name);
  }
  for (const name of roles?.infield || []) {
    if (seen.has(name)) continue;
    seen.add(name);
    inf.push(name);
  }
  return { infield: inf, attackers: atk, outfield: out };
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
  const b = board();
  const z = b.zoom || 1;
  const x = b.panX || 0;
  const y = b.panY || 0;
  els.stage.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  els.btnZoomReset.textContent = `${Math.round(z * 100)}%`;
}

/** パンの範囲を制限（コートが完全に画面外へ行かない） */
function clampPan() {
  const b = board();
  if (!els.stage || !els.viewport) return;
  const z = b.zoom || 1;
  const w = els.stage.offsetWidth * z;
  const h = els.stage.offsetHeight * z;
  const vw = els.viewport.clientWidth;
  const vh = els.viewport.clientHeight;
  const maxX = Math.max(48, (w - vw) / 2 + vw * 0.35);
  const maxY = Math.max(48, (h - vh) / 2 + vh * 0.35);
  b.panX = clamp(b.panX || 0, -maxX, maxX);
  b.panY = clamp(b.panY || 0, -maxY, maxY);
}

function setPan(x, y, save = false) {
  board().panX = x;
  board().panY = y;
  clampPan();
  applyZoom();
  if (save) scheduleSave();
}

function resetView() {
  board().panX = 0;
  board().panY = 0;
  setZoom(1);
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

/** コート左右（または上下）の余白にツール／ベンチを配置（ズーム無視） */
function layoutSidePanels() {
  const area = document.querySelector(".board-area");
  const toolbar = document.getElementById("toolbar");
  const bench = document.getElementById("bench-panel");
  if (!area || !els.stage || !els.viewport) return;

  const ar = area.getBoundingClientRect();
  const vp = els.viewport.getBoundingClientRect();
  // transform(scale) の影響を受けないレイアウトサイズで余白を測る
  const stageW = els.stage.offsetWidth;
  const stageH = els.stage.offsetHeight;
  const stageLeft = vp.left + (vp.width - stageW) / 2;
  const stageTop = vp.top + (vp.height - stageH) / 2;
  const stageRight = stageLeft + stageW;
  const stageBottom = stageTop + stageH;

  const leftGap = Math.max(0, stageLeft - ar.left);
  const rightGap = Math.max(0, ar.right - stageRight);
  const topGap = Math.max(0, stageTop - ar.top);
  const bottomGap = Math.max(0, ar.bottom - stageBottom);
  const useVertical = topGap + bottomGap > leftGap + rightGap + 40;

  area.classList.toggle("gutter-vertical", useVertical);

  const pad = 6;
  // ベンチ下に常時確保（操作バー／展開ボタン用）。開閉で他バーを動かさない
  const ACTION_SLOT = 52;
  const isPhone = window.matchMedia("(max-width: 640px)").matches;

  if (useVertical) {
    // 上下余白モード：CSSクラスに任せる（幅は自動）
    if (toolbar) {
      toolbar.style.left = `${pad}px`;
      toolbar.style.right = `${pad}px`;
      toolbar.style.top = `${Math.max(pad, 4)}px`;
      toolbar.style.bottom = "auto";
      toolbar.style.width = "";
      toolbar.style.height = "";
      const toolMax = isPhone
        ? Math.max(44, Math.min(topGap - pad, 52))
        : Math.max(48, topGap - pad);
      toolbar.style.maxHeight = `${toolMax}px`;
    }
    if (bench) {
      bench.style.left = `${pad}px`;
      bench.style.right = `${pad}px`;
      bench.style.top = "auto";
      bench.style.bottom = `${pad + ACTION_SLOT}px`;
      bench.style.width = "";
      bench.style.height = "auto";
      // 選手が多いときは枠を大きく（選手欄スクロールはしない）
      const benchMax = Math.max(120, bottomGap - pad - ACTION_SLOT);
      bench.style.maxHeight = `${benchMax}px`;
    }
  } else {
    // 左右余白モード：左カラムを左端寄せ（ツール／クイック／操作を揃える）
    const toolW = Math.max(44, Math.min(72, leftGap - pad * 2));
    const benchW = Math.max(120, Math.min(220, rightGap - pad * 2));
    const leftCol = pad;
    const rightCol = Math.max(pad, Math.floor((rightGap - benchW) / 2));
    if (toolbar) {
      toolbar.style.left = `${leftCol}px`;
      toolbar.style.right = "auto";
      toolbar.style.top = `${pad}px`;
      toolbar.style.bottom = "auto";
      toolbar.style.width = `${toolW}px`;
      toolbar.style.height = "auto";
      // 左下に操作バーがあるのでその分を避ける
      toolbar.style.maxHeight = `calc(100% - ${pad * 2 + ACTION_SLOT}px)`;
    }
    if (bench) {
      bench.style.right = `${rightCol}px`;
      bench.style.left = "auto";
      bench.style.top = `${pad}px`;
      // 右はベンチのみ：下端近くまで枠を使える
      bench.style.bottom = "auto";
      bench.style.width = `${benchW}px`;
      bench.style.height = "auto";
      bench.style.maxHeight = `calc(100% - ${pad * 2}px)`;
    }
    layoutActionBar(pad, ACTION_SLOT, false, leftCol, toolW);
    syncExpandButtonPositions(leftCol);
    syncTabletQuickBar(leftCol, toolW);
    return;
  }
  layoutActionBar(pad, ACTION_SLOT, useVertical);
  syncExpandButtonPositions();
  syncTabletQuickBar();
}

/** 操作バー：縦＝右下、左右モード＝左下（内容幅・左端揃え） */
function layoutActionBar(pad, actionSlot, useVertical = null, leftCol = null, toolW = null) {
  const actionBar = document.getElementById("action-bar");
  if (!actionBar) return;
  if (document.body.classList.contains("present-mode")) return;

  const area = document.querySelector(".board-area");
  const vertical =
    useVertical ?? area?.classList.contains("gutter-vertical") ?? false;

  actionBar.classList.toggle("actions-left", !vertical);
  actionBar.style.bottom = `${pad}px`;
  actionBar.style.minHeight = `${Math.max(40, actionSlot - 8)}px`;

  if (vertical) {
    actionBar.style.left = "auto";
    actionBar.style.right = `${pad}px`;
    actionBar.style.width = "max-content";
    actionBar.style.maxWidth = `calc(100% - ${pad * 2}px)`;
  } else {
    const left = leftCol ?? pad;
    actionBar.style.left = `${left}px`;
    actionBar.style.right = "auto";
    actionBar.style.width = "max-content";
    // コートへ大きくはみ出さない程度に制限（折り返し可）
    actionBar.style.maxWidth = `calc(100% - ${left + pad}px)`;
  }
}

/** 展開ボタンを、折りたたみボタンと同じ位置に合わせる */
function syncExpandButtonPositions(leftCol = null) {
  const area = document.querySelector(".board-area");
  const toolbar = document.getElementById("toolbar");
  const bench = document.getElementById("bench-panel");
  const expandTools = document.getElementById("btn-expand-tools");
  const expandBench = document.getElementById("btn-expand-bench");
  if (!area) return;

  const vertical = area.classList.contains("gutter-vertical");
  const toolsLeft = leftCol != null ? `${leftCol}px` : (toolbar?.style.left || "6px");

  if (expandTools && toolbar) {
    // ツールバーの配置（折りたたみ時の transform に依存しない）
    // ※ transform は CSS の is-visible アニメに任せる
    expandTools.style.left = toolsLeft;
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
      // ベンチと同じ高さ帯（操作スロットの上）
      expandBench.style.top = "auto";
      expandBench.style.bottom = bench.style.bottom || "58px";
    } else {
      expandBench.style.top = bench.style.top || "8px";
      expandBench.style.bottom = "auto";
    }
  }

  const expandActions = document.getElementById("btn-expand-actions");
  if (expandActions) {
    expandActions.style.top = "auto";
    expandActions.style.bottom = "8px";
    // ツール展開ボタンと同じ幅感・やや大きめのタップ面
    expandActions.style.width = vertical
      ? "48px"
      : (toolbar?.style.width || "48px");
    expandActions.style.height = "44px";
    expandActions.style.removeProperty("transform");
    if (vertical) {
      expandActions.style.left = "auto";
      expandActions.style.right = "8px";
    } else {
      expandActions.style.left = toolsLeft;
      expandActions.style.right = "auto";
    }
  }
}

/** タブレット／説明モード用クイックバー（左下・ツールと同じ left） */
function syncTabletQuickBar(leftCol = null, toolW = null) {
  const bar = document.getElementById("tablet-quick-bar");
  if (!bar) return;

  const isTablet = window.matchMedia("(max-width: 1180px)").matches;
  const isPhone = window.matchMedia("(max-width: 640px)").matches;
  const isPhoneLandscape = window.matchMedia("(orientation: landscape) and (max-height: 500px)").matches;
  const isPresent = document.body.classList.contains("present-mode");
  // 説明モードでは常に左下へ。通常時はタブレット幅のみ
  const show = isPresent || isTablet;

  bar.hidden = !show;
  if (!show) return;

  const area = document.querySelector(".board-area");
  const toolbar = document.getElementById("toolbar");
  const vertical = area?.classList.contains("gutter-vertical");

  // 左右モードではツールバーと left／幅を揃える（縦は従来どおり）
  if (!vertical) {
    const left =
      leftCol != null
        ? leftCol
        : parseFloat(toolbar?.style.left) || (isPhone ? 4 : 6);
    const width =
      toolW != null
        ? toolW
        : parseFloat(toolbar?.style.width) || (isPhone ? 44 : 48);
    bar.style.left = `${left}px`;
    bar.style.width = `${width}px`;
  } else {
    bar.style.left = isPhone ? "4px" : "6px";
    bar.style.width = "";
  }
  bar.style.right = "auto";
  bar.style.top = "auto";
  let bottom = 156;
  if (isPhoneLandscape) {
    bottom = 68;
  } else if (isPhone) {
    const bench = document.getElementById("bench-panel");
    const benchH =
      vertical && bench && !bench.classList.contains("collapsed")
        ? Math.round(bench.getBoundingClientRect().height)
        : 0;
    bottom = Math.max(152, benchH + 10);
  } else if (!vertical) {
    // 左右モード：左下操作バーの上（開閉で位置は変えない）
    bottom = 62;
  }
  bar.style.bottom = `${bottom}px`;
}

function setZoom(z, save = true) {
  board().zoom = clamp(z, 0.5, 3);
  clampPan();
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
  const undoDisabled = !canUndo();
  const redoDisabled = !canRedo();
  if (els.btnUndo) els.btnUndo.disabled = undoDisabled;
  if (els.btnRedo) els.btnRedo.disabled = redoDisabled;
  const undoT = $("#btn-undo-tablet");
  const redoT = $("#btn-redo-tablet");
  if (undoT) undoT.disabled = undoDisabled;
  if (redoT) redoT.disabled = redoDisabled;
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
  const g = liveInkEl.closest?.("g.shape") || liveInkEl.parentElement;
  if ((d.type === "pen" || (d.type === "arrow" && d.free)) && liveInkEl.tagName === "path") {
    const pts = d.type === "arrow" ? shaftPointsForArrow(d) : (d.points || []);
    liveInkEl.setAttribute("d", pointsToSmoothPath(pts));
  } else if ((d.type === "line" || (d.type === "arrow" && !d.free)) && liveInkEl.tagName === "line") {
    const shaft = shaftCoordsForStraightArrow(d);
    liveInkEl.setAttribute("x1", shaft.x1);
    liveInkEl.setAttribute("y1", shaft.y1);
    liveInkEl.setAttribute("x2", shaft.x2);
    liveInkEl.setAttribute("y2", shaft.y2);
  } else if (d.type === "ellipse" && liveInkEl.tagName === "ellipse") {
    liveInkEl.setAttribute("cx", d.cx);
    liveInkEl.setAttribute("cy", d.cy);
    liveInkEl.setAttribute("rx", Math.abs(d.rx));
    liveInkEl.setAttribute("ry", Math.abs(d.ry));
  } else {
    renderDrawings();
    return;
  }
  if (g) attachArrowHead(g, d);
}

function updateDrawLayerClass() {
  const hidden = state.drawingsVisible === false ? " drawings-hidden" : "";
  els.draw.setAttribute("class", `draw-layer tool-${state.tool}${hidden}`);
  // 選択ツールでも描画ヒット用に受け付ける（移動のため）
  if (state.tool === "select" || !isPieceTool()) {
    els.draw.style.pointerEvents = state.drawingsVisible === false ? "none" : "auto";
  } else {
    els.draw.style.pointerEvents = "none";
  }
  document.body.classList.toggle("ink-tool", !isPieceTool());
  document.body.classList.toggle("tool-eraser", state.tool === "eraser");
  document.body.classList.toggle("tool-multiselect", state.tool === "multiselect");
}

/** 矢印先端の向き（終端付近の点から算出） */
function getArrowTipGeometry(d) {
  const width = d.width || state.penWidth || 3.5;
  const size = Math.max(12, width * 3.4);
  if (d.free && Array.isArray(d.points) && d.points.length >= 2) {
    const tip = d.points[d.points.length - 1];
    let base = d.points[d.points.length - 2];
    for (let i = d.points.length - 2; i >= 0; i--) {
      if (dist(d.points[i], tip) >= 10) {
        base = d.points[i];
        break;
      }
    }
    const ang = Math.atan2(tip.y - base.y, tip.x - base.x);
    return { tip, ang, size };
  }
  if (d.x1 != null && d.x2 != null) {
    const tip = { x: d.x2, y: d.y2 };
    const ang = Math.atan2(d.y2 - d.y1, d.x2 - d.x1);
    return { tip, ang, size };
  }
  return null;
}

function shaftPointsForArrow(d) {
  const pts = d.points || [];
  if (pts.length < 2) return pts;
  const geom = getArrowTipGeometry(d);
  if (!geom) return pts;
  const pull = geom.size * 0.72;
  const cut = {
    x: geom.tip.x - Math.cos(geom.ang) * pull,
    y: geom.tip.y - Math.sin(geom.ang) * pull
  };
  const out = pts.slice(0, -1);
  out.push(cut);
  return out;
}

function shaftCoordsForStraightArrow(d) {
  if (d.type !== "arrow" || d.free) {
    return { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
  }
  const geom = getArrowTipGeometry(d);
  if (!geom) return { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
  const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
  const pull = Math.min(geom.size * 0.72, Math.max(0, len - 2));
  return {
    x1: d.x1,
    y1: d.y1,
    x2: d.x2 - Math.cos(geom.ang) * pull,
    y2: d.y2 - Math.sin(geom.ang) * pull
  };
}

function attachArrowHead(g, d) {
  g.querySelectorAll(".arrow-head").forEach((n) => n.remove());
  if (d.type !== "arrow") return;
  const geom = getArrowTipGeometry(d);
  if (!geom) return;
  const { tip, ang, size } = geom;
  const spread = Math.PI / 6.5;
  const p2 = {
    x: tip.x - size * Math.cos(ang - spread),
    y: tip.y - size * Math.sin(ang - spread)
  };
  const p3 = {
    x: tip.x - size * Math.cos(ang + spread),
    y: tip.y - size * Math.sin(ang + spread)
  };
  const ns = "http://www.w3.org/2000/svg";
  const poly = document.createElementNS(ns, "polygon");
  poly.classList.add("arrow-head");
  poly.setAttribute("points", `${tip.x},${tip.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`);
  poly.setAttribute("fill", d.color || "#ff3b30");
  poly.setAttribute("fill-opacity", String(clamp(d.opacity ?? 1, 0.05, 1)));
  poly.setAttribute("stroke", "none");
  poly.style.pointerEvents = "none";
  g.appendChild(poly);
}

function createShapeEl(d) {
  const ns = "http://www.w3.org/2000/svg";
  const color = d.color || "#ff3b30";
  const width = d.width || state.penWidth || 3.5;
  const g = document.createElementNS(ns, "g");
  g.classList.add("shape");
  g.dataset.id = d.id;
  if (d.id && d.id === selectedDrawingId) g.classList.add("is-selected");

  let el;
  if (d.type === "pen" || (d.type === "arrow" && d.free && d.points)) {
    el = document.createElementNS(ns, "path");
    const pts = d.type === "arrow" ? shaftPointsForArrow(d) : (d.points || []);
    el.setAttribute("d", pointsToSmoothPath(pts));
  } else if (d.type === "line" || d.type === "arrow") {
    el = document.createElementNS(ns, "line");
    const shaft = shaftCoordsForStraightArrow(d);
    el.setAttribute("x1", shaft.x1);
    el.setAttribute("y1", shaft.y1);
    el.setAttribute("x2", shaft.x2);
    el.setAttribute("y2", shaft.y2);
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
  attachArrowHead(g, d);

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

/** 触れた線をまるごと消す */
function eraseWholeStrokeAt(pt) {
  const hitR = Math.max(state.penWidth * 5, 16);
  let changed = false;
  const next = [];
  for (const d of board().drawings) {
    const r = Math.max(hitR, (d.width || 3.5) * 3.2);
    if (shapeHitsPoint(d, pt, r)) {
      changed = true;
      continue;
    }
    next.push(d);
  }
  if (changed) {
    board().drawings = next;
    renderDrawings();
    return true;
  }
  return false;
}

function applyEraserAt(pt) {
  return state.eraserMode === "stroke" ? eraseWholeStrokeAt(pt) : eraseNearPoint(pt);
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
    const pts = d.points || [];
    for (let i = 0; i < pts.length; i++) {
      if (dist(pts[i], pt) <= r) return true;
      if (i > 0 && distToSegment(pt, pts[i - 1], pts[i]) <= r) return true;
    }
    return false;
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

function hitTopDrawing(pt) {
  const list = board().drawings;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    const r = Math.max(14, (d.width || 3.5) * 3.2);
    if (shapeHitsPoint(d, pt, r)) return d;
  }
  return null;
}

function applyDrawingTranslation(target, origin, dx, dy) {
  if (Array.isArray(origin.points)) {
    target.points = origin.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
  if (origin.x1 != null) {
    target.x1 = origin.x1 + dx;
    target.y1 = origin.y1 + dy;
    target.x2 = origin.x2 + dx;
    target.y2 = origin.y2 + dy;
  }
  if (origin.cx != null) {
    target.cx = origin.cx + dx;
    target.cy = origin.cy + dy;
  }
}

function clearDrawingSelection() {
  if (!selectedDrawingId && !dragDrawing) return;
  selectedDrawingId = null;
  dragDrawing = null;
  renderDrawings();
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
  updatePlayerCount();
}

/** コート上の選手数（player のみ）をヘッダーに表示 */
function updatePlayerCount() {
  const el = $("#player-count");
  if (!el) return;
  const n = board().pieces.filter((p) => p.kind === "player").length;
  el.textContent = String(n);
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

/** 選手コマの論理サイズ（画面上の実寸から換算） */
function estimatePlayerBoardSize() {
  const sample = els.pieces?.querySelector(".piece-player");
  if (sample && els.stage) {
    const pr = sample.getBoundingClientRect();
    const sr = els.stage.getBoundingClientRect();
    if (sr.width > 1 && sr.height > 1 && pr.width > 1 && pr.height > 1) {
      return {
        w: (pr.width / sr.width) * BOARD_W,
        h: (pr.height / sr.height) * BOARD_H
      };
    }
  }
  // CSS: width 6.4%, aspect 5/7
  const w = BOARD_W * 0.064;
  return { w, h: w * (7 / 5) };
}

/** 選択中の選手を横一列／縦一列に整列 */
function alignSelectedPieces(axis) {
  const selected = board().pieces.filter(
    (p) => multiSelectedIds.has(p.id) && p.kind === "player"
  );
  if (selected.length < 2) {
    toast("選手を2人以上選択してください");
    return;
  }

  const size = estimatePlayerBoardSize();
  // 中心間 = コマ実寸 → 縦横どちらも縁がちょうど触れる程度
  const gap = axis === "horizontal" ? size.w : size.h;
  const margin = Math.max(28, (axis === "horizontal" ? size.w : size.h) / 2 + 4);
  const n = selected.length;

  if (axis === "horizontal") {
    const cy = selected.reduce((s, p) => s + p.y, 0) / n;
    const sorted = [...selected].sort((a, b) => a.x - b.x);
    const total = (n - 1) * gap;
    let start = selected.reduce((s, p) => s + p.x, 0) / n - total / 2;
    start = clamp(start, margin, BOARD_W - margin - total);
    const y = clamp(cy, margin, BOARD_H - margin);
    sorted.forEach((p, i) => {
      p.x = start + i * gap;
      p.y = y;
    });
  } else {
    const cx = selected.reduce((s, p) => s + p.x, 0) / n;
    const sorted = [...selected].sort((a, b) => a.y - b.y);
    const total = (n - 1) * gap;
    let start = selected.reduce((s, p) => s + p.y, 0) / n - total / 2;
    start = clamp(start, margin, BOARD_H - margin - total);
    const x = clamp(cx, margin, BOARD_W - margin);
    sorted.forEach((p, i) => {
      p.x = x;
      p.y = start + i * gap;
    });
  }

  pushHistory();
  renderPieces();
  scheduleSave();
  toast(axis === "horizontal" ? "横一列に並べました" : "縦一列に並べました");
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

  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size >= 2) {
    beginPinchGesture();
    return;
  }

  const el = e.currentTarget;
  const id = el.dataset.id;
  const piece = board().pieces.find((p) => p.id === id);
  if (!piece) {
    activePointers.delete(e.pointerId);
    return;
  }

  const canMove = isPieceMovable(piece);

  // 動かせないコマ：選択ツールならタップでメニュー（相手・ボール）
  if (!canMove) {
    if (isPieceGloballyFrozen(piece) && (piece.kind === "player" || piece.kind === "opponent")) {
      activePointers.delete(e.pointerId);
      toast("コマが固定されています。「配置編集」に切り替えてください");
      return;
    }
    if (piece.kind === "ball" && isPieceIndividuallyLocked(piece) && state.tool === "multiselect") {
      activePointers.delete(e.pointerId);
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
        activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (updatePinchGesture(ev)) return;
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
        activePointers.delete(ev.pointerId);
        endPinchIfNeeded();
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
      return;
    }
    activePointers.delete(e.pointerId);
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
    activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (updatePinchGesture(ev)) return;
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
    activePointers.delete(ev.pointerId);
    endPinchIfNeeded();
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
  if (tool !== "select") clearDrawingSelection();

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
    state.eraserMode = p.mode === "stroke" ? "stroke" : "partial";
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
    inkPrefs.eraser = { width: state.penWidth, mode: state.eraserMode || "partial" };
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

function setEraserMode(mode) {
  state.eraserMode = mode === "stroke" ? "stroke" : "partial";
  updateInkPopoverSections();
  persistCurrentInkPrefs();
  toast(state.eraserMode === "stroke" ? "線ごと消し" : "部分消し");
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
  const eraserBlock = $("#ink-eraser-mode");
  const title = $("#ink-style-popover .ink-style-title");
  if (opacityBlock) opacityBlock.hidden = isEraser;
  if (arrowBlock) {
    arrowBlock.hidden = !isArrow;
    if (!isArrow) arrowBlock.setAttribute("hidden", "");
    else arrowBlock.removeAttribute("hidden");
  }
  if (eraserBlock) {
    eraserBlock.hidden = !isEraser;
    if (!isEraser) eraserBlock.setAttribute("hidden", "");
    else eraserBlock.removeAttribute("hidden");
  }
  if (title) {
    title.textContent = isEraser ? "消しゴム" : isArrow ? "矢印" : "スタイル";
  }
  $$("[data-arrow-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.arrowMode === (state.arrowStyle || "straight"));
  });
  $$("[data-eraser-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.eraserMode === (state.eraserMode || "partial"));
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
  els.btnLock?.classList.toggle("locked", locked);
  if (els.lockLabel) els.lockLabel.textContent = locked ? "コマ固定" : "配置編集";

  const presentBtn = els.btnLockPresent;
  if (presentBtn) {
    presentBtn.classList.toggle("is-locked", locked);
    presentBtn.classList.toggle("locked", locked);
    presentBtn.setAttribute("aria-pressed", locked ? "true" : "false");
    presentBtn.title = locked ? "コマ固定中（タップで配置編集）" : "配置編集中（タップでコマ固定）";
  }

  const unlock = els.btnLock?.querySelector(".icon-unlock");
  const lock = els.btnLock?.querySelector(".icon-lock");
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
  syncTabletQuickBar();
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
    benchCollapsed: document.getElementById("bench-panel")?.classList.contains("collapsed") || false,
    actionsCollapsed: document.getElementById("action-bar")?.classList.contains("collapsed") || false
  };
  try { localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
}

function applyPanelPrefs() {
  const prefs = loadPanelPrefs();
  const toolbar = document.getElementById("toolbar");
  const bench = document.getElementById("bench-panel");
  const actions = document.getElementById("action-bar");
  toolbar?.classList.toggle("collapsed", Boolean(prefs.toolsCollapsed));
  if (!document.body.classList.contains("present-mode")) {
    bench?.classList.toggle("collapsed", Boolean(prefs.benchCollapsed));
    actions?.classList.toggle("collapsed", Boolean(prefs.actionsCollapsed));
  }
  updatePanelToggles();
}

function setPanelCollapsed(which, collapsed) {
  const toolbar = document.getElementById("toolbar");
  const bench = document.getElementById("bench-panel");
  const actions = document.getElementById("action-bar");
  if (which === "tools") toolbar?.classList.toggle("collapsed", collapsed);
  if (which === "bench") bench?.classList.toggle("collapsed", collapsed);
  if (which === "actions") actions?.classList.toggle("collapsed", collapsed);
  updatePanelToggles();
  savePanelPrefs();
  requestAnimationFrame(() => fitStage());
}

function updatePanelToggles() {
  const toolsCollapsed = document.getElementById("toolbar")?.classList.contains("collapsed");
  const benchCollapsed = document.getElementById("bench-panel")?.classList.contains("collapsed");
  const actionsCollapsed = document.getElementById("action-bar")?.classList.contains("collapsed");
  const expandTools = document.getElementById("btn-expand-tools");
  const expandBench = document.getElementById("btn-expand-bench");
  const expandActions = document.getElementById("btn-expand-actions");
  const inPresent = document.body.classList.contains("present-mode");
  const showTools = Boolean(toolsCollapsed);
  const showBench = !inPresent && Boolean(benchCollapsed);
  const showExpandActions = !inPresent && Boolean(actionsCollapsed);

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
  if (expandActions) {
    expandActions.hidden = false;
    expandActions.classList.toggle("is-visible", showExpandActions);
    expandActions.setAttribute("aria-hidden", showExpandActions ? "false" : "true");
  }
  syncExpandButtonPositions();
  syncTabletQuickBar();
}

// ---------- ボードポインタ（描画・ピンチ・パン） ----------
function pinchMidpoint(pts) {
  return {
    x: (pts[0].x + pts[1].x) / 2,
    y: (pts[0].y + pts[1].y) / 2
  };
}

function beginPinchGesture() {
  // 描画中でも2本指なら線を破棄してズーム／パンへ（片手＋補助指）
  drawing = null;
  liveInkEl = null;
  eraserSession = null;
  dragPiece = null;
  dragDrawing = null;
  hideMarquee();
  clearLongPress();
  const pts = [...activePointers.values()];
  if (pts.length < 2) return;
  pinchStartDist = dist(pts[0], pts[1]);
  pinchStartZoom = board().zoom;
  pinchLastMid = pinchMidpoint(pts);
  renderDrawings();
}

function updatePinchGesture(e) {
  if (activePointers.size !== 2) return false;
  if (e?.cancelable) e.preventDefault();
  const pts = [...activePointers.values()];
  const mid = pinchMidpoint(pts);
  const d = dist(pts[0], pts[1]);
  const b = board();
  if (pinchLastMid) {
    b.panX = (b.panX || 0) + (mid.x - pinchLastMid.x);
    b.panY = (b.panY || 0) + (mid.y - pinchLastMid.y);
  }
  if (pinchStartDist > 0) {
    b.zoom = clamp(pinchStartZoom * (d / pinchStartDist), 0.5, 3);
  }
  clampPan();
  applyZoom();
  pinchLastMid = mid;
  return true;
}

function endPinchIfNeeded() {
  if (activePointers.size < 2) {
    if (pinchStartDist > 0 || pinchLastMid) scheduleSave();
    pinchStartDist = 0;
    pinchLastMid = null;
  }
}

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

  // 2本指 → ピンチズーム＋パン開始
  if (activePointers.size === 2) {
    beginPinchGesture();
    return;
  }

  if (dragPiece) return;

  // 選択ツール：描き終わった線を1本ずつ掴んで移動
  if (state.tool === "select" && activePointers.size === 1 && state.drawingsVisible !== false) {
    const pt = clientToBoard(e.clientX, e.clientY);
    const hit = hitTopDrawing(pt);
    if (hit) {
      e.preventDefault();
      hidePieceActions();
      selectedDrawingId = hit.id;
      dragDrawing = {
        id: hit.id,
        pointerId: e.pointerId,
        startBoard: pt,
        origin: deepClone(hit),
        moved: false
      };
      renderDrawings();
      try { els.viewport.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    if (selectedDrawingId) clearDrawingSelection();
  }

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
    if (applyEraserAt(pt)) eraserSession.erased = true;
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

  // 2本指：ピンチズーム＋パン（画面移動）
  if (updatePinchGesture(e)) return;

  // 描画の移動
  if (dragDrawing && e.pointerId === dragDrawing.pointerId) {
    e.preventDefault();
    const pt = clientToBoard(e.clientX, e.clientY);
    const dx = pt.x - dragDrawing.startBoard.x;
    const dy = pt.y - dragDrawing.startBoard.y;
    if (Math.hypot(dx, dy) > 2.5) dragDrawing.moved = true;
    const d = board().drawings.find((x) => x.id === dragDrawing.id);
    if (d) {
      applyDrawingTranslation(d, dragDrawing.origin, dx, dy);
      renderDrawings();
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
      if (applyEraserAt(pt)) eraserSession.erased = true;
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
    endPinchIfNeeded();
  }

  if (dragDrawing && e.pointerId === dragDrawing.pointerId) {
    if (dragDrawing.moved) {
      pushHistory();
      scheduleSave();
    }
    dragDrawing = null;
    renderDrawings();
    return;
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

// ホイール：通常はパン、Ctrl/Cmd+ホイールでズーム
function onWheel(e) {
  e.preventDefault();
  const b = board();

  if (e.ctrlKey || e.metaKey) {
    const delta = e.deltaY > 0 ? -0.08 : 0.08;
    setZoom((b.zoom || 1) + delta);
    return;
  }

  // トラックパッドの横スクロール／Shift+縦スクロールも考慮
  let dx = e.deltaX;
  let dy = e.deltaY;
  if (e.shiftKey && Math.abs(dx) < Math.abs(dy)) {
    dx = dy;
    dy = 0;
  }
  // deltaMode: 0=pixel, 1=line, 2=page
  if (e.deltaMode === 1) {
    dx *= 16;
    dy *= 16;
  } else if (e.deltaMode === 2) {
    dx *= 80;
    dy *= 80;
  }

  b.panX = (b.panX || 0) - dx;
  b.panY = (b.panY || 0) - dy;
  clampPan();
  applyZoom();
  scheduleSave();
}

// ---------- メンバー設定（1画面・タップで役割切替） ----------
const MEMBER_ROLE_CYCLE = ["none", "infield", "attacker", "outfield"];
const MEMBER_ROLE_LABEL = {
  none: "未設定",
  infield: "内野",
  attacker: "アタッカー",
  outfield: "外野"
};

let draftRoles = emptyRoles();

function openMembers() {
  draftRoles = normalizeRoles(board().roles);
  $("#modal-members").hidden = false;
  renderMembersEditor();
}

function closeModal(name) {
  if (name === "tpl-zoom") {
    closeTplZoom();
    return;
  }
  if (name === "template-preview") {
    closeTplZoom();
    closeTemplatePreview();
    return;
  }
  if (name === "snapshot-preview") {
    closeSnapshotPreview();
    return;
  }
  $(`#modal-${name}`).hidden = true;
  if (name === "templates") {
    closeTplZoom();
    closeTemplatePreview();
  }
  if (name === "snapshots") {
    closeSnapshotPreview();
  }
}

function closeTplZoom() {
  const modal = $("#modal-tpl-zoom");
  if (modal) modal.hidden = true;
  const layer = $("#tpl-zoom-pieces");
  if (layer) layer.innerHTML = "";
}

function openTplZoom(side) {
  if (!tplPreviewId || (side !== "before" && side !== "after")) return;
  const t = state.templates.find((x) => x.id === tplPreviewId);
  if (!t) return;

  let players = [];
  let roles = emptyRoles();
  let label = "";

  if (side === "before") {
    const currentBoard = state.modes[tplPreviewMode];
    players = (currentBoard?.pieces || []).filter((p) => p.kind === "player");
    roles = currentBoard?.roles || emptyRoles();
    label = `今の配置（${MODE_LABEL[tplPreviewMode]}）`;
  } else {
    const tplData = getTemplateModeData(t, tplPreviewMode);
    if (!tplData) {
      toast("読み込み後のデータがありません");
      return;
    }
    players = (tplData.pieces || []).filter((p) => p.kind === "player");
    roles = tplData.roles || emptyRoles();
    label = `読み込み後（${MODE_LABEL[tplPreviewMode]}）`;
  }

  const title = $("#tpl-zoom-title");
  const meta = $("#tpl-zoom-meta");
  if (title) title.textContent = t.name;
  if (meta) meta.textContent = `${label} · 選手 ${players.length}人`;

  fillTplPreviewLayer($("#tpl-zoom-pieces"), players, roles, { animate: false });
  $("#modal-tpl-zoom").hidden = false;
}

function draftRoleOf(name) {
  return getRole(name, draftRoles);
}

function setDraftRole(name, role) {
  draftRoles.infield = draftRoles.infield.filter((n) => n !== name);
  draftRoles.attackers = draftRoles.attackers.filter((n) => n !== name);
  draftRoles.outfield = draftRoles.outfield.filter((n) => n !== name);
  if (role === "infield") draftRoles.infield.push(name);
  else if (role === "attacker") draftRoles.attackers.push(name);
  else if (role === "outfield") draftRoles.outfield.push(name);
}

function cycleDraftRole(name) {
  const cur = draftRoleOf(name);
  const i = MEMBER_ROLE_CYCLE.indexOf(cur);
  const next = MEMBER_ROLE_CYCLE[(i < 0 ? 0 : i + 1) % MEMBER_ROLE_CYCLE.length];
  setDraftRole(name, next);
}

function renderMembersEditor() {
  const list = els.membersList;
  if (!list) return;
  list.innerHTML = "";

  const inf = draftRoles.infield.length;
  const atk = draftRoles.attackers.length;
  const out = draftRoles.outfield.length;
  const summary = $("#members-summary");
  if (summary) {
    summary.innerHTML = `
      <span class="members-sum-item infield">内野 <strong>${inf}</strong></span>
      <span class="members-sum-item attacker">アタッカー <strong>${atk}</strong></span>
      <span class="members-sum-item outfield">外野 <strong>${out}</strong></span>
    `;
  }
  if (els.membersHint) {
    els.membersHint.textContent = "タップで役割を切り替え：未設定 → 内野 → アタッカー → 外野";
  }

  for (const name of ROSTER) {
    const role = draftRoleOf(name);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `member-item role-${role}` + (role !== "none" ? " is-set" : "");
    btn.innerHTML = `
      <span class="member-name">${escapeHtml(splitName(name).join(" "))}</span>
      <span class="member-role">${MEMBER_ROLE_LABEL[role]}</span>
    `;
    btn.title = `${name}（${MEMBER_ROLE_LABEL[role]}）— タップで切替`;
    btn.addEventListener("click", () => {
      cycleDraftRole(name);
      renderMembersEditor();
    });
    list.appendChild(btn);
  }
}

function clearDraftMembers() {
  draftRoles = emptyRoles();
  renderMembersEditor();
}

function applyMembers() {
  board().roles = normalizeRoles(draftRoles);
  closeModal("members");
  renderPieces();
  renderPlayerPool();
  pushHistory();
  seedEmptyModesFrom(state.currentMode);
  scheduleSave();
  toast("メンバー設定を反映しました");
}

// ---------- テンプレート（3モードセット） ----------
let tplPreviewId = null;
let tplPreviewMode = "attack";
let snapPreviewId = null;

/** DOMの並びを配列に反映 */
function syncArrayOrderFromList(listEl, arr) {
  if (!listEl || !arr) return false;
  const ids = [...listEl.querySelectorAll("li[data-id]")].map((li) => li.dataset.id);
  if (!ids.length) return false;
  const map = new Map(arr.map((x) => [x.id, x]));
  const next = ids.map((id) => map.get(id)).filter(Boolean);
  if (next.length !== arr.length) return false;
  let changed = false;
  for (let i = 0; i < next.length; i++) {
    if (arr[i] !== next[i]) {
      changed = true;
      break;
    }
  }
  if (!changed) return false;
  arr.splice(0, arr.length, ...next);
  return true;
}

/** ハンドルでドラッグ＆ドロップ並び替え（タッチ対応・フローティング） */
function bindListDragReorder(listEl, onReorder) {
  if (!listEl) return;
  listEl.querySelectorAll("[data-drag-handle]").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      const li = handle.closest("li[data-id]");
      if (!li || !listEl.contains(li)) return;
      e.preventDefault();
      e.stopPropagation();

      const startRect = li.getBoundingClientRect();
      const offsetY = e.clientY - startRect.top;
      const offsetX = e.clientX - startRect.left;
      let lastClientX = e.clientX;
      let lastClientY = e.clientY;
      let rafId = 0;
      let moved = false;

      const placeholder = document.createElement("li");
      placeholder.className = "item-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      placeholder.style.height = `${startRect.height}px`;
      listEl.insertBefore(placeholder, li);

      li.classList.add("is-dragging");
      li.style.width = `${startRect.width}px`;
      li.style.left = `${startRect.left}px`;
      li.style.top = `${startRect.top}px`;

      try {
        handle.setPointerCapture(e.pointerId);
      } catch (_) {}

      const placePlaceholder = (clientY) => {
        const others = [...listEl.querySelectorAll("li[data-id]")].filter((el) => el !== li);
        let target = null;
        for (const other of others) {
          const rect = other.getBoundingClientRect();
          if (clientY < rect.top + rect.height / 2) {
            target = other;
            break;
          }
        }
        if (target) {
          if (placeholder.nextElementSibling !== target) listEl.insertBefore(placeholder, target);
        } else {
          listEl.appendChild(placeholder);
        }
      };

      const onMove = (ev) => {
        lastClientX = ev.clientX;
        lastClientY = ev.clientY;
        moved = true;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          li.style.left = `${lastClientX - offsetX}px`;
          li.style.top = `${lastClientY - offsetY}px`;
          placePlaceholder(lastClientY);
        });
      };

      const finish = (ev) => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch (_) {}
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }

        li.classList.remove("is-dragging");
        li.style.width = "";
        li.style.left = "";
        li.style.top = "";
        if (placeholder.parentElement) {
          listEl.insertBefore(li, placeholder);
          placeholder.remove();
        } else {
          listEl.appendChild(li);
        }
        handle.classList.remove("is-active");
        if (moved) onReorder?.();
      };

      handle.classList.add("is-active");
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    });
  });
}

function emptyFormation() {
  return { pieces: [], roles: emptyRoles() };
}

/** 旧形式テンプレをセット形式へ変換（不足モードは空） */
function ensureTemplateIsSet(t) {
  if (!t || isSetTemplate(t)) return;
  const modes = {
    attack: emptyFormation(),
    defense: emptyFormation(),
    free: emptyFormation()
  };
  if (MODES.includes(t.mode)) {
    modes[t.mode] = {
      pieces: deepClone((t.pieces || []).filter((p) => p.kind === "player")),
      roles: deepClone(t.roles || emptyRoles())
    };
  }
  t.modes = modes;
  delete t.pieces;
  delete t.roles;
  delete t.mode;
}

function isSetTemplate(t) {
  return Boolean(t?.modes && typeof t.modes === "object");
}

/** モード用の選手＋役割を取得（セット／旧形式両対応） */
function getTemplateModeData(t, mode) {
  if (!t) return null;
  if (isSetTemplate(t)) {
    const block = t.modes[mode];
    if (!block) return null;
    return {
      pieces: deepClone(block.pieces || []),
      roles: deepClone(block.roles || emptyRoles())
    };
  }
  // 旧形式：保存時のモードだけデータあり
  if (t.mode === mode) {
    return {
      pieces: deepClone(t.pieces || []),
      roles: deepClone(t.roles || emptyRoles())
    };
  }
  return null;
}

function captureModeFormation(mode) {
  const b = state.modes[mode];
  return {
    pieces: deepClone((b?.pieces || []).filter((p) => p.kind === "player")),
    roles: deepClone(b?.roles || emptyRoles())
  };
}

function captureCurrentSet() {
  return {
    attack: captureModeFormation("attack"),
    defense: captureModeFormation("defense"),
    free: captureModeFormation("free")
  };
}

function countPlayersInFormation(data) {
  if (!data?.pieces) return 0;
  return data.pieces.filter((p) => p.kind === "player").length;
}

function templateMetaText(t) {
  if (isSetTemplate(t)) {
    const counts = MODES.map((m) => {
      const n = countPlayersInFormation(t.modes[m]);
      return `${MODE_LABEL[m]}${n}`;
    }).join(" / ");
    return `セット · ${counts}`;
  }
  const n = (t.pieces || []).filter((p) => p.kind === "player").length;
  return `単一（${MODE_LABEL[t.mode] || "?"}）· 選手 ${n}人`;
}

function openTemplates() {
  closeTemplatePreview();
  $("#modal-templates").hidden = false;
  renderTemplateList();
}

function closeTemplatePreview() {
  closeTplZoom();
  const modal = $("#modal-template-preview");
  if (modal) modal.hidden = true;
  tplPreviewId = null;
  for (const id of ["tpl-mini-pieces", "tpl-mini-pieces-before"]) {
    const layer = $(`#${id}`);
    if (layer) {
      layer.classList.remove("animating");
      layer.innerHTML = "";
    }
  }
}

function renderTemplateList() {
  const list = els.templateList;
  if (!list) return;
  list.innerHTML = "";
  if (!state.templates.length) {
    list.innerHTML = `<li class="empty-note">保存されたテンプレートはありません</li>`;
    return;
  }
  for (const t of state.templates) {
    const li = document.createElement("li");
    li.dataset.id = t.id;
    li.innerHTML = `
      <button type="button" class="item-drag" data-drag-handle aria-label="ドラッグで並び替え" title="ドラッグで並び替え">⋮⋮</button>
      <div class="item-info">
        <div class="item-name">${escapeHtml(t.name)}</div>
        <div class="item-meta">${escapeHtml(templateMetaText(t))}</div>
      </div>
      <div class="item-actions">
        <button type="button" data-act="preview">プレビュー</button>
        <button type="button" data-act="overwrite" title="攻撃・守備・自由をまとめて上書き">セット上書</button>
        <button type="button" data-act="overwrite-mode" title="今見ているモードだけ上書き">今モード上書</button>
        <button type="button" data-act="dup">複製</button>
        <button type="button" data-act="rename">改名</button>
        <button type="button" class="danger" data-act="del">削除</button>
      </div>
    `;
    li.querySelector('[data-act="preview"]').onclick = () => openTemplatePreview(t.id);
    li.querySelector('[data-act="overwrite"]').onclick = () => overwriteTemplate(t.id);
    li.querySelector('[data-act="overwrite-mode"]').onclick = () => overwriteTemplateCurrentMode(t.id);
    li.querySelector('[data-act="dup"]').onclick = () => duplicateTemplate(t.id);
    li.querySelector('[data-act="rename"]').onclick = () => renameTemplate(t.id);
    li.querySelector('[data-act="del"]').onclick = () => deleteTemplate(t.id);
    list.appendChild(li);
  }
  bindListDragReorder(list, () => {
    if (syncArrayOrderFromList(list, state.templates)) scheduleSave(true);
  });
}

function saveTemplate() {
  const name = els.templateName.value.trim();
  if (!name) {
    toast("テンプレート名を入力してください");
    return;
  }
  const now = Date.now();
  state.templates.unshift({
    id: uid(),
    name,
    modes: captureCurrentSet(),
    createdAt: now,
    updatedAt: now
  });
  els.templateName.value = "";
  renderTemplateList();
  scheduleSave(true);
  toast("3モードをセット保存しました");
}

function overwriteTemplate(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`「${t.name}」を今の攻撃・守備・自由の配置で上書きしますか？`)) return;
  t.modes = captureCurrentSet();
  delete t.pieces;
  delete t.roles;
  delete t.mode;
  t.updatedAt = Date.now();
  renderTemplateList();
  if (tplPreviewId === id) renderTemplatePreview({ animate: false });
  scheduleSave(true);
  toast(`「${t.name}」をセット上書きしました`);
}

function overwriteTemplateCurrentMode(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  const mode = state.currentMode;
  if (
    !confirm(
      `「${t.name}」の${MODE_LABEL[mode]}だけを、今の配置で上書きしますか？\n\n他のモードは変更しません。`
    )
  ) {
    return;
  }
  ensureTemplateIsSet(t);
  t.modes[mode] = captureModeFormation(mode);
  t.updatedAt = Date.now();
  renderTemplateList();
  if (tplPreviewId === id) {
    // プレビュータブを今のモードに合わせて再描画
    tplPreviewMode = mode;
    $$(".tpl-mode-tab").forEach((tab) => {
      const m = tab.dataset.tplMode;
      const has = Boolean(getTemplateModeData(t, m));
      tab.disabled = !has;
      tab.classList.toggle("active", m === mode);
      tab.classList.toggle("is-empty", !has);
    });
    renderTemplatePreview({ animate: false });
  }
  scheduleSave(true);
  toast(`「${t.name}」の${MODE_LABEL[mode]}を上書きしました`);
}

function duplicateTemplate(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  const idx = state.templates.findIndex((x) => x.id === id);
  const now = Date.now();
  const copy = deepClone(t);
  copy.id = uid();
  copy.name = `${t.name} のコピー`;
  copy.createdAt = now;
  copy.updatedAt = now;
  state.templates.splice(idx + 1, 0, copy);
  renderTemplateList();
  scheduleSave(true);
  toast(`「${copy.name}」を作成しました`);
}

function openTemplatePreview(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  tplPreviewId = id;
  // プレビュー初期モード：セットなら今のモード、旧形式なら保存モード
  if (isSetTemplate(t)) {
    tplPreviewMode = state.currentMode;
  } else {
    tplPreviewMode = MODES.includes(t.mode) ? t.mode : "attack";
  }
  const title = $("#tpl-preview-title");
  if (title) title.textContent = t.name;
  $$(".tpl-mode-tab").forEach((tab) => {
    const m = tab.dataset.tplMode;
    const has = Boolean(getTemplateModeData(t, m));
    tab.disabled = !has;
    tab.classList.toggle("active", m === tplPreviewMode);
    tab.classList.toggle("is-empty", !has);
  });
  $("#modal-template-preview").hidden = false;
  renderTemplatePreview({ animate: false });
}

function setTplPreviewMode(mode) {
  if (!MODES.includes(mode) || mode === tplPreviewMode) return;
  const t = state.templates.find((x) => x.id === tplPreviewId);
  if (!t || !getTemplateModeData(t, mode)) {
    toast("このモードのデータがありません");
    return;
  }
  const prevAfter = captureTplPreviewPositions($("#tpl-mini-pieces"));
  const prevBefore = captureTplPreviewPositions($("#tpl-mini-pieces-before"));
  tplPreviewMode = mode;
  $$(".tpl-mode-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tplMode === mode);
  });
  renderTemplatePreview({
    animate: true,
    prevPosAfter: prevAfter,
    prevPosBefore: prevBefore
  });
}

function captureTplPreviewPositions(layer) {
  const map = new Map();
  if (!layer) return map;
  for (const el of layer.querySelectorAll(".tpl-mini-piece[data-name]")) {
    const name = el.dataset.name;
    if (!name) continue;
    map.set(`player:${name}`, {
      x: parseFloat(el.dataset.x || "0"),
      y: parseFloat(el.dataset.y || "0")
    });
  }
  return map;
}

function fillTplPreviewLayer(layer, players, roles, { animate = false, prevPos = null } = {}) {
  if (!layer) return;
  layer.classList.remove("animating");
  layer.innerHTML = "";
  const targets = [];

  for (const p of players) {
    const el = document.createElement("div");
    const role = getRole(p.name, roles);
    el.className = `tpl-mini-piece role-${role}`;
    el.dataset.name = p.name;
    el.dataset.x = String(p.x);
    el.dataset.y = String(p.y);
    el.style.left = `${(p.x / BOARD_W) * 100}%`;
    el.style.top = `${(p.y / BOARD_H) * 100}%`;
    const label = document.createElement("div");
    label.className = "tpl-mini-name";
    // フルネームを縦書き（姓・名を段で）
    for (const part of splitName(p.name)) {
      const row = document.createElement("span");
      row.className = "tpl-mini-name-part";
      for (const ch of [...part]) {
        const c = document.createElement("i");
        c.textContent = ch;
        row.appendChild(c);
      }
      label.appendChild(row);
    }
    el.appendChild(label);
    el.title = p.name;
    layer.appendChild(el);

    if (animate && prevPos) {
      const prev = prevPos.get(`player:${p.name}`);
      if (!prev) {
        el.classList.add("piece-enter");
        targets.push({ el, enter: true, x: p.x, y: p.y });
      } else if (Math.hypot(prev.x - p.x, prev.y - p.y) >= 0.8) {
        el.style.transition = "none";
        el.style.left = `${(prev.x / BOARD_W) * 100}%`;
        el.style.top = `${(prev.y / BOARD_H) * 100}%`;
        targets.push({ el, enter: false, x: p.x, y: p.y });
      }
    }
  }

  if (!animate || !targets.length) return;

  layer.classList.add("animating");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const item of targets) {
        if (item.enter) {
          item.el.classList.add("piece-enter-active");
        } else {
          item.el.style.transition = "";
          item.el.style.left = `${(item.x / BOARD_W) * 100}%`;
          item.el.style.top = `${(item.y / BOARD_H) * 100}%`;
        }
      }
      window.setTimeout(() => {
        layer.classList.remove("animating");
        for (const item of targets) {
          item.el.classList.remove("piece-enter", "piece-enter-active");
          item.el.style.transition = "";
        }
      }, 520);
    });
  });
}

function renderTemplatePreview({
  animate = false,
  prevPosAfter = null,
  prevPosBefore = null
} = {}) {
  const t = state.templates.find((x) => x.id === tplPreviewId);
  const layerAfter = $("#tpl-mini-pieces");
  const layerBefore = $("#tpl-mini-pieces-before");
  const meta = $("#tpl-preview-meta");
  if (!t || !layerAfter || !layerBefore) return;

  const tplData = getTemplateModeData(t, tplPreviewMode);
  const currentBoard = state.modes[tplPreviewMode];
  const currentPlayers = (currentBoard?.pieces || []).filter((p) => p.kind === "player");
  const currentRoles = currentBoard?.roles || emptyRoles();

  if (!tplData) {
    layerAfter.innerHTML = "";
    fillTplPreviewLayer(layerBefore, currentPlayers, currentRoles, {
      animate,
      prevPos: prevPosBefore
    });
    if (meta) meta.textContent = `${MODE_LABEL[tplPreviewMode]} · テンプレ側のデータがありません`;
    return;
  }

  const tplPlayers = (tplData.pieces || []).filter((p) => p.kind === "player");
  if (meta) {
    meta.textContent = `${MODE_LABEL[tplPreviewMode]} · 今 ${currentPlayers.length}人 → 読込後 ${tplPlayers.length}人`;
  }

  fillTplPreviewLayer(layerBefore, currentPlayers, currentRoles, {
    animate,
    prevPos: prevPosBefore
  });
  fillTplPreviewLayer(layerAfter, tplPlayers, tplData.roles, {
    animate,
    prevPos: prevPosAfter
  });
}

/** 指定モードへ選手配置を適用（相手・ボール・描画は維持） */
function applyFormationToMode(mode, data) {
  if (!data || !state.modes[mode]) return false;
  const b = state.modes[mode];
  const others = (b.pieces || []).filter((p) => p.kind !== "player");
  b.pieces = [...deepClone(data.pieces || []), ...others];
  b.roles = deepClone(data.roles || emptyRoles());
  return true;
}

function loadTemplateSet() {
  const t = state.templates.find((x) => x.id === tplPreviewId);
  if (!t) return;

  if (
    !confirm(
      `「${t.name}」のセットを読み込みますか？\n\n各モードの自チーム選手配置が置き換わります。\n相手・ボール・描画はそのまま残ります。`
    )
  ) {
    return;
  }

  if (isSetTemplate(t)) {
    let n = 0;
    for (const m of MODES) {
      const data = getTemplateModeData(t, m);
      if (!data) continue;
      applyFormationToMode(m, data);
      pushHistory(m);
      n++;
    }
    fullRender();
    closeModal("template-preview");
    closeModal("templates");
    scheduleSave();
    toast(`「${t.name}」を${n}モードに読み込みました`);
    return;
  }

  // 旧形式：保存モードへ適用
  const data = getTemplateModeData(t, t.mode);
  if (!data) {
    toast("読み込めるデータがありません");
    return;
  }
  applyFormationToMode(t.mode, data);
  pushHistory(t.mode);
  fullRender();
  closeModal("template-preview");
  closeModal("templates");
  scheduleSave();
  toast(`「${t.name}」を${MODE_LABEL[t.mode]}に読み込みました`);
}

function loadTemplateCurrentMode() {
  const t = state.templates.find((x) => x.id === tplPreviewId);
  if (!t) return;
  const mode = state.currentMode;
  let data = getTemplateModeData(t, mode);

  // 旧形式：今のモードと違う場合は、プレビュー中のデータを今のモードへ入れる
  if (!data && !isSetTemplate(t)) {
    data = getTemplateModeData(t, t.mode);
  }
  if (!data) {
    toast(`${MODE_LABEL[mode]}用のデータがありません`);
    return;
  }
  if (
    !confirm(
      `「${t.name}」を今の${MODE_LABEL[mode]}に読み込みますか？\n\n自チームの選手配置が置き換わります。\n相手・ボール・描画はそのまま残ります。`
    )
  ) {
    return;
  }
  applyFormationToMode(mode, data);
  pushHistory(mode);
  fullRender();
  closeModal("template-preview");
  closeModal("templates");
  scheduleSave();
  toast(`「${t.name}」を${MODE_LABEL[mode]}に読み込みました`);
}

function renameTemplate(id) {
  const t = state.templates.find((x) => x.id === id);
  if (!t) return;
  const name = prompt("新しい名前", t.name);
  if (!name || !name.trim()) return;
  t.name = name.trim();
  renderTemplateList();
  const title = $("#tpl-preview-title");
  if (tplPreviewId === id && title) title.textContent = t.name;
  scheduleSave(true);
}

function deleteTemplate(id) {
  if (!confirm("このテンプレートを削除しますか？")) return;
  state.templates = state.templates.filter((t) => t.id !== id);
  if (tplPreviewId === id) closeTemplatePreview();
  renderTemplateList();
  scheduleSave(true);
}

// ---------- スナップ ----------
function openSnapshots() {
  closeSnapshotPreview();
  $("#modal-snapshots").hidden = false;
  renderSnapshotList();
}

function closeSnapshotPreview() {
  const modal = $("#modal-snapshot-preview");
  if (modal) modal.hidden = true;
  snapPreviewId = null;
  const layer = $("#snap-mini-pieces");
  if (layer) layer.innerHTML = "";
}

function renderSnapshotList() {
  const list = els.snapshotList;
  if (!list) return;
  list.innerHTML = "";
  if (!state.snapshots.length) {
    list.innerHTML = `<li class="empty-note">保存されたスナップはありません</li>`;
    return;
  }
  for (const s of state.snapshots) {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    const date = new Date(s.updatedAt || s.createdAt).toLocaleString("ja-JP");
    const drawings = s.board?.drawings?.length || 0;
    li.innerHTML = `
      <button type="button" class="item-drag" data-drag-handle aria-label="ドラッグで並び替え" title="ドラッグで並び替え">⋮⋮</button>
      <div class="item-info">
        <div class="item-name">${escapeHtml(s.name)}</div>
        <div class="item-meta">${MODE_LABEL[s.mode] || ""} · ${date}${drawings ? ` · 描画${drawings}` : ""}</div>
      </div>
      <div class="item-actions">
        <button type="button" data-act="preview">プレビュー</button>
        <button type="button" data-act="overwrite">上書き</button>
        <button type="button" data-act="rename">改名</button>
        <button type="button" class="danger" data-act="del">削除</button>
      </div>
    `;
    li.querySelector('[data-act="preview"]').onclick = () => openSnapshotPreview(s.id);
    li.querySelector('[data-act="overwrite"]').onclick = () => overwriteSnapshot(s.id);
    li.querySelector('[data-act="rename"]').onclick = () => renameSnapshot(s.id);
    li.querySelector('[data-act="del"]').onclick = () => deleteSnapshot(s.id);
    list.appendChild(li);
  }
  bindListDragReorder(list, () => {
    if (syncArrayOrderFromList(list, state.snapshots)) scheduleSave(true);
  });
}

function saveSnapshot() {
  const name = els.snapshotName.value.trim();
  if (!name) {
    toast("スナップ名を入力してください");
    return;
  }
  const now = Date.now();
  state.snapshots.unshift({
    id: uid(),
    name,
    mode: state.currentMode,
    piecesLocked: state.piecesLocked,
    board: deepClone(board()),
    createdAt: now,
    updatedAt: now
  });
  els.snapshotName.value = "";
  renderSnapshotList();
  scheduleSave(true);
  toast("スナップを保存しました");
}

function openSnapshotPreview(id) {
  const s = state.snapshots.find((x) => x.id === id);
  if (!s) return;
  snapPreviewId = id;
  const title = $("#snap-preview-title");
  if (title) title.textContent = s.name;
  const meta = $("#snap-preview-meta");
  if (meta) {
    const pieces = s.board?.pieces || [];
    const players = pieces.filter((p) => p.kind === "player").length;
    const opponents = pieces.filter((p) => p.kind === "opponent").length;
    const balls = pieces.filter((p) => p.kind === "ball").length;
    const drawings = s.board?.drawings?.length || 0;
    const date = new Date(s.updatedAt || s.createdAt).toLocaleString("ja-JP");
    meta.textContent = `${MODE_LABEL[s.mode] || "?"} · 選手${players} / 相手${opponents} / ボール${balls}${drawings ? ` / 描画${drawings}` : ""} · ${date}`;
  }
  fillSnapPreviewLayer($("#snap-mini-pieces"), s.board);
  $("#modal-snapshot-preview").hidden = false;
}

function fillSnapPreviewLayer(layer, boardData) {
  if (!layer) return;
  layer.innerHTML = "";
  for (const p of boardData?.pieces || []) {
    if (!p || (p.kind !== "player" && p.kind !== "opponent" && p.kind !== "ball")) continue;
    const el = document.createElement("div");
    el.className = `snap-mini-piece ${p.kind}`;
    el.style.left = `${(p.x / BOARD_W) * 100}%`;
    el.style.top = `${(p.y / BOARD_H) * 100}%`;
    if (p.kind === "player") {
      const role = getRole(p.name, boardData.roles) || "none";
      el.classList.add(`role-${role}`);
      el.title = p.name || "";
      el.textContent = [...(p.name || "?")][0] || "?";
    }
    layer.appendChild(el);
  }
}

function overwriteSnapshot(id) {
  const s = state.snapshots.find((x) => x.id === id);
  if (!s) return;
  if (
    !confirm(
      `「${s.name}」を今の盤面で上書きしますか？\n\nモードは現在の「${MODE_LABEL[state.currentMode]}」になります。\n選手・相手・ボール・描画を含めて保存されます。`
    )
  ) {
    return;
  }
  s.mode = state.currentMode;
  s.piecesLocked = state.piecesLocked;
  s.board = deepClone(board());
  s.updatedAt = Date.now();
  renderSnapshotList();
  if (snapPreviewId === id) openSnapshotPreview(id);
  scheduleSave(true);
  toast(`「${s.name}」を上書きしました`);
}

function loadSnapshot(id = snapPreviewId) {
  const s = state.snapshots.find((x) => x.id === id);
  if (!s) return;
  if (
    !confirm(
      `「${s.name}」を読み込みますか？\n\n${MODE_LABEL[s.mode]}モードの盤面全体（選手・相手・ボール・描画）が置き換わります。\n他のモードには影響しません。`
    )
  ) {
    return;
  }
  // スナップのモードへ切替して盤面全体を復元
  state.currentMode = s.mode;
  $$(".mode-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.mode === s.mode);
  });
  state.modes[s.mode] = deepClone(s.board);
  if (typeof s.piecesLocked === "boolean") state.piecesLocked = s.piecesLocked;
  resetHistory(s.mode);
  fullRender();
  closeSnapshotPreview();
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
  const title = $("#snap-preview-title");
  if (snapPreviewId === id && title) title.textContent = s.name;
  scheduleSave(true);
}

function deleteSnapshot(id) {
  if (!confirm("このスナップを削除しますか？")) return;
  state.snapshots = state.snapshots.filter((s) => s.id !== id);
  if (snapPreviewId === id) closeSnapshotPreview();
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
  $$(".toggle-draw-btn").forEach((btn) => {
    btn.classList.toggle("is-off", !visible);
    btn.setAttribute("aria-pressed", visible ? "true" : "false");
    btn.title = visible ? "描画を非表示" : "描画を表示";
  });
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
            panX: data.modes[m].panX || 0,
            panY: data.modes[m].panY || 0,
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
  if (!b) return;
  b.classList.remove("cloud", "error");
  b.textContent = "";
  let label = "ローカル保存";
  if (kind === "cloud") {
    b.classList.add("cloud");
    label = "クラウド同期中";
  } else if (kind === "error") {
    b.classList.add("error");
    label = "同期エラー";
  } else if (kind === "offline-cfg") {
    label = "ローカル保存（未設定）";
  }
  b.title = label;
  b.setAttribute("aria-label", label);
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
  $$("[data-eraser-mode]").forEach((b) => {
    b.addEventListener("click", () => setEraserMode(b.dataset.eraserMode));
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
  $("#btn-undo-tablet")?.addEventListener("click", undo);
  $("#btn-redo-tablet")?.addEventListener("click", redo);
  $("#btn-clear-draw")?.addEventListener("click", clearDrawings);
  $$(".toggle-draw-btn").forEach((btn) => {
    btn.addEventListener("click", toggleDrawingsVisible);
  });
  $("#btn-zoom-in")?.addEventListener("click", () => setZoom(board().zoom + 0.15));
  $("#btn-zoom-out")?.addEventListener("click", () => setZoom(board().zoom - 0.15));
  $("#btn-zoom-reset")?.addEventListener("click", () => resetView());

  els.btnLock?.addEventListener("click", toggleLock);
  els.btnLockPresent?.addEventListener("click", toggleLock);
  $("#btn-add-opponent")?.addEventListener("click", addOpponent);
  $("#btn-add-ball")?.addEventListener("click", addBall);
  $("#btn-add-opponent-action")?.addEventListener("click", addOpponent);
  $("#btn-add-ball-action")?.addEventListener("click", addBall);
  $("#btn-clear-pieces")?.addEventListener("click", clearPieces);
  $("#btn-select-all")?.addEventListener("click", selectAllPieces);
  $("#btn-align-row")?.addEventListener("click", () => alignSelectedPieces("horizontal"));
  $("#btn-align-col")?.addEventListener("click", () => alignSelectedPieces("vertical"));
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
  $("#btn-collapse-actions")?.addEventListener("click", () => setPanelCollapsed("actions", true));
  $("#btn-expand-actions")?.addEventListener("click", () => setPanelCollapsed("actions", false));

  // メンバー（1画面エディタ）
  $("#btn-members-clear")?.addEventListener("click", clearDraftMembers);
  $("#btn-members-done")?.addEventListener("click", applyMembers);
  $("#btn-save-template").addEventListener("click", saveTemplate);
  $("#btn-save-snapshot").addEventListener("click", saveSnapshot);
  $("#btn-tpl-back")?.addEventListener("click", () => closeTemplatePreview());
  $("#btn-tpl-zoom-back")?.addEventListener("click", () => closeTplZoom());
  $$("[data-tpl-zoom]").forEach((el) => {
    el.addEventListener("click", () => openTplZoom(el.dataset.tplZoom));
  });
  $$(".tpl-mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => setTplPreviewMode(tab.dataset.tplMode));
  });
  $("#btn-tpl-load-set")?.addEventListener("click", loadTemplateSet);
  $("#btn-tpl-load-current")?.addEventListener("click", loadTemplateCurrentMode);
  $("#btn-tpl-overwrite-set")?.addEventListener("click", () => {
    if (tplPreviewId) overwriteTemplate(tplPreviewId);
  });
  $("#btn-tpl-overwrite-current")?.addEventListener("click", () => {
    if (tplPreviewId) overwriteTemplateCurrentMode(tplPreviewId);
  });
  $("#btn-snap-back")?.addEventListener("click", () => closeSnapshotPreview());
  $("#btn-snap-load")?.addEventListener("click", () => loadSnapshot());
  $("#btn-snap-overwrite")?.addEventListener("click", () => {
    if (snapPreviewId) overwriteSnapshot(snapPreviewId);
  });

  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.dataset.close));
  });

  // ポインタ
  els.viewport.addEventListener("pointerdown", onViewportPointerDown);
  els.viewport.addEventListener("pointermove", onViewportPointerMove);
  els.viewport.addEventListener("pointerup", onViewportPointerUp);
  els.viewport.addEventListener("pointercancel", onViewportPointerUp);
  els.viewport.addEventListener("wheel", onWheel, { passive: false });

  // ダブルタップ／ピンチによるページズーム抑止（ボード内ピンチは別途許可）
  let lastTouchEndAt = 0;
  const blockPageZoom = (e) => {
    if (e.cancelable) e.preventDefault();
  };
  document.addEventListener("gesturestart", blockPageZoom, { passive: false, capture: true });
  document.addEventListener("gesturechange", blockPageZoom, { passive: false, capture: true });
  document.addEventListener("gestureend", blockPageZoom, { passive: false, capture: true });
  document.addEventListener(
    "touchend",
    (e) => {
      const now = Date.now();
      if (now - lastTouchEndAt <= 320) {
        if (e.cancelable) e.preventDefault();
      }
      lastTouchEndAt = now;
    },
    { passive: false, capture: true }
  );
  document.addEventListener(
    "dblclick",
    (e) => {
      if (e.cancelable) e.preventDefault();
    },
    { capture: true }
  );

  // キーボード
  window.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    if (meta && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    if (e.key === "Escape") {
      setCopyMenuOpen(false);
      setPresentMode(false);
      if (!$("#modal-tpl-zoom")?.hidden) {
        closeTplZoom();
        return;
      }
      if (!$("#modal-template-preview")?.hidden) {
        closeTemplatePreview();
        return;
      }
      if (!$("#modal-snapshot-preview")?.hidden) {
        closeSnapshotPreview();
        return;
      }
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
  window.addEventListener("orientationchange", () => {
    // iPad 回転後にレイアウト寸法が遅れて変わることがある
    requestAnimationFrame(() => fitStage());
    setTimeout(() => fitStage(), 280);
  });
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
