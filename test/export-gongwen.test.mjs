// test/export-gongwen.test.mjs — docx-gongwen 导出集成测试（依赖本机 gongwen CLI，缺失则跳过）
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveResult, markdownToGongwenDocx } from "../lib/export.js";

function gongwenAvailable() {
  const r = spawnSync("gongwen", ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
  return r.status === 0;
}

const SAMPLE = {
  channel: "B",
  markdown: "关于开展检查工作的通知\n\n一、检查时间\n\n2026年10月15日至10月31日。",
  text: "关于开展检查工作的通知",
};

test("markdownToGongwenDocx：产出合法 docx（Python zipfile CRC 全量校验 + 公文字体断言）", { skip: gongwenAvailable() ? false : "gongwen CLI 不可用" }, (t) => {
  const buf = markdownToGongwenDocx(SAMPLE.markdown);
  assert.ok(buf.length > 5000, `产物过小: ${buf.length}`);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "zip local header 签名");

  const dir = mkdtempSync(join(tmpdir(), "ocr-gwtest-"));
  const file = join(dir, "gw.docx");
  writeFileSync(file, buf);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(
    "python",
    [
      "-c",
      "import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None, 'CRC 损坏'\ndoc=z.read('word/document.xml').decode('utf-8')\nassert '仿宋' in doc or 'FangSong' in doc, '缺少公文正文字体'\nprint('OK')",
      file,
    ],
    { encoding: "utf8", timeout: 30000 }
  );
  assert.equal(r.status, 0, `python 校验失败: ${r.stderr}`);
});

test("saveResult(docx-gongwen)：落盘成功、不降级、扩展名正确", { skip: gongwenAvailable() ? false : "gongwen CLI 不可用" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-gwsave-"));
  try {
    const r = await saveResult(SAMPLE, { format: "docx-gongwen", saveDir: dir, sourcePath: "D:/x/测试.png" });
    assert.equal(r.files.length, 1);
    assert.ok(r.files[0].endsWith(".docx"));
    assert.ok(!r.note, `不应出现降级说明: ${r.note}`);
    assert.ok(readFileSync(r.files[0]).length > 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
