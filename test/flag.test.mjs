// test/flag.test.mjs — stripFlag 整 token 匹配（#1/#3）：--doc 不吞 --docx、--md 不吞 --md-assets
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFlag } from "../lib/index.js";

test("stripFlag：--doc 不匹配 --docx（#1）", () => {
  const [hit, next] = stripFlag("--docx --vl", "--doc");
  assert.equal(hit, false, "整 token 匹配：--doc 不应命中 --docx");
  assert.equal(next, "--docx --vl");
});

test("stripFlag：--md 不匹配 --md-assets（#3）", () => {
  const [hit, next] = stripFlag("--md-assets --pdf", "--md");
  assert.equal(hit, false, "整 token 匹配：--md 不应命中 --md-assets");
  assert.equal(next, "--md-assets --pdf");
});

test("stripFlag：命中整 token 后正确剔除", () => {
  const [hit, next] = stripFlag("D:\\doc.pdf --vl --docx", "--docx");
  assert.equal(hit, true);
  assert.equal(next.trim(), "D:\\doc.pdf --vl");
  const [h2, n2] = stripFlag("D:\\论文.pdf --vl --pdf --md-assets", "--md-assets");
  assert.equal(h2, true);
  assert.equal(n2.trim(), "D:\\论文.pdf --vl --pdf");
});
