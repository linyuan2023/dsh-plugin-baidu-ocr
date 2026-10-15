// lib/hq.js — 矢量图纸高清重截：本地 PDF 且有版面 JSON 时，按版面坐标用本机
// pymupdf 以高 DPI 重新截取图片区域（图纸是矢量+文本层内容，后端抠出的区域图
// 分辨率不足），优先于 materializeImages 的网络下载。仅百度 VL 路径可用（AI Studio
// 无版面 JSON）。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonCmd } from "./pylaunch.js";

/** pages: layoutToPageBlocks 输出（image 块带 _pos=[x,y,w,h]（版面像素）、页带
 *  _pageW=内容右缘最大值）。缩放比在 python 侧按"原件同口径内容右缘(pt)/_pageW"求，
 *  取不到内容极值退回页宽；比例超出 [0.3, 3] 视为映射失败该格跳过（回退 url 下载），
 *  绝不产出错位图。
 *  重截成功的块填 data/ext，保留 url（md 导出仍可引用直链）。
 *  返回 { recaptured, total, failed }；python/pymupdf 不可用返回 null。 */
export function recaptureVectorImages(pages, pdfPath, { dpi = 220, timeoutMs = 300000 } = {}) {
  try {
    const probe = spawnSync(pythonCmd(), ["-c", "import pymupdf"], { encoding: "utf8", timeout: 30000, windowsHide: true });
    if (probe.status !== 0) return null;
  } catch {
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), "ocr-hq-"));
  const manifest = [];
  const targets = []; // [{ block, out }]
  let n = 0;
  pages.forEach((page, pi) => {
    const pageW = Number(page?._pageW) || 0;
    if (!(pageW > 0)) return;
    for (const b of page.blocks ?? []) {
      if (b.type !== "image" || !Array.isArray(b._pos)) continue;
      const [x, y, w, h] = b._pos.map((v) => Number(v) || 0);
      if (!(w > 0 && h > 0)) continue;
      n += 1;
      const out = join(dir, `hq-${String(n).padStart(4, "0")}.png`);
      manifest.push({ page: pi + 1, x, y, w, h, pageW, dpi, out });
      targets.push({ block: b, out });
    }
  });
  if (!manifest.length) {
    rmSync(dir, { recursive: true, force: true });
    return { recaptured: 0, total: 0, failed: 0 };
  }

  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const script =
    "import sys, json, pymupdf\n" +
    "doc = pymupdf.open(sys.argv[1])\n" +
    "items = json.load(open(sys.argv[2], encoding='utf-8'))\n" +
    "ok = 0\n" +
    "ext_cache = {}\n" +
    "def content_extent(pg):\n" +
    "    x1 = y1 = 0.0\n" +
    "    try:\n" +
    "        for b in pg.get_text('blocks'):\n" +
    "            x1 = max(x1, b[2]); y1 = max(y1, b[3])\n" +
    "        for im in pg.get_image_info():\n" +
    "            bb = im.get('bbox')\n" +
    "            if bb:\n" +
    "                x1 = max(x1, bb[2]); y1 = max(y1, bb[3])\n" +
    "        for d in pg.get_drawings():\n" +
    "            r = d.get('rect')\n" +
    "            if r is not None:\n" +
    "                x1 = max(x1, r.x1); y1 = max(y1, r.y1)\n" +
    "    except Exception:\n" +
    "        return None\n" +
    "    return (x1, y1) if x1 > 1 and y1 > 1 else None\n" +
    "for it in items:\n" +
    "    pg = doc[it['page'] - 1]\n" +
    // 口径对齐：layout 的 pageW 是"内容右缘最大值"（版面像素空间），缩放比分母须用同一内容
    // 在 PDF pt 空间的右缘，否则页边距被当内容、s 被高估 → 裁剪窗系统性偏移。取不到退回页宽。
    "    pi = it['page']\n" +
    "    if pi not in ext_cache:\n" +
    "        ext_cache[pi] = content_extent(pg)\n" +
    "    ext = ext_cache[pi]\n" +
    "    base = ext[0] if ext else pg.rect.width\n" +
    "    s = base / it['pageW'] if it['pageW'] else 0\n" +
    "    if not (0.3 <= s <= 3):\n" +
    "        continue\n" +
    "    r = pymupdf.Rect(it['x'] * s, it['y'] * s, (it['x'] + it['w']) * s, (it['y'] + it['h']) * s) & pg.rect\n" +
    "    if r.is_empty or r.width <= 1 or r.height <= 1:\n" +
    "        continue\n" +
    "    pg.get_pixmap(clip=r, dpi=it.get('dpi', 220)).save(it['out'])\n" +
    "    ok += 1\n" +
    "print(ok)";
  const r = spawnSync(pythonCmd(), ["-c", script, String(pdfPath), manifestPath], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  let recaptured = 0;
  let failed = 0;
  if (r.status === 0) {
    for (const t of targets) {
      try {
        const buf = readFileSync(t.out);
        if (buf.length < 100) throw new Error("too small");
        t.block.data = buf;
        t.block.ext = "png";
        recaptured += 1;
      } catch {
        failed += 1;
      }
    }
  } else {
    failed = targets.length;
  }
  rmSync(dir, { recursive: true, force: true });
  return { recaptured, total: targets.length, failed };
}
