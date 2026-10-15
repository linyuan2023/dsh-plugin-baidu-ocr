// docs/samples/inspect-page-size.mjs — 零配额诊断：本地现有报文里到底有没有「页尺寸」。
//
// 背景：layout.js 的 bbox 归一化分母优先取「页面矩形」，取不到才回退「内容极值」
// （见 layoutPageSize()）。页尺寸有/无决定了字号换算与复刻/HQ/评分是否精确。
// 本脚本只读本地落盘，不发任何网络请求、不耗云端配额：
//   ~/.dsh/ocr/raw/*.jsonl   AI Studio 原始报文（aistudio.js dumpRawJsonl，最近 10 份）
//   ~/.dsh/ocr/cache/*.json  清洗后的结果（cachePut，含 layoutJson）
//
// 用法：
//   node docs/samples/inspect-page-size.mjs              # 扫描上述两个目录
//   node docs/samples/inspect-page-size.mjs <file...>    # 只查指定文件
//
// 若要验证**百度通道** parse_result_url 的 pages[] 结构（本地通常没有该通道的报文），
// 走 docs/samples/capture-layout.mjs（需 AK/SK、耗 1 次配额）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { dataDir } from "../../lib/auth.js";

const CACHE_DIR = join(dataDir(), "cache");
const RAW_DIR = join(dataDir(), "raw");

function listDir(dir, ext) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext) && !f.includes(".tmp-"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** AI Studio 原始 JSONL：逐页 layoutParsingResults[].prunedResult.{width,height} */
function inspectRawJsonl(file) {
  const text = readFileSync(file, "utf8");
  const pages = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    for (const r of o?.result?.layoutParsingResults ?? []) pages.push(r);
  }
  if (!pages.length) return null; // 非 AI Studio 结构

  const dims = new Map();
  let withBoxes = 0;
  for (const r of pages) {
    const pr = r?.prunedResult ?? r?.pruned_result ?? {};
    const k = `${pr.width}x${pr.height}`;
    dims.set(k, (dims.get(k) ?? 0) + 1);
    if (Array.isArray(pr.parsing_res_list) && pr.parsing_res_list.length) withBoxes++;
  }
  const first = pages[0]?.prunedResult ?? {};
  const sample = Array.isArray(first.parsing_res_list) ? first.parsing_res_list[0] : null;
  return {
    channel: "aistudio",
    pages: pages.length,
    dims,
    withBoxes,
    sampleBox: sample ? { label: sample.block_label, bbox: sample.block_bbox } : null,
  };
}

/** 清洗后的结果缓存：layoutJson.pages[i] 是否带页尺寸字段（百度通道走这条） */
const SIZE_KEYS = ["width", "height", "page_width", "page_height", "pageW", "pageH", "size", "page_size", "pageSize", "rect", "page_rect"];

function inspectCache(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const result = raw?.result ?? raw;
  if (!result || typeof result !== "object") return null;
  const key = file.split(/[\\/]/).pop();
  const channel = key.includes("_aistudio_") ? "aistudio" : key.includes("_baidu_") ? "baidu" : "未知";

  const hasKey = Object.prototype.hasOwnProperty.call(result, "layoutJson");
  const lj = result.layoutJson;
  if (!lj || !Array.isArray(lj.pages) || !lj.pages.length) {
    return { channel, layoutJson: lj === null ? "null" : lj === undefined ? "字段不存在" : "无 pages", pages: 0, hits: null };
  }
  const hits = new Map();
  for (const pg of lj.pages) {
    for (const k of SIZE_KEYS) {
      if (pg && Object.prototype.hasOwnProperty.call(pg, k)) hits.set(k, (hits.get(k) ?? 0) + 1);
    }
  }
  return {
    channel,
    layoutJson: "有效",
    pages: lj.pages.length,
    pageFields: Object.keys(lj.pages[0] ?? {}),
    hits,
  };
}

// ── 主流程 ──
const args = process.argv.slice(2);
const rawFiles = args.length ? args.filter((f) => f.endsWith(".jsonl")) : listDir(RAW_DIR, ".jsonl");
const cacheFiles = args.length ? args.filter((f) => f.endsWith(".json")) : listDir(CACHE_DIR, ".json");

console.log("数据目录:", dataDir());
console.log(`raw/*.jsonl : ${rawFiles.length} 份     cache/*.json : ${cacheFiles.length} 份\n`);

let anyPageSize = false;
let sawBaiduCache = false;

if (rawFiles.length) {
  console.log("── AI Studio 原始报文（raw/*.jsonl） ─────────────────────────");
  for (const f of rawFiles) {
    const info = inspectRawJsonl(f);
    const name = f.split(/[\\/]/).pop();
    if (!info) {
      console.log(`  ${name}  非 AI Studio 结构，跳过`);
      continue;
    }
    const dimLine = [...info.dims].map(([d, n]) => `${d}×${n}页`).join("  ");
    const ok = info.dims.size > 0 && ![...info.dims.keys()].some((k) => k.startsWith("undefined"));
    if (ok) anyPageSize = true;
    console.log(`  ${name}`);
    console.log(`    页数=${info.pages}  页尺寸: ${dimLine}${info.dims.size > 1 ? "（逐页不同 → 真实页几何）" : ""}`);
    console.log(`    带块级坐标的页数=${info.withBoxes}/${info.pages}${info.sampleBox ? `  样例: ${info.sampleBox.label} bbox=${JSON.stringify(info.sampleBox.bbox)}` : ""}`);
  }
  console.log("");
}

if (cacheFiles.length) {
  console.log("── 清洗后的结果缓存（cache/*.json） ──────────────────────────");
  for (const f of cacheFiles) {
    const info = inspectCache(f);
    const name = f.split(/[\\/]/).pop();
    if (!info) continue;
    if (info.channel === "baidu") sawBaiduCache = true;
    if (!info.pages) {
      console.log(`  ${name}\n    渠道=${info.channel}  layoutJson=${info.layoutJson} → 无版面数据`);
      continue;
    }
    console.log(`  ${name}\n    渠道=${info.channel}  layoutJson 有效，pages=${info.pages}`);
    console.log(`    pages[0] 字段: [${(info.pageFields ?? []).join(", ")}]`);
    console.log(`    页尺寸字段命中: ${info.hits.size ? [...info.hits].map(([k, n]) => `${k}×${n}`).join(", ") : "无"}`);
  }
  console.log("");
}

console.log("── 结论 ────────────────────────────────────────────────────");
if (anyPageSize) {
  console.log("  ✅ AI Studio 通道：页尺寸**存在**，位于 result.layoutParsingResults[].prunedResult.{width,height}。");
  console.log("     已由 aistudio.js::parseJsonlPages 映射进 layoutJson.pages[].width/height → _base=\"page\"。");
} else {
  console.log("  ⚠️ 本地 raw 中未发现页尺寸字段。");
}
if (!sawBaiduCache) {
  console.log("  ℹ️ 本地没有百度通道（provider=baidu）的 vl 缓存 → 「parse_result_url 的 pages[i] 是否带");
  console.log("     width/height」**无法用本地数据回答**。需跑一次：node docs/samples/capture-layout.mjs <pdf> <out.json>");
}
