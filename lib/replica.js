// lib/replica.js — sandwich PDF（v0.4，扫描件复刻旗舰）：原页高 DPI 位图打底 + 版面文本隐形文字层。
// 视觉 100% 复刻（位图即原件本身）+ 全文可检索可复制（隐形文字 render_mode=3）。
// 仅文本类块（标题/段落）按 bbox 叠加；表格/图片/公式留在位图里（它们在原件页面上本来就存在）。
// pymupdf 缺失/源打不开时抛 OcrError，saveResult 捕获后降级可读 PDF。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OcrError } from "./errors.js";
import { pythonCmd } from "./pylaunch.js";

// stdin 传 spec（页数可能很大，argv 有长度上限）；stdout 打印产物页数供校验。
// 隐形文字：insert_textbox(render_mode=3)；放不下时降字号重试 3 轮，仍放不下计数跳过（位图兜底，内容无损）。
// bbox 反归一化口径：layout.js 的 0–1000 归一化分母是"内容右/下缘最大值"（原点 0，非页宽），
// 此处必须从原件算同一口径的极值，否则有页边距的文档隐形层被系统性拉伸（扫描页位图铺满时两者相等）。
const REPLICA_SCRIPT = `
import sys, json, pymupdf
spec = json.loads(sys.stdin.read())
src = pymupdf.open(spec["source"])
out = pymupdf.open()
skipped = 0
MAX_PIX = 40000000  # 单页位图像素上限（A0 高 DPI 防 OOM；超出按面积降 DPI）

def content_extent(pg):
    x1 = y1 = 0.0
    try:
        for b in pg.get_text("blocks"):
            x1 = max(x1, b[2]); y1 = max(y1, b[3])
        for im in pg.get_image_info():
            bb = im.get("bbox")
            if bb:
                x1 = max(x1, bb[2]); y1 = max(y1, bb[3])
        for d in pg.get_drawings():
            r = d.get("rect")
            if r is not None:
                x1 = max(x1, r.x1); y1 = max(y1, r.y1)
    except Exception:
        return None
    if x1 <= 1 or y1 <= 1:
        return None
    return x1, y1

for p in spec["pages"]:
    sp = src[p["index"] - 1]
    dpi = spec["dpi"]
    area = sp.rect.width * sp.rect.height
    if area > 0 and area * (dpi / 72.0) ** 2 > MAX_PIX:
        dpi = max(72, int(72.0 * (MAX_PIX / area) ** 0.5))
    pix = sp.get_pixmap(dpi=dpi)
    page = out.new_page(width=sp.rect.width, height=sp.rect.height)
    page.insert_image(page.rect, pixmap=pix)
    ext = content_extent(sp)
    W = ext[0] if ext else sp.rect.width
    H = ext[1] if ext else sp.rect.height
    for b in p["blocks"]:
        bbox = b.get("bbox")
        text = b.get("text")
        if not bbox or not text:
            continue
        rect = pymupdf.Rect(
            bbox[0] / 1000.0 * W, bbox[1] / 1000.0 * H,
            bbox[2] / 1000.0 * W, bbox[3] / 1000.0 * H) & page.rect
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
  try {
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
    try {
      rmSync(outPath, { force: true });
    } catch {}
  }
}
