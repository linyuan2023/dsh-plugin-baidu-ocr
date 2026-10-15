// lib/replica.js — sandwich PDF（v0.4，扫描件复刻旗舰）：原页高 DPI 位图打底 + 版面文本隐形文字层。
// 视觉 100% 复刻（位图即原件本身）+ 全文可检索可复制（隐形文字 render_mode=3）。
// 仅文本类块（标题/段落）按 bbox 叠加；表格/图片/公式留在位图里（它们在原件页面上本来就存在）。
// pymupdf 缺失/源打不开时抛 OcrError，由 saveResult 的调用方决定降级（export 层已保证先验条件）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OcrError } from "./errors.js";
import { pythonCmd } from "./pylaunch.js";

// stdin 传 spec（页数可能很大，argv 有长度上限）；stdout 打印产物页数供校验。
// 隐形文字：insert_textbox(render_mode=3)；放不下时降字号重试 3 轮，仍放不下计数跳过（位图兜底，内容无损）。
const REPLICA_SCRIPT = `
import sys, json, pymupdf
spec = json.loads(sys.stdin.read())
src = pymupdf.open(spec["source"])
out = pymupdf.open()
skipped = 0
for p in spec["pages"]:
    sp = src[p["index"] - 1]
    pix = sp.get_pixmap(dpi=spec["dpi"])
    page = out.new_page(width=sp.rect.width, height=sp.rect.height)
    page.insert_image(page.rect, pixmap=pix)
    for b in p["blocks"]:
        bbox = b.get("bbox")
        text = b.get("text")
        if not bbox or not text:
            continue
        rect = pymupdf.Rect(
            bbox[0] / 1000.0 * sp.rect.width, bbox[1] / 1000.0 * sp.rect.height,
            bbox[2] / 1000.0 * sp.rect.width, bbox[3] / 1000.0 * sp.rect.height)
        if rect.is_empty:
            continue
        fs = max(6, min(24, rect.height * 0.8))
        rc = page.insert_textbox(rect, text, fontsize=fs, fontname="china-s", render_mode=3, align=0)
        tries = 0
        while rc < 0 and tries < 3:
            fs = max(5, fs * 0.7)
            rc = page.insert_textbox(rect, text, fontsize=fs, fontname="china-s", render_mode=3, align=0)
            tries += 1
        if rc < 0:
            skipped += 1
out.save(sys.argv[1], garbage=3, deflate=True)
print(len(out), skipped)
`;

/** 原件 PDF + DocumentModel → sandwich PDF。
 *  @returns { buffer:Buffer, pages:number, skipped:number }——skipped 为放不下隐形层的文本块数（位图已含内容，不丢）。 */
export function replicaPdf({ sourcePath, docModel, dpi = 200, timeoutMs = 300000 } = {}) {
  if (!sourcePath || !docModel?.pages?.length) {
    throw new OcrError("E_REPLICA_INPUT", "复刻 PDF 需要本地 PDF 源与版面文档模型");
  }
  const spec = {
    source: String(sourcePath),
    dpi: Math.min(400, Math.max(96, Number(dpi) || 200)),
    pages: docModel.pages.map((p) => ({
      index: p.index,
      blocks: (p.blocks ?? []).filter((b) => typeof b?.text === "string" && b.text.trim() && Array.isArray(b?.bbox)),
    })),
  };
  const outPath = join(tmpdir(), `ocr-replica-${process.pid}-${Date.now()}.pdf`);
  let r;
  try {
    r = spawnSync(pythonCmd(), ["-c", REPLICA_SCRIPT, outPath], {
      input: JSON.stringify(spec),
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    throw new OcrError("E_REPLICA", `复刻 PDF 执行失败：${e.message}`);
  }
  const detail = String(r.stderr || r.stdout || r.error?.message || "").trim();
  if (r.status !== 0 || !existsSync(outPath)) {
    throw new OcrError("E_REPLICA", `复刻 PDF 生成失败：${detail.slice(-200) || "无输出（python/pymupdf 不可用？）"}`);
  }
  try {
    const buf = readFileSync(outPath);
    if (buf.length < 1000) throw new OcrError("E_REPLICA", `复刻 PDF 产物异常（${buf.length} 字节）`);
    // 只解析末行（锚定 "页数 跳过数"）：stdout 可能混入 pymupdf/MuPDF 的告警文本
    const lastLine = String(r.stdout ?? "").trim().split("\n").pop() ?? "";
    const m = /^(\d+)\s+(\d+)$/.exec(lastLine);
    return {
      buffer: buf,
      pages: m ? Number(m[1]) || docModel.pages.length : docModel.pages.length,
      skipped: m ? Number(m[2]) || 0 : 0,
    };
  } finally {
    rmSync(outPath, { force: true });
  }
}
