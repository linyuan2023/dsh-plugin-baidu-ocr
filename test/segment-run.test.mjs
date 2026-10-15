// test/segment-run.test.mjs — 分段自动推进：一次调用推一段、缓存幂等、完成自动合并
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir as td } from "node:os";

const ISOLATED = mkdtempSync(join(td(), "ocr-segrun-test-"));
process.env.DSH_OCR_TOKEN_FILE = join(ISOLATED, "token.json");

const { recognizeSegmented } = await import("../lib/pipeline.js");
const pymupdf = () => spawnSync("python", ["-c", "import pymupdf"], { encoding: "utf8" });

test("recognizeSegmented：一次调用推一段，全部完成自动合并+整本缓存（注入假适配器）", async (t) => {
  if (pymupdf().status !== 0) return t.skip("python/pymupdf 不可用");
  const dir = mkdtempSync(join(td(), "ocr-segrun-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdf = join(dir, "src9.pdf");
  const r0 = spawnSync(
    "python",
    ["-c", "import sys, pymupdf\nd = pymupdf.open()\nfor _ in range(9):\n    d.new_page()\nd.save(sys.argv[1])", pdf],
    { encoding: "utf8", timeout: 60000 }
  );
  assert.equal(r0.status, 0, r0.stderr);

  const input = { buffer: readFileSync(pdf), size: statSync(pdf).size, kind: "pdf" };
  const cfg = { provider: "aistudio", vlSegmentPages: 3 }; // 9 页 → 3 段（1-3/4-6/7-9）

  let calls = 0;
  const pageHints = [];
  const adapters = {
    aistudio: async (_cfg, segInput) => {
      calls += 1;
      pageHints.push(segInput.pagesHint);
      return { markdown: `段${calls}`, text: `段${calls}`, taskId: `t${calls}`, pagesCount: segInput.pagesHint ?? 0 };
    },
    vl: async () => {
      throw new Error("provider=aistudio 时不应调用 vl 适配器");
    },
  };

  const notes1 = [];
  const r1 = await recognizeSegmented(cfg, input, pdf, { segmentLimit: 1, extraNotes: notes1, adapters });
  assert.equal(calls, 1);
  assert.equal(r1.incomplete, true);
  assert.equal(r1.doneCount, 1);
  assert.equal(r1.result.markdown, "段1");
  assert.equal(r1.result.incomplete, true);
  assert.ok(notes1.join("").includes("1/3 段"), "note 说明进度");
  assert.ok(notes1.join("").includes("再次调用"), "note 提示再次调用");

  const notes2 = [];
  const r2 = await recognizeSegmented(cfg, input, pdf, { segmentLimit: 1, extraNotes: notes2, adapters });
  assert.equal(calls, 2, "自动推进到第 2 段");
  assert.equal(r2.incomplete, true);
  // v0.4 跨段段落合并：段1 无句读与段2 拼接（paraMerge 默认开）
  assert.equal(r2.result.markdown, "段1 段2", "返回目前为止的合并结果");

  const notes3 = [];
  const r3 = await recognizeSegmented(cfg, input, pdf, { segmentLimit: 1, extraNotes: notes3, adapters });
  assert.equal(calls, 3);
  assert.equal(r3.incomplete, false);
  assert.equal(r3.doneCount, 3);
  assert.equal(r3.result.markdown, "段1 段2 段3", "完成时返回整本合并结果");
  assert.equal(r3.result.incomplete, undefined);
  assert.ok(notes3.join("").includes("分段识别完成"), "完成 note");
  assert.deepEqual(pageHints, [3, 3, 3], "每段页数正确");

  // 全部完成后：重复调用不再打适配器（整本缓存命中）
  const before = calls;
  const notes4 = [];
  const r4 = await recognizeSegmented(cfg, input, pdf, { segmentLimit: 1, extraNotes: notes4, adapters });
  assert.equal(calls, before, "全缓存幂等");
  assert.equal(r4.incomplete, false);
  assert.equal(r4.result.markdown, "段1 段2 段3");

  // segmentLimit 不传（命令路径）：一次调用跑完所有缺失段
  rmSync(join(ISOLATED, "cache"), { recursive: true, force: true });
  let calls2 = 0;
  const adapters2 = {
    aistudio: async (_cfg, segInput) => {
      calls2 += 1;
      return { markdown: `段${calls2}`, text: `段${calls2}`, taskId: `t2-${calls2}`, pagesCount: 3 };
    },
    vl: async () => {
      throw new Error("不应调用");
    },
  };
  const notes5 = [];
  const r5 = await recognizeSegmented(cfg, input, pdf, { extraNotes: notes5, adapters: adapters2 });
  assert.equal(calls2, 3, "命令路径一次调用跑完全部段");
  assert.equal(r5.incomplete, false);
  assert.equal(r5.result.markdown, "段1 段2 段3");
});

test("resumeTask 防重入：done 任务抛 E_TASK_DONE 并引导正确续跑方式", async () => {
  const { recordTask } = await import("../lib/tasks.js");
  const { resumeTask } = await import("../lib/pipeline.js");
  recordTask({ id: "done-task-xyz789", provider: "aistudio", status: "done" });
  await assert.rejects(
    resumeTask({ cfg: {}, id: "done-task-xyz789" }),
    (e) => e.code === "E_TASK_DONE" && e.message.includes("不要使用 resumeTaskId")
  );
});
