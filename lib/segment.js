// lib/segment.js — 大 PDF 自动分段：切分、逐段识别、结果合并。
// 分段让 476 页级图册在 330s 轮询上限内可完成，且每段独立缓存/可重试。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OcrError } from "./errors.js";
import { pythonCmd } from "./pylaunch.js";
import { mergeCrossPageParagraphs } from "./textflow.js";

export const SEGMENT_DATA_DIR = join(".dsh", "ocr", "segments");

/** 段规划：from/to 为 1 起始页码（含两端）；totalPages<1 或非有限数返回空计划 */
export function planSegments(totalPages, size = 40) {
  const total = Math.floor(totalPages);
  if (!Number.isFinite(total) || total < 1) return [];
  // size 语义：Infinity = 调用方明确"不分段"（一段覆盖全本）；NaN/非有限 → 回落默认 40。
  // 旧版直接 Math.floor(size)：Infinity 会产出 to:Infinity 的段，python int("inf")
  // 抛 ValueError，报出 confusing 的 E_SEGMENT（#18）
  const step = size === Infinity ? Infinity : Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 40;
  const segs = [];
  for (let from = 1; from <= total; from += step) {
    segs.push({ index: segs.length + 1, from, to: Math.min(from + step - 1, total) });
  }
  return segs;
}

/** 段工作目录：路径+大小+内容哈希 的短哈希（同源文件重跑复用已切段）。
 *  内容哈希必须进键：只按路径+字节数的话，同路径同大小但内容不同的文件会共用目录，
 *  中断残留的 .ok 旧段会被当成新文件的段提交云端，错内容按新缓存键永久落库（#10） */
export function segmentDirFor(srcPath, bytes, rootDir, contentHash) {
  const h = createHash("sha256").update(`${srcPath}:${bytes}:${contentHash ?? ""}`).digest("hex").slice(0, 12);
  return join(rootDir, h);
}

/** 本机页数（pymupdf）；不可用返回 null */
export function pdfPageCountSync(pdfPath, { timeoutMs = 60000 } = {}) {
  try {
    const r = spawnSync(
      pythonCmd(),
      ["-c", "import sys, pymupdf; print(len(pymupdf.open(sys.argv[1])))", String(pdfPath)],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true }
    );
    if (r.status !== 0) return null;
    const n = parseInt(String(r.stdout).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 切分落盘（幂等：已有 .ok 标记的段直接复用）。返回带 file 字段的 plan。 */
export function writeSegmentPdfs(srcPath, plan, dir, { timeoutMs = 120000 } = {}) {
  mkdirSync(dir, { recursive: true });
  const script =
    "import sys, pymupdf\n" +
    "src = pymupdf.open(sys.argv[1]); f = int(sys.argv[2]); t = int(sys.argv[3])\n" +
    "d = pymupdf.open(); d.insert_pdf(src, from_page=f - 1, to_page=t - 1)\n" +
    "d.save(sys.argv[4]); print(len(d))";
  for (const seg of plan) {
    const out = join(dir, `seg-${String(seg.index).padStart(3, "0")}.pdf`);
    if (existsSync(out) && existsSync(`${out}.ok`)) {
      seg.file = out;
      continue;
    }
    const r = spawnSync(pythonCmd(), ["-c", script, String(srcPath), String(seg.from), String(seg.to), out], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0 || !existsSync(out)) {
      const detail = String(r.stderr || r.stdout || r.error?.message || "").trim();
      throw new OcrError("E_SEGMENT", `第 ${seg.index} 段（第 ${seg.from}-${seg.to} 页）切分失败：${detail.slice(-200) || "无输出"}`);
    }
    writeFileSync(`${out}.ok`, "ok");
    seg.file = out;
  }
  return plan;
}

/** 各段后端结果合并为一个 result（pages 顺序拼接；layoutJson.pages concat 与
 *  blocksToDocxPages 的逐页渲染天然兼容）。
 *  paraMerge（v0.4，默认开）：段边界段落合并——上一段末行无句读与下一段首行拼接。 */
export function mergeSegmentResults(results, { paraMerge = true } = {}) {
  const ok = (results ?? []).filter(Boolean);
  if (!ok.length) return null;
  const merged = mergeCrossPageParagraphs(
    ok.map((r) => r.markdown ?? r.text ?? "").filter((t) => t && t.trim()),
    { enabled: paraMerge }
  );
  const markdown = merged.text;
  return {
    engine: "vl",
    channel: "B",
    markdown,
    text: markdown,
    taskId: ok.map((r) => r.taskId).filter(Boolean).join(","),
    status: "done",
    pagesCount: ok.reduce((n, r) => n + (r.pagesCount ?? 0), 0),
    layoutJson: ok.some((r) => r.layoutJson?.pages?.length) ? { pages: ok.flatMap((r) => r.layoutJson?.pages ?? []) } : null,
    tablesHtml: ok.flatMap((r) => r.tablesHtml ?? []),
    ...(merged.merged > 0 ? { paraMerged: merged.merged } : {}),
    segmented: { count: ok.length },
  };
}

/** 清理段工作目录（保留缓存；.ok 标记随目录删除，下次全量重切） */
export function cleanupSegmentDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
