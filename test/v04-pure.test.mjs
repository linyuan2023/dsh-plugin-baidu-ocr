// test/v04-pure.test.mjs — v0.4 纯函数与新模块单测：
// textflow 段落合并 / thinPdfPages / resolveTier / EXIF 解析 / docmodel·content-list / libstore
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 数据目录隔离（沿 tasks 测试的同款模式：DSH_OCR_TOKEN_FILE 决定 dataDir 根）
const ISOLATED = mkdtempSync(join(tmpdir(), "ocr-v04-"));
process.env.DSH_OCR_TOKEN_FILE = join(ISOLATED, "token.json");

const { mergeCrossPageParagraphs, mergeAdjacentParagraphBlocks, isParaLine, endsSentence } = await import("../lib/textflow.js");
const { thinPdfPages, resolveTier } = await import("../lib/pipeline.js");
const { readJpegExifOrientation } = await import("../lib/files.js");
const { layoutToDocModel, blocksToDocModel, docModelToContentList } = await import("../lib/docmodel.js");
const { cellFlatText } = await import("../lib/layout.js");
const { recordLib, listLib, findLib } = await import("../lib/libstore.js");

describe("textflow：跨页段落合并", () => {
  test("页尾无句读 CJK + 页首段落 → 直连合并", () => {
    const r = mergeCrossPageParagraphs(["本工程采用明挖法施工", "基坑深度约五米。"], {});
    assert.equal(r.text, "本工程采用明挖法施工基坑深度约五米。");
    assert.equal(r.merged, 1);
  });
  test("页尾句号 → 不合并", () => {
    const r = mergeCrossPageParagraphs(["本工程已完成。", "下页内容"], {});
    assert.equal(r.text, "本工程已完成。\n\n下页内容");
    assert.equal(r.merged, 0);
  });
  test("页尾冒号（保守句读表）→ 不合并", () => {
    const r = mergeCrossPageParagraphs(["主要内容如下：", "第一项内容"], {});
    assert.equal(r.merged, 0);
  });
  test("页尾表格行阻断", () => {
    const r = mergeCrossPageParagraphs(["| a | b |", "下页内容"], {});
    assert.equal(r.merged, 0);
  });
  test("页尾标题阻断", () => {
    const r = mergeCrossPageParagraphs(["## 第二章", "正文开始"], {});
    assert.equal(r.merged, 0);
  });
  test("页首标题阻断", () => {
    const r = mergeCrossPageParagraphs(["他说到这里", "## 第二章"], {});
    assert.equal(r.merged, 0);
  });
  test("页首列表阻断", () => {
    const r = mergeCrossPageParagraphs(["他说到这里", "- 第一条"], {});
    assert.equal(r.merged, 0);
  });
  test("页尾未闭合代码围栏阻断", () => {
    const r = mergeCrossPageParagraphs(["```js", "const a = 1;"], {});
    assert.equal(r.merged, 0);
  });
  test("西文合并补空格", () => {
    const r = mergeCrossPageParagraphs(["The quick brown fox", "jumps over the dog."], {});
    assert.equal(r.text, "The quick brown fox jumps over the dog.");
  });
  test("数字结尾（3.14）不是句末可拼", () => {
    const r = mergeCrossPageParagraphs(["圆周率取", "3.14 计算。"], {});
    assert.equal(r.text, "圆周率取 3.14 计算。");
    assert.equal(r.merged, 1);
  });
  test("页尾图片行阻断", () => {
    const r = mergeCrossPageParagraphs(["![图](http://x/y.png)", "下页"], {});
    assert.equal(r.merged, 0);
  });
  test("enabled=false 完全等价旧 join", () => {
    const parts = ["第一段", "第二段。"];
    assert.equal(mergeCrossPageParagraphs(parts, { enabled: false }).text, parts.join("\n\n"));
    assert.equal(mergeCrossPageParagraphs(parts, { enabled: false }).merged, 0);
  });
  test("三段链式合并", () => {
    const r = mergeCrossPageParagraphs(["一", "二", "三。"], {});
    assert.equal(r.text, "一二三。");
    assert.equal(r.merged, 2);
  });
  test("块流相邻合并：仅无句读段落块拼接", () => {
    const out = mergeAdjacentParagraphBlocks([
      { type: "p", text: "前半句没有结束" },
      { type: "p", text: "后半句结束了。" },
      { type: "p", text: "另一段。" },
    ]);
    assert.deepEqual(out.map((b) => b.text), ["前半句没有结束后半句结束了。", "另一段。"]);
  });
});

describe("thinPdfPages / resolveTier", () => {
  test("thinPdfPages：混合/全 rich/全 thin/自定义 minChars", () => {
    assert.deepEqual(thinPdfPages(["一段比较长的正文内容，超过一百字才不算薄页。".repeat(5), "短", "  "]), [2, 3]);
    assert.deepEqual(thinPdfPages(["很长".repeat(100)]), []);
    assert.deepEqual(thinPdfPages(["", " "]), [1, 2]);
    assert.deepEqual(thinPdfPages(["ab", "abcdefgh"], { minChars: 5 }), [1]);
    assert.deepEqual(thinPdfPages(null), []);
  });
  test("resolveTier：档位映射；auto/非法为空", () => {
    assert.deepEqual(resolveTier("flash", "pdf"), { engine: "general" });
    assert.deepEqual(resolveTier("basic", "image"), { engine: "accurate" });
    assert.deepEqual(resolveTier("standard", "pdf"), { engine: "vl" });
    assert.deepEqual(resolveTier("advanced", "pdf"), { engine: "vl", format: "docx", hqForce: true });
    assert.deepEqual(resolveTier("auto", "pdf"), {});
    assert.deepEqual(resolveTier("turbo", "pdf"), {});
    assert.deepEqual(resolveTier(undefined, "pdf"), {});
  });
});

describe("EXIF Orientation 解析", () => {
  // 手工构造最小 JPEG：SOI + APP1(Exif IFD0 含 Orientation) + SOF0 + EOI
  function jpegWithOrientation(orient, endian = "II") {
    const ifdEntries = [];
    // Entry: tag(2) type(2) count(4) value(2 + padding 2)
    const le = endian === "II";
    const u16 = (v) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(v, 0) : b.writeUInt16BE(v, 0); return b; };
    const u32 = (v) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v, 0) : b.writeUInt32BE(v, 0); return b; };
    const entry = Buffer.concat([u16(0x0112), u16(3), u32(1), u16(orient), Buffer.from([0, 0])]);
    ifdEntries.push(entry);
    const ifd = Buffer.concat([
      Buffer.from(endian, "ascii"),
      u16(42),
      u32(8), // IFD0 offset=8
      u16(1), // entry count
      ...ifdEntries,
      u32(0), // next IFD
    ]);
    const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), ifd]);
    const app1Body = Buffer.concat([exifPayload]);
    const app1 = Buffer.concat([
      Buffer.from([0xff, 0xe1]),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(app1Body.length + 2, 0); return b; })(),
      app1Body,
    ]);
    return Buffer.concat([
      Buffer.from([0xff, 0xd8]), // SOI
      app1,
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03]), // SOF0 h=48 w=64
      Buffer.from([0xff, 0xd9]), // EOI
    ]);
  }
  test("Orientation 1/3/6/8 正确解析", () => {
    assert.equal(readJpegExifOrientation(jpegWithOrientation(1)), 1);
    assert.equal(readJpegExifOrientation(jpegWithOrientation(3)), 3);
    assert.equal(readJpegExifOrientation(jpegWithOrientation(6)), 6);
    assert.equal(readJpegExifOrientation(jpegWithOrientation(8)), 8);
  });
  test("大端（MM）TIFF 头解析", () => {
    assert.equal(readJpegExifOrientation(jpegWithOrientation(6, "MM")), 6);
  });
  test("无 APP1 → 0；非 JPEG → 0", () => {
    assert.equal(readJpegExifOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 0x11, 8, 0, 0x30, 0, 0x40, 3, 0xff, 0xd9])), 0);
    assert.equal(readJpegExifOrientation(Buffer.from("%PDF-1.4")), 0);
    assert.equal(readJpegExifOrientation(Buffer.alloc(0)), 0);
  });
  test("畸形 EXIF（坏 TIFF 头）→ 0 不抛", () => {
    const bad = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x58, 0x58, 0xff, 0xd9]);
    assert.equal(readJpegExifOrientation(bad), 0);
  });
});

describe("docmodel / content-list", () => {
  const layoutJson = {
    pages: [
      {
        layouts: [
          { layout_id: 1, type: "doc_title", text: "测试标题", position: [100, 50, 600, 40] },
          { layout_id: 2, type: "text", text: "正文内容。", position: [100, 120, 600, 80] },
        ],
        images: [],
        tables: [],
      },
    ],
  };
  test("layoutToDocModel：bbox 归一化 0–1000", () => {
    const dm = layoutToDocModel(layoutJson, {});
    assert.equal(dm.pages.length, 1);
    assert.equal(dm.pages[0].blocks[0].type, "h1");
    assert.equal(dm.pages[0].blocks[0].level, undefined, "标题块用 type 表达层级，不重复 level");
    const bbox = dm.pages[0].blocks[0].bbox;
    // 页范围取全部块极值：W=700、H=200 → 标题(100,50,600,40) 归一化：
    assert.deepEqual(bbox, [143, 250, 1000, 450]);
  });
  test("docModelToContentList：确定性输出（无时间戳）且结构对齐", () => {
    const dm = layoutToDocModel(layoutJson, { source: "x.pdf", provider: "baidu" });
    const cl = docModelToContentList(dm);
    assert.equal(cl.meta.source, "x.pdf");
    assert.equal(cl.meta.provider, "baidu");
    assert.ok(!JSON.stringify(cl).includes("createdAt"), "无时间戳字段");
    assert.equal(cl.pages[0].blocks[0].text, "测试标题");
  });
  test("blocksToDocModel：markdown 降级路径（bbox 缺失）", () => {
    const dm = blocksToDocModel([{ type: "p", text: "hi" }], { engine: "general" });
    assert.equal(dm.pages[0].blocks[0].bbox, undefined);
    assert.equal(dm.meta.engine, "general");
  });
  test("cellFlatText：嵌套格摊平", () => {
    assert.equal(cellFlatText({ nested: { rows: [["内1", "内2"], ["内3", ""]] }, text: "外" }), "外 内1 内2 内3");
    assert.equal(cellFlatText("普通"), "普通");
  });
});

describe("libstore 文档库", () => {
  test("登记/列表/尾缀查找/淘汰上限", () => {
    mkdirSync(ISOLATED, { recursive: true });
    const f1 = join(ISOLATED, "a.md");
    writeFileSync(f1, "# 文档A");
    const id1 = recordLib({ files: [f1], sourcePath: "a.pdf", engine: "vl", format: "md", chars: 8 });
    assert.ok(id1 && id1.length === 8);
    const id2 = recordLib({ files: [join(ISOLATED, "b.md")], sourcePath: "b.pdf", engine: "vl", format: "md", chars: 3 });
    assert.equal(listLib(10).length, 2, "两条登记");
    assert.equal(findLib(id1.slice(-4)).id, id1, "尾缀查找");
    assert.equal(findLib("不存在"), null);
    assert.ok(id1 !== id2);
    rmSync(join(ISOLATED, "lib.json"), { force: true });
  });
});
