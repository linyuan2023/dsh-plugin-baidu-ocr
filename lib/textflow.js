// lib/textflow.js — 跨页/跨块段落合并（v0.4 内容完整性，对标 MinerU 3.1 truncated paragraph merging）
// 原则：保守——拿不准就不拼（漏拼只是少一次修复，误拼会篡改原文）。
// 两个入口：
//   mergeCrossPageParagraphs(parts)      按页/段 markdown 字符串数组拼接（aistudio/segment/pdf-text）
//   mergeAdjacentParagraphBlocks(blocks) 块流相邻 p 块合并（layoutToBlocks 拼接输出路径）
// 判定：行必须是"段落行"（非标题/表格/代码/图片/列表/HTML/引用），且前段末行不以句末标点收尾。

const HEADING_RE = /^#{1,6}\s+/;
const CODE_FENCE_RE = /^\s*```/;
const IMAGE_LINE_RE = /^\s*!\[[^\]]*\]\([^)\s]+\)\s*$/;
const LIST_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
const HTML_RE = /^\s*<[/a-zA-Z]/;
const QUOTE_RE = /^\s*>/;

function isCjkChar(ch) {
  return /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/.test(ch);
}

/** 段落行：非空且不属于任何"阻断形态"（标题/表格行/代码围栏/图片/列表/HTML/引用）。 */
export function isParaLine(line) {
  const s = String(line ?? "");
  if (!s.trim()) return false;
  if (HEADING_RE.test(s) || CODE_FENCE_RE.test(s) || IMAGE_LINE_RE.test(s)) return false;
  if (LIST_RE.test(s) || HTML_RE.test(s) || QUOTE_RE.test(s)) return false;
  if (s.includes("|")) return false; // 表格行/分隔行（沿用 markdown 路径的宽口径，保守防误拼）
  return true;
}

/** 句末判定（保守）：尾字符 ∈ CJK 句读/收尾引括 ∪ 西文 .!? → 句子已完整。
 *  西文句点一律视为句末（"etc." 不与下页拼接）；数字结尾（"3.14"）不是句末可拼。 */
const SENTENCE_END_RE = /[。！？；：…"』」）】〉》.!?\s]$/;
export function endsSentence(line) {
  return SENTENCE_END_RE.test(String(line ?? ""));
}

function lastNonEmptyIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i;
  return -1;
}
function firstNonEmptyIndex(lines) {
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) return i;
  return -1;
}

/** 按页/段字符串数组拼接，页尾无句读段落行与下页首段行拼为一行。
 *  返回 { text, merged }；enabled=false 时与旧 join("\n\n") 行为完全一致（回归开关）。 */
export function mergeCrossPageParagraphs(parts, { enabled = true } = {}) {
  const all = (parts ?? []).map((p) => String(p ?? ""));
  if (!enabled) return { text: all.filter((t) => t.trim()).join("\n\n"), merged: 0 };
  const list = all.filter((t) => t.trim());
  if (list.length < 2) return { text: list.join("\n\n"), merged: 0 };
  let lines = list[0].replace(/\r\n?/g, "\n").split("\n");
  let merged = 0;
  for (let i = 1; i < list.length; i++) {
    const nextLines = list[i].replace(/\r\n?/g, "\n").split("\n");
    const pIdx = lastNonEmptyIndex(lines);
    const nIdx = firstNonEmptyIndex(nextLines);
    const prevLine = pIdx >= 0 ? lines[pIdx] : "";
    const nextLine = nIdx >= 0 ? nextLines[nIdx] : "";
    if (pIdx >= 0 && nIdx >= 0 && isParaLine(prevLine) && isParaLine(nextLine) && !endsSentence(prevLine)) {
      const joiner = isCjkChar(prevLine.slice(-1)) && isCjkChar(nextLine.slice(0, 1)) ? "" : " ";
      lines = lines.slice(0, pIdx + 1);
      lines[pIdx] = prevLine.trimEnd() + joiner + nextLine.trim();
      lines = lines.concat(nextLines.slice(nIdx + 1));
      merged++;
    } else {
      // 不合并：段间补空行分隔（旧行为 join("\n\n") 语义）；连续空行由末尾归一化收敛
      lines = lines.concat(["", ...nextLines]);
    }
  }
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n"), merged };
}

/** 块流相邻 p 块合并（版面拼接输出路径）：前块末行无句读且两块均为段落块 → 拼接文本。
 *  仅服务 md/csv 拼接路径；docx 逐页渲染不经此函数（页归属不动）。 */
export function mergeAdjacentParagraphBlocks(blocks, { enabled = true } = {}) {
  if (!enabled || !Array.isArray(blocks)) return blocks;
  const out = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    const prevText = String(prev?.text ?? "");
    const curText = String(b?.text ?? "");
    if (
      prev?.type === "p" &&
      b?.type === "p" &&
      prevText &&
      curText &&
      isParaLine(prevText.split("\n").pop() ?? "") &&
      isParaLine(curText.split("\n")[0] ?? "") &&
      !endsSentence(prevText.split("\n").pop() ?? "")
    ) {
      const joiner = isCjkChar(prevText.slice(-1)) && isCjkChar(curText.slice(0, 1)) ? "" : " ";
      prev.text = prevText.trimEnd() + joiner + curText.trim();
      continue;
    }
    out.push(b);
  }
  return out;
}
