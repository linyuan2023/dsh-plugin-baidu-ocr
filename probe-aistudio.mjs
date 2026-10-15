// docs/samples/probe-aistudio.mjs — AI Studio PaddleOCR API 探针
// 用法: node probe-aistudio.mjs <API_URL> <AccessToken> <文件路径>
// 作用：真实调用一次，dump 响应完整结构（判定是 OCR 文本行形态还是文档解析 markdown 形态），
//       并用插件适配器跑一遍归一化。
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [url, token, file] = process.argv.slice(2);
if (!url || !token || !file) {
  console.error("用法: node probe-aistudio.mjs <API_URL> <AccessToken> <文件路径>");
  process.exit(1);
}
const buf = readFileSync(file);
const isPdf = /\.pdf$/i.test(file);
const ext = (basename(file).match(/\.([a-z0-9]+)$/i)?.[1] ?? "png").toLowerCase();
const mime = isPdf ? "application/pdf" : ext === "png" ? "image/png" : "image/jpeg";
const payload = { file: `data:${mime};base64,${buf.toString("base64")}`, fileType: isPdf ? 0 : 1 };

const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
console.log("HTTP", res.status);
const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { console.log("非 JSON:", text.slice(0, 400)); process.exit(1); }
console.log("顶层字段:", Object.keys(body));
console.log("errorCode:", body.errorCode, "| errorMsg:", body.errorMsg);
const slim = JSON.parse(JSON.stringify(body));
const cut = (v, d = 0) => {
  if (d > 5 || v == null) return v;
  if (typeof v === "string") return v.length > 60 ? v.slice(0, 60) + `…(${v.length})` : v;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => cut(x, d + 1));
  if (typeof v === "object") { for (const k of Object.keys(v)) v[k] = cut(v[k], d + 1); return v; }
  return v;
};
console.log("结构概览:", JSON.stringify(cut(slim)).slice(0, 900));

const { normalizeAistudioResponse } = await import("../../lib/aistudio.js");
try {
  const r = normalizeAistudioResponse(body);
  console.log("\n适配器归一化: markdown?", r.markdown ? `是(${r.markdown.length}字)` : "否", "| text:", (r.text ?? "").length, "字");
} catch (e) {
  console.log("\n适配器报错:", e.message);
}
