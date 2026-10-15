// test/segment.test.mjs — 分段规划/合并/任务表/结果缓存
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir as td } from "node:os";

// 隔离数据目录（tasks/cache 跟随 DSH_OCR_TOKEN_FILE）
const ISOLATED = mkdtempSync(join(td(), "ocr-seg-test-"));
process.env.DSH_OCR_TOKEN_FILE = join(ISOLATED, "token.json");

const { planSegments, mergeSegmentResults, pdfPageCountSync, segmentDirFor, writeSegmentPdfs } = await import("../lib/segment.js");
const { recordTask, markTask, findTask, listTasks } = await import("../lib/tasks.js");
const { fileHash, cacheKey, cacheGet, cachePut, cachePrune, cacheClear } = await import("../lib/cache.js");

const pymupdf = () => spawnSync("python", ["-c", "import pymupdf"], { encoding: "utf8" });

test("planSegments：边界（0/39/40/41/476 页）", () => {
  assert.equal(planSegments(0, 40).length, 0);
  assert.deepEqual(planSegments(39, 40).map((s) => [s.from, s.to]), [[1, 39]]);
  assert.deepEqual(planSegments(40, 40).map((s) => [s.from, s.to]), [[1, 40]]);
  assert.deepEqual(planSegments(41, 40).map((s) => [s.from, s.to]), [[1, 40], [41, 41]]);
  const p476 = planSegments(476, 40);
  assert.equal(p476.length, 12);
  assert.deepEqual([p476[0].from, p476.at(-1).to], [1, 476]);
  assert.deepEqual(p476.map((s) => s.index), Array.from({ length: 12 }, (_, i) => i + 1));
});

test("planSegments：非有限入参的语义（#18：旧版 Infinity 产出 to:Infinity 的段）", () => {
  assert.deepEqual(planSegments(Infinity, 40), []); // 总页数非有限 → 空计划
  assert.deepEqual(planSegments(NaN, 40), []);
  assert.deepEqual(planSegments(100, Infinity).map((s) => [s.from, s.to]), [[1, 100]], "size=Infinity = 不分段");
  assert.deepEqual(planSegments(100, NaN).map((s) => [s.from, s.to]), [[1, 40], [41, 80], [81, 100]], "size=NaN 回落 40");
  // 任何计划都不得出现非有限页码
  for (const seg of [...planSegments(100, Infinity), ...planSegments(100, NaN)]) {
    assert.ok(Number.isFinite(seg.from) && Number.isFinite(seg.to), JSON.stringify(seg));
  }
});

test("mergeSegmentResults：markdown/pages/tables/taskId 合并", () => {
  const a = { markdown: "# A", text: "# A", taskId: "t1", pagesCount: 3, layoutJson: { pages: [{ blocks: [1] }] }, tablesHtml: ["<table>1</table>"] };
  const b = { markdown: "# B", text: "# B", taskId: "t2", pagesCount: 2, layoutJson: { pages: [{ blocks: [2] }, { blocks: [3] }] }, tablesHtml: [] };
  const m = mergeSegmentResults([a, b]);
  assert.equal(m.markdown, "# A\n\n# B");
  assert.equal(m.pagesCount, 5);
  assert.equal(m.taskId, "t1,t2");
  assert.equal(m.layoutJson.pages.length, 3);
  assert.equal(m.tablesHtml.length, 1);
  assert.equal(mergeSegmentResults([]), null);
});

test("pdfPageCountSync：pymupdf 现场生成样例（缺依赖跳过）", (t) => {
  if (pymupdf().status !== 0) return t.skip("python/pymupdf 不可用");
  const dir = mkdtempSync(join(td(), "ocr-seg-pdf-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdf = join(dir, "t.pdf");
  const r = spawnSync(
    "python",
    ["-c", "import sys, pymupdf\nd = pymupdf.open()\nfor _ in range(5):\n    d.new_page()\nd.save(sys.argv[1])", pdf],
    { encoding: "utf8", timeout: 60000 }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(pdfPageCountSync(pdf), 5);
  assert.equal(pdfPageCountSync(join(dir, "不存在.pdf")), null);
});

test("writeSegmentPdfs：切分 + .ok 标记复用（缺依赖跳过）", (t) => {
  if (pymupdf().status !== 0) return t.skip("python/pymupdf 不可用");
  const dir = mkdtempSync(join(td(), "ocr-seg-w-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdf = join(dir, "src.pdf");
  const r = spawnSync(
    "python",
    ["-c", "import sys, pymupdf\nd = pymupdf.open()\nfor _ in range(8):\n    d.new_page()\nd.save(sys.argv[1])", pdf],
    { encoding: "utf8", timeout: 60000 }
  );
  assert.equal(r.status, 0);
  const plan = planSegments(8, 5); // [1-5],[6-8]
  const segDir = join(dir, "segs");
  writeSegmentPdfs(pdf, plan, segDir);
  assert.ok(existsSync(join(segDir, "seg-001.pdf")));
  assert.ok(existsSync(join(segDir, "seg-002.pdf")));
  assert.ok(existsSync(join(segDir, "seg-001.pdf.ok")));
  writeSegmentPdfs(pdf, plan, segDir); // 复用不重写（无异常即通过）
});

test("segmentDirFor：同源稳定、异源不同", () => {
  const root = join(td(), "ocr-seg-root");
  const a1 = segmentDirFor("D:/x/a.pdf", 100, root);
  const a2 = segmentDirFor("D:/x/a.pdf", 100, root);
  const b = segmentDirFor("D:/x/b.pdf", 100, root);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test("segmentDirFor：内容哈希进键（#10：同路径同大小内容不同不共用段目录）", () => {
  const root = join(td(), "ocr-seg-root");
  const v1 = segmentDirFor("D:/x/a.pdf", 100, root, "hash1");
  const v1b = segmentDirFor("D:/x/a.pdf", 100, root, "hash1");
  const v2 = segmentDirFor("D:/x/a.pdf", 100, root, "hash2"); // 同路径同大小、内容不同
  assert.equal(v1, v1b);
  assert.notEqual(v1, v2, "内容不同必须换目录，否则陈旧 .ok 段会被当成新文件的段提交");
  const noHash = segmentDirFor("D:/x/a.pdf", 100, root);
  assert.notEqual(noHash, v1);
});

test("tasks：登记/标记/后缀查找/裁剪", () => {
  recordTask({ id: "task-abcdef123456", provider: "aistudio", engine: "vl", fileName: "a.pdf", pagesHint: 12 });
  assert.equal(findTask("task-abcdef123456").status, "running");
  assert.equal(findTask("123456").id, "task-abcdef123456"); // 后缀匹配
  assert.equal(findTask("不存在"), null);
  markTask("task-abcdef123456", { status: "done" });
  assert.equal(findTask("task-abcdef123456").status, "done");
  for (let i = 0; i < 55; i++) recordTask({ id: `t-${i}`, provider: "baidu" });
  assert.ok(listTasks(100).length <= 50, "任务表最多 50 条");
  assert.equal(listTasks(3).length, 3);
});

test("cache：写入/读取/键区分/清理", () => {
  const fh = fileHash(Buffer.from("hello"));
  const key = cacheKey({ fileHash: fh, engine: "vl", provider: "aistudio" });
  assert.equal(cacheGet(key), null);
  cachePut(key, { text: "结果A" });
  assert.equal(cacheGet(key).result.text, "结果A");
  const key2 = cacheKey({ fileHash: fh, engine: "vl", provider: "baidu", span: "p1-40" });
  assert.equal(cacheGet(key2), null);
  cachePut(key2, { text: "段1" });
  assert.equal(cacheGet(key2).result.text, "段1");
  const fh2 = fileHash(Buffer.from("world"));
  assert.notEqual(fh, fh2);
  cacheClear();
  assert.equal(cacheGet(key), null);
});

test("cachePrune：过期删除", () => {
  const fh = fileHash(Buffer.from("old"));
  const key = cacheKey({ fileHash: fh, engine: "vl", provider: "aistudio" });
  cachePut(key, { text: "旧" }, { savedAt: Date.now() - 8 * 24 * 3600 * 1000 });
  cachePrune({ now: Date.now() + 8 * 24 * 3600 * 1000 }); // prune 按文件 mtime 判龄
  assert.equal(cacheGet(key), null, "超 7 天的缓存被清理");
});
