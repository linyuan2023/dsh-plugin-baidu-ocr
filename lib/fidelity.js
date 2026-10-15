// lib/fidelity.js — 复刻度评分（v0.4）：数字 PDF 原件为 ground truth，量化产物的复刻水平。
// 三项指标（0–100）：
//   textCoverage：逐页字符 LCS 覆盖率（原文→产物；双方去空白、单页截断 3000 字；>50 页抽样 20 页）
//   blockIoU：原件文本块矩形（pymupdf）× 产物 bbox（0–1000 归一化）贪心配对，命中率×平均IoU×覆盖率合成
//   pageMatch：页数一致 × 各页方向一致（双方均有页尺寸时含 ±2% 尺寸一致）
//   overall = 0.5×textCoverage + 0.3×blockIoU + 0.2×pageMatch
// pymupdf 不可用 / 产物无 bbox / 非本地 PDF → 返回 null（调用方 note「评分不可用」，不阻断主流程）。
import { spawnSync } from "node:child_process";
import { pythonCmd } from "./pylaunch.js";
import { layoutToDocModel } from "./docmodel.js";

const MAX_SAMPLE = 20; // 抽样上限
const CHAR_CAP = 3000; // 单页 LCS 字符截断（防超长页 O(n²) 爆炸）
const IOU_HIT = 0.3; // 配对命中阈值

const PAGE_SCRIPT = [
  "import sys, json, pymupdf",
  "d = pymupdf.open(sys.argv[1])",
  "out = []",
  "for p in d:",
  "    words = [w[4] for w in p.get_text('words')]",
  "    blocks = [[b[0], b[1], b[2], b[3]] for b in p.get_text('blocks')]",
  "    out.append({'w': p.rect.width, 'h': p.rect.height, 'words': words, 'blocks': blocks, 'images': len(p.get_images())})",
  "sys.stdout.write(json.dumps(out))",
].join("\n");

function runPymupdf(sourcePath, timeoutMs) {
  try {
    const r = spawnSync(pythonCmd(), ["-c", PAGE_SCRIPT, String(sourcePath)], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout?.trim()) return null;
    const pages = JSON.parse(r.stdout);
    return Array.isArray(pages) && pages.length ? pages : null;
  } catch {
    return null;
  }
}

const squeeze = (s) => String(s ?? "").replace(/\s+/g, "");

/** 字符级 LCS 覆盖率：原文 → 产物方向（产物是原文的忠实子集/转写程度）。 */
function lcsCoverage(origText, prodText) {
  const a = squeeze(origText).slice(0, CHAR_CAP);
  const b = squeeze(prodText).slice(0, CHAR_CAP);
  if (!a.length) return 1; // 原页无文本层（扫描页）：不计入（调用方跳过该页）
  if (!b.length) return 0;
  const prev = new Uint32Array(b.length + 1);
  const cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = ai === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev.set(cur);
  }
  return Math.min(1, prev[b.length] / a.length);
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const denom = areaA + areaB - inter;
  return denom > 0 ? inter / denom : 0;
}

/** 单页版面相似度：产物块（0–1000，按 0 起点内容极值归一化——与 layout.js 的 bbox 口径一致）
 *  × 原件块（同一口径：x/max(x1)、y/max(y1)）。两边都以内容左上为原点、极值为满刻度。 */
function pageBlockIou(prodBlocks, origBlocks) {
  if (!origBlocks.length) return null; // 原件无文本块（扫描页）→ 该页不计
  if (!prodBlocks.length) return 0;
  const contentW = Math.max(...origBlocks.map((b) => b[2]), 1);
  const contentH = Math.max(...origBlocks.map((b) => b[3]), 1);
  const norm = origBlocks.map((b) => [
    (b[0] / contentW) * 1000,
    (b[1] / contentH) * 1000,
    (b[2] / contentW) * 1000,
    (b[3] / contentH) * 1000,
  ]);
  let matched = 0;
  let iouSum = 0;
  const used = new Set();
  for (const pb of prodBlocks) {
    if (!Array.isArray(pb?.bbox)) continue;
    let best = 0;
    let bestIdx = -1;
    for (let i = 0; i < norm.length; i++) {
      if (used.has(i)) continue;
      const v = iou(pb.bbox, norm[i]);
      if (v > best) {
        best = v;
        bestIdx = i;
      }
    }
    if (best >= IOU_HIT && bestIdx >= 0) {
      used.add(bestIdx);
      matched++;
      iouSum += best;
    }
  }
  const prodWithBbox = prodBlocks.filter((b) => Array.isArray(b?.bbox)).length;
  const precision = prodWithBbox ? matched / prodWithBbox : 0;
  const recall = matched / origBlocks.length;
  const avgIou = matched ? iouSum / matched : 0;
  // 命中率（查准×查全均值）× 配对质量：产物多切/少切块都会扣分
  return ((precision + recall) / 2) * (0.5 + 0.5 * avgIou);
}

/**
 * 评分主入口。docModel：docmodel.js 的 DocumentModel；或直接给 layoutJson（内部构建）。
 * @returns null（不可评）或 { overall, textCoverage, blockIoU, pageMatch, detail }
 */
export function scoreReplica({ sourcePath, docModel, layoutJson, formulaMode = "unicode", mergeMode = "strict", paraMerge = false, timeoutMs = 60000 } = {}) {
  let dm = docModel;
  if (!dm && layoutJson) {
    try {
      dm = layoutToDocModel(layoutJson, { formulaMode, mergeMode, paraMerge });
    } catch {
      return null;
    }
  }
  if (!sourcePath || !dm?.pages?.length) return null;
  const prodHasBbox = dm.pages.some((p) => (p.blocks ?? []).some((b) => Array.isArray(b?.bbox)));
  if (!prodHasBbox) return null;
  const orig = runPymupdf(sourcePath, timeoutMs);
  if (!orig) return null;

  const prodPages = dm.pages;
  const pageIdx = prodPages.length > MAX_SAMPLE && orig.length > MAX_SAMPLE
    ? [...Array(5).keys(), ...Array.from({ length: MAX_SAMPLE - 5 }, (_, i) => Math.floor(((i + 1) * (orig.length - 5)) / (MAX_SAMPLE - 4)))]
    : null;
  const indices = pageIdx ?? orig.map((_, i) => i);

  let covSum = 0;
  let covN = 0;
  let iouSum = 0;
  let iouN = 0;
  for (const i of indices) {
    const o = orig[i];
    const p = prodPages[i];
    if (!o || !p) continue;
    const origText = (o.words ?? []).join("");
    if (squeeze(origText).length >= 10) {
      const prodText = (p.blocks ?? []).map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
      covSum += lcsCoverage(origText, prodText);
      covN++;
    }
    const bi = pageBlockIou(p.blocks ?? [], o.blocks ?? []);
    if (bi != null) {
      iouSum += bi;
      iouN++;
    }
  }

  const textCoverage = covN ? (covSum / covN) * 100 : null;
  const blockIoU = iouN ? (iouSum / iouN) * 100 : null;
  // pageMatch：页数一致即满分。方向/尺寸不比——docModel 的宽高是"内容极值"（非页面尺寸），
  // 内容横向排布时必然"横"，与真实页面方向无关（页面几何由 3.8 的 pageSizes 通道单独保证）。
  const pagesEqual = orig.length === prodPages.length ? 1 : 0;
  const pageMatch = pagesEqual * 100;

  const parts = [textCoverage, blockIoU, pageMatch].map((v) => (v == null ? null : v));
  const weights = [0.5, 0.3, 0.2];
  let overall = 0;
  let wSum = 0;
  parts.forEach((v, i) => {
    if (v != null) {
      overall += v * weights[i];
      wSum += weights[i];
    }
  });
  if (!wSum) return null;
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    overall: r1(overall / wSum),
    textCoverage: r1(textCoverage),
    blockIoU: r1(blockIoU),
    pageMatch: r1(pageMatch),
    detail: { sampled: indices.length, totalPages: orig.length },
  };
}
