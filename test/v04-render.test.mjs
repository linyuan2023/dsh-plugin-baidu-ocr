// test/v04-render.test.mjs — v0.4 渲染层集成测试（pymupdf 可用性门控）：
// 复刻度评分（fidelity.js）/ sandwich PDF（replica.js）/ docx 页几何钉死（ooxml.js pageSizes）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonCmd } from "../lib/pylaunch.js";

function pymupdfOk() {
  try {
    return spawnSync(pythonCmd(), ["-c", "import pymupdf"], { encoding: "utf8", timeout: 30000, windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}
const PY_OK = pymupdfOk();
const SKIP = PY_OK ? false : "python/pymupdf 不可用";

const dir = mkdtempSync(join(tmpdir(), "ocr-v04-render-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// 生成一份含两段已知文本的 PDF，并取回原文块矩形（作为 ground truth 与版面坐标源）
let pdfPath = "";
let layoutJson = null;
const TEXT1 = "复刻度评分测试页面内容";
const TEXT2 = "第二段文字用于版面对照。";

test("setup：pymupdf 生成样例 PDF + 提取原件块", { skip: PY_OK ? false : SKIP }, () => {
  pdfPath = join(dir, "sample.pdf");
  const script = [
    "import sys, json, pymupdf",
    "d = pymupdf.open()",
    "p = d.new_page(width=595, height=842)",
    "p.insert_text((72, 100), sys.argv[2], fontsize=12, fontname='china-s')",
    "p.insert_text((72, 140), sys.argv[3], fontsize=12, fontname='china-s')",
    "d.save(sys.argv[1])",
    "out = d[0].get_text('blocks')",
    "print(json.dumps({'blocks': [[b[0], b[1], b[2], b[3], b[4].strip()] for b in out], 'w': 595, 'h': 842}))",
  ].join("\n");
  const r = spawnSync(pythonCmd(), ["-c", script, pdfPath, TEXT1, TEXT2], { encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr).slice(-200));
  const info = JSON.parse(r.stdout.trim());
  layoutJson = {
    pages: [
      {
        layouts: info.blocks.map((b, i) => ({
          layout_id: i + 1,
          type: "text",
          text: b[4],
          position: [b[0], b[1], b[2] - b[0], b[3] - b[1]],
        })),
        images: [],
        tables: [],
      },
    ],
  };
  assert.ok(layoutJson.pages[0].layouts.length >= 2);
});

test("复刻度评分：坐标一致 → overall ≥ 85", { skip: PY_OK ? false : SKIP }, async () => {
  const { scoreReplica } = await import("../lib/fidelity.js");
  const score = scoreReplica({ sourcePath: pdfPath, layoutJson });
  assert.ok(score, "评分不可用（pymupdf 缺失？）");
  assert.ok(score.overall >= 85, `overall=${score.overall}（${JSON.stringify(score)}）`);
  assert.ok(score.textCoverage >= 95, `textCoverage=${score.textCoverage}`);
});

test("sandwich PDF：原页位图 + 隐形文字层可检索", { skip: PY_OK ? false : SKIP }, async () => {
  const { replicaPdf } = await import("../lib/replica.js");
  const { layoutToDocModel } = await import("../lib/docmodel.js");
  const dm = layoutToDocModel(layoutJson, {});
  const { buffer, skipped } = replicaPdf({ sourcePath: pdfPath, docModel: dm, dpi: 120 });
  const outPath = join(dir, "replica.pdf");
  writeFileSync(outPath, buffer);
  // 产物可打开、文本层可提取（隐形文字 render_mode=3 仍参与 get_text）
  const script = "import sys, pymupdf\nprint(pymupdf.open(sys.argv[1])[0].get_text())";
  const r = spawnSync(pythonCmd(), ["-c", script, outPath], { encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(TEXT1) && r.stdout.includes(TEXT2), "隐形文字层可检索");
  assert.equal(skipped, 0);
});

test("docx 页几何钉死：非 A4 原件尺寸写入 sectPr", async () => {
  const { blocksToDocxPages } = await import("../lib/ooxml.js");
  const { readZip } = await import("../lib/office.js");
  const pages = [{ blocks: [{ type: "p", text: "正文" }], isLandscape: false, header: "", footer: "", stats: { unknownTypes: [] } }];
  const buf = blocksToDocxPages(pages, { pageSizes: [{ wPt: 400, hPt: 600, wTwips: 8000, hTwips: 12000 }] });
  const docXml = readZip(buf).get("word/document.xml").toString("utf8");
  assert.ok(docXml.includes('<w:pgSz w:w="8000" w:h="12000"/>'), "真实页尺寸（twips=pt×20）写入 pgSz");
  // 无 pageSizes 回退 A4
  const buf2 = blocksToDocxPages(pages, {});
  const docXml2 = readZip(buf2).get("word/document.xml").toString("utf8");
  assert.ok(docXml2.includes('w:w="11906"'), "回退 A4 纵向");
});
