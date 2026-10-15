// docs/samples/capture-layout.mjs — 一次性采集真实版面 JSON（golden fixture 素材，耗少量云端配额）。
// 用法：node docs/samples/capture-layout.mjs <本地PDF> <输出.json> [AK] [SK]
//   AK/SK 缺省读配置/环境变量（BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY）。
// 提交整个 PDF（vl 异步任务），取回 parse_result_url 的版面 JSON 原样落盘——之后回归零配额。
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { loadInputFile } from "../../lib/files.js";
import { vlDocParse, pollVlUntilDone } from "../../lib/baidu.js";

const [, , pdfPath, outPath, ak, sk] = process.argv;
if (!pdfPath || !outPath) {
  console.error("用法：node docs/samples/capture-layout.mjs <本地PDF> <输出.json> [AK] [SK]");
  process.exit(1);
}
const cfg = { apiKey: ak || process.env.BAIDU_OCR_API_KEY || "", secretKey: sk || process.env.BAIDU_OCR_SECRET_KEY || "" };
if (!cfg.apiKey || !cfg.secretKey) {
  console.error("缺少 AK/SK（参数或环境变量 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY）");
  process.exit(1);
}
const input = loadInputFile(pdfPath, {});
if (input.kind !== "pdf") {
  console.error("仅支持 PDF（fixtures 素材场景）");
  process.exit(1);
}
const submitted = await vlDocParse(cfg, {
  pdfBase64: input.buffer.toString("base64"),
  ext: input.ext,
  fileName: basename(pdfPath),
  sourcePath: pdfPath,
  bytes: input.size,
}, { onProgress: (t) => console.log(t) });
console.log("任务已提交：", submitted.taskId);
const result = await pollVlUntilDone(cfg, submitted.taskId, { onProgress: (t) => console.log(t) });
if (!result.layoutJson) {
  console.error("未取到版面 JSON（parse_result_url 拉取失败）");
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify(result.layoutJson, null, 1), "utf8");
console.log("已保存版面 JSON：", outPath, `（${result.layoutJson.pages?.length ?? 0} 页）`);
console.log("提示：入库前按 test/fixtures/README.md 的脱敏规范处理；图片 data_url 可替换为 1x1 占位。");
