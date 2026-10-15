// lib/office.js — Office 本地直读（v0.4，对标 MinerU 3.0/3.1 原生解析）：docx/pptx/xlsx 零依赖解析。
// zip：EOCD 扫描定位中央目录 → 按 local header 读条目；method 8 = zlib.inflateRawSync，method 0 = stored。
// docx：word/document.xml 正文流（w:p/w:tbl）+ Heading 样式分级 + 表格(gridSpan/vMerge→merges)
//       + 内嵌图片（rels → media，EMU 尺寸）。文本框(txbx)/内容控件(sdt)/SmartArt 静默跳过并计数。
// pptx：ppt/slides/slideN.xml 的 a:p 文本（按页）；a:tbl 表格 v1 跳过并计数。
// xlsx：xl/sharedStrings.xml + 首个 sheet 的行列 → 单表 table 块。
// 边界：只支持正文流；扫描型（低文本量）由调用方提示走云端。全程零第三方依赖。
import zlib from "node:zlib";
import { OcrError } from "./errors.js";
import { blocksToMarkdown } from "./markdown.js";

// ── zip 读取（只读不写）─────────────────────────────────────────────────────
// 单条目解压上限：Office 文件 ≤100MB，但恶意 zip（zip 炸弹）条目可膨胀数 GB 撑爆内存
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** 解析 zip Buffer → Map(name → Buffer)。伪 zip/损坏抛错。 */
export function readZip(buf) {
  if (!buf || buf.length < 22) throw new Error("zip 过小");
  // EOCD 从尾部 64KB 窗口内倒扫（zip 允许前置注释）
  let eocd = -1;
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip EOCD 未找到");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    // local header：真实数据起点要按 local 的 name/extra 长度重算（可与 central 不同）
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lName = buf.readUInt16LE(localOff + 26);
    const lExtra = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lName + lExtra;
    if (dataStart + compSize > buf.length) continue;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    try {
      // maxOutputLength：超限抛错 → 按缺失条目跳过（zip 炸弹不炸宿主）
      entries.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
    } catch {
      // 单条目损坏不整体失败（后续按缺失处理）
    }
  }
  if (!entries.size) throw new Error("zip 无可读条目");
  return entries;
}

// ── XML 小工具 ───────────────────────────────────────────────────────────────
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "nbsp": " " };
// 畸形数字引用（>0x10FFFF）fromCodePoint 会抛 RangeError：丢弃，不让坏字符炸整个解析
const fromCodePointSafe = (cp) => (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "");
function xmlDecode(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => fromCodePointSafe(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePointSafe(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e] ?? _);
}
const attr = (tagXml, name) => {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tagXml) ?? new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(tagXml);
  return m ? m[1] : "";
};

/** 标签流扫描：返回 [{closing, tag, attrs, start, end}]（start/end 为标签串位置）。 */
function scanTags(xml) {
  const tags = [];
  const re = /<(\/?)([\w:]+)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*(\/?)>/g;
  for (let m; (m = re.exec(xml)); ) {
    tags.push({ closing: m[1] === "/", tag: m[2], attrs: m[3] ?? "", selfClose: m[4] === "/", start: m.index, end: m.index + m[0].length });
  }
  return tags;
}

/** 取一段 XML 里同名字段的文本（不含嵌套结构，简单拼接该段内所有 text 节点）。 */
function collectText(xml, textTag) {
  let out = "";
  for (const t of scanTags(xml)) {
    if (!t.closing && t.tag === textTag && !t.selfClose) {
      const close = xml.indexOf(`</${textTag}>`, t.end);
      if (close >= 0) {
        out += xmlDecode(xml.slice(t.end, close));
      }
    }
  }
  return out;
}

// ── docx ────────────────────────────────────────────────────────────────────
const HEADING_STYLE = { Heading1: "h1", Heading2: "h2", Heading3: "h3", "1": "h1", "2": "h2", "3": "h3" };

/** 顶层切分 body：深度计数找直属的 w:p / w:tbl。返回 [{kind:"p"|"tbl", xml}] */
function splitTopLevel(bodyXml, pTag, tblTag) {
  const out = [];
  const tags = scanTags(bodyXml);
  let dP = 0;
  let dT = 0;
  let cur = null; // {kind, start}
  for (const t of tags) {
    if (t.tag === pTag) dP += t.closing ? -1 : t.selfClose ? 0 : 1;
    if (t.tag === tblTag) dT += t.closing ? -1 : t.selfClose ? 0 : 1;
    const depth = dP + dT;
    if (!cur) {
      if (!t.closing && !t.selfClose && (t.tag === pTag || t.tag === tblTag) && depth === 1) {
        cur = { kind: t.tag === tblTag ? "tbl" : "p", start: t.start };
      }
    } else if (depth === 0) {
      out.push({ kind: cur.kind, xml: bodyXml.slice(cur.start, t.end) });
      cur = null;
    }
  }
  return out;
}

/** docx 段落 XML → 块（h1/h2/h3/p/image）。返回 block 或 null（空段）。 */
function docxParagraph(xml, { relsMap, media }) {
  // 图片：a:blip r:embed → rels → media 字节 → data_url；尺寸取 wp:extent（EMU→px）
  const embed = /r:embed\s*=\s*"([^"]+)"/.exec(xml)?.[1];
  if (embed && relsMap?.has(embed)) {
    const target = relsMap.get(embed);
    const data = media.get(target.replace(/^\/?word\//, "").replace(/^\//, ""));
    if (data) {
      const ext = /\.png$/i.test(target) ? "png" : /\.gif$/i.test(target) ? "gif" : /\.bmp$/i.test(target) ? "bmp" : "jpeg";
      const extM = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp" }[ext];
      const extent = /<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"/.exec(xml);
      return {
        type: "image",
        url: `data:${extM};base64,${data.toString("base64")}`,
        ...(extent ? { w: Math.max(1, Math.round(Number(extent[1]) / 9525)), h: Math.max(1, Math.round(Number(extent[2]) / 9525)) } : {}),
      };
    }
  }
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(xml)?.[1] ?? "";
  const isList = /<w:numPr\s*\/?>/.test(xml) || /<w:numPr>/.test(xml);
  // w:t 文本 + w:br/w:tab 结构
  let text = "";
  for (const t of scanTags(xml)) {
    if (t.tag === "w:t" && !t.closing && !t.selfClose) {
      const close = xml.indexOf("</w:t>", t.end);
      if (close >= 0) text += xmlDecode(xml.slice(t.end, close));
    } else if (t.tag === "w:br" && !t.closing) {
      text += "\n";
    } else if (t.tag === "w:tab" && !t.closing) {
      text += "\t";
    }
  }
  text = text.replace(/\u000b/g, "\n");
  if (!text.trim()) return null;
  const level = HEADING_STYLE[style];
  if (level) return { type: level, text };
  return { type: "p", text: isList ? `- ${text}` : text };
}

/** docx 表格 XML → table 块（gridSpan→colSpan，vMerge restart/延续→rowSpan，嵌套表降级为摊平文本并计数）。 */
function docxTable(xml, skipped) {
  const rowsIds = []; // 每行的 cell-id 网格（被跨格重复同一 id）
  const cellsById = new Map(); // id → {text, }
  let cellSeq = 0;
  const tags = scanTags(xml);
  // 第一遍：按深度找直属 tr（切片含外层 <w:tbl> 本身，直属行在 dT===1；内层嵌套表 dT≥2 被排除）
  let dT = 0;
  const trRanges = [];
  let trStart = -1;
  for (const t of tags) {
    if (t.tag === "w:tbl") dT += t.closing ? -1 : t.selfClose ? 0 : 1;
    if (t.tag === "w:tr" && dT === 1) {
      if (!t.closing && !t.selfClose) {
        trStart = t.start;
      } else if (trStart >= 0) {
        trRanges.push([trStart, t.end]);
        trStart = -1;
      }
    }
  }
  const openMerge = new Map(); // 列 → 开启 vMerge 的 cell id（跨行状态；续格继承 origin id，rowSpan 才能成链）
  for (const [rs, re_] of trRanges) {
    const rowXml = xml.slice(rs, re_);
    const row = [];
    let cc = 0; // 当前格起始列（gridSpan 累计）
    // 行内直属 tc
    let dRow = 0;
    let tcStart = -1;
    for (const t of scanTags(rowXml)) {
      if (t.tag === "w:tbl") dRow += t.closing ? -1 : t.selfClose ? 0 : 1;
      if (t.tag === "w:tc" && dRow === 0) {
        if (!t.closing && !t.selfClose) tcStart = t.start;
        else if (tcStart >= 0) {
          const cellXml = rowXml.slice(tcStart, t.end);
          const span = Number(attr(/<w:gridSpan[^>]*/.exec(cellXml)?.[0] ?? "", "w:val")) || 1;
          const vMergeTag = /<w:vMerge[^>]*/.exec(cellXml)?.[0] ?? "";
          const isVMerge = /<w:vMerge/.test(cellXml);
          const vRestart = /w:val\s*=\s*"restart"/.test(vMergeTag);
          let id = `c${cellSeq++}`;
          if (isVMerge && !vRestart) {
            // vMerge 延续格：继承该列 origin 的 id（旧实现每格独立 id，rowSpan 永远推不出来）
            id = openMerge.get(cc) ?? id;
          } else if (isVMerge) {
            openMerge.set(cc, id);
          } else {
            openMerge.delete(cc);
          }
          // 单元格文本：直属段落拼 \n；内层嵌套表压平为"行"文本（内容不丢，结构降级计数）
          const innerTables = (cellXml.match(/<w:tbl[\s>]/g) ?? []).length;
          if (innerTables > 0) skipped.nestedTables += 1;
          const paras = [];
          for (const [ps, pe] of topRanges(cellXml, "w:p")) {
            const ptext = docxParagraphText(cellXml.slice(ps, pe));
            if (ptext) paras.push(ptext);
          }
          // 延续格继承 origin 的 id：不覆盖已有登记（否则 origin 的文本/isCont 被空延续格冲掉）
          if (!cellsById.has(id)) {
            cellsById.set(id, { text: paras.join("\n"), span, isCont: isVMerge && !vRestart });
          }
          for (let s2 = 0; s2 < span; s2++) row.push(id);
          cc += span;
          tcStart = -1;
        }
      }
    }
    rowsIds.push(row);
  }
  // grid 规整（每行等长）+ 由 id 出现位置推导 merges（同 id 连续块）
  const nCols = Math.max(1, ...rowsIds.map((r) => r.length));
  const rows = [];
  const merges = [];
  const posById = new Map();
  rowsIds.forEach((row, r) => {
    const grid = [];
    for (let c = 0; c < nCols; c++) grid.push(row[c] ?? `__blank_${r}_${c}`);
    rows.push(grid);
    grid.forEach((id, c) => {
      if (!posById.has(id)) posById.set(id, []);
      posById.get(id).push({ r, c });
    });
  });
  for (const [id, positions] of posById) {
    const cell = cellsById.get(id);
    if (!cell || cell.isCont) continue;
    const rs = new Set(positions.map((p) => p.r)).size;
    const cs = new Set(positions.map((p) => p.c)).size;
    if (rs > 1 || cs > 1) {
      merges.push({ r: positions[0].r, c: positions[0].c, rowSpan: rs, colSpan: cs });
    }
  }
  // 文本只渲染在每个 id 的首个位置（gridSpan 覆盖列、vMerge 延续行都是同一 id 的后续位置 → 空串）
  const renderKey = new Set();
  for (const positions of posById.values()) {
    const p0 = positions[0];
    renderKey.add(`${p0.r},${p0.c}`);
  }
  const outRows = rows.map((grid, r) =>
    grid.map((id, c) => {
      const cell = cellsById.get(id);
      return cell && !cell.isCont && renderKey.has(`${r},${c}`) ? cell.text : "";
    })
  );
  if (!outRows.some((r) => r.some((c) => c.trim()))) return null;
  return { type: "table", rows: outRows, ...(merges.length ? { merges } : {}) };
}

/** 段落 XML → 纯文本（表格单元格用，不计图片） */
function docxParagraphText(xml) {
  let text = "";
  for (const t of scanTags(xml)) {
    if (t.tag === "w:t" && !t.closing && !t.selfClose) {
      const close = xml.indexOf("</w:t>", t.end);
      if (close >= 0) text += xmlDecode(xml.slice(t.end, close));
    } else if (t.tag === "w:br" && !t.closing) {
      text += "\n";
    }
  }
  return text.trim();
}

/** 顶层范围切分（同 splitTopLevel，返回 [start,end] 数组） */
function topRanges(xml, tag) {
  const out = [];
  let d = 0;
  let start = -1;
  for (const t of scanTags(xml)) {
    if (t.tag === tag) d += t.closing ? -1 : t.selfClose ? 0 : 1;
    if (start < 0 && !t.closing && !t.selfClose && t.tag === tag && d === 1) start = t.start;
    if (start >= 0 && d === 0 && t.tag === tag && t.closing) {
      out.push([start, t.end]);
      start = -1;
    }
  }
  return out;
}

function parseDocx(entries, skipped) {
  const docXml = entries.get("word/document.xml")?.toString("utf8");
  if (!docXml) throw new Error("缺少 word/document.xml");
  // rels：rId → target（media/x.png）
  const relsMap = new Map();
  const relsXml = entries.get("word/_rels/document.xml.rels")?.toString("utf8") ?? "";
  for (const t of scanTags(relsXml)) {
    if (t.tag === "Relationship" && !t.closing) {
      const id = attr(t.attrs, "Id");
      const target = attr(t.attrs, "Target");
      if (id && target) relsMap.set(id, target);
    }
  }
  const media = new Map();
  for (const [name, data] of entries) {
    if (name.startsWith("word/media/")) media.set(name.replace(/^word\//, ""), data);
  }
  const bodyStart = docXml.indexOf("<w:body>");
  const bodyEnd = docXml.lastIndexOf("</w:body>");
  const body = docXml.slice(bodyStart + 8, bodyEnd >= 0 ? bodyEnd : undefined);
  skipped.txbx += (body.match(/<w:txbxContent[\s>]/g) ?? []).length;
  const blocks = [];
  for (const part of splitTopLevel(body, "w:p", "w:tbl")) {
    if (part.kind === "tbl") {
      const tbl = docxTable(part.xml, skipped);
      if (tbl) blocks.push(tbl);
    } else {
      const b = docxParagraph(part.xml, { relsMap, media });
      if (b) blocks.push(b);
    }
  }
  return blocks;
}

// ── pptx ────────────────────────────────────────────────────────────────────
function parsePptx(entries, skipped) {
  const slideNames = [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/slide(\d+)\.xml$/.exec(a)[1]) - Number(/slide(\d+)\.xml$/.exec(b)[1]));
  if (!slideNames.length) throw new Error("缺少 ppt/slides");
  const pages = [];
  for (const name of slideNames) {
    const xml = entries.get(name).toString("utf8");
    skipped.pptTables += (xml.match(/<a:tbl[\s>]/g) ?? []).length;
    const paras = [];
    for (const [ps, pe] of topRanges(xml, "a:p")) {
      const text = collectText(xml.slice(ps, pe), "a:t").replace(/\u000b/g, "\n").trim();
      if (text) paras.push(text);
    }
    pages.push(paras.join("\n\n"));
  }
  return pages;
}

// ── xlsx ────────────────────────────────────────────────────────────────────
function colLetterToIndex(s) {
  let n = 0;
  for (const ch of String(s ?? "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function parseXlsx(entries, skipped) {
  const shared = [];
  const sst = entries.get("xl/sharedStrings.xml")?.toString("utf8");
  if (sst) {
    for (const [ps, pe] of topRanges(sst, "si")) {
      shared.push(collectText(sst.slice(ps, pe), "t"));
    }
  }
  const sheetName = [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error("缺少 worksheets");
  if (entries.size > 0 && [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length > 1) {
    skipped.extraSheets = [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length - 1;
  }
  const xml = entries.get(sheetName).toString("utf8");
  const rows = [];
  for (const [rs, re_] of topRanges(xml, "row")) {
    const rowXml = xml.slice(rs, re_);
    const cells = [];
    let maxC = -1;
    for (const t of scanTags(rowXml)) {
      if (t.tag === "c" && !t.closing && !t.selfClose) {
        const close = rowXml.indexOf("</c>", t.end);
        if (close < 0) continue;
        const cXml = rowXml.slice(t.end, close);
        const ref = attr(rowXml.slice(t.start, t.end), "r") || "";
        const col = colLetterToIndex(/([A-Z]+)/.exec(ref)?.[1] ?? "");
        const type = attr(rowXml.slice(t.start, t.end), "t");
        const v = collectText(cXml, "v");
        const val = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? collectText(cXml, "t") : v;
        while (cells.length <= Math.max(col, maxC + 1) - 1) cells.push("");
        cells[col >= 0 ? col : cells.length] = xmlDecode(val);
        maxC = Math.max(maxC, col);
      }
    }
    if (cells.some((c) => String(c).trim())) rows.push(cells);
  }
  if (!rows.length) throw new Error("工作表为空");
  const width = Math.max(...rows.map((r) => r.length));
  return [{ type: "table", rows: rows.map((r) => [...r, ...Array(width - r.length).fill("")]) }];
}

/** 本地直读主入口。返回与通道 A/B result 同形的结果（channel:"LOCAL"），失败抛错由调用方回落云端。 */
export function extractOfficeLocal(buffer, ext, { minTextChars = 50 } = {}) {
  const skipped = { txbx: 0, nestedTables: 0, pptTables: 0, extraSheets: 0 };
  // 扩展名前置校验（先于 zip 解析：OLE 旧格式给明确指引而非"zip 损坏"）
  if (![".docx", ".pptx", ".xlsx"].includes(ext)) {
    throw new OcrError("E_OFFICE_READ", `本地直读不支持 ${ext}（旧版 .doc/.ppt 请先另存为新格式，或直接用 --vl 走云端）`);
  }
  let entries;
  try {
    entries = readZip(buffer);
  } catch (e) {
    throw new OcrError("E_OFFICE_READ", `Office 文件解析失败：${e.message}`);
  }
  let blocks = null;
  let engine;
  let pages = null;
  if (ext === ".docx") {
    engine = "office-text";
    blocks = parseDocx(entries, skipped);
  } else if (ext === ".pptx") {
    engine = "office-text";
    pages = parsePptx(entries, skipped);
  } else if (ext === ".xlsx") {
    engine = "office-sheet";
    blocks = parseXlsx(entries, skipped);
  } else {
    throw new OcrError("E_OFFICE_READ", `本地直读不支持 ${ext}`);
  }
  let markdown;
  if (pages) {
    markdown = pages.filter(Boolean).join("\n\n");
  } else {
    markdown = blocksToMarkdown(blocks ?? []);
  }
  if (!markdown.trim()) throw new OcrError("E_OFFICE_READ", "本地直读结果为空（可能是扫描型文档），请用 --vl 走云端解析");
  const warnBits = [];
  if (skipped.txbx) warnBits.push(`${skipped.txbx} 处文本框`);
  if (skipped.nestedTables) warnBits.push(`${skipped.nestedTables} 个嵌套表`);
  if (skipped.pptTables) warnBits.push(`${skipped.pptTables} 个 PPT 表格`);
  if (skipped.extraSheets) warnBits.push(`${skipped.extraSheets} 个附加工作表`);
  return {
    engine,
    channel: "LOCAL",
    markdown,
    text: markdown,
    ...(pages ? { pages: pages.map((t) => ({ text: t })), pagesCount: pages.length } : {}),
    blocks: blocks ?? undefined,
    ...(warnBits.length ? { localSkipped: warnBits.join("、") } : {}),
  };
}
