// test/pipeline.test.mjs — 引擎×文件类型路由矩阵（不触网）
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRoute, resolveSaveDir } from "../lib/pipeline.js";
import { OcrError } from "../lib/errors.js";

test("图片：同步引擎走 A，vl 走 B", () => {
  assert.deepEqual(resolveRoute("general", "image"), { channel: "A", engine: "general", note: "" });
  assert.deepEqual(resolveRoute("handwriting", "image"), { channel: "A", engine: "handwriting", note: "" });
  assert.deepEqual(resolveRoute("vl", "image"), { channel: "B", engine: "vl", note: "" });
});

test("PDF：纯文字走 A（general/accurate），vl 走 B，handwriting 报错", () => {
  assert.deepEqual(resolveRoute("general", "pdf"), { channel: "A", engine: "general", note: "" });
  assert.deepEqual(resolveRoute("accurate", "pdf"), { channel: "A", engine: "accurate", note: "" });
  assert.deepEqual(resolveRoute("vl", "pdf"), { channel: "B", engine: "vl", note: "" });
  assert.throws(() => resolveRoute("handwriting", "pdf"), OcrError);
});

test("PDF 的 doc 引擎自动升格为 vl", () => {
  assert.deepEqual(resolveRoute("doc", "pdf"), { channel: "B", engine: "vl", note: "" });
});

test("Word/PPT：只接受 vl（doc 升格），纯文字引擎报错", () => {
  assert.deepEqual(resolveRoute("vl", "word").channel, "B");
  assert.deepEqual(resolveRoute("doc", "ppt").engine, "vl");
  assert.throws(() => resolveRoute("general", "word"), OcrError);
  assert.throws(() => resolveRoute("accurate", "ppt"), OcrError);
});

test("url：同步引擎走 A，vl 走 B（file_url/fileUrl 分支）", () => {
  assert.deepEqual(resolveRoute("general", "url").channel, "A");
  assert.deepEqual(resolveRoute("vl", "url").channel, "B");
});

test("resolveSaveDir：outDir 优先，其次 exec 工作区，最后源文件目录", () => {
  const cfg = { saveDir: "" };
  assert.equal(resolveSaveDir({ outDir: "D:/tmp", cfg, sourcePath: "D:/a/b.png" }), "D:/tmp");
  assert.equal(
    resolveSaveDir({ cfg, exec: { agent: { workspace: "D:/ws" } }, sourcePath: "D:/a/b.png" }),
    "D:\\ws\\ocr-output"
  );
  assert.equal(resolveSaveDir({ cfg, sourcePath: "D:/a/b.png" }), "D:\\a\\ocr-output");
  cfg.saveDir = "D:/cfgdir";
  assert.equal(resolveSaveDir({ cfg, sourcePath: "D:/a/b.png" }), "D:/cfgdir");
});

test("extractPdfTextLocal：可搜索 PDF 直取文本（pymupdf 生成样例，缺依赖则跳过）", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync("python", ["-c", "import pymupdf; print('ok')"], { encoding: "utf8", timeout: 15000 });
  if (probe.status !== 0) return t.skip("pymupdf 不可用");
  const { extractPdfTextLocal } = await import("../lib/pipeline.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "ocr-pdftext-"));
  const pdf = join(dir, "sample.pdf");
  const gen = spawnSync("python", ["-c", "import pymupdf,sys\nimport pymupdf\n" +
    "d = pymupdf.open()\n" +
    "p = d.new_page()\n" +
    "p.insert_text((72, 100), 'Hello PDF text layer for local extraction test.')\n" +
    "p.insert_text((72, 130), 'Second line with enough content to pass the minimum threshold check.')\n" +
    "d.save(sys.argv[1])", pdf], { encoding: "utf8", timeout: 60000 });
  assert.equal(gen.status, 0, `生成 PDF 失败: ${gen.stderr}`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = extractPdfTextLocal(pdf);
  assert.ok(r, "应提取成功");
  assert.ok(r.pages.length >= 1);
  assert.ok(r.pages.join("").includes("Hello PDF text layer"), "应含插入文本");
});
