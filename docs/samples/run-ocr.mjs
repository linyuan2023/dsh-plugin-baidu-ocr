// 驱动脚本：脱离 DSH 直接调用插件管线（与 /ocr 命令同一代码路径）
// 用法: node run-ocr.mjs <图片路径> <engine> <format> [outDir]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { recognize } from "../../lib/pipeline.js";

const [img, engine, format, outDir] = process.argv.slice(2);
const fileCfg = JSON.parse(readFileSync(join(homedir(), ".dsh", "ocr", "config.json"), "utf8"));
const cfg = {
  ...fileCfg, // 全字段透传（provider/aistudioUrl/aistudioToken/keepHeaderFooter 等）
  requestTimeoutMs: 30000,
  vlPollTimeoutMs: 320000,
  defaultFormat: "md",
  saveDir: outDir || ".",
};
try {
  const r = await recognize({ cfg, path: img, engine, format, outDir });
  console.log("=== RESULT ===");
  console.log(JSON.stringify({ engine: r.engine, channel: r.channel, chars: r.chars, saved: r.savedFiles, taskId: r.taskId, note: r.note }, null, 1));
  console.log("=== PREVIEW(前400字) ===");
  console.log(r.preview.slice(0, 400));
} catch (e) {
  console.error("=== ERROR ===");
  console.error(`[${e.code ?? "?"}] ${e.message}`);
  process.exit(1);
}
