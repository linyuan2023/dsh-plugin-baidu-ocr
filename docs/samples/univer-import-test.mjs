// Univer 导入保真度测试：手写最小 OOXML docx / gongwen 产物 → exchange-node-binding → Univer 快照
// 已确认参数：{"format":"docx","unitType":"doc","fileName":"x.docx"}（unitType ∈ sheet|base|doc|slide）
// 正文位置：snap.metadata[kind="doc"].data(JSON) → document.body.dataStream（\r 分段）
// 用法: node univer-import-test.mjs <docx 路径...>，随后跟要探测的内容关键词
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const profileNM = join(process.env.USERPROFILE || process.env.HOME, ".dsh", "profiles", "web", "node_modules");
const req = createRequire(join(profileNM, "noop.js"));
const binding = req("@univerjs-pro/exchange-node-binding");

const args = process.argv.slice(2);
const splitAt = args.indexOf("--");
const files = splitAt === -1 ? args : args.slice(0, splitAt);
const probes = splitAt === -1
  ? ["摘要", "关键词", "中国政法大学"]
  : args.slice(splitAt + 1);

for (const file of files) {
  const buf = readFileSync(file);
  console.log(`\n===== ${file} (${buf.length} 字节) =====`);
  const snap = await binding.exchangeImportToSnapshot(buf, '{"format":"docx","unitType":"doc","fileName":"test.docx"}');
  console.log("导入成功 | metadata:", snap.metadata.map((m) => m.kind).join(","), "| sheetBlocks:", snap.sheetBlocks.length);
  const docMeta = snap.metadata.find((m) => m.kind === "doc");
  if (!docMeta) { console.log("❌ 无 doc 元数据"); continue; }
  const j = JSON.parse(docMeta.data.toString("utf8"));
  const stream = j.document?.body?.dataStream ?? j.body?.dataStream ?? "";
  console.log("dataStream 字符数:", stream.length, "| 段落数:", stream.split("\r").length);
  for (const probe of probes) {
    console.log(`  含"${probe}":`, stream.includes(probe) ? "✅" : "❌");
  }
  if (!stream) console.log("body JSON 前600:", JSON.stringify(j.document?.body ?? j).slice(0, 600));
}
