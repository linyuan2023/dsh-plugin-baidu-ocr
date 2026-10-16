// test/html.test.mjs — HTML/PDF 渲染层：图片 MIME 表（#1）、空页清单防护（#15）
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksToHtml, pagesToPdfFile } from "../lib/html.js";
import { OcrError } from "../lib/errors.js";

test("blocksToHtml：webp/gif/bmp/png 各自正确的 data URL MIME（#1：旧版一律 image/jpeg）", () => {
  const mk = (ext) => [{ type: "image", ext, data: Buffer.from([0x01, 0x02, 0x03]) }];
  assert.ok(blocksToHtml(mk("webp")).includes("data:image/webp;base64,"));
  assert.ok(blocksToHtml(mk("gif")).includes("data:image/gif;base64,"));
  assert.ok(blocksToHtml(mk("bmp")).includes("data:image/bmp;base64,"));
  assert.ok(blocksToHtml(mk("png")).includes("data:image/png;base64,"));
  assert.ok(blocksToHtml(mk("jpeg")).includes("data:image/jpeg;base64,"));
  // 未知/缺失扩展名回落 jpeg（保底不崩）
  assert.ok(blocksToHtml(mk(undefined)).includes("data:image/jpeg;base64,"));
});

test("pagesToPdfFile：空页清单抛错而非产出 0 页 PDF（#15）", () => {
  // pagesToPdfFile 是同步函数：用 throws（rejects 只适用于返回 promise 的函数）
  assert.throws(
    () => pagesToPdfFile([], "C:/tmp/never-written.pdf"),
    (e) => e instanceof OcrError && e.code === "E_PDF_EMPTY"
  );
  assert.throws(
    () => pagesToPdfFile(null, "C:/tmp/never-written.pdf"),
    (e) => e instanceof OcrError && e.code === "E_PDF_EMPTY"
  );
});

test("blocksToHtml：段落 \n 转 <br/>（HTML 会折叠裸换行，目录块行结构须显式标记）", () => {
  const html = blocksToHtml([{ type: "p", text: "初版序言 ..... 1\n再版序言 ..... 2" }]);
  assert.ok(html.includes("初版序言 ..... 1<br/>再版序言 ..... 2"));
  // 标题同口径；转义仍生效（& 不受 <br/> 注入影响）
  const h = blocksToHtml([{ type: "h2", text: "甲\n乙 & 丙" }]);
  assert.ok(h.includes("甲<br/>乙 &amp; 丙"));
});
