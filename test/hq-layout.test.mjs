// test/hq-layout.test.mjs — 矢量高清重截 + 图注吸附/页码剥离/宽松拼接/表头启发式
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const pymupdf = () => spawnSync("python", ["-c", "import pymupdf"], { encoding: "utf8" });
const L = (type, x, y, w, h, extra = {}) => ({ type, text: extra.text ?? "", position: [x, y, w, h], ...extra });

test("layoutToPageBlocks：图注吸附（图后/图前/过长不吸）", async () => {
  const { layoutToPageBlocks } = await import("../lib/layout.js");
  const json = {
    pages: [
      {
        layouts: [
          L("image", 0, 0, 500, 300),
          L("text", 0, 310, 500, 30, { text: "图1−4−2 土方回填与压实工艺示范" }),
          L("text", 0, 360, 500, 30, { text: "表 2-1 验收标准" }),
          L("image", 0, 400, 500, 300),
          L("image", 0, 720, 500, 300),
          L("text", 0, 1030, 500, 30, { text: "这一段是很长的正文文字，绝对不是图注，不应该被吸附到图片上作为标题说明文字" }),
        ],
        images: [],
      },
    ],
  };
  json.pages[0].layouts[0].layout_id = "i1";
  json.pages[0].layouts[3].layout_id = "i2";
  json.pages[0].layouts[4].layout_id = "i3";
  json.pages[0].images.push({ layout_id: "i1", data_url: "http://x/1.jpg" });
  json.pages[0].images.push({ layout_id: "i2", data_url: "http://x/2.jpg" });
  json.pages[0].images.push({ layout_id: "i3", data_url: "http://x/3.jpg" });
  const pages = layoutToPageBlocks(json, { mergeCrossPageTables: false });
  const blocks = pages[0].blocks;
  // 图1：图注在图后 → 吸附；表2-1：在第二张图前 → 吸附
  assert.equal(blocks.filter((b) => b.type === "image").length, 3);
  assert.equal(blocks.filter((b) => b.type === "p").length, 1, "长正文保留");
  assert.equal(blocks[0].caption, "图1−4−2 土方回填与压实工艺示范");
  assert.equal(blocks[1].caption, "表 2-1 验收标准");
  assert.equal(blocks[2].caption, undefined, "长文本不吸附");
});

test("layoutToPageBlocks：页首/页尾孤立纯数字页码剥离并计数", async () => {
  const { layoutToPageBlocks } = await import("../lib/layout.js");
  const json = {
    pages: [
      {
        layouts: [
          L("text", 0, 0, 500, 30, { text: "39" }),
          L("text", 0, 100, 500, 40, { text: "正文第一段" }),
          L("text", 0, 200, 500, 40, { text: "3. 工艺流程" }),
          L("text", 0, 1000, 500, 30, { text: "40" }),
        ],
        images: [],
      },
      { layouts: [L("text", 0, 100, 500, 40, { text: "第二页正文" })], images: [] },
    ],
  };
  const pages = layoutToPageBlocks(json, { mergeCrossPageTables: false });
  assert.deepEqual(pages[0].blocks.map((b) => b.text), ["正文第一段", "3. 工艺流程"], "页码剥掉、小节号保留");
  assert.equal(pages[0].stats.strippedPN, 2);
  assert.equal(pages[1].blocks[0].text, "第二页正文");
  assert.equal(pages[1].stats.strippedPN, 0);
});

test("mergeCrossPageTables loose：前表触底+无跨页合并+列数一致 → 拼接保留后表首行", async () => {
  const { layoutToPageBlocks } = await import("../lib/layout.js");
  const mk = (rows, pos, pageH) => ({
    pages: [
      {
        layouts: [L("table", pos[0], pos[1], pos[2], pos[3], { table_html: `<tr>${rows[0].map((c) => `<td>${c}</td>`).join("")}</tr><tr>${rows[1].map((c) => `<td>${c}</td>`).join("")}</tr>` })],
        images: [],
      },
      {
        layouts: [L("table", 0, 0, 500, 200, { table_html: `<tr>${rows[2].map((c) => `<td>${c}</td>`).join("")}</tr>` })],
        images: [],
      },
    ],
  });
  const json = mk(
    [
      ["名称", "数量"],
      ["苹果", "3"],
      ["香蕉", "4"],
    ],
    [0, 700, 500, 200],
    900
  ); // 前表 700+200=900 = 页底 100% ≥85%
  const strict = layoutToPageBlocks(json, { mergeMode: "strict" });
  assert.equal(strict[0].blocks[0].rows.length, 2, "strict：首行不同不拼");
  const loose = layoutToPageBlocks(json, { mergeMode: "loose" });
  assert.equal(loose[0].blocks[0].rows.length, 3, "loose：拼上后表（含首行）");
  assert.deepEqual(loose[0].blocks[0].rows[2], ["香蕉", "4"]);
  assert.equal(loose[1].blocks.length, 0);
});

test("isHeaderRow：短首行+数字主体才是表头", async () => {
  const { isHeaderRow } = await import("../lib/layout.js");
  assert.equal(isHeaderRow([["名称", "数量"], ["苹果", "3"]]), true);
  assert.equal(isHeaderRow([["第一行是很长的正文内容说明文字", "第二列也很长明显不是表头"], ["3", "4"]]), false, "首行长文本不是表头");
  assert.equal(isHeaderRow([["甲", "乙"], ["丙", "丁"]]), false, "主体无数字不是表头");
  assert.equal(isHeaderRow([["唯一行"]]), false, "单行表不是表头");
});

test("recaptureVectorImages：pymupdf 造矢量页重截（缺依赖跳过）", async (t) => {
  if (pymupdf().status !== 0) return t.skip("python/pymupdf 不可用");
  const { recaptureVectorImages } = await import("../lib/hq.js");
  const dir = mkdtempSync(join(tmpdir(), "ocr-hq-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdf = join(dir, "vec.pdf");
  // 画一个 400x300pt 的页面，含矢量矩形+文字，页宽=400pt
  const r1 = spawnSync(
    "python",
    [
      "-c",
      "import sys, pymupdf\nd = pymupdf.open()\np = d.new_page(width=400, height=300)\np.draw_rect(pymupdf.Rect(50, 50, 350, 250), color=(0, 0, 1), width=2)\np.insert_text((60, 80), 'DIM 100mm', fontsize=14)\nd.save(sys.argv[1])",
      pdf,
    ],
    { encoding: "utf8", timeout: 60000 }
  );
  assert.equal(r1.status, 0, r1.stderr);
  // 版面像素宽 800（scale = 400/800 = 0.5，在安全区间），图片区域 (100,100)-(700,500) px
  const pages = [
    {
      _pageW: 800,
      blocks: [{ type: "image", url: "http://invalid/should-not-download", w: 600, h: 400, _pos: [100, 100, 600, 400] }],
    },
  ];
  const stat = recaptureVectorImages(pages, pdf, { dpi: 150 });
  assert.ok(stat && stat.recaptured === 1, `重截成功（${JSON.stringify(stat)}）`);
  const blk = pages[0].blocks[0];
  assert.ok(Buffer.isBuffer(blk.data) && blk.data.length > 100);
  assert.equal(blk.ext, "png");
  assert.equal(blk.url, "http://invalid/should-not-download", "url 保留（md 引用用）");
  // 比例失防：_pageW 错到 8 → scale=50 超区间 → 不重截
  const pages2 = [{ _pageW: 8, blocks: [{ type: "image", url: "u", w: 600, h: 400, _pos: [100, 100, 600, 400] }] }];
  const stat2 = recaptureVectorImages(pages2, pdf, { dpi: 150 });
  assert.equal(stat2.recaptured, 0, "比例超安全区间跳过");
  assert.equal(pages2[0].blocks[0].data, undefined);
});

test("materializeImages 并发池：数据在的块不重复下载、坏 url 剔除", async (t) => {
  const { materializeImages } = await import("../lib/layout.js");
  const blocks = [
    { type: "image", url: "http://127.0.0.1:1/x.jpg" }, // 必失败
    { type: "image", data: Buffer.from("已有数据"), url: "http://127.0.0.1:1/y.jpg" }, // 已有数据不下载
    { type: "p", text: "正文" },
  ];
  const failed = await materializeImages(blocks, { timeoutMs: 3000, concurrency: 2 });
  assert.equal(failed, 1);
  assert.equal(blocks.filter((b) => b.type === "image").length, 1, "失败图剔除、已有数据保留");
});

test("materializeImages 大小上限：content-length 预告超限直接拒、流式超限中断", async (t) => {
  const { materializeImages } = await import("../lib/layout.js");
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  // 1) content-length 预告 40MB → 直接拒，body 一个字节都不读
  let bodyTouched = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === "content-length" ? String(40 * 1024 * 1024) : null) },
    body: {
      getReader: () => {
        bodyTouched = true;
        throw new Error("不应创建 reader");
      },
    },
  });
  const blocks1 = [{ type: "image", url: "http://fake.local/huge" }];
  const failed1 = await materializeImages(blocks1, { timeoutMs: 3000 });
  assert.equal(failed1, 1);
  assert.equal(blocks1.length, 0, "超限块被剔除");
  assert.equal(bodyTouched, false, "content-length 超限时未读取 body");

  // 2) 流式 body 无 content-length：累计超 30MB 即中断（reader.cancel 被调用，不会读完整包）
  let cancelled = false;
  let delivered = 0;
  const CHUNK = 8 * 1024 * 1024;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          //  effectively 无限流：没有上限保护就会一直读下去
          if (delivered >= 8 * 1024 * 1024 * 1024) return { done: true, value: undefined };
          delivered += CHUNK;
          return { done: false, value: Buffer.alloc(CHUNK, 0x41) };
        },
        cancel: async () => {
          cancelled = true;
        },
      }),
    },
  });
  const blocks2 = [{ type: "image", url: "http://fake.local/stream" }];
  const failed2 = await materializeImages(blocks2, { timeoutMs: 3000 });
  assert.equal(failed2, 1);
  assert.equal(cancelled, true, "超限后取消读取");
  assert.ok(delivered <= 64 * 1024 * 1024, `未读完整包（两次尝试累计 ${Math.round(delivered / 1024 / 1024)}MB，远小于无限流）`);
});
