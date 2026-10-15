// lib/layout.js — VL 版面 JSON → 版面块流（第 1 期版面保真的核心）
// parse_result_url JSON 结构实测（2026-10-11，见 docs/layout-improvement-analysis.md §8.1）：
//   pages[]: { layouts[], images[], tables[], text, markdown, ... }
//   layouts[]: { layout_id, type, text, position[x,y,w,h], polygon, table_html, sub_type, parent/children }
//   page.images[]: { layout_id, data_url(30天直链), ... }
// 块模型扩展（与 markdown.js/ooxml.js 共用）：
//   { type:'image', url, w, h, data?:Buffer, ext } —— data 由 materializeImages 下载后填充
import { OcrError } from "./errors.js";
import { cleanMath } from "./math.js";
import { mergeAdjacentParagraphBlocks } from "./textflow.js";

// 页眉页脚类（浏览器截图的标签页/网址也会落在这些类型里，默认过滤）
export const HEADER_TYPES = new Set(["header", "footer", "header_image", "footer_image"]);
// 标题类（实测出现 paragraph_title；title/doc_title 等宽松兼容）
const TITLE_TYPES = new Set(["title", "doc_title", "paragraph_title", "heading"]);

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function htmlUnescape(s) {
  return String(s ?? "").replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m, e) => HTML_ENTITIES[e] ?? m);
}

function stripTags(s) {
  return String(s ?? "").replace(/<[^>]+>/g, "");
}

/** 嵌套表格降级：内层 <table> 压平为"行\n / 列空格"文本（正则平铺不解析结构，保内容不保结构）。
 *  keepOuter=true 只压到还剩最外一个表（用于整表预处理）；=false 全部压平（用于单元格内容）。 */
function flattenNestedTables(s, keepOuter = true) {
  let out = String(s ?? "");
  const minTables = keepOuter ? 2 : 1;
  for (let guard = 0; guard < 5 && (out.match(/<table[\s>]/gi) ?? []).length >= minTables; guard++) {
    const next = out.replace(/<table[^>]*>((?:(?!<table)[\s\S])*?)<\/table>/gi, (_, inner) => {
      const lines = [];
      for (const tr of inner.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
        const cells = [...tr[0].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
          .map((c) => htmlUnescape(stripTags(c[1].replace(/<br\s*\/?>/gi, " "))).trim())
          .filter((t) => t !== "");
        if (cells.length) lines.push(cells.join(" "));
      }
      return lines.join("\n");
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 单元格内容 → 文本：<br> 保留为换行；块级闭合标签转换行；嵌套表格压平；
 *  字面 \n（后端在单元格文本里输出的转义串，非真换行）转真换行。 */
function cellToText(html) {
  let s = String(html ?? "");
  if (/<table[\s>]/i.test(s)) s = flattenNestedTables(s, false);
  return htmlUnescape(stripTags(s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li)>/gi, "\n")))
    .replace(/\\n/g, "\n")
    .trim();
}

/** 带 table 嵌套深度感知的行/格扫描：内层表的 </tr>/</td> 不会截断外层结构
 *  （旧版非贪婪正则 <tr…</tr> 在嵌套表处提前截断导致行列错位）。
 *  返回 [{ attrs, html }] 数组的数组（每行若干格，html 为格内原始内容）。 */
function scanTableRows(src) {
  const rows = [];
  const tagRe = /<(\/?)(table|tr|td|th)\b([^>]*)>/gi;
  let depth = 0; // 内层表深度（最外层表本身不计，否则外层行列会被整表跳过）
  let outerSeen = false;
  let rowStart = -1;
  let cellStart = -1;
  let cellAttrs = "";
  const closeCell = (end) => {
    if (rowStart >= 0 && cellStart >= 0 && rows.length) {
      rows[rows.length - 1].push({ attrs: cellAttrs, html: src.slice(cellStart, end) });
    }
    cellStart = -1;
    cellAttrs = "";
  };
  const closeRow = (end) => {
    if (rowStart >= 0) closeCell(end);
    rowStart = -1;
  };
  for (const m of src.matchAll(tagRe)) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "table") {
      if (closing) {
        if (depth > 0) depth--;
        else outerSeen = false;
      } else if (outerSeen || depth > 0 || rowStart >= 0) {
        // 已在表内容里（含无 <table> 标签的行片段）→ 这是嵌套表
        depth++;
      } else {
        outerSeen = true;
      }
      continue;
    }
    if (depth > 0) continue; // 内层表结构留给 cellToText 压平
    if (tag === "tr") {
      if (closing) closeRow(m.index);
      else {
        closeRow(m.index);
        rowStart = m.index + m[0].length;
        rows.push([]);
      }
      continue;
    }
    // td / th
    if (closing) {
      closeCell(m.index);
    } else {
      closeCell(m.index); // 容忍未闭合的前一格（<td>a<td>b）
      if (rowStart < 0) {
        rowStart = m.index;
        rows.push([]);
      }
      cellStart = m.index + m[0].length;
      cellAttrs = (m[3] ?? "").trim();
    }
  }
  closeRow(src.length); // EOF 未闭合收尾
  return rows;
}

/** table_html → rows（colspan/rowspan 感知网格；<br> 保留换行；嵌套表降级为文本）。
 *  返回 { rows: 网格(合并覆盖格为空串), merges }。
 *  健壮性：rowspan 超出来源行数的幻影尾行裁掉（VL 常见误预测），merges 同步裁剪；
 *  行格子数超预估值时自动扩列不丢格；空 <tr> 保留空行占位（行号对齐来源）。 */
// colspan/rowspan 上限：畸形表格 HTML（如 colspan="99999999"）会让 nCols/幻影行
// 物化出上亿元素的数组，直接拖死导出并产出几百 MB 的 document.xml（#7）
const MAX_CELL_SPAN = 100;

export function htmlToRows(tableHtml) {
  const rawRows = scanTableRows(String(tableHtml ?? "")).map((cells) =>
    cells.map(({ attrs, html }) => {
      const cs = Math.min(MAX_CELL_SPAN, Number(/colspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? 1) || 1);
      const rs = Math.min(MAX_CELL_SPAN, Number(/rowspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? 1) || 1);
      // 嵌套表（v0.4 表格真嵌套）：格内 <table> 递归解析为 {nested:{rows,merges}} 结构
      // （docx 原生嵌套 w:tbl 用），格内表格外围文本保留；递归深度由 inner 内容自然收敛
      if (/<table[\s>]/i.test(html)) {
        const inner = /<table[\s>][\s\S]*<\/table>/i.exec(html)?.[0] ?? "";
        const around = inner ? html.replace(inner, "") : html;
        const aroundText = cellToText(around);
        return {
          ...(inner ? { nested: htmlToRows(inner) } : {}),
          text: aroundText,
          colSpan: cs,
          rowSpan: rs,
        };
      }
      return { text: cellToText(html), colSpan: cs, rowSpan: rs };
    })
  );
  if (!rawRows.length) return { rows: [], merges: [] };
  let nCols = Math.max(...rawRows.map((r) => r.reduce((n, c) => n + c.colSpan, 0)), 1);
  const occupied = new Set();
  const merges = [];
  const rows = [];
  const ensureRow = (r) => {
    rows[r] = rows[r] || Array(nCols).fill("");
    while (rows[r].length < nCols) rows[r].push("");
    return rows[r];
  };
  for (let r = 0; r < rawRows.length; r++) {
    ensureRow(r);
    let c = 0;
    for (const cell of rawRows[r]) {
      while (c < nCols && occupied.has(`${r},${c}`)) c++;
      if (c >= nCols) {
        // 防御性扩列（正常不会触发：nCols 取各行 colspan 和的最大值）
        nCols = c + 1;
        for (let rr = 0; rr < rows.length; rr++) ensureRow(rr);
      }
      rows[r][c] = cell.nested ? cell : cell.text;
      if (cell.rowSpan > 1 || cell.colSpan > 1) merges.push({ r, c, rowSpan: cell.rowSpan, colSpan: cell.colSpan });
      for (let rr = r; rr < r + cell.rowSpan; rr++) {
        for (let cc = c; cc < c + cell.colSpan; cc++) {
          if (rr === r && cc === c) continue;
          occupied.add(`${rr},${cc}`);
          ensureRow(rr)[cc] = "";
        }
      }
      c += cell.colSpan;
    }
  }
  // rowspan 越界产生的幻影尾行（整行全空）裁掉；merges 越界部分同步裁剪/剔除
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
  // 列数上限同理（防御性扩列路径也可能被畸形输入推到很大）
  if (nCols > MAX_CELL_SPAN * 4) {
    for (const r of rows) r.length = Math.min(r.length, MAX_CELL_SPAN * 4);
    nCols = MAX_CELL_SPAN * 4;
  }
  const clamped = [];
  for (const m of merges) {
    if (m.r >= rows.length) continue;
    const rowSpan = Math.min(m.rowSpan, rows.length - m.r);
    if (rowSpan <= 1 && m.colSpan <= 1) continue; // 裁剪后退化成普通格的合并直接去掉
    clamped.push({ ...m, rowSpan });
  }
  return { rows, merges: clamped };
}


/** 通栏块装配（2/N 栏共用）：栏区之上的通栏块在前、之下的垫后、夹在栏间的按 y 排栏后。
 *  旧实现把所有宽块无条件提到最前——页底通栏表/图会被提到页首，阅读顺序倒置（#13） */
function assembleWithColumns(cols, wide) {
  const byY = (a, b) =>
    (a?.position?.[1] ?? 0) - (b?.position?.[1] ?? 0) || (a?.position?.[0] ?? 0) - (b?.position?.[0] ?? 0);
  const flat = cols.flat();
  const colTop = Math.min(...flat.map((l) => l?.position?.[1] ?? 0));
  const colBottom = Math.max(...flat.map((l) => (l?.position?.[1] ?? 0) + (l?.position?.[3] ?? 0)));
  const topOf = (l) => l?.position?.[1] ?? 0;
  const bottomOf = (l) => (l?.position?.[1] ?? 0) + (l?.position?.[3] ?? 0);
  const above = wide.filter((l) => bottomOf(l) <= colTop + 1).sort(byY);
  const below = wide.filter((l) => topOf(l) >= colBottom - 1).sort(byY);
  const mid = wide.filter((l) => !above.includes(l) && !below.includes(l)).sort(byY);
  return [...above, ...flat, ...mid, ...below];
}

/** 阅读顺序（第 3 期双栏重建 + v0.4 3/4 栏泛化）。
 * 双栏判定（保守，用真实坐标校准过误判用例）：
 *   1) 非全宽块按中心 x 分左右两簇，各 ≥3 块；
 *   2) 栏间沟：左簇最右边缘 + 2%页宽 < 右簇最左边缘（左右 x 区间真正分离）；
 *   3) 并行性：两簇的 y 区间重叠高度 > 较矮簇的 50%（两栏并排存在，而非上下散布）。
 * N 栏判定（先于双栏尝试）：非全宽块中心 x 排序后相邻间距 > 12% 页宽视为栏沟，
 *   聚成 3–4 簇且每簇 ≥2 块 → 按栏序阅读（左→右，栏内 y 序）。
 * 全宽块（标题/跨栏表格图）视为独立流按位置插入。 */
function orderLayouts(layouts) {
  const byY = (a, b) =>
    (a?.position?.[1] ?? 0) - (b?.position?.[1] ?? 0) || (a?.position?.[0] ?? 0) - (b?.position?.[0] ?? 0);
  if (layouts.length < 7) return [...layouts].sort(byY);
  const pageW = Math.max(...layouts.map((l) => (l?.position?.[0] ?? 0) + (l?.position?.[2] ?? 0)), 1);
  const wide = [];
  const rest = [];
  for (const l of layouts) {
    const [x, , w] = l?.position ?? [0, 0, 0];
    if (w > pageW * 0.6) wide.push(l);
    else rest.push(l);
  }
  const centerX = (l) => (l?.position?.[0] ?? 0) + (l?.position?.[2] ?? 0) / 2;
  // N 栏（3–4 栏）：中心间距 > 12% 页宽聚类；每栏 ≥2 块才启用（防误判碎块）
  if (rest.length >= 6) {
    const sorted = [...rest].sort((a, b) => centerX(a) - centerX(b));
    const clusters = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
      const last = clusters[clusters.length - 1];
      if (centerX(sorted[i]) - centerX(last[last.length - 1]) > pageW * 0.12) clusters.push([sorted[i]]);
      else last.push(sorted[i]);
    }
    if (clusters.length >= 3 && clusters.length <= 4 && clusters.every((c) => c.length >= 2)) {
      return assembleWithColumns(clusters.map((c) => c.sort(byY)), wide);
    }
  }
  const mid = pageW / 2;
  const left = [];
  const right = [];
  for (const l of rest) {
    const [x, , w] = l?.position ?? [0, 0, 0];
    (x + w / 2 < mid ? left : right).push(l);
  }
  if (left.length >= 3 && right.length >= 3) {
    const lMaxX = Math.max(...left.map((l) => (l?.position?.[0] ?? 0) + (l?.position?.[2] ?? 0)));
    const rMinX = Math.min(...right.map((l) => l?.position?.[0] ?? 0));
    const yRange = (arr) => {
      const ys = arr.map((l) => l?.position?.[1] ?? 0);
      return { min: Math.min(...ys), max: Math.max(...ys) };
    };
    const ly = yRange(left);
    const ry = yRange(right);
    const overlap = Math.min(ly.max, ry.max) - Math.max(ly.min, ry.min);
    const gapOk = lMaxX + pageW * 0.02 < rMinX;
    const overlapOk = overlap > Math.min(ly.max - ly.min, ry.max - ry.min) * 0.5;
    if (gapOk && overlapOk) {
      return assembleWithColumns([left.sort(byY), right.sort(byY)], wide);
    }
  }
  return [...layouts].sort(byY);
}

/** 估算正文行高：全部 text 块中最小的有效块高（单行正文的块高 ≈ 行高）。
 *  用于标题分级（第 3 期）：标题块高 / 正文行高 ≥1.4 → h1，≥1.1 → h2，否则 h3。 */
function estimateBodyLineH(layouts) {
  const hs = layouts
    .filter((l) => l?.type === "text" && l?.position?.[3] > 0)
    .map((l) => l.position[3])
    .sort((a, b) => a - b);
  return hs.length ? hs[0] : 0;
}

// 公文序号模式（实测：VL 对公文 PDF 的 paragraph_title 块高可能小于正文块高，字号比对失灵，
// 序号模式是最可靠信号）：一、二、… → h2（黑体级）；（一）（二）… → h3（楷体级）
const CN_NUM = "[一二三四五六七八九十百]+";
const H2_PATTERN = new RegExp(`^\\s*${CN_NUM}\\s*、`);
const H3_PATTERN = new RegExp(`^\\s*[（(]\\s*${CN_NUM}\\s*[）)]`);

function spanMaxHeight(l) {
  // span_boxes 字段结构未实测（样例为 null），防御性解析：取有效 box 高的最大值
  const spans = l?.span_boxes;
  if (!Array.isArray(spans) || !spans.length) return 0;
  let m = 0;
  for (const s of spans) {
    const h = Number(s?.height ?? s?.position?.[3] ?? 0);
    if (h > m) m = h;
  }
  return m;
}

function titleLevel(l, bodyLineH) {
  const text = String(l?.text ?? "").trim();
  if (l?.type === "title" || l?.type === "doc_title") return "h1";
  // 公文序号模式优先于字号（实测段落标题块高可能小于正文块高）
  if (H2_PATTERN.test(text)) return "h2";
  if (H3_PATTERN.test(text)) return "h3";
  const h = Math.max(Number(l?.position?.[3]) || 0, spanMaxHeight(l));
  if (bodyLineH > 0 && h > 0) {
    const ratio = h / bodyLineH;
    if (ratio >= 1.4) return "h1";
    if (ratio >= 1.1) return "h2";
    return "h3";
  }
  return "h2"; // 无正文行高可参照时保持旧行为
}

/** md 表格文本 → rows（跳过 --- 分隔行；容忍缺尾竖线；\| 转义不拆列；字面 \n 转真换行） */
export function mdTableToRows(md) {
  const rows = [];
  for (const line of String(md ?? "").split("\n")) {
    const s = line.trim();
    if (!s.includes("|")) continue;
    if (/^\|?[\s:\-|]+\|?\s*$/.test(s)) continue;
    let body = s;
    if (body.startsWith("|")) body = body.slice(1);
    if (/(?<!\\)\|$/.test(body)) body = body.slice(0, -1);
    rows.push(body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\n/g, "\n").replace(/\\\|/g, "|")));
  }
  return rows;
}

/** 从 page.tables[] 的 matrix+cells 重建带合并信息的表格（第 3 期补充：实测合并信息只在这里）。
 *  matrix = [[cellId,...],...]（同行同号=colSpan，同列同号=rowSpan），cells[id].text = 内容。
 *  返回 { rows(网格，起始格有文本、被覆盖格为""), merges:[{r,c,rowSpan,colSpan}] }，无数据返回 null。 */
export function buildTableFromCells(t) {
  const matrix = t?.matrix;
  const cells = t?.cells;
  if (!Array.isArray(matrix) || !Array.isArray(cells) || !matrix.length) return null;
  const nCols = Math.max(...matrix.map((r) => r.length));
  const posById = new Map();
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix[r].length; c++) {
      const id = matrix[r][c];
      if (!posById.has(id)) posById.set(id, []);
      posById.get(id).push({ r, c });
    }
  }
  // cells 两种形态都要能寻址：数组下标（matrix 的 id 就是下标）与 {cell_id,text}
  // 对象数组（id 是业务键）。旧实现只认 cells[id].text，对象数组形态下全表取空（#5）。
  // 业务键与下标分表注册、按业务键优先查找：共用一个键空间时 idx 会覆盖同号 cell_id
  // （cells 顺序≠id 顺序时全表错位）；实测后端存在"数字下标 matrix + cell_id 对象"混合形态，
  // 两边都要注册才都能寻址。
  const cellByBizId = new Map();
  const cellByIdx = new Map();
  cells.forEach((c, idx) => {
    if (c && typeof c === "object") {
      if (c.cell_id != null) cellByBizId.set(String(c.cell_id), c);
      cellByIdx.set(String(idx), c);
    } else if (c != null) {
      cellByIdx.set(String(idx), c); // 纯字符串数组
    }
  });
  const lookupCell = (id) => cellByBizId.get(String(id)) ?? cellByIdx.get(String(id));
  const merges = [];
  const rows = [];
  for (let r = 0; r < matrix.length; r++) {
    const row = [];
    for (let c = 0; c < nCols; c++) {
      const id = matrix[r]?.[c];
      const positions = posById.get(id) ?? [];
      const rs = new Set(positions.map((p) => p.r)).size;
      const cs = new Set(positions.map((p) => p.c)).size;
      const isOrigin = positions[0]?.r === r && positions[0]?.c === c;
      const cell = lookupCell(id);
      const raw = typeof cell === "string" ? cell : cell?.text;
      row.push(isOrigin ? String(raw ?? "").replace(/\\n/g, "\n").trim() : "");
      if ((rs > 1 || cs > 1) && isOrigin) merges.push({ r, c, rowSpan: rs, colSpan: cs });
    }
    rows.push(row);
  }
  // 一格文本都没取到 = matrix/cells 对不上：返回 null 让调用方走 markdown/table_html 兜底。
  // 旧实现返回全空 rows，调用方的 rows.length 守卫判真 → 产出空表还把兜底路径 continue 掉（#5）
  if (!rows.some((r) => r.some((c) => c))) return null;
  return { rows, merges };
}

/** 单元格 → 摊平文本：嵌套格（{nested,text}）递归摊平为空格连接（列宽/表头判定/md/csv 渲染共用） */
export function cellFlatText(c) {
  if (c && typeof c === "object") {
    const parts = [];
    if (c.text) parts.push(String(c.text));
    if (c.nested?.rows?.length) {
      for (const row of c.nested.rows) {
        const line = row.map(cellFlatText).filter((t) => t).join(" ");
        if (line) parts.push(line);
      }
    }
    return parts.join(" ");
  }
  return String(c ?? "");
}

/** 表头判定（渲染层共用）：首行全短文本（显示宽 ≤12，CJK 按双宽计）且其余行至少
 *  一格含数字 → 按表头渲染（加粗/跨页重复表头）；否则首行当数据行。 */
export function dispWidth(s) {
  let n = 0;
  for (const ch of String(s ?? "")) n += /[\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}

export function isHeaderRow(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const first = rows[0] ?? [];
  if (!first.some((c) => String(cellFlatText(c) ?? "").trim())) return false;
  const allShort = first.every((c) => dispWidth(cellFlatText(c)) <= 12);
  const bodyHasDigit = rows.slice(1).some((r) => (r ?? []).some((c) => /\d/.test(cellFlatText(c))));
  return allShort && bodyHasDigit;
}

/** 跨页续表拼接。mode：
 *  - strict（默认）：后表首行与前表表头逐字相同才拼（去重表头），零误拼；
 *  - loose：表头不同也可拼——需同时满足列数一致、前表无延伸到末行的合并、
 *    后表首行无合并、前表延伸到页底（≥85% 页高，靠 table 块的 _pos/_pageH），
 *    拼接时保留后表首行（它不是重复表头）；
 *  - off：不拼接。 */
export function mergeCrossPageTables(pages, mode = "strict") {
  if (mode === "off") return pages;
  // carry：已跨页合并、还可能继续往下接的表。续表在下一页通常是首块，合并后原块被
  // splice 摘除——不 carry 的话第 3 页起的续表永远挂不上来（#4）。就地修改 ta
  // （而非新建对象）同时保住 _pos 等私有元数据，loose 的触底判定才继续有效。
  let carry = null;
  for (let i = 0; i < pages.length - 1; i++) {
    const blocks = pages[i]?.blocks ?? [];
    const b = pages[i + 1]?.blocks ?? [];
    const tb = b[0];
    if (tb?.type !== "table") {
      carry = null;
      continue;
    }
    const local = blocks[blocks.length - 1];
    const ta = carry ?? (local?.type === "table" ? local : null);
    if (!ta) {
      carry = null;
      continue;
    }
    const wa = Math.max(...ta.rows.map((r) => r.length));
    const wb = Math.max(...tb.rows.map((r) => r.length));
    if (wa !== wb) {
      carry = null;
      continue;
    }
    const sameHeader = JSON.stringify(ta.rows[0]) === JSON.stringify(tb.rows[0]);
    const off = ta.rows.length;
    // 触底守卫（strict/loose 共用）：前表未延伸到页底时，下一页同表头的表更可能是
    // 独立表（页 1 末尾与页 2 开头各有一张同表头小表是报表常态，逐字同表头≠续表）。
    // 无坐标数据（_pos/_pageH 缺失）时无法判定，保持旧行为允许拼接。
    const pageH = Number(pages[i]?._pageH) || 0;
    const aBottom = Array.isArray(ta._pos) ? Number(ta._pos[1]) + Number(ta._pos[3]) : 0;
    const reachesBottom = !(pageH > 0 && Array.isArray(ta._pos)) || aBottom >= pageH * 0.85;

    if (sameHeader && reachesBottom) {
      ta.rows = [...ta.rows, ...tb.rows.slice(1)];
      const merges = [...(ta.merges ?? [])];
      for (const m of tb.merges ?? []) {
        if (m.r === 0) continue; // 被丢弃的重复表头行（tb.rows[0]）的合并格不迁移，否则会错挂到前一页末行（#8）
        merges.push({ ...m, r: m.r + off - 1 });
      }
      if (merges.length) ta.merges = merges;
      b.splice(0, 1);
      if (Array.isArray(tb._pos)) ta._pos = tb._pos; // 位置前移到最近续块，loose 触底判定对中继页也成立
      carry = ta;
      continue;
    }
    if (mode !== "loose" || !reachesBottom) {
      carry = null;
      continue;
    }
    const mergesTouchBottom = (ta.merges ?? []).some((m) => m.r + m.rowSpan >= ta.rows.length);
    const firstRowMerged = (tb.merges ?? []).some((m) => m.r === 0);
    if (mergesTouchBottom || firstRowMerged) {
      carry = null;
      continue;
    }
    ta.rows = [...ta.rows, ...tb.rows];
    const merges = [...(ta.merges ?? []), ...(tb.merges ?? []).map((m) => ({ ...m, r: m.r + off }))];
    if (merges.length) ta.merges = merges;
    b.splice(0, 1);
    if (Array.isArray(tb._pos)) ta._pos = tb._pos;
    carry = ta;
  }
  return pages;
}

// 图注模式："图1−4−2 土方回填…" / "表 2-1 ×××"（全角/半角分隔符均容忍）
const CAPTION_RE = /^(图|表)\s*[0-9A-Za-z]{1,6}(?:\s*[-−—－.．]\s*[0-9A-Za-z]{1,6})*\s*[\u4e00-\u9fff]/;
// 标签号后接续接词 = 正文引用句（"表1所示…"/"图2如下…"），不是图注。
// 旧实现只认 CAPTION_RE，这类句子会被吸成图片 caption，md 里沦为 alt 文字（#14）
const CAPTION_PROSE_RE = /^(?:图|表)\s*[0-9A-Za-z]{1,6}(?:\s*[-−—－.．]\s*[0-9A-Za-z]{1,6})*\s*(?:所示|如下|上述|所列|是本|为本|详见|参见|是按|如图|见表)/;
const isCaptionText = (t) => CAPTION_RE.test(t) && !CAPTION_PROSE_RE.test(t);

/** 图注吸附：image 块与紧邻的单行短图注段（≤40 字）合并为 caption，
 *  解决"图在上、图注在下却被其他块隔开/引用悬空"。图注在图前或图后均可。 */
function attachCaptions(blocks) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b?.type !== "image") continue;
    const nxt = blocks[i + 1];
    if (nxt?.type === "p" && nxt.text.length <= 40 && !nxt.text.includes("\n") && isCaptionText(nxt.text)) {
      b.caption = nxt.text;
      blocks.splice(i + 1, 1);
      continue;
    }
    const prv = i > 0 ? blocks[i - 1] : null;
    if (prv?.type === "p" && prv.text.length <= 40 && !prv.text.includes("\n") && isCaptionText(prv.text)) {
      b.caption = prv.text;
      blocks.splice(i - 1, 1);
      i -= 1;
    }
  }
  return blocks;
}

/** 表注吸附（v0.4）：与表格块相邻的"表x-x"短段吸附为表格 caption（表注通常在表上方，下方也可）。
 *  在图注吸附之后执行（图注正则 CAPTION_RE 本就含"表"前缀，避免同一段被两处争抢）。 */
function attachTableCaptions(blocks) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b?.type !== "table" || b.caption) continue;
    const nxt = blocks[i + 1];
    if (nxt?.type === "p" && nxt.text.length <= 40 && !nxt.text.includes("\n") && isCaptionText(nxt.text)) {
      b.caption = nxt.text;
      blocks.splice(i + 1, 1);
      continue;
    }
    const prv = i > 0 ? blocks[i - 1] : null;
    if (prv?.type === "p" && prv.text.length <= 40 && !prv.text.includes("\n") && isCaptionText(prv.text)) {
      b.caption = prv.text;
      blocks.splice(i - 1, 1);
      i -= 1;
    }
  }
  return blocks;
}

/** 块内单行高估算（v0.4 字号传递，单位与坐标一致）：
 *  显式多行 → 块高/行数；单行块（块高 ≤ 正文行高×1.6，含标题）→ 块高；
 *  多行正文（换行不可知）→ 正文行高近似。估算不出返回 0（渲染层走预设字号）。 */
function estimateBlockFontUnits(l, bodyLineH) {
  const h = Number(l?.position?.[3]) || 0;
  const text = String(l?.text ?? "");
  if (!(h > 0) || !text) return 0;
  const explicit = text.split(/\r?\n/).length;
  if (explicit > 1) return h / explicit;
  if (h <= (bodyLineH || 0) * 1.6) return h;
  return bodyLineH || 0;
}

/** 页码剥离：页首/页尾的孤立纯数字段（VL 常不标 header/footer，"39"这类页码
 *  不是内容）。先删头再查尾（下标动态取），剥离计数进 stats.strippedPN。
 *  守卫：整页不足 3 块时不剥——孤块数字更可能是表单值/章节号/年份标题而非页码
 *  （markdown 路径的 stripPageNumberLines 用 ≥10 命中做同类守卫，#16）。 */
function stripPageNumberBlocks(blocks) {
  if (blocks.length < 3) return 0;
  let n = 0;
  if (blocks[0]?.type === "p" && /^\d{1,4}[.)]?$/.test(blocks[0].text ?? "")) {
    blocks.splice(0, 1);
    n += 1;
  }
  const last = blocks[blocks.length - 1];
  if (last?.type === "p" && /^\d{1,4}[.)]?$/.test(last.text ?? "")) {
    blocks.splice(blocks.length - 1, 1);
    n += 1;
  }
  return n;
}

/** 版面 JSON → 按页块流（100% 版面还原：页数/页边界/页面方向与原件一致）。
 *  formulaMode：unicode=文本/表格单元格做公式清洗（默认，与 markdown 路径一致）；raw/omml=保留原文。
 *  mergeMode：跨页续表拼接 strict/loose/off（默认 strict）。
 *  页与 image/table 块携带私有元数据（_pageW/_pageH/_pos）供矢量重截与宽松拼接使用，渲染层忽略。
 *  @returns { pages: [{ blocks, isLandscape, header, footer, stats }] } */
export function layoutToPageBlocks(parseJson, { filterHeaderFooter = true, formulaMode = "unicode", mergeCrossPageTables: mergeTables = true, mergeMode = "strict" } = {}) {
  const pages = Array.isArray(parseJson?.pages) ? parseJson.pages : [];
  if (!pages.length) throw new OcrError("E_LAYOUT_EMPTY", "版面 JSON 中没有页数据");
  const clean = (t) => (formulaMode === "unicode" ? cleanMath(t) : t);

  const pageResults = pages.map((page) => {
    const layouts = Array.isArray(page?.layouts) ? [...page.layouts] : [];
    const imagesById = new Map();
    for (const im of page?.images ?? []) {
      if (im?.layout_id && im?.data_url) imagesById.set(im.layout_id, im);
    }
    const tablesById = new Map();
    for (const t of page?.tables ?? []) {
      if (t?.layout_id) tablesById.set(t.layout_id, t);
    }
    const consumedTables = new Set();
    const takeTable = (layoutId) => {
      const hit = layoutId != null ? tablesById.get(layoutId) : null;
      if (hit) {
        consumedTables.add(hit.layout_id);
        return hit;
      }
      // 占位块无/不匹配 layout_id 时，按顺序取未认领的表（同页 table 块与 tables 顺序对应）
      for (const t of tablesById.values()) {
        if (!consumedTables.has(t.layout_id)) {
          consumedTables.add(t.layout_id);
          return t;
        }
      }
      return null;
    };

    // 页眉页脚块先摘出来（不参与正文排序/字号估算）
    const body = [];
    let filteredHF = 0;
    let header = "";
    let footer = "";
    for (const l of layouts) {
      if (HEADER_TYPES.has(l?.type)) {
        if (filterHeaderFooter) {
          filteredHF++;
        } else {
          const text = String(l?.text ?? "").trim();
          if (!String(l?.type ?? "").endsWith("_image")) {
            if (String(l?.type ?? "").startsWith("header") && !header) header = text;
            if (String(l?.type ?? "").startsWith("footer") && !footer) footer = text;
          }
        }
        continue;
      }
      body.push(l);
    }

    const bodyLineH = estimateBodyLineH(body);
    // 页面范围先行计算（v0.4：bbox 归一化需要在块循环里用；口径不变=全部 layouts 含页眉页脚的极值，
    // 与原页尾计算一致，isLandscape 行为不变）。
    // position 须为 4 个有限数值：一个畸形坐标（缺 h 等）会让 Math.max 产出 NaN，
    // 把整页所有块的 bbox 全部打没（fidelity 记 0、复刻层丢页）
    const posOk = (l) =>
      Array.isArray(l?.position) &&
      l.position.length >= 4 &&
      l.position.slice(0, 4).every((v) => Number.isFinite(Number(v)));
    const withPos = layouts.filter(posOk);
    const pageW = Math.max(...withPos.map((l) => l.position[0] + l.position[2]), 0);
    const pageH = Math.max(...withPos.map((l) => l.position[1] + l.position[3]), 0);
    // bbox：0–1000 归一化（content-list/复刻度评分/sandwich PDF 的统一坐标）；无坐标或极端页返回 null
    const bboxOf = (l) => {
      if (!posOk(l) || !(pageW > 0) || !(pageH > 0)) return null;
      const [x, y, w, h] = l.position;
      const r = (v) => Math.max(0, Math.min(1000, Math.round(v)));
      return [r((x / pageW) * 1000), r((y / pageH) * 1000), r(((x + w) / pageW) * 1000), r(((y + h) / pageH) * 1000)];
    };
    const blocks = [];
    let imageCount = 0;
    let strippedPN = 0;
    const unknownTypes = new Set();

    for (const l of orderLayouts(body)) {
      const type = String(l?.type ?? "");
      const text = String(l?.text ?? "").trim();
      const bbox = bboxOf(l);
      const fontUnits = estimateBlockFontUnits(l, bodyLineH);
      const meta = {
        ...(bbox ? { bbox } : {}),
        ...(fontUnits > 0 ? { _fontUnits: fontUnits } : {}),
      };

      if (TITLE_TYPES.has(type)) {
        if (text) blocks.push({ type: titleLevel(l, bodyLineH), text: clean(text), ...meta });
        continue;
      }

      if (type === "image" || type.endsWith("_image")) {
        const im = imagesById.get(l?.layout_id);
        if (im?.data_url) {
          blocks.push({
            type: "image",
            url: im.data_url,
            w: Number(l?.position?.[2]) || null,
            h: Number(l?.position?.[3]) || null,
            ...(Array.isArray(l?.position) ? { _pos: l.position } : {}),
            ...meta,
          });
          imageCount++;
        } else if (text) {
          blocks.push({ type: "p", text: clean(text), ...meta });
        }
        continue;
      }

      if (type === "table" || l?.table_html) {
        const t = takeTable(l?.layout_id);
        // 优先级：matrix+cells（唯一带合并信息的源）> markdown > table_html（layouts 块内实测常为空）
        let built = null;
        if (t) built = buildTableFromCells(t);
        if (!built) {
          if (t?.markdown) built = { rows: mdTableToRows(t.markdown), merges: [] };
          else if (t?.table_html) built = htmlToRows(t.table_html);
          else if (l?.table_html) built = htmlToRows(l.table_html);
        }
        // 有实际文本才算表：防止三个来源（matrix/markdown/table_html）任一解析出全空网格时，
        // 用空表把 text 段落兜底也挤掉（#5 的二道防线）；嵌套格（{nested}）按子表自身内容判
        const cellText = (c) => (c && typeof c === "object" ? String(c.text ?? "") : String(c ?? ""));
        const hasContent = built?.rows?.some((r) =>
          r.some((c) => cellText(c).trim() || (c && typeof c === "object" && c.nested))
        );
        if (hasContent) {
          // 嵌套格保留对象形态（docx 原生嵌套 w:tbl 依赖），仅纯文本格做公式清洗（同 markdown.js）
          const rows =
            formulaMode === "unicode"
              ? built.rows.map((r) => r.map((c) => (c && typeof c === "object" ? c : clean(c))))
              : built.rows;
          blocks.push({
            type: "table",
            rows,
            ...(built.merges?.length ? { merges: built.merges } : {}),
            ...(Array.isArray(l?.position) ? { _pos: l.position } : {}),
            ...meta,
          });
          continue;
        }
        if (text) {
          blocks.push({ type: "p", text: clean(text), ...meta });
          continue;
        }
        continue;
      }

      // text 与未知类型：有文本按段落，纯装饰块跳过并记录
      if (text) {
        blocks.push({ type: "p", text: clean(text), ...meta });
      } else if (type && type !== "text" && type !== "unknown") {
        unknownTypes.add(type);
      }
    }

    // 后处理：图注吸附 → 表注吸附 → 页码剥离（先吸附，避免图注被误当页尾孤立段）
    attachCaptions(blocks);
    attachTableCaptions(blocks);
    strippedPN += stripPageNumberBlocks(blocks);

    return {
      blocks,
      isLandscape: pageW > pageH,
      header,
      footer,
      _pageW: pageW,
      _pageH: pageH,
      stats: { filteredHF, imageCount, strippedPN, unknownTypes: [...unknownTypes] },
    };
  });
  return mergeTables ? mergeCrossPageTables(pageResults, mergeMode) : pageResults;
}

/** 版面 JSON → 全文档块流（多页拼接；兼容旧调用方）。
 *  paraMerge：页边界段落合并（v0.4，默认开）——只拼"前页末块×后页首块"，同页相邻块是
 *  独立版面块绝不互拼；docx 逐页渲染走 layoutToPageBlocks 保持页归属不动。 */
export function layoutToBlocks(parseJson, opts = {}) {
  const pageResults = layoutToPageBlocks(parseJson, opts);
  const flat = [];
  pageResults.forEach((p, i) => {
    const blocks = p.blocks ?? [];
    const prev = flat[flat.length - 1];
    if (i > 0 && opts.paraMerge !== false && prev?.type === "p" && blocks[0]?.type === "p") {
      const joined = mergeAdjacentParagraphBlocks([prev, blocks[0]]);
      if (joined.length === 1) {
        flat[flat.length - 1] = joined[0];
        flat.push(...blocks.slice(1));
        return;
      }
    }
    flat.push(...blocks);
  });
  const blocks = flat;
  const header = pageResults.map((p) => p.header).find((h) => h) ?? "";
  const footer = pageResults.map((p) => p.footer).find((f) => f) ?? "";
  const stats = {
    filteredHF: pageResults.reduce((n, p) => n + p.stats.filteredHF, 0),
    imageCount: pageResults.reduce((n, p) => n + p.stats.imageCount, 0),
    strippedPN: pageResults.reduce((n, p) => n + (p.stats.strippedPN ?? 0), 0),
    unknownTypes: [...new Set(pageResults.flatMap((p) => p.stats.unknownTypes))],
  };
  return { blocks, header, footer, stats };
}

const IMG_TIMEOUT_MS = 30000;
const IMG_MAX_BYTES = 30 * 1024 * 1024; // 单图大小上限，避免异常大图撑爆内存（#pipeline low）

/** 按文件头嗅探图片扩展名（content-type/url 不可信时兜底；webp/gif/bmp 不再被误命名 .jpeg，#pipeline low） */
function sniffImageExt(buf) {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 6).startsWith("GIF8")) return "gif";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  return null;
}

/** 流式读取响应体并夹上限：超过 cap 立即取消读取抛错。
 *  防止坏链/恶意链（或缺 content-length 的大响应）把整包读进内存才被拒（#pipeline low 遗留）。 */
async function readCapped(body, cap) {
  if (!body?.getReader) {
    // 无流式 body（测试 stub / 异常运行时）：整包读 + 读后校验兜底
    const buf = Buffer.from((await body?.arrayBuffer?.()) ?? []);
    if (buf.length > cap) throw new Error(`图片过大（${Math.round(buf.length / 1024 / 1024)}MB）`);
    return buf;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        throw new Error(`图片过大（>${Math.round(cap / 1024 / 1024)}MB，已中断下载）`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  return Buffer.concat(chunks);
}

async function downloadImage(b, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs, 5000));
  try {
    const res = await fetch(b.url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // content-length 预告超限 → 直接拒，一个字节都不落内存
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > IMG_MAX_BYTES) {
      throw new Error(`图片过大（${Math.round(declared / 1024 / 1024)}MB > ${Math.round(IMG_MAX_BYTES / 1024 / 1024)}MB）`);
    }
    const buf = await readCapped(res.body, IMG_MAX_BYTES);
    if (buf.length < 100) throw new Error("图片内容过小");
    if (buf.length > IMG_MAX_BYTES) throw new Error(`图片过大（${Math.round(buf.length / 1024 / 1024)}MB）`);
    const type = res.headers.get("content-type") || "";
    b.data = buf;
    b.ext = sniffImageExt(buf) || (/png/i.test(type) || /\.png/i.test(b.url) ? "png" : "jpeg");
  } finally {
    clearTimeout(timer);
  }
}

/** 下载版面里的图片并填充到块（image.url → data/ext）。并发 6 + 失败重试 1 次；
 *  最终仍失败的图片块剔除（不加占位文字，保持内容纯度）。
 *  @returns 失败张数 */
export async function materializeImages(blocks, { timeoutMs = IMG_TIMEOUT_MS, concurrency = 6 } = {}) {
  const jobs = blocks.filter((b) => b.type === "image" && b.url && !b.data);
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const b = jobs[cursor++];
      try {
        await downloadImage(b, timeoutMs);
      } catch {
        try {
          await new Promise((r) => setTimeout(r, 1000));
          await downloadImage(b, timeoutMs);
        } catch {
          failed += 1;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), jobs.length) }, worker));
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === "image" && !blocks[i].data) blocks.splice(i, 1);
  }
  return failed;
}
