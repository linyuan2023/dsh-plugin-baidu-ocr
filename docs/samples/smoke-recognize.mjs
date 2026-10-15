// ⚠ 手动冒烟脚本（打真实云端、耗配额）：不会被 npm test 自动发现。
// 用法：node docs/samples/smoke-recognize.mjs <文件绝对路径> [engine] [format] [outDir]
// 配置读取 ~/.dsh/ocr/config.json（与 DSH 设置面板同源）。
import { recognize } from "../../lib/pipeline.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("用法: node smoke-recognize.mjs <文件绝对路径> [engine] [format] [outDir]");
  process.exit(1);
}
const engine = process.argv[3] || "vl";
const format = process.argv[4] || "docx";
const outDir = process.argv[5];

const cfg = JSON.parse(readFileSync(join(homedir(), ".dsh", "ocr", "config.json"), "utf8"));

console.log(`Starting OCR: engine=${engine} format=${format} path=${target}`);
const r = await recognize({ cfg, path: target, engine, format, outDir });
console.log("Keys:", Object.keys(r));
console.log("chars:", r.chars);
console.log("pages:", r.pages);
console.log("savedFiles:", r.savedFiles);
console.log("preview length:", (r.preview || "").length);
console.log("taskId:", r.taskId);
console.log("engine:", r.engine);
console.log("channel:", r.channel);
console.log("NOTE:", r.note);
