// test/files.test.mjs — 魔数识别、尺寸读取、通道限额校验
import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffKind, imageSize, extOf, checkEncodedSize, checkChannelLimits } from "../lib/files.js";
import { OcrError } from "../lib/errors.js";

function pngBuffer(w, h, totalBytes = 33) {
  // 8 字节签名 + 4 字节长度 + IHDR + 宽高，够 imageSize 读数即可；totalBytes 用于模拟大文件
  const b = Buffer.alloc(Math.max(33, totalBytes));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpegBuffer(w, h) {
  const b = Buffer.alloc(16);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xc0; // SOF0
  b.writeUInt16BE(16, 4); // segment length
  b[6] = 8; // precision
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
}

test("sniffKind：PNG/JPEG/BMP/PDF/zip(docx)", () => {
  assert.equal(sniffKind(pngBuffer(10, 10), ".png").mime, "png");
  assert.equal(sniffKind(jpegBuffer(10, 10), ".jpg").mime, "jpeg");
  const bmp = Buffer.alloc(32);
  bmp.write("BM", 0, "ascii");
  assert.equal(sniffKind(bmp, ".bmp").mime, "bmp");
  const pdf = Buffer.from("%PDF-1.7\n...");
  assert.equal(sniffKind(pdf, ".pdf").kind, "pdf");
  assert.equal(sniffKind(Buffer.from("garbage!"), ".png").kind, "unknown");
});

test("sniffKind：OLE 只认 D0CF11E0 真签名（#17：曾有一个错误的 \"PO^Q`\" 判断）", () => {
  const ole = Buffer.alloc(600);
  ole.set([0xd0, 0xcf, 0x11, 0xe0], 0);
  assert.equal(sniffKind(ole, ".doc").kind, "office_legacy");
  assert.equal(sniffKind(ole, ".ppt").mime, "ppt");
  // "PO^Q`" 不是 OLE 签名——以它开头的普通文件不得被误判成 doc
  const notOle = Buffer.alloc(600);
  notOle.write("PO^Q`abc", 0, "ascii");
  assert.notEqual(sniffKind(notOle, ".doc").kind, "word");
});

test("sniffKind：OOXML 扫描窗 64KB（#17：word/ 条目超过 4KB 的大 docx 不再误判 zip）", () => {
  // PK 头 + 5KB 填充 + "word/document.xml"：旧 4KB 窗口只能看到填充 → 误判 zip
  const big = Buffer.alloc(8192);
  big.set([0x50, 0x4b], 0);
  big.write("word/document.xml", 5120, "ascii");
  assert.equal(sniffKind(big, ".docx").kind, "word");
  const ppt = Buffer.alloc(8192);
  ppt.set([0x50, 0x4b], 0);
  ppt.write("ppt/slides/s1.xml", 5120, "ascii");
  assert.equal(sniffKind(ppt, ".pptx").kind, "ppt");
});

test("imageSize：PNG 与 JPEG（JPEG 附带 EXIF orientation，无 EXIF 为 1）", () => {
  assert.deepEqual(imageSize(pngBuffer(800, 600)), { w: 800, h: 600 });
  assert.deepEqual(imageSize(jpegBuffer(640, 480)), { w: 640, h: 480, orientation: 1 });
});

test("checkEncodedSize：超过 4MB（编码后）报 OcrError", () => {
  // 3.2MB 原始 → 编码后 ~4.27MB，应超限
  const big = Buffer.alloc(3.2 * 1024 * 1024);
  assert.throws(() => checkEncodedSize(big), OcrError);
  // 1MB 原始没问题
  checkEncodedSize(Buffer.alloc(1024 * 1024));
});

test("extOf 小写化", () => {
  assert.equal(extOf("a.BMP"), ".bmp");
  assert.equal(extOf("noext"), "");
});

test("checkChannelLimits：同步 4MB/4096px，VL 放宽到 10MB/8192px", () => {
  // 6MB + 5000px：A 通道先撞大小，VL 通道放行
  const big = { kind: "image", buffer: pngBuffer(5000, 100, 6 * 1048576), dims: { w: 5000, h: 100 } };
  assert.throws(() => checkChannelLimits({ channel: "A" }, big), /4MB/);
  checkChannelLimits({ channel: "B" }, big);
  // 小文件但超 px：A 拦、VL（8192 内）放
  const wide = { kind: "image", buffer: pngBuffer(5000, 100), dims: { w: 5000, h: 100 } };
  assert.throws(() => checkChannelLimits({ channel: "A" }, wide), /4096/);
  checkChannelLimits({ channel: "B" }, wide);
  const edge = { kind: "image", buffer: pngBuffer(8192, 10), dims: { w: 8192, h: 10 } };
  checkChannelLimits({ channel: "B" }, edge);
  const over = { kind: "image", buffer: pngBuffer(8193, 10), dims: { w: 8193, h: 10 } };
  assert.throws(() => checkChannelLimits({ channel: "B" }, over), /8192/);
  // url 输入不设本地限额
  checkChannelLimits({ channel: "A" }, { kind: "url" });
  checkChannelLimits({ channel: "B" }, { kind: "url" });
});

test("checkChannelLimits：VL 流式文档 50MB 上限", () => {
  const doc = { kind: "word", buffer: Buffer.alloc(55 * 1048576) };
  assert.throws(() => checkChannelLimits({ channel: "B" }, doc), /vl 通道 .*限制/);
  const okDoc = { kind: "word", buffer: Buffer.alloc(30 * 1048576) };
  checkChannelLimits({ channel: "B" }, okDoc);
});
