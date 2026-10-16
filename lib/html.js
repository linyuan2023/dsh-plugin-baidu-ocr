// lib/html.js — 第 2 期：版面块流 → HTML → Edge headless 打印 PDF（零依赖，Windows 自带 Edge）
// 视觉保真路径：图片 data-url 内嵌、标题字号层级、表格边框；PDF 不可编辑但与原件最接近。
// v0.4：@page 用原件真实页尺寸（pagePt）、块级字号传递（_fontUnits×页高比例）、表注渲染。
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { pythonCmd } from "./pylaunch.js";
import { OcrError } from "./errors.js";
import { isHeaderRow, cellFlatText } from "./layout.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// HTML 渲染会把 \n 折叠成空白；块内换行（后端常把整页目录识别为一块）须转 <br/> 才保行结构
function escBr(s) {
  return esc(s).replace(/\r\n?|\n/g, "<br/>");
}

// 图片 MIME 表：与 sniffImageExt 的取值对齐。旧实现只分 png/其他→jpeg，
// 嗅探修复后 webp/gif/bmp 会被打上错误的 image/jpeg，Edge/LibreOffice 解不了 → PDF 里图静默丢失（#1）
const IMG_MIME = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };

function imgSrc(b) {
  const mime = IMG_MIME[b.ext] || "image/jpeg";
  return `data:${mime};base64,${b.data.toString("base64")}`;
}

/** 单页块流 → HTML（页面方向自适应：@page size 按 isLandscape 切换横/纵）。
 *  scale：字号整体缩放（逐页保真的溢出回收——表格自然高度超页高时缩小字号保证单页）。
 *  pagePt（v0.4）：{wPt,hPt} 原件真实页尺寸 → @page 精确复刻；pageHU：坐标页高（字号折算分母）。 */
export function blocksToHtml(blocks, { title = "OCR 识别结果", isLandscape = false, scale = 1, pagePt = null, pageHU = 0 } = {}) {
  const S = (pt) => `${Math.round(pt * scale * 10) / 10}pt`;
  // 块级字号（v0.4）：块高（坐标单位）×（真实页高pt/坐标页高）→ pt，clamp 7–42
  const fontFactor = pagePt?.hPt > 0 && pageHU > 0 ? pagePt.hPt / pageHU : 0;
  const fsOf = (b) => {
    if (!fontFactor || !b?._fontUnits) return "";
    const pt = Math.max(7, Math.min(42, b._fontUnits * fontFactor));
    return ` style="font-size:${S(pt)}"`;
  };
  const body = blocks
    .map((b) => {
      switch (b.type) {
        case "h1":
          return `<h1${fsOf(b)}>${escBr(b.text)}</h1>`;
        case "h2":
          return `<h2${fsOf(b)}>${escBr(b.text)}</h2>`;
        case "h3":
          return `<h3${fsOf(b)}>${escBr(b.text)}</h3>`;
        case "code":
          return `<pre>${esc((b.lines ?? [b.text ?? ""]).join("\n"))}</pre>`;
        case "image": {
          const src = imgSrc(b);
          const cap = b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : "";
          return src ? `<figure><img src="${src}" alt=""/>${cap}</figure>` : "";
        }
        case "table": {
          const rows = b.rows ?? [];
          if (!rows.length) return "";
          const header = isHeaderRow(rows); // 表头启发式与 docx 渲染一致
          const tblcap = b.caption ? `<p class="tblcap">${esc(b.caption)}</p>` : "";
          // 合并格：origin 加 rowspan/colspan，被覆盖格跳过
          const origin = new Map();
          const covered = new Set();
          for (const m of b.merges ?? []) {
            origin.set(`${m.r},${m.c}`, m);
            for (let r = m.r; r < m.r + m.rowSpan; r++) {
              for (let c = m.c; c < m.c + m.colSpan; c++) {
                if (!(r === m.r && c === m.c)) covered.add(`${r},${c}`);
              }
            }
          }
          const trs = rows
            .map((r, i) => {
              const tds = [];
              for (let c = 0; c < r.length; c++) {
                if (covered.has(`${i},${c}`)) continue;
                const m = origin.get(`${i},${c}`);
                const span = m ? ` rowspan="${m.rowSpan}" colspan="${m.colSpan}"` : "";
                const tag = header && i === 0 ? "th" : "td";
                tds.push(`<${tag}${span}>${esc(cellFlatText(r[c]))}</${tag}>`);
              }
              return `<tr>${tds.join("")}</tr>`;
            })
            .join("");
          return tblcap + `<table>${trs}</table>`;
        }
        default:
          return `<p${fsOf(b)}>${escBr(b.text ?? "")}</p>`;
      }
    })
    .filter(Boolean)
    .join("\n");
  // @page：原件真实页尺寸优先（pt），方向以 w/h 为准；无尺寸回退 A4 预设
  const hasPage = pagePt?.wPt > 0 && pagePt?.hPt > 0;
  if (hasPage) isLandscape = pagePt.wPt > pagePt.hPt;
  const size = hasPage ? `${pagePt.wPt}pt ${pagePt.hPt}pt` : isLandscape ? "A4 landscape" : "A4 portrait";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
@page { size: ${size}; margin: 14mm 13mm; }
* { box-sizing: border-box; }
body { font: ${S(12)}/1.6 "Source Han Serif SC","Noto Serif CJK SC",SimSun,serif; color: #111; margin: 0; }
h1 { font-size: ${S(19)}; text-align: center; margin: 0.5em 0; }
h2 { font-size: ${S(14.5)}; margin: 1em 0 0.45em; }
h3 { font-size: ${S(12.5)}; margin: 0.9em 0 0.4em; }
p { margin: 0.4em 0; text-align: justify; text-justify: inter-ideograph; }
pre { background: #f5f5f5; padding: 8px 10px; font: ${S(10)}/1.5 Consolas,monospace; white-space: pre-wrap; }
figure { margin: 0.7em 0; text-align: center; }
img { max-width: 100%; }
table { border-collapse: collapse; width: 100%; margin: 0.7em 0; font-size: ${S(10)}; }
th, td { border: 1px solid #888; padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #f0f0f0; }
.tblcap { text-align: center; font-size: ${S(10)}; margin: 0.2em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function findRenderer() {
  // 优先 Edge（chrome 内核，@page/字体还原最好），LibreOffice 兜底（Writer HTML 导入，CSS 支持有限但图片/表格/标题保得住）
  const edge = [
    process.env.EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean).find((p) => existsSync(p));
  if (edge) return { kind: "edge", exe: edge };
  const lo = [
    process.env.LIBREOFFICE_PATH,
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ].filter(Boolean).find((p) => existsSync(p));
  if (lo) return { kind: "lo", exe: lo };
  return null;
}

/** HTML 文件 → PDF。写到 outPath。失败抛 OcrError。
 *  LibreOffice 兜底要求 htmlPath 与 outPath 同名（.html→.pdf），由 blocksToPdfFile 保证。 */
export function renderHtmlToPdf(htmlPath, outPath, { timeoutMs = 90000 } = {}) {
  const renderer = findRenderer();
  if (!renderer) {
    throw new OcrError("E_NO_RENDERER", "未找到 Microsoft Edge 或 LibreOffice，无法渲染保真 PDF；请改用 docx 格式");
  }
  let r;
  if (renderer.kind === "edge") {
    r = spawnSync(
      renderer.exe,
      [
        "--headless",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--virtual-time-budget=3000",
        `--print-to-pdf=${outPath}`,
        pathToFileURL(htmlPath).href,
      ],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true }
    );
  } else {
    r = spawnSync(
      renderer.exe,
      ["--headless", "--convert-to", "pdf", "--outdir", dirname(outPath), htmlPath],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true }
    );
  }
  if (!existsSync(outPath)) {
    const detail = String(r.stderr || r.stdout || r.error?.message || "").trim();
    throw new OcrError("E_PDF_RENDER", `PDF 渲染失败：${detail.slice(-200) || "渲染器未产生输出"}`);
  }
}

/** 便捷入口：blocks → 临时 html → PDF。html 与 outPath 同名同目录（LibreOffice 兜底要求）。 */
export function blocksToPdfFile(blocks, outPath, { title, timeoutMs } = {}) {
  const htmlPath = outPath.replace(/\.pdf$/i, ".html");
  writeFileSync(htmlPath, blocksToHtml(blocks, { title }), "utf8");
  try {
    renderHtmlToPdf(htmlPath, outPath, { timeoutMs });
  } finally {
    rmSync(htmlPath, { force: true });
  }
}

/** 逐页 PDF 合并（pymupdf）。pagePdfs 按序合并写入 outPath。
 *  页数多时把路径清单经 stdin 传入，避免单个 argv 撞 Windows 32767 命令行长度上限（#pipeline low）。 */
function mergePdfs(pagePdfs, outPath) {
  const script =
    "import sys, json\n" +
    "import pymupdf\n" +
    "pages = json.loads(sys.stdin.read())\n" +
    "out = pymupdf.open()\n" +
    "for p in pages:\n" +
    "    src = pymupdf.open(p)\n" +
    "    out.insert_pdf(src)\n" +
    "    src.close()\n" +
    "out.save(sys.argv[1])\n";
  const r = spawnSync(pythonCmd(), ["-c", script, outPath], {
    input: JSON.stringify(pagePdfs),
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  // 同时看退出码：python 崩了（内存/坏输入）也会留下半成品 outPath，只查存在性会漏报（#15）
  if (r.status !== 0 || !existsSync(outPath)) {
    throw new OcrError("E_PDF_MERGE", `合并分页 PDF 失败：${String(r.stderr || r.error?.message || "").slice(-200)}`);
  }
}

/**
 * 第 2 期升级：逐页保真 PDF——每页独立渲染（横/纵方向自适应），页数/页边界/方向与原件 100% 一致。
 * pages: layoutToPageBlocks 的输出（需先 materializeImages 每页）。
 */
function pdfPageCount(path) {
  // pymupdf 页数校验；python 不可用返回 null（调用方跳过单页约束）
  const r = spawnSync(pythonCmd(), ["-c", "import sys, pymupdf; print(len(pymupdf.open(sys.argv[1])))", path], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  if (r.status !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function pagesToPdfFile(pageResults, outPath, { title = "OCR 识别结果", timeoutMs, pageSizes = null } = {}) {
  // 空页清单：mergePdfs 会 save 出一个合法的 0 页 PDF 并当成成功——直接拦掉（#15）
  if (!pageResults?.length) {
    throw new OcrError("E_PDF_EMPTY", "识别结果没有页面，无法生成 PDF");
  }
  // pymupdf 可用性只探一次：旧实现每轮溢出回收都 spawn 一次 python 查页数，
  // 无 pymupdf 的机器上 476 页文档要白跑约 1900 次 spawn（#15）
  let pyOk = true;
  try {
    pyOk = spawnSync(pythonCmd(), ["-c", "import pymupdf"], { encoding: "utf8", timeout: 30000, windowsHide: true }).status === 0;
  } catch {
    pyOk = false;
  }
  const base = outPath.replace(/\.pdf$/i, "");
  const pagePdfs = [];
  try {
    pageResults.forEach((p, i) => {
      const htmlPath = `${base}.page${i + 1}.html`;
      const pdfPath = `${base}.page${i + 1}.pdf`;
      const ps = Array.isArray(pageSizes) ? pageSizes[i] : null;
      const pagePt = ps?.wPt > 0 && ps?.hPt > 0 ? { wPt: ps.wPt, hPt: ps.hPt } : null;
      // 溢出回收：表格自然高度可能超过页高——渲染后查页数，>1 页则缩小字号重渲（最多 3 轮）
      const scales = [1, 0.8, 0.64, 0.5];
      let done = false;
      for (const scale of scales) {
        writeFileSync(htmlPath, blocksToHtml(p.blocks, { title, isLandscape: p.isLandscape, scale, pagePt, pageHU: p._pageH }), "utf8");
        renderHtmlToPdf(htmlPath, pdfPath, { timeoutMs });
        const n = pyOk ? pdfPageCount(pdfPath) : null;
        if (n === null || n <= 1) { done = true; break; }
      }
      if (!done) console.error(`[ocr] 第 ${i + 1} 页多次缩放仍超 1 页，按最后结果接受`);
      pagePdfs.push(pdfPath);
      rmSync(htmlPath, { force: true });
    });
    if (pagePdfs.length === 1) {
      // 单页无需合并，直接改名
      rmSync(outPath, { force: true });
      renameSync(pagePdfs[0], outPath);
      return;
    }
    mergePdfs(pagePdfs, outPath);
  } finally {
    for (const f of pagePdfs) rmSync(f, { force: true });
  }
}
