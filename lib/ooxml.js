// lib/ooxml.js — 零依赖最小 docx 写入器
// zip 层：只写 stored（不压缩）条目——OCR 文本体积小，不压缩没有代价，合法面最小。
//   CRC32 优先用 Node 22 内置 zlib.crc32，缺失时回退自实现查表法（双保险）。
// OOXML 层：[Content_Types].xml + _rels/.rels + docProps/core.xml + word/document.xml
//   + word/styles.xml（Normal/Heading1-3）。映射规则见 lib/markdown.js 的块结构。
// 公式：formulaMode=omml 时，段落里的 $…$/$$…$$ 由 lib/math.js 转原生 OMML 公式对象，
//   无法解析的公式回退原文纯文本（可恢复）。m 命名空间无条件声明（不使用时无副作用）。
import zlib from "node:zlib";
import { latexToOmml, isCurrencyText } from "./math.js";
import { isHeaderRow, cellFlatText } from "./layout.js";

// ── CRC32 ───────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32Hand(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const crc32 = typeof zlib?.crc32 === "function" ? (buf) => zlib.crc32(buf) >>> 0 : crc32Hand;

// ── stored zip ──────────────────────────────────────────────────────────────
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 打包 stored zip。entries: [{ name: string, data: Buffer|string }]
 * 结构：local file header + data ×N → central directory → EOCD。UTF-8 文件名（flags bit 11）。
 */
export function zipStore(entries) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const ent of entries) {
    const nameBuf = Buffer.from(ent.name, "utf8");
    const data = Buffer.isBuffer(ent.data) ? ent.data : Buffer.from(ent.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 name
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed
    local.writeUInt32LE(data.length, 22); // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16); // cd offset = 总 local 数据长度
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

export { crc32 };

// ── XML 基础 ────────────────────────────────────────────────────────────────
export function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // 清洗 XML 1.0 非法控制字符（保留 \t \n \r）；\x0B/\x0C 常见于 PDF 文本层分页符，
    // 不处理会导致生成非法 XML、docx 整体损坏（#10）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ");
}

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
  ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

function run(text, { bold = false, mono = false, sz = null } = {}) {
  const parts = [];
  if (bold) parts.push("<w:b/>");
  if (mono) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>');
  // 字号传递（v0.4）：版面块高折算的 half-point 字号（7–42pt 间），覆盖样式预设
  if (sz) parts.push(`<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`);
  const rpr = parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
  return `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

// ── 图片（版面保真第 1 期）──────────────────────────────────────────────────
// EMU = px × 9525；A4 正文区宽度约 5.72M EMU，超宽图片等比缩到 5.5M EMU。
const IMG_MAX_W_EMU = 5500000;

function drawingRun(rid, wPx, hPx, idx) {
  const cx0 = Math.max(1, wPx || 300) * 9525;
  const cy0 = Math.max(1, hPx || 200) * 9525;
  const scale = Math.min(1, IMG_MAX_W_EMU / cx0);
  const cx = Math.round(cx0 * scale);
  const cy = Math.round(cy0 * scale);
  const id = idx + 1;
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

function imageParagraph(block, rid, idx) {
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${drawingRun(rid, block.w, block.h, idx)}</w:p>`;
}

/** 图注段：居中五号宋体，无首行缩进（吸附自"图x−x−x ×××"文本块） */
function captionParagraph(text) {
  const rpr = '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>';
  return `<w:p><w:pPr><w:jc w:val="center"/><w:ind w:firstLineChars="0" w:firstLine="0"/></w:pPr><w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function headerFooterXml(kind, text) {
  // kind: hdr | ftr
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:${kind} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run(text)}</w:p></w:${kind}>`
  );
}

function paragraph(text, style, formulaMode = "unicode", szHalfPt = null) {
  const ppr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${ppr}${inlineRuns(text, formulaMode, szHalfPt)}</w:p>`;
}

/** 段落文本 → run 序列。omml 模式下 $…$/$$…$$ 片段转原生公式对象，解析失败回退原文 run。 */
function inlineRuns(text, formulaMode, szHalfPt = null) {
  if (formulaMode !== "omml") return run(text, { sz: szHalfPt });
  const s = String(text ?? "");
  let out = "";
  let last = 0;
  // 长度帽与 cleanMath 对齐（行内 40 / 显示 200）：相隔很远的两个 $ 不会把整行吞成一次公式尝试（#math）
  const re = /\$\$([^$\n]{1,200}?)\$\$|\$([^$\n]{1,40}?)\$/g;
  for (let m; (m = re.exec(s)); ) {
    out += run(s.slice(last, m.index), { sz: szHalfPt });
    const display = m[1] != null;
    const content = display ? m[1] : m[2];
    // 货币守卫与 unicode 路径一致：$5 至 $6 这类金额不转公式对象
    const omml = display ? latexToOmml(content) : isCurrencyText(content) ? null : latexToOmml(content);
    out += omml
      ? display
        ? `<m:oMathPara><m:oMath>${omml}</m:oMath></m:oMathPara>`
        : `<m:oMath>${omml}</m:oMath>`
      : run(m[0], { sz: szHalfPt });
    last = m.index + m[0].length;
  }
  out += run(s.slice(last), { sz: szHalfPt });
  return out;
}

function codeParagraph(line) {
  return `<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr>${run(line, { mono: true })}</w:p>`;
}

function cellParagraph(text, bold, sz = 21) {
  // 表格字体：五号宋体（中文表格惯例），与正文 16pt 仿宋区分；\n 转 w:br 保留多行单元格；
  // 表头行加粗；宽表（≥8 列）降为 9pt 防挤压
  const rpr =
    `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/>` +
    `${bold ? "<w:b/>" : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
  const lines = String(text ?? "").split("\n");
  const runs = lines
    .map((line, i) => (i > 0 ? `<w:r>${rpr}<w:br/></w:r>` : "") + `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`)
    .join("");
  return `<w:p>${runs}</w:p>`;
}

const TBL_BORDER =
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/>' +
  '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/>';

// 列宽权重：CJK 字符按 2 倍宽计（中文表格列不再被系统性挤窄）
const CJK_WIDE_RE = /[\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
function textWidth(s) {
  let n = 0;
  for (const ch of String(s ?? "")) n += CJK_WIDE_RE.test(ch) ? 2 : 1;
  return n;
}

// A4 正文区可用宽度（twips）：纵向 11906-1588-1474=8844 取 9026 上限值；横向 16838-1701-2098=13039
const BODY_W_PORTRAIT = 9026;
const BODY_W_LANDSCAPE = 13039;

function table(rows, merges = [], { bodyW = BODY_W_PORTRAIT } = {}) {
  // 空表直接不产出 <w:tbl>：Math.max(...[]) = -Infinity 会造出空 tblGrid 的非法表格（#20）
  if (!rows.length) return "";
  // 合并布局：origin 格标 vMerge restart / gridSpan；rowSpan 覆盖格生成 vMerge continuation；
  // colSpan 覆盖格整格跳过（docx 规则：gridSpan 格算多列，不生成被跨的 tc）
  const origin = new Map();
  const vCont = new Map(); // key → colSpan（跨行延续格若原点跨列，须带 gridSpan）
  const skipped = new Set();
  for (const m of merges) {
    origin.set(`${m.r},${m.c}`, m);
    for (let r = m.r; r < m.r + m.rowSpan; r++) {
      for (let c = m.c; c < m.c + m.colSpan; c++) {
        if (r === m.r && c === m.c) continue;
        if (r > m.r && c === m.c) {
          // 跨行续行的「起始列」：生成带 gridSpan 的延续格（rowSpan>1 且 colSpan>1 时须带 gridSpan）
          vCont.set(`${r},${c}`, m.colSpan);
        } else {
          // 其余被覆盖格整格跳过：colSpan 覆盖格不生成 tc（由 gridSpan 吸收）；
          // 跨行续行非起始列也由同一 gridSpan 续格吸收，绝不重复生成 tc（#2）
          skipped.add(`${r},${c}`);
        }
      }
    }
  }
  const nCols = Math.max(...rows.map((r) => r.length));
  // 列宽按内容显示宽度加权铺满正文区：宽表不再挤成窄条，长文列自动更宽（嵌套格取摊平文本）
  const weights = Array.from({ length: nCols }, (_, c) =>
    Math.max(6, ...rows.map((r) => Math.min(80, textWidth(cellFlatText(r[c])))))
  );
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const gridCols = weights.map((w) => Math.max(700, Math.round((bodyW * w) / wSum)));
  const grid = `<w:tblGrid>${gridCols.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  const cellSz = nCols >= 8 ? 18 : 21; // 宽表降字号（9pt）防挤压
  const header = isHeaderRow(rows); // 表头启发式：首行全短文本+其余行含数字才按表头渲染
  const trs = rows
    .map((cells, ri) => {
      const tcs = [];
      for (let ci = 0; ci < nCols; ci++) {
        const key = `${ri},${ci}`;
        if (skipped.has(key)) continue;
        if (vCont.has(key)) {
          const cs = vCont.get(key);
          const g = cs > 1 ? `<w:gridSpan w:val="${cs}"/>` : "";
          // ECMA-376 要求 w:tc 至少含一个块级元素：续格补空 w:p（WPS/LibreOffice 严格校验需要）
          tcs.push(`<w:tc><w:tcPr>${g}<w:vMerge/></w:tcPr><w:p/></w:tc>`);
          continue;
        }
        const m = origin.get(key);
        const mergePr =
          m && m.rowSpan > 1 && m.colSpan > 1
            ? `<w:vMerge w:val="restart"/><w:gridSpan w:val="${m.colSpan}"/>`
            : m && m.rowSpan > 1
              ? '<w:vMerge w:val="restart"/>'
              : m && m.colSpan > 1
                ? `<w:gridSpan w:val="${m.colSpan}"/>`
                : "";
        // 嵌套表（v0.4）：格值为 {nested:{rows,merges}, text?} → 格内文本段 + 原生嵌套 w:tbl
        const nested = cells[ci] && typeof cells[ci] === "object" && cells[ci].nested ? cells[ci].nested : null;
        const cellText = nested ? String(cells[ci].text ?? "") : String(cells[ci] ?? "");
        const inner = nested ? table(nested.rows ?? [], nested.merges ?? [], { bodyW }) : "";
        tcs.push(
          `<w:tc><w:tcPr>${mergePr}<w:vAlign w:val="center"/></w:tcPr>${cellParagraph(cellText, header && ri === 0, cellSz)}${inner}</w:tc>`
        );
      }
      // 首行标 tblHeader：表格跨页时每页重复表头（仅在判定为表头时）
      const trpr = header && ri === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
      return `<w:tr>${trpr}${tcs.join("")}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${TBL_BORDER}</w:tblBorders></w:tblPr>${grid}${trs}</w:tbl>`;
}

/** 单页块渲染 → body XML（不含 sectPr）。imageRids 与图片块出现顺序一一对应。 */
function renderBlocks(blocks, { imageRids = [], formulaMode = "unicode" } = {}) {
  let imgIdx = 0;
  return blocks
    .map((b) => {
      switch (b.type) {
        case "h1":
          return paragraph(b.text, "Heading1", formulaMode);
        case "h2":
          return paragraph(b.text, "Heading2", formulaMode);
        case "h3":
          return paragraph(b.text, "Heading3", formulaMode);
        case "code":
          return (b.lines ?? [b.text ?? ""]).map(codeParagraph).join("");
        case "table":
          return table(b.rows ?? [], b.merges ?? []);
        case "image":
          if (!b.data) return ""; // 未 materialize 的图片块跳过（export 层已剔除，防御）
          return (
            imageParagraph(b, imageRids[imgIdx++] ?? `rIdImg${imgIdx}`, imgIdx - 1) +
            (b.caption ? captionParagraph(b.caption) : "")
          );
        default:
          return paragraph(b.text ?? "", "Normal", formulaMode);
      }
    })
    .join("");
}

const PAGE_MARGIN_PORTRAIT = '<w:pgMar w:top="2098" w:right="1474" w:bottom="1985" w:left="1588" w:header="851" w:footer="992" w:gutter="0"/>';
const PAGE_MARGIN_LANDSCAPE = '<w:pgMar w:top="1418" w:right="2098" w:bottom="1701" w:left="1701" w:header="851" w:footer="851" w:gutter="0"/>';

function sectPrXml(isLandscape, { headerRid = null, footerRid = null, pageSize = null } = {}) {
  const refs =
    (headerRid ? `<w:headerReference w:type="default" r:id="${headerRid}"/>` : "") +
    (footerRid ? `<w:footerReference w:type="default" r:id="${footerRid}"/>` : "");
  // 页几何钉死（v0.4）：原件真实页尺寸（pt→twips）优先，方向以 w/h 为准；无尺寸回退 A4 预设
  let sz;
  if (pageSize?.wTwips > 0 && pageSize?.hTwips > 0) {
    const land = pageSize.wTwips > pageSize.hTwips;
    isLandscape = land;
    sz = `<w:pgSz w:w="${pageSize.wTwips}" w:h="${pageSize.hTwips}"${land ? ' w:orient="landscape"' : ""}/>`;
  } else {
    sz = isLandscape
      ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
      : '<w:pgSz w:w="11906" w:h="16838"/>';
  }
  const mar = isLandscape ? PAGE_MARGIN_LANDSCAPE : PAGE_MARGIN_PORTRAIT;
  return `<w:sectPr>${refs}${sz}${mar}</w:sectPr>`;
}

/** 块数组 → word/document.xml（单节，纵向）。
 *  blocks 支持图片块（type:'image'，须已 materialize 出 data）；
 *  imageRids 与文档中图片块出现顺序一一对应；headerRid/footerRid 为页眉页脚关系 id；
 *  formulaMode：omml 时段落 $…$ 转原生公式对象。 */
export function blocksToDocumentXml(blocks, { imageRids = [], headerRid = null, footerRid = null, formulaMode = "unicode" } = {}) {
  const body = renderBlocks(blocks, { imageRids, formulaMode });
  const sectPr = sectPrXml(false, { headerRid, footerRid });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}${sectPr}</w:body></w:document>`;
}

/** 多节文档：每页一个 section（页边界/方向/页尺寸钉死）→ docx 页数与原件一致。
 *  pages: layoutToPageBlocks 输出。图片 rid 跨页连续分配（imageRids 由调用方从 docRelsXml 传入，顺序与跨页图片块一致）。
 *  表格列宽按所在节方向取正文区宽度（横页用横向全宽，宽表不再挤在 2/3 宽度里）。
 *  pageSizes（v0.4）：本地原件逐页 {wTwips,hTwips,wPt,hPt}——页尺寸/方向以真实尺寸为准，
 *  并据此把块 _fontUnits（坐标单位）折算为 pt（字号传递）；无 pageSizes 时回退 A4 预设。 */
export function blocksToDocumentPagesXml(pages, { headerRid = null, footerRid = null, imageRids = [], formulaMode = "unicode", pageSizes = null } = {}) {
  const imageBlocks = pages.flatMap((p) => (p.blocks ?? []).filter((b) => b.type === "image" && b.data));
  const ridOf = new Map(imageBlocks.map((b, i) => [b, imageRids[i] ?? `rIdImg${i + 1}`]));
  let imgIdx = 0;

  const parts = [];
  pages.forEach((page, pi) => {
    const ps = Array.isArray(pageSizes) ? pageSizes[pi] : null;
    const hasSize = ps?.wTwips > 0 && ps?.hTwips > 0;
    const isLand = hasSize ? ps.wTwips > ps.hTwips : page.isLandscape === true;
    const bodyW = hasSize
      ? Math.max(3000, ps.wTwips - (isLand ? 1701 + 2098 : 1588 + 1474))
      : isLand
        ? BODY_W_LANDSCAPE
        : BODY_W_PORTRAIT;
    // 字号传递：块高（坐标单位）×（真实页高 pt / 坐标页高）→ pt → half-points（clamp 7–42pt）
    const fontFactor = hasSize && page._pageH > 0 ? ps.hPt / page._pageH : 0;
    const szOf = (b) => {
      if (!fontFactor || !b?._fontUnits) return null;
      const pt = Math.max(7, Math.min(42, b._fontUnits * fontFactor));
      return String(Math.round(pt * 2));
    };
    const body = (page.blocks ?? [])
      .map((b) => {
        switch (b.type) {
          case "h1":
            return paragraph(b.text, "Heading1", formulaMode, szOf(b));
          case "h2":
            return paragraph(b.text, "Heading2", formulaMode, szOf(b));
          case "h3":
            return paragraph(b.text, "Heading3", formulaMode, szOf(b));
          case "code":
            return (b.lines ?? [b.text ?? ""]).map(codeParagraph).join("");
          case "table":
            return (b.caption ? captionParagraph(b.caption) : "") + table(b.rows ?? [], b.merges ?? [], { bodyW });
          case "image":
            if (!b.data) return "";
            {
              const img = imageParagraph(b, ridOf.get(b) ?? `rIdImg${imgIdx + 1}`, imgIdx++);
              return b.caption ? img + captionParagraph(b.caption) : img;
            }
          default:
            return paragraph(b.text ?? "", "Normal", formulaMode, szOf(b));
        }
      })
      .join("");
    const sect = sectPrXml(isLand, { headerRid, footerRid, pageSize: hasSize ? ps : null });
    if (pi === pages.length - 1) {
      parts.push(body + sect); // 末节：body 级 sectPr
    } else {
      parts.push(`${body}<w:p><w:pPr>${sect}</w:pPr></w:p>`); // 节分隔段落
    }
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${parts.join("")}</w:body></w:document>`;
}

function contentTypesXml({ imageExts = [], hasHeader, hasFooter }) {
  const CT = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
  const imgDefaults = [...new Set(imageExts)]
    .map((ext) => `<Default Extension="${ext}" ContentType="${CT[ext] || "image/jpeg"}"/>`)
    .join("");
  const overrides =
    (hasHeader ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : "") +
    (hasFooter ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : "");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${imgDefaults}${overrides}</Types>`;
}

function rel(rid, type, target) {
  return `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
}

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

function docRelsXml({ hasHeader, hasFooter, imageExts }) {
  const parts = [];
  let n = 0;
  const next = () => `rId${++n}`;
  const stylesRid = next();
  parts.push(rel(stylesRid, "styles", "styles.xml"));
  const headerRid = hasHeader ? next() : null;
  if (hasHeader) parts.push(rel(headerRid, "header", "header1.xml"));
  const footerRid = hasFooter ? next() : null;
  if (hasFooter) parts.push(rel(footerRid, "footer", "footer1.xml"));
  const imageRids = imageExts.map((ext, i) => {
    const rid = next();
    parts.push(rel(rid, "image", `media/image${i + 1}.${ext}`));
    return rid;
  });
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.join("")}</Relationships>`,
    headerRid,
    footerRid,
    imageRids,
  };
}

function stylesXml() {
  // 中文文档常规样式（按 GB/T 公文惯例）：正文仿宋三号、固定 28 磅行距、首行缩进 2 字符；
  // H1=文档标题（小标宋二号居中）、H2=一级（黑体三号）、H3=二级（楷体三号）
  const FONT_BODY = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="仿宋_GB2312"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="仿宋_GB2312"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:pPr><w:spacing w:line="560" w:lineRule="exact" w:before="0" w:after="0"/><w:ind w:firstLineChars="200" w:firstLine="640"/><w:jc w:val="justify"/></w:pPr><w:rPr>${FONT_BODY}<w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:line="560" w:lineRule="exact" w:before="120" w:after="120"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="方正小标宋简体"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:line="560" w:lineRule="exact" w:before="60" w:after="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="黑体"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:line="560" w:lineRule="exact" w:before="0" w:after="0"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="楷体_GB2312"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style></w:styles>`;
}

function coreXml(title) {
  const iso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>dsh-plugin-baidu-ocr</dc:creator><cp:lastModifiedBy>dsh-plugin-baidu-ocr</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`;
}

/** 块数组 → docx Buffer。
 *  image 块（type:'image'，data:Buffer，ext:'png'|'jpeg'）嵌入 word/media 并以 w:drawing 引用；
 *  headerText/footerText 非空时生成页眉/页脚部件；formulaMode=omml 时 $…$ 转原生公式对象。 */
export function blocksToDocx(blocks, { title = "OCR 识别结果", headerText = "", footerText = "", formulaMode = "unicode" } = {}) {
  const imageBlocks = blocks.filter((b) => b.type === "image" && b.data);
  const imageExts = imageBlocks.map((b) => ["png", "jpeg", "webp", "gif", "bmp"].includes(b.ext) ? b.ext : "jpeg");
  const { xml: docRels, headerRid, footerRid, imageRids } = docRelsXml({
    hasHeader: Boolean(headerText),
    hasFooter: Boolean(footerText),
    imageExts,
  });

  const entries = [
    { name: "[Content_Types].xml", data: contentTypesXml({ imageExts, hasHeader: Boolean(headerText), hasFooter: Boolean(footerText) }) },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/core.xml", data: coreXml(title) },
    { name: "word/document.xml", data: blocksToDocumentXml(blocks, { imageRids, headerRid, footerRid, formulaMode }) },
    { name: "word/_rels/document.xml.rels", data: docRels },
    { name: "word/styles.xml", data: stylesXml() },
  ];
  if (headerText) entries.push({ name: "word/header1.xml", data: headerFooterXml("hdr", headerText) });
  if (footerText) entries.push({ name: "word/footer1.xml", data: headerFooterXml("ftr", footerText) });
  imageBlocks.forEach((b, i) => {
    entries.push({ name: `word/media/image${i + 1}.${imageExts[i]}`, data: b.data });
  });
  return zipStore(entries);
}

/** 多节 docx：每页一个 section（页边界/方向/页尺寸钉死）→ 页数与原件一致。pages: layoutToPageBlocks 输出。
 *  pageSizes（v0.4）：本地原件逐页尺寸，透传 blocksToDocumentPagesXml。 */
export function blocksToDocxPages(pages, { title = "OCR 识别结果", headerText = "", footerText = "", formulaMode = "unicode", pageSizes = null } = {}) {
  const imageBlocks = pages.flatMap((p) => (p.blocks ?? []).filter((b) => b.type === "image" && b.data));
  const imageExts = imageBlocks.map((b) => ["png", "jpeg", "webp", "gif", "bmp"].includes(b.ext) ? b.ext : "jpeg");
  const { xml: docRels, headerRid, footerRid, imageRids } = docRelsXml({
    hasHeader: Boolean(headerText),
    hasFooter: Boolean(footerText),
    imageExts,
  });

  const entries = [
    { name: "[Content_Types].xml", data: contentTypesXml({ imageExts, hasHeader: Boolean(headerText), hasFooter: Boolean(footerText) }) },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/core.xml", data: coreXml(title) },
    { name: "word/document.xml", data: blocksToDocumentPagesXml(pages, { headerRid, footerRid, imageRids, formulaMode, pageSizes }) },
    { name: "word/_rels/document.xml.rels", data: docRels },
    { name: "word/styles.xml", data: stylesXml() },
  ];
  if (headerText) entries.push({ name: "word/header1.xml", data: headerFooterXml("hdr", headerText) });
  if (footerText) entries.push({ name: "word/footer1.xml", data: headerFooterXml("ftr", footerText) });
  imageBlocks.forEach((b, i) => {
    entries.push({ name: `word/media/image${i + 1}.${imageExts[i]}`, data: b.data });
  });
  return zipStore(entries);
}
