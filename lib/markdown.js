// lib/markdown.js — 归一化块结构 ⇄ markdown/docx 的桥
// 块结构（内部中间表示）：
//   { type:'h1'|'h2'|'h3', text } | { type:'p', text } | { type:'code', lines:[...] } | { type:'table', rows:[[...]] }
// 内联标记（**、`、[]()）在进 docx 时剥离为纯文本；进 markdown 时保持原样。
// formulaMode：unicode=公式 LaTeX 清洗为可读文本（默认）；raw/omml=保留 LaTeX 源（omml 在 docx 渲染时转 OMML）。

import { htmlToRows, cellFlatText } from "./layout.js";
import { cleanMath } from "./math.js";

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const CODE_FENCE_RE = /^\s*```(.*)$/;
const TABLE_SEP_RE = /^\s*\|?[\s:\-|]+\|?\s*$/;

function isCjkChar(ch) {
  return /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/.test(ch);
}

/** 表格分隔行：--- | --- （容忍无首尾竖线，但必须同时含 - 和 |，纯水平线不算） */
function isTableSeparator(line) {
  return TABLE_SEP_RE.test(line) && line.includes("-") && line.includes("|");
}

/** 表格数据行：含竖线的非空行且本身不是分隔行（GFM 容忍缺首尾竖线） */
function isTableRow(line) {
  const s = line.trim();
  return s !== "" && s.includes("|") && !isTableSeparator(line);
}

/** 解析单元格行：| a | b | → [a, b]（容忍缺首尾竖线；\| 转义不拆列） */
function parseTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (/(?<!\\)\|$/.test(s)) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** markdown → 块数组。表格要求表头行+分隔行；代码块要求成对 ``` 围栏。 */
export function markdownToBlocks(md, { formulaMode = "unicode" } = {}) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let i = 0;
  const clean = (t) => (formulaMode === "unicode" ? cleanMath(t) : t);

  // 内嵌 HTML 表格（AI Studio/PaddleOCR markdown 的表格是内嵌 HTML）→ table 块
  const pushHtmlTable = (html) => {
    const h = htmlToRows(html);
    if (!h.rows.length) return;
    // 嵌套格（{nested}）保留对象形态（docx 原生嵌套）；纯文本格做公式清洗
    const rows = h.rows.map((r) => r.map((c) => (c && typeof c === "object" ? c : clean(c))));
    blocks.push({ type: "table", rows, ...(h.merges.length ? { merges: h.merges } : {}) });
  };
  const flushHtmlTable = () => {
    // 收集 <table ...> 到 </table> 的全部行 → rows（layout.js 的 htmlToRows 支持 rowspan/colspan）
    let html = "";
    while (i < lines.length) {
      html += lines[i];
      i++;
      if (/<\/table>/i.test(lines[i - 1])) break;
    }
    pushHtmlTable(html);
  };
  // <html>/<body> 包裹的表格输出（部分 PP-Structure 版本）：只提取其中的 <table> 块
  const flushHtmlDoc = () => {
    let doc = "";
    while (i < lines.length) {
      doc += lines[i] + "\n";
      i++;
      if (/<\/html>/i.test(lines[i - 1])) break;
    }
    for (const m of doc.matchAll(/<table[\s>][\s\S]*?<\/table>/gi)) pushHtmlTable(m[0]);
  };

  const flushPara = () => {
    if (!para.length) return;
    // md 软换行合并为一段；CJK 相邻不加空格，西文相邻加空格
    let text = para[0];
    for (let k = 1; k < para.length; k++) {
      const joiner = isCjkChar(text.slice(-1)) && isCjkChar(para[k].slice(0, 1)) ? "" : " ";
      text += joiner + para[k];
    }
    blocks.push({ type: "p", text: clean(text) });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = CODE_FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const codeLines = [];
      i++;
      while (i < lines.length && !CODE_FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾围栏（或越界）
      blocks.push({ type: "code", lines: codeLines });
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      flushPara();
      const level = Math.min(h[1].length, 3);
      blocks.push({ type: `h${level}`, text: clean(stripInline(h[2])) });
      i++;
      continue;
    }

    // 独立图片行：![alt](url) → image 块（url 供 docx 嵌入 / md 内联）
    const imgLine = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line.trim());
    if (imgLine) {
      flushPara();
      blocks.push({ type: "image", url: imgLine[2] });
      i++;
      continue;
    }

    // HTML 表格块（AI Studio/PaddleOCR markdown 的表格是内嵌 HTML）→ table 块
    if (/^<table[\s>]/i.test(line.trim())) {
      flushPara();
      flushHtmlTable();
      continue;
    }

    // <html>/<body> 包裹的表格文档（部分 PP-Structure 版本）→ 提取其中全部表格
    if (/^<html[\s>]|^<body[\s>]/i.test(line.trim())) {
      flushPara();
      flushHtmlDoc();
      continue;
    }

    // div 包装块（AI Studio 表格标题/残留，可跨行）：<div...>...</div> → 剥壳为文本
    if (/^<div/i.test(line.trim())) {
      let html = line;
      while (!/<\/div>/i.test(html) && i + 1 < lines.length) {
        i++;
        html += "\n" + lines[i];
      }
      html = html.trim();
      if (/<table/i.test(html)) {
        flushPara();
        pushHtmlTable(html);
      } else {
        const inner = html.replace(/^<div[^>]*>/i, "").replace(/<\/div>$/i, "").trim();
        const HTML_ENT2 = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
        const plain = inner
          .replace(/<[^>]+>/g, "")
          .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m2, e2) => HTML_ENT2[e2] ?? m2);
        if (plain) para.push(plain);
      }
      i++;
      continue;
    }

    // md 表格：当前行是数据行且下一行是分隔行（容忍缺首尾竖线）
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const rows = [parseTableRow(line)];
      i += 2; // 跳过表头与分隔行
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      const width = Math.max(...rows.map((r) => r.length));
      blocks.push({
        type: "table",
        rows: rows.map((r) => {
          const padded = r.length < width ? [...r, ...Array(width - r.length).fill("")] : r;
          return padded.map((c) => (c && typeof c === "object" ? c : clean(c)));
        }),
      });
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

/** 剥离内联标记：加粗（**与__）、行内代码、链接文字化；保留其余纯文本。
 *  下划线强调按 CommonMark 词边界判定：词内 _ 不是强调（snake_case/max_size 原样保留），
 *  星号强调按规范允许词内。 */
export function stripInline(s) {
  let out = String(s ?? "");
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "$1");
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1");
  out = out.replace(/\*(?=\S)([\s\S]*?\S)\*/g, "$1");
  out = out.replace(/(?<![A-Za-z0-9_\p{L}\p{N}])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_\p{L}\p{N}])/gu, "$1");
  out = out.replace(/(?<![A-Za-z0-9_\p{L}\p{N}])_(?=\S)([\s\S]*?\S)_(?![A-Za-z0-9_\p{L}\p{N}])/gu, "$1");
  out = out.replace(/`([^`]*)`/g, "$1");
  return out.replace(/\s{2,}$/g, "");
}

/** 块数组 → markdown。image 块内联为 ![](url)（docx 走嵌入，md 引用 30 天直链）。 */
export function blocksToMarkdown(blocks) {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "h1":
          return `# ${b.text}`;
        case "h2":
          return `## ${b.text}`;
        case "h3":
          return `### ${b.text}`;
        case "code":
          return "```\n" + (b.lines ?? []).join("\n") + "\n```";
        case "image":
          return b.url ? `![${b.caption ?? "image"}](${b.url})` : "";
        case "table": {
          const rows = b.rows ?? [];
          if (!rows.length) return "";
          const width = Math.max(...rows.map((r) => r.length));
          // 单元格内换行压成空格（md 表格语法要求）；单元格里的 | 转义为 \|，
          // 否则再解析时列数会错（README 声明的 \| 转义能力在导出侧也得兑现，#9）；
          // 嵌套格摊平（md 无法表达嵌套，docx 保留，摊平文本不丢内容）
          const clean = (c) => cellFlatText(c).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
          const pad = (r) => [...r, ...Array(width - r.length).fill("")].map(clean);
          const head = pad(rows[0]);
          const sep = Array.from({ length: width }, () => "---");
          const rest = rows.slice(1).map(pad);
          const tbl = [head, sep, ...rest].map((r) => `| ${r.join(" | ")} |`).join("\n");
          // 表注（v0.4）：吸附的 caption 作为表格前的独立行（纯原文，不加修饰）
          return b.caption ? `${b.caption}\n\n${tbl}` : tbl;
        }
        default:
          return b.text ?? "";
      }
    })
    .filter((s) => s !== "")
    .join("\n\n");
}

/** 提取块中所有表格（供 csv 导出） */
export function extractTables(blocks) {
  return blocks.filter((b) => b.type === "table").map((b) => b.rows ?? []);
}

/** 页码行剥离（markdown 路径的页码处理，与版面路径的 stripPageNumberBlocks 对应）：
 *  markdown 里每页一个孤立纯数字行（"39"）。防误伤：全文孤立数字行 ≥10 个才认定是
 *  页码模式整体剥离（少量孤立数字可能是正文），返回 { text, removed }。 */
export function stripPageNumberLines(md, { min = 10 } = {}) {
  const text = String(md ?? "");
  if (!text) return { text, removed: 0 };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const hits = [];
  lines.forEach((l, i) => {
    if (/^\d{1,4}[.)]?$/.test(l.trim())) hits.push(i);
  });
  if (hits.length < min) return { text, removed: 0 };
  for (const i of hits) lines[i] = "";
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n"), removed: hits.length };
}
