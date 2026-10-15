// test/http-api.test.mjs — /ocr/api/settings GET/POST 处理器（打码回显、打码不覆盖、__CLEAR__ 清除）
// 环境隔离：DSH_OCR_TOKEN_FILE 指到临时目录（index.js 的 CONFIG_FILE 由此派生），
// 密钥走环境变量——绝不触碰真实 ~/.dsh/ocr/config.json，也不发真实网络请求（不测 ping）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("settings API：GET 打码回显 / POST 打码不覆盖 / __CLEAR__ 清除", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-http-"));
  const prev = { TF: process.env.DSH_OCR_TOKEN_FILE, AK: process.env.BAIDU_OCR_API_KEY, SK: process.env.BAIDU_OCR_SECRET_KEY };
  process.env.DSH_OCR_TOKEN_FILE = join(dir, "token.json");
  process.env.BAIDU_OCR_API_KEY = "test-apikey-1234567890";
  process.env.BAIDU_OCR_SECRET_KEY = "test-secretkey-1234567890";
  t.after(() => {
    if (prev.TF === undefined) delete process.env.DSH_OCR_TOKEN_FILE; else process.env.DSH_OCR_TOKEN_FILE = prev.TF;
    if (prev.AK === undefined) delete process.env.BAIDU_OCR_API_KEY; else process.env.BAIDU_OCR_API_KEY = prev.AK;
    if (prev.SK === undefined) delete process.env.BAIDU_OCR_SECRET_KEY; else process.env.BAIDU_OCR_SECRET_KEY = prev.SK;
    rmSync(dir, { recursive: true, force: true });
  });

  const m = await import("../lib/index.js");
  const routes = {};
  // 注意：不提供 settings 服务 → 走 config.json 兜底模式（saveConfig 真正落盘，才能断言文件内容）
  m.apply({
    tools: { register: () => {} },
    commands: { register: () => {} },
    webServer: { register: (r) => { routes[r.path] = r.handler; } },
  });
  assert.ok(routes["/ocr/api/settings"], "settings 路由已注册");

  const mockRes = () => {
    const state = { code: 0, body: "" };
    return {
      state,
      res: {
        writeHead(c) { state.code = c; },
        end(b) { state.body = b == null ? "" : String(b); },
      },
    };
  };
  const bodyReq = (obj) => ({
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(obj));
    },
  });

  // 1) GET：env 密钥打码回显，绝不出现明文
  let r = mockRes();
  await routes["/ocr/api/settings"]({ method: "GET" }, r.res);
  assert.equal(r.state.code, 200);
  const cfg = JSON.parse(r.state.body).config;
  assert.equal(cfg.hasApiKey, true);
  assert.ok(cfg.apiKey.startsWith("****"), `回显应打码: ${cfg.apiKey}`);
  assert.ok(!cfg.apiKey.includes("1234567890"), "不能明文回显");

  // 2) POST 带打码值 → 视为"保持不变"，不写明文进 config.json
  r = mockRes();
  await routes["/ocr/api/settings"]({ method: "POST", ...bodyReq({ apiKey: "****9999", secretKey: "****9999" }) }, r.res);
  assert.equal(r.state.code, 200);
  const cfgFile = join(dir, "config.json");
  assert.ok(existsSync(cfgFile), "config.json 已写出");
  const saved1 = JSON.parse(readFileSync(cfgFile, "utf8"));
  assert.ok(!saved1.apiKey, "打码值不得落盘为密钥");

  // 3) POST __CLEAR__ → 密钥清空落盘
  r = mockRes();
  await routes["/ocr/api/settings"]({ method: "POST", ...bodyReq({ apiKey: "__CLEAR__", secretKey: "__CLEAR__" }) }, r.res);
  assert.equal(r.state.code, 200);
  const saved2 = JSON.parse(readFileSync(cfgFile, "utf8"));
  assert.equal(saved2.apiKey, "");
  assert.equal(saved2.secretKey, "");

  // 4) POST 明文新密钥 → 正常落盘
  r = mockRes();
  await routes["/ocr/api/settings"]({ method: "POST", ...bodyReq({ apiKey: "new-plain-key-abcdef" }) }, r.res);
  assert.equal(r.state.code, 200);
  const saved3 = JSON.parse(readFileSync(cfgFile, "utf8"));
  assert.equal(saved3.apiKey, "new-plain-key-abcdef");
  assert.equal(saved3.secretKey, "", "上一步的清空不被覆盖");

  // 5) requestTimeoutMs 上下限夹取（此前只校验 >0，可写入 999999999 这类失去超时保护的值）
  r = mockRes();
  await routes["/ocr/api/settings"]({ method: "POST", ...bodyReq({ requestTimeoutMs: 999999999 }) }, r.res);
  assert.equal(r.state.code, 200);
  assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).requestTimeoutMs, 120000, "超上限夹到 120s");

  r = mockRes();
  await routes["/ocr/api/settings"]({ method: "POST", ...bodyReq({ requestTimeoutMs: 100 }) }, r.res);
  assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).requestTimeoutMs, 5000, "低于下限夹到 5s");

  r = mockRes();
  await routes["/ocr/api/settings"]({ method: "POST", ...bodyReq({ requestTimeoutMs: 60000 }) }, r.res);
  assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).requestTimeoutMs, 60000, "区间内原样保留");
});
