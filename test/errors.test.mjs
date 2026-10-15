// test/errors.test.mjs — 错误码映射与分类
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeBaiduError, isTokenError, isRetryableCode, OcrError } from "../lib/errors.js";

test("已知错误码给出中文说明", () => {
  const s = describeBaiduError(17, "reach daily limit");
  assert.ok(s.includes("每日流量超限"));
  assert.ok(s.includes("17"));
});

test("未知错误码回退原始信息", () => {
  const s = describeBaiduError(999999, "mystery");
  assert.ok(s.includes("mystery"));
  assert.ok(s.includes("999999"));
});

test("VL 文档解析 336xxx 族给中文指引而非未知兜底（#12）", () => {
  const s = describeBaiduError(336501, "task failed");
  assert.ok(s.includes("文档解析（VL）"), s);
  assert.ok(s.includes("336501"), s);
  assert.ok(s.includes("task failed"), s);
  const s2 = describeBaiduError(336200, "");
  assert.ok(s2.includes("文档解析（VL）"), s2);
  // 族外仍走原兜底
  assert.ok(describeBaiduError(337999, "x").includes("百度接口报错"));
});

test("token 类与可重试类分类", () => {
  for (const c of [100, 110, 111]) assert.ok(isTokenError(c), String(c));
  assert.ok(!isTokenError(17));
  for (const c of [1, 2, 18]) assert.ok(isRetryableCode(c), String(c));
  assert.ok(!isRetryableCode(216202));
});

test("OcrError 带 code", () => {
  const e = new OcrError("E_TEST", "msg");
  assert.equal(e.code, "E_TEST");
  assert.equal(e.name, "OcrError");
});
