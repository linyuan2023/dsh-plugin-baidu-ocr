// docs/samples/cmd-e2e.mjs — 真实 /ocr 命令处理器端到端测试（假 ctx，含 --dir 批量）
// 自包含：现场造一张合法魔数 png（IHDR 100x40，过 files.js 最短边 ≥15px 校验），不依赖任何历史缓存路径。
// 注意：会真实调用百度云端（走 ~/.dsh/ocr/config.json 或环境变量里的 AK/SK）。
// 合成 PNG 只有文件头、不是可解码图像，真实后端会以 error_code=216201「图片格式错误」拒掉——
// 这正好验证了"解析→路由→调用→错误中文化"全链路；要看成功落盘，把 img 换成一张真实截图再跑。
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const m = await import("../../lib/index.js");
let cmd = null, tool = null;
const scope = { get() { return null }, update: async () => {} };
m.apply({
  settings: { register: () => scope },
  tools: { register: (t) => { if (t.name === "ocr_recognize") tool = t; } },
  commands: { register: (c) => { if (c.name === "ocr") cmd = c; } },
  webServer: { register: () => {} },
});
console.log("注册完成 tool+cmd:", Boolean(tool && cmd));

const dir = mkdtempSync(join(tmpdir(), "ocr-cmd-e2e-"));
const out = join(dirname(fileURLToPath(import.meta.url)), "cmd-e2e-out");
mkdirSync(out, { recursive: true });

// 现场造 png（同 test/pipeline-e2e.test.mjs 构造）
const pngBuf = Buffer.alloc(33);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngBuf, 0);
pngBuf.writeUInt32BE(13, 8);
pngBuf.write("IHDR", 12, "ascii");
pngBuf.writeUInt32BE(100, 16);
pngBuf.writeUInt32BE(40, 20);
const img = join(dir, "样张.png");
writeFileSync(img, pngBuf);
const dirInput = join(dir, "batch");
mkdirSync(dirInput, { recursive: true });
writeFileSync(join(dirInput, "a.png"), pngBuf);
writeFileSync(join(dirInput, "b.png"), pngBuf);

// 1) 单文件
const r1 = await cmd.handler({ rawInput: `${img} --txt --out ${out}` });
console.log("--- 单文件 ---");
console.log(r1.kind, "|", (r1.text || "").split("\n")[0].slice(0, 80));

// 2) --dir 批量
const r2 = await cmd.handler({ rawInput: `${dirInput} --dir --txt --out ${out}` });
console.log("--- --dir 批量 ---");
console.log((r2.text || "").slice(0, 400));

// 3) 空输入 → 用法提示
const r3 = await cmd.handler({ rawInput: "" });
console.log("--- 空输入 ---", r3.kind, "|", (r3.text || "").slice(0, 40));

console.log("--- 产物清单 ---");
console.log(readdirSync(out).join("\n"));
rmSync(dir, { recursive: true, force: true });
