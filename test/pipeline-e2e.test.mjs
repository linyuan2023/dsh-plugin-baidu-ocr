// test/pipeline-e2e.test.mjs — 端到端冒烟：stub fetch（不触网），跑通 A 通道全链路
// 覆盖：文件校验 → auth（token 获取与缓存）→ baidu 同步调用 → md/docx 落盘
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recognize } from "../lib/pipeline.js";

const realFetch = globalThis.fetch;

test("A 通道端到端：png → general → md/docx 落盘", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-e2e-"));
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });
  // token 缓存指到临时目录，不污染 ~/.dsh/ocr/token.json
  process.env.DSH_OCR_TOKEN_FILE = join(dir, "token.json");

  // 造一张真实魔数的 png
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(100, 16);
  png.writeUInt32BE(40, 20);
  const pngPath = join(dir, "样张.png");
  writeFileSync(pngPath, png);

  // stub fetch：oauth 发 token；general_basic 出固定识别词
  let ocrCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/oauth/2.0/token")) {
      return { status: 200, text: async () => JSON.stringify({ access_token: "fake-token-abcdef", expires_in: 2592000 }) };
    }
    if (u.includes("general_basic")) {
      ocrCalls++;
      assert.ok(u.includes("access_token=fake-token-abcdef"), "请求带上了 token");
      return {
        status: 200,
        text: async () => JSON.stringify({ words_result: [{ words: "你好" }, { words: "世界" }], words_result_num: 2, log_id: 42 }),
      };
    }
    throw new Error("unexpected fetch: " + u);
  };

  const cfg = { apiKey: "test-ak", secretKey: "test-sk", requestTimeoutMs: 5000, defaultFormat: "md", saveDir: "" };
  const outDir = join(dir, "out");

  const r = await recognize({ cfg, path: pngPath, engine: "general", format: "md", outDir });
  assert.equal(r.channel, "A");
  assert.equal(r.engine, "general");
  assert.equal(r.chars, 5); // "你好\n世界"
  assert.equal(r.preview, "你好\n世界");
  assert.equal(r.savedFiles.length, 1);
  assert.ok(r.savedFiles[0].endsWith(".md"));
  assert.ok(readFileSync(r.savedFiles[0], "utf8").includes("你好"));
  assert.equal(existsSync(join(dir, "token.json")), true, "token 已缓存");
  assert.equal(ocrCalls, 1);

  // 同一配置再跑 docx：token 应直接命中缓存（oauth 不再被调用 → 不会翻车在严格计数上，只验证产物）
  const r2 = await recognize({ cfg, path: pngPath, engine: "general", format: "docx", outDir });
  assert.ok(r2.savedFiles[0].endsWith(".docx"));
  const docx = readFileSync(r2.savedFiles[0]);
  assert.equal(docx.readUInt32LE(0), 0x04034b50, "docx 以 zip local header 开头");
  assert.ok(docx.length > 1000);
});

test("A 通道：百度 error_code 冒泡为中文 OcrError", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-e2e2-"));
  t.after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.DSH_OCR_TOKEN_FILE = join(dir, "token.json");
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000064000000280806000000", "hex");
  const pngPath = join(dir, "x.png");
  writeFileSync(pngPath, png);

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/oauth/2.0/token")) {
      return { status: 200, text: async () => JSON.stringify({ access_token: "t", expires_in: 100 }) };
    }
    return { status: 200, text: async () => JSON.stringify({ error_code: 17, error_msg: "daily limit" }) };
  };

  const cfg = { apiKey: "ak", secretKey: "sk", requestTimeoutMs: 5000, defaultFormat: "none" };
  await assert.rejects(
    () => recognize({ cfg, path: pngPath, engine: "general", format: "none" }),
    (e) => e.baiduCode === 17 && e.message.includes("每日流量超限")
  );
});
