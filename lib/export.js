// lib/export.js — 识别结果落盘编排：txt / md / docx / docx-gongwen / csv
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { OcrError } from "./errors.js";
import { markdownToBlocks, blocksToMarkdown, extractTables } from "./markdown.js";
import { blocksToDocx, blocksToDocxPages } from "./ooxml.js";
import { layoutToPageBlocks, layoutToBlocks, materializeImages, htmlToRows, cellFlatText } from "./layout.js";
import { layoutToDocModel, blocksToDocModel, docModelToContentList } from "./docmodel.js";
import { mergeCrossPageParagraphs } from "./textflow.js";
import { cleanMath } from "./math.js";
import { recaptureVectorImages } from "./hq.js";
import { blocksToPdfFile, pagesToPdfFile } from "./html.js";

const EXTS = { txt: ".txt", md: ".md", docx: ".docx", "docx-gongwen": ".docx", pdf: ".pdf", csv: ".csv", "content-list": ".json", "pdf-replica": ".pdf" };

// GB/T 9704-2012 国标页边距（gongwen 默认 2.8/2.7cm，须覆盖）
const GONGWEN_OVERRIDES = JSON.stringify({
  page_setup: { margins: { top: "3.7cm", bottom: "3.5cm", left: "2.8cm", right: "2.6cm" } },
});

let _gongwenExe;
function gongwenExe() {
  if (_gongwenExe !== undefined) return _gongwenExe;
  const probe = (cmd) => {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    return r.status === 0 && String(r.stdout || "").includes("gongwen") ? cmd : null;
  };
  _gongwenExe = probe("gongwen") ?? probe(join(process.env.PYHOME || "C:\\Python314", "Scripts", "gongwen.exe"));
  return _gongwenExe;
}

/** 公文格式化：markdown（stdin 管道）→ gongwen md2docx → GB/T 9704 docx Buffer。
 *  只做版式转换不添加内容（--no-ai-declaration；不传落款/日期等增补参数）。 */
export function markdownToGongwenDocx(md, { docType = "notice" } = {}) {
  const exe = gongwenExe();
  if (!exe) {
    throw new OcrError("E_NO_GONGWEN", "未找到 gongwen 命令行工具（pip install gongwen-skill），无法导出公文 docx");
  }
  const outFile = join(tmpdir(), `ocr-gongwen-${process.pid}-${Date.now()}.docx`);
  const r = spawnSync(
    exe,
    ["md2docx", "-", "-o", outFile, "-t", docType, "--no-ai-declaration", "--config-overrides", GONGWEN_OVERRIDES, "--json"],
    { input: md, encoding: "utf8", timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  );
  const detail = String(r.stderr || r.stdout || r.error?.message || "").trim();
  if (r.error || r.status !== 0 || !existsSync(outFile)) {
    throw new OcrError("E_GONGWEN", `gongwen md2docx 执行失败：${detail.slice(-200) || "无输出"}`);
  }
  let buf;
  try {
    buf = readFileSync(outFile);
  } finally {
    rmSync(outFile, { force: true });
  }
  if (buf.length < 1000) throw new OcrError("E_GONGWEN", `gongwen 产物异常（${buf.length} 字节）`);
  return buf;
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeBaseName(sourcePath) {
  const raw = basename(String(sourcePath ?? "result"));
  const noExt = raw.replace(/\.[^.]+$/, "");
  const cleaned = noExt.replace(/[\\/:*?"<>|]/g, "_").trim() || "result";
  return cleaned.slice(0, 60); // 防止超长文件名
}

/** 产物时间戳来源：源文件 mtime（同输入 → 同字节，docx 可复现）。
 *  取不到（远程 URL / stdin / 文件已删）返回 undefined → ooxml 侧回退 SOURCE_DATE_EPOCH → 固定基准。 */
function sourceMtimeMs(sourcePath) {
  try {
    return sourcePath ? statSync(sourcePath).mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** 识别结果 → markdown 文本。原则：只输出原文内容，不添加任何原文没有的元素。
 *  通道 B 用百度原样 markdown；通道 A 按页拼接（paraMerge=true 时页边界段落合并）。 */
export function resultToMarkdown(result, { paraMerge = false } = {}) {
  if (result.channel === "B" && result.markdown != null) return result.markdown;
  const parts = (result.pages ?? [{ text: result.text ?? "" }])
    .map((p) => p.text)
    .filter((t) => t && t.trim());
  if (!paraMerge || parts.length < 2) return parts.join("\n\n");
  return mergeCrossPageParagraphs(parts, { enabled: true }).text;
}

/** 结果 → docx Buffer（与 markdown 同一内容源） */
export function resultToDocx(result, formulaMode = "unicode") {
  const md = resultToMarkdown(result);
  const blocks = markdownToBlocks(md, { formulaMode });
  if (!blocks.length) throw new OcrError("E_EMPTY_RESULT", "识别结果为空，无法生成文档");
  return blocksToDocx(blocks, { title: "OCR 识别结果", formulaMode });
}

function csvEscape(cell) {
  // 嵌套格摊平（v0.4）：csv 无法表达嵌套，内容不丢
  const s = String(cellFlatText(cell) ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tableToCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

/** 版面 JSON → 块流（同步部分：排序/类型映射/表格解析/公式清洗/图注/页码剥离）。
 *  失败返回 null（调用方降级 markdown 路径）。paraMerge：页边界段落合并（拼接输出路径）。 */
function layoutBlocks(result, keepHeaderFooter, formulaMode = "unicode", mergeMode = "strict", paraMerge = false) {
  if (!result?.layoutJson) return null;
  try {
    return layoutToBlocks(result.layoutJson, { filterHeaderFooter: !keepHeaderFooter, formulaMode, mergeMode, paraMerge });
  } catch {
    return null;
  }
}

/** md 图片本地化：下载图片写 <产物名>.assets/，url 改写为相对路径后重出 md。
 *  返回新 md 文本；无图片返回 null（调用方保留原 md）。 */
async function localizeMdImages(blocks, mdFile, notes) {
  const imgs = blocks.filter((b) => b.type === "image" && b.url);
  if (!imgs.length) return null;
  const failed = await materializeImages(blocks);
  if (failed > 0) notes.push(`${failed} 张图片下载失败，md 中保留原直链`);
  const name = basename(mdFile).replace(/\.[^.]+$/, "");
  // 产物名可能含空格 → 文件夹名与 md 里的相对引用须一致地清洗空格，否则链接断裂（#pipeline low）
  const assetName = name.replace(/\s+/g, "_");
  const dir = join(dirname(mdFile), `${assetName}.assets`);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const b of blocks) {
    if (b.type !== "image" || !b.data) continue;
    n += 1;
    const fext = b.ext === "jpeg" ? "jpg" : b.ext || "jpg";
    const fn = `img-${String(n).padStart(3, "0")}.${fext}`;
    writeFileSync(join(dir, fn), b.data);
    b.url = `${assetName}.assets/${fn}`;
  }
  if (!n) return null;
  notes.push(`已本地化 ${n} 张图片到 ${assetName}.assets/（不受 30 天直链过期影响）`);
  return blocksToMarkdown(blocks);
}

/** AI Studio 结构化表格兜底：markdown 里没解析出表格但 JSONL 带了 table_res_list HTML 时补入。 */
function appendAiStudioTables(blocks, result, formulaMode) {
  if (blocks.some((b) => b.type === "table")) return;
  const htmls = Array.isArray(result?.tablesHtml) ? result.tablesHtml : [];
  for (const h of htmls) {
    try {
      const built = htmlToRows(h);
      if (!built.rows.length) continue;
      const rows = formulaMode === "unicode" ? built.rows.map((r) => r.map((c) => cleanMath(c))) : built.rows;
      blocks.push({ type: "table", rows, ...(built.merges.length ? { merges: built.merges } : {}) });
    } catch {}
  }
}

/**
 * 落盘主入口。
 * result: baidu.js 的识别结果；format: 'txt'|'md'|'docx'|'docx-gongwen'|'csv'；saveDir: 已展开的绝对目录
 * opts.keepHeaderFooter: 版面页眉页脚保留开关（默认 false=过滤；true 时 docx 写入页眉页脚，md 保留文本）
 * opts.formulaMode: 公式输出模式 unicode（LaTeX→可读文本，默认）| raw（保留 LaTeX 源）| omml（docx 原生公式对象；
 *   pdf/gongwen/csv 不支持 OMML，自动按 unicode 输出，raw 保持原文）
 * opts.mergeMode: 跨页续表拼接 strict（默认，表头逐字相同）| loose | off
 * opts.hq: { pdfPath, dpi? } | null —— 本地 PDF + 版面 JSON 时对图片区域做本机高清重截
 * opts.localizeAssets: md 导出时下载图片到 <产物名>.assets/ 并写相对路径（默认 false 引用 30 天直链）
 * 返回 { files: [保存路径], note?: 降级/附加说明 }。
 */
export async function saveResult(result, { format, saveDir, sourcePath, keepHeaderFooter = false, formulaMode = "unicode", mergeMode = "strict", hq = null, localizeAssets = false, paraMerge = false, pageSizes = null, replicaDpi = 200 } = {}) {
  const ext = EXTS[format];
  if (!ext) throw new OcrError("E_BAD_FORMAT", `不支持的导出格式：${format}（支持 txt/md/docx/docx-gongwen/pdf/csv/content-list/pdf-replica）`);
  const label = safeBaseName(sourcePath);
  const createdAt = sourceMtimeMs(sourcePath);
  const name = `${stamp()}_${label}${ext}`;
  const file = join(saveDir, name);
  mkdirSync(dirname(file), { recursive: true });
  const notes = [];
  // 不支持 OMML 的格式：unicode 兜底（raw 保持原样不清洗）
  const flatMode = (m) => (m === "raw" ? "raw" : "unicode");

  if (format === "content-list") {
    // 统一文档模型 → content-list JSON（v0.4）：有版面走 bbox 全量；无版面降级 markdown 块（bbox 缺失）。
    // 确定性输出：不含时间戳；图片保留 url（30 天直链或 data_url）。
    let dm = null;
    if (result.layoutJson) {
      try {
        dm = layoutToDocModel(result.layoutJson, {
          filterHeaderFooter: !keepHeaderFooter,
          formulaMode,
          mergeMode,
          paraMerge,
          source: sourcePath ?? "",
          engine: result.engine ?? "",
          provider: result.provider ?? "",
        });
      } catch {
        dm = null;
      }
    }
    let degradedNote = "";
    if (!dm) {
      const blocks = markdownToBlocks(resultToMarkdown(result), { formulaMode });
      if (!blocks.length) throw new OcrError("E_EMPTY_RESULT", "识别结果为空，无法生成 content-list");
      dm = blocksToDocModel(blocks, { engine: result.engine ?? "", provider: result.provider ?? "" });
      degradedNote = "无版面坐标，content-list 不含 bbox";
    }
    writeFileSync(file, JSON.stringify(docModelToContentList(dm), null, 2), "utf8");
    return { files: [file], note: degradedNote || undefined };
  }

  if (format === "pdf-replica") {
    // sandwich PDF（v0.4）：原页位图打底 + 版面文本隐形叠加（视觉复刻+可检索）。
    // 需要本地 PDF 源与版面数据；不满足时降级可读 PDF 路径并注明。
    const canReplica = sourcePath && /\.(pdf)$/i.test(String(sourcePath)) && result.layoutJson?.pages?.length;
    if (!canReplica) {
      notes.push("复刻模式需要本地 PDF 与版面数据，已按可读 PDF 输出");
      return saveResult(result, { format: "pdf", saveDir, sourcePath, keepHeaderFooter, formulaMode, mergeMode, hq, localizeAssets, paraMerge, pageSizes });
    }
    const { replicaPdf } = await import("./replica.js");
    const dm = layoutToDocModel(result.layoutJson, {
      filterHeaderFooter: !keepHeaderFooter,
      formulaMode,
      mergeMode,
      paraMerge,
    });
    // 运行期失败（python/pymupdf 缺失、超时、页数不符）降级可读 PDF，不让已成功的识别整体交付失败
    try {
      const { buffer, skipped } = replicaPdf({ sourcePath, docModel: dm, dpi: replicaDpi });
      writeFileSync(file, buffer);
      if (skipped > 0) notes.push(`${skipped} 处文本块未适配隐形文字层（位图已含内容，不丢）`);
      return { files: [file], note: notes.join("；") || undefined };
    } catch (e) {
      notes.push(`复刻 PDF 生成失败（${String(e?.message ?? e).slice(0, 120)}），已降级为可读 PDF`);
      const fb = await saveResult(result, { format: "pdf", saveDir, sourcePath, keepHeaderFooter, formulaMode, mergeMode, hq, localizeAssets, paraMerge, pageSizes });
      return {
        files: fb.files,
        note: [notes.join("；"), fb.note].filter(Boolean).join("；") || undefined,
      };
    }
  }

  if (format === "txt") {
    const text = (result.pages?.length ? result.pages.map((p) => p.text) : [result.text ?? ""])
      .filter((t) => t && t.trim())
      .join("\n\n");
    if (!text.trim()) throw new OcrError("E_EMPTY_RESULT", "识别结果为空（图片里可能没有可识别文字）");
    writeFileSync(file, text, "utf8");
    return { files: [file] };
  }
  if (format === "md") {
    // 版面块流优先（结构正确+图片内联）；无版面数据时降级原样 markdown
    let md = null;
    const built = layoutBlocks(result, keepHeaderFooter, formulaMode, mergeMode, paraMerge);
    if (built) {
      md = blocksToMarkdown(built.blocks);
      if (built.stats.filteredHF > 0) notes.push(`已按版面过滤 ${built.stats.filteredHF} 个页眉页脚块（设置可保留）`);
      if (built.stats.strippedPN > 0) notes.push(`已剥离 ${built.stats.strippedPN} 个页码块`);
    }
    if (!md || !md.trim()) md = resultToMarkdown(result, { paraMerge });
    if (localizeAssets && md.trim()) {
      const blocks = built?.blocks?.length ? built.blocks : markdownToBlocks(resultToMarkdown(result, { paraMerge }), { formulaMode });
      const localized = await localizeMdImages(blocks, file, notes);
      if (localized != null) md = localized;
    }
    if (!md.trim()) throw new OcrError("E_EMPTY_RESULT", "识别结果为空（图片里可能没有可识别文字）");
    writeFileSync(file, md, "utf8");
    return { files: [file], note: notes.join("；") || undefined };
  }
  if (format === "docx") {
    // 版面保真 docx（多节）：每页一个 section（页边界/方向钉死 → 页数与原件一致）+
    // 中文文档样式（标题分级字体/仿宋正文/28磅行距）。无版面数据降级单节 markdown 路径。
    let headerText = "";
    let footerText = "";
    let pages = null;
    if (result.layoutJson) {
      try {
        pages = layoutToPageBlocks(result.layoutJson, { filterHeaderFooter: !keepHeaderFooter, formulaMode, mergeMode });
        if (hq?.pdfPath && existsSync(hq.pdfPath)) {
          const hqStat = recaptureVectorImages(pages, hq.pdfPath, { dpi: hq.dpi ?? 220 });
          if (hqStat?.recaptured > 0) notes.push(`${hqStat.recaptured} 张图片已本机高清重截（DPI ${hq.dpi ?? 220}）`);
        }
        for (const p of pages) {
          if (keepHeaderFooter) {
            headerText = headerText || p.header;
            footerText = footerText || p.footer;
          }
          const failedImgs = await materializeImages(p.blocks);
          if (failedImgs > 0) notes.push(`${failedImgs} 张图片下载失败已跳过`);
        }
        const pn = pages.reduce((n2, p) => n2 + (p.stats?.strippedPN ?? 0), 0);
        if (pn > 0) notes.push(`已剥离 ${pn} 个页码块`);
        if (!pages.some((p) => p.blocks.length)) pages = null;
      } catch {
        pages = null;
      }
    }
    if (pages) {
      const allBlocks = pages.flatMap((p) => p.blocks);
      if (!allBlocks.length) pages = null;
      else {
        const hfUnknown = pages.flatMap((p) => p.stats.unknownTypes).filter((t, i, a) => a.indexOf(t) === i);
        if (hfUnknown.length) notes.push(`未识别版面块类型: ${hfUnknown.join("/")}`);
        writeFileSync(file, blocksToDocxPages(pages, { title: "OCR 识别结果", headerText, footerText, formulaMode, pageSizes, createdAt }));
        return { files: [file], note: notes.join("；") || undefined };
      }
    }
    const blocks = markdownToBlocks(resultToMarkdown(result), { formulaMode });
    appendAiStudioTables(blocks, result, formulaMode);
    await materializeImages(blocks); // markdown 内联图片（如 AI Studio 结果）也嵌入 docx
    if (!blocks.length) throw new OcrError("E_EMPTY_RESULT", "识别结果为空（图片里可能没有可识别文字）");
    writeFileSync(file, blocksToDocx(blocks, { title: "OCR 识别结果", headerText, footerText, formulaMode, createdAt }));
    if (formulaMode === "omml") notes.push("公式已转 Word 原生对象（无法解析的保留 LaTeX 原文）");
    return { files: [file], note: notes.join("；") || undefined };
  }
  if (format === "pdf") {
    // 第 2 期升级：逐页保真 PDF——每页独立渲染（横/纵自适应），页数/页边界/方向与原件 100% 一致。
    // PDF 路径不支持 OMML 公式对象：omml 按 unicode 文本兜底（raw 保持原文）。
    const pdfMode = flatMode(formulaMode);
    let pages = null;
    if (result.layoutJson) {
      try {
        pages = layoutToPageBlocks(result.layoutJson, { filterHeaderFooter: !keepHeaderFooter, formulaMode: pdfMode, mergeMode });
        if (hq?.pdfPath && existsSync(hq.pdfPath)) {
          recaptureVectorImages(pages, hq.pdfPath, { dpi: hq.dpi ?? 220 });
        }
        for (const p of pages) await materializeImages(p.blocks);
        if (!pages.some((p) => p.blocks.length)) pages = null;
      } catch {
        pages = null;
      }
    }
    if (!pages) {
      // 无版面数据（通道 A 等）：单页简单排版
      const blocks = markdownToBlocks(resultToMarkdown(result), { formulaMode: pdfMode });
      appendAiStudioTables(blocks, result, pdfMode);
      await materializeImages(blocks); // 图片行 → 内嵌（保真 PDF 同样吃图片）
      if (!blocks.length) throw new OcrError("E_EMPTY_RESULT", "识别结果为空（图片里可能没有可识别文字）");
      pages = [{ blocks, isLandscape: false, header: "", footer: "", stats: {} }];
    }
    try {
      pagesToPdfFile(pages, file, { title: "OCR 识别结果", pageSizes });
    } catch (e) {
      if (e instanceof OcrError) throw e;
      throw new OcrError("E_PDF_RENDER", `PDF 渲染失败：${e.message}（可改用 docx 格式）`);
    }
    return { files: [file], note: notes.join("；") || undefined };
  }
  if (format === "docx-gongwen") {
    // 公文格式化：优先走版面块流重建 md（标题独立/层级正确/表格 md 化），
    // 比文档级线性 markdown 质量高得多（实测：线性 md 会把标题并进正文大段）。
    // 图片块剔除（gongwen 不处理图片，![](url) 会被当正文文字）。
    // gongwen 不支持 OMML：omml 按 unicode 清洗兜底（raw 保持原文）。
    const gwMode = flatMode(formulaMode);
    if (formulaMode === "omml") notes.push("公文 docx 不支持公式对象，公式按 Unicode 文本输出");
    const md = (() => {
      const built = layoutBlocks(result, keepHeaderFooter, gwMode, mergeMode, paraMerge);
      if (built?.blocks?.length) {
        const imgCount = built.blocks.filter((b) => b.type === "image").length;
        if (imgCount > 0) notes.push(`公文 docx 不支持图片，已跳过 ${imgCount} 张`);
        const blocks = built.blocks.filter((b) => b.type !== "image");
        const out = blocksToMarkdown(blocks);
        if (out.trim()) return out;
      }
      return resultToMarkdown(result);
    })();
    if (!md.trim()) throw new OcrError("E_EMPTY_RESULT", "识别结果为空（图片里可能没有可识别文字）");
    try {
      writeFileSync(file, markdownToGongwenDocx(md));
      return { files: [file], note: notes.join("；") || undefined };
    } catch (e) {
      // gongwen 缺失或执行失败：降级普通 docx，让调用方在返回里注明
      if (!(e instanceof OcrError)) throw e;
      writeFileSync(file, resultToDocx(result, formulaMode));
      return { files: [file], note: ["gongwen 不可用，已降级为普通 docx", ...notes].join("；") };
    }
  }
  // csv：提取 VL markdown 里的表格；无表格则报错并提示改用 md。
  // 公式按 unicode 清洗（csv 是纯数据格式）；带 BOM（Excel 直接打开中文不乱码）。
  const csvBlocks = markdownToBlocks(resultToMarkdown(result), { formulaMode: "unicode" });
  appendAiStudioTables(csvBlocks, result, "unicode");
  const tables = extractTables(csvBlocks);
  if (!tables.length) throw new OcrError("E_NO_TABLE", "结果中没有识别出表格，无法导出 csv；请改用 md/txt/docx");
  const base = join(saveDir, `${stamp()}_${label}`);
  if (tables.length === 1) {
    const file1 = `${base}.csv`;
    writeFileSync(file1, "\uFEFF" + tableToCsv(tables[0]), "utf8");
    return { files: [file1] };
  }
  const files = tables.map((rows, i) => {
    const fi = `${base}_table${i + 1}.csv`;
    writeFileSync(fi, "\uFEFF" + tableToCsv(rows), "utf8");
    return fi;
  });
  return { files };
}
