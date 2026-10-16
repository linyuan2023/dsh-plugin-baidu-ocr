// test/ooxml.test.mjs — stored zip 结构 + 最小 OOXML docx
// 除了结构断言，还用 Python zipfile.testzip() 做 CRC 全量校验（真实解压器验证）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipStore, crc32, blocksToDocx, blocksToDocxPages, blocksToDocumentXml, xmlEscape } from "../lib/ooxml.js";
import { blocksToMarkdown } from "../lib/markdown.js";
import { markdownToBlocks } from "../lib/markdown.js";

const SAMPLE_BLOCKS = [
  { type: "h1", text: "验收报告 & 摘要 <2026>" },
  { type: "p", text: "第一段，含 & < > 引号内容。" },
  { type: "code", lines: ["const a = 1;", "print(a)"] },
  {
    type: "table",
    rows: [
      ["项目", "数值"],
      ["长度", "12"],
    ],
  },
  { type: "h2", text: "第二节" },
  { type: "p", text: "结尾。" },
];

function eocd(buf) {
  const i = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(i > 0, "EOCD 签名存在");
  return { i, disk: buf.readUInt16LE(i + 4), cdDisk: buf.readUInt16LE(i + 6), n: buf.readUInt16LE(i + 8), total: buf.readUInt16LE(i + 10), cdSize: buf.readUInt32LE(i + 12), cdOff: buf.readUInt32LE(i + 16) };
}

test("zipStore：结构完整（签名/偏移/条目数自洽）", () => {
  const entries = [
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: "<w:document/>" },
  ];
  const zip = zipStore(entries);
  assert.ok(zip.readUInt32LE(0) === 0x04034b50, "local header 签名");
  const e = eocd(zip);
  assert.equal(e.total, entries.length);
  assert.equal(e.n, entries.length);
  assert.equal(e.cdOff + e.cdSize + 22, zip.length, "EOCD 位于尾部且偏移自洽");
  // 第一条 local header 里的文件名
  const nameLen = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLen).toString("utf8"), "[Content_Types].xml");
  // stored：压缩前=压缩后
  assert.equal(zip.readUInt32LE(18), zip.readUInt32LE(22));
});

test("crc32 与已知向量一致", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("blocksToDocumentXml：转义完整、标签平衡", () => {
  const xml = blocksToDocumentXml(SAMPLE_BLOCKS);
  assert.ok(xml.includes("&amp;"), "& 被转义");
  assert.ok(xml.includes("&lt;2026&gt;"), "<> 被转义");
  assert.equal(xml.split("<w:p>").length, xml.split("</w:p>").length, "w:p 配对");
  assert.equal(xml.split("<w:tc>").length, xml.split("</w:tc>").length, "w:tc 配对");
  assert.ok(xml.includes('<w:pStyle w:val="Heading1"/>'));
  assert.ok(xml.includes("<w:tbl>"));
});

test("xmlEscape", () => {
  assert.equal(xmlEscape(`a&b<c>"d"'e'`), "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
});

test("xmlEscape：清洗 XML 1.0 非法控制字符（#10）", () => {
  // \x0B/\x0C 常见于 PDF 文本层分页符，不清洗会生成非法 XML、docx 整体损坏
  const input = "a" + String.fromCharCode(0x0b) + "b" + String.fromCharCode(0x0c) + "c" + String.fromCharCode(0x0c) + "d" + "\t" + "e" + "\n" + "f";
  const out = xmlEscape(input);
  const expected = "a b c d" + "\t" + "e" + "\n" + "f";
  assert.equal(out, expected, "C0 非法字符被替换为空格，\\t\\n 保留");
  for (const ch of out) {
    const code = ch.codePointAt(0);
    assert.ok(
      !(code >= 0x00 && code <= 0x08) && code !== 0x0b && code !== 0x0c && !(code >= 0x0e && code <= 0x1f),
      `不该残留控制字符 U+${code.toString(16)}`
    );
  }
});

test("二维合并格：续行只输出一个 gridSpan 续格（防止 Word 损坏，#2）", (t) => {
  const blocks = [
    { type: "table", rows: [["A", "B"], ["1", "2"]], merges: [{ r: 0, c: 0, rowSpan: 2, colSpan: 2 }] },
  ];
  const docx = blocksToDocx(blocks, { title: "2D 合并" });
  const dir = mkdtempSync(join(tmpdir(), "ocr-2dmerge-"));
  const file = join(dir, "m.docx");
  writeFileSync(file, docx);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(
    "python",
    [
      "-c",
      "import zipfile,sys,re\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\ndoc=z.read('word/document.xml').decode()\nassert doc.count('<w:vMerge w:val=\"restart\"/>')==1, 'restart 应 1 处'\nassert doc.count('<w:vMerge/></w:tcPr><w:p/>')==1, '续行应只有 1 个续格（buggy 会生成 2 个导致列数超限）'\nfor ri,row in enumerate(re.findall(r'<w:tr>.*?</w:tr>', doc, re.S)):\n    cols=0\n    for c in re.findall(r'<w:tc>.*?</w:tc>', row, re.S):\n        m=re.search(r'<w:gridSpan w:val=\"(\\d+)\"/>', c)\n        cols += int(m.group(1)) if m else 1\n    assert cols==2, f'row {ri} 栅格合计 {cols} 应等于列数 2'\nprint('OK')",
      file,
    ],
    { encoding: "utf8", timeout: 30000 }
  );
  assert.equal(r.status, 0, `python 校验失败: ${r.stderr}`);
  assert.ok(r.stdout.includes("OK"));
});

test("docx 用 Python zipfile 全量校验（CRC + 部件齐全）", (t) => {
  const py = spawnSync("python", ["--version"], { encoding: "utf8" });
  if (py.status !== 0) return t.skip("python 不可用");
  const docx = blocksToDocx(SAMPLE_BLOCKS, { title: "测试文档" });
  assert.ok(docx.length > 1000);
  const dir = mkdtempSync(join(tmpdir(), "ocr-docx-"));
  const file = join(dir, "sample.docx");
  writeFileSync(file, docx);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(
    "python",
    [
      "-c",
      "import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nbad=z.testzip()\nassert bad is None, 'CRC 坏条目: '+str(bad)\nnames=z.namelist()\nfor need in ['[Content_Types].xml','_rels/.rels','docProps/core.xml','word/document.xml','word/_rels/document.xml.rels','word/styles.xml']:\n    assert need in names, '缺部件: '+need\ndoc=z.read('word/document.xml').decode('utf-8')\nassert 'Heading1' in doc and '<w:tbl>' in doc\nprint('OK', len(names))",
      file,
    ],
    { encoding: "utf8", timeout: 30000 }
  );
  assert.equal(r.status, 0, `python 校验失败: ${r.stderr}`);
  assert.ok(r.stdout.includes("OK 6"), "六个部件齐全");
});

test("图片嵌入：media 条目 + Content_Types + w:drawing + rels", (t) => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" + "0d0a2db4", "hex");
  const blocks = [
    { type: "p", text: "前文" },
    { type: "image", data: png, ext: "png", w: 400, h: 200 },
    { type: "p", text: "后文" },
  ];
  const docx = blocksToDocx(blocks, { title: "图测", headerText: "页眉", footerText: "页脚" });
  const dir = mkdtempSync(join(tmpdir(), "ocr-imgdocx-"));
  const file = join(dir, "img.docx");
  writeFileSync(file, docx);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(
    "python",
    [
      "-c",
      "import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nnames=z.namelist()\nassert 'word/media/image1.png' in names, names\ncn=z.read('[Content_Types].xml').decode()\nassert 'image/png' in cn and 'header+xml' in cn and 'footer+xml' in cn\ndoc=z.read('word/document.xml').decode()\nassert '<w:drawing>' in doc and 'r:embed=' in doc\nrels=z.read('word/_rels/document.xml.rels').decode()\nassert 'media/image1.png' in rels and 'header1.xml' in rels and 'footer1.xml' in rels\nhdr=z.read('word/header1.xml').decode(); ftr=z.read('word/footer1.xml').decode()\nassert '页眉' in hdr and '页脚' in ftr\nprint('OK')",
      file,
    ],
    { encoding: "utf8", timeout: 30000 }
  );
  assert.equal(r.status, 0, `python 校验失败: ${r.stderr}`);
  assert.ok(r.stdout.includes("OK"));
});

test("blocksToMarkdown：image 块内联", () => {
  const md = blocksToMarkdown([{ type: "p", text: "a" }, { type: "image", url: "http://x/1.jpg" }]);
  assert.equal(md, "a\n\n![image](http://x/1.jpg)");
});

test("表格合并：vMerge restart/continuation + gridSpan", (t) => {
  const probe = spawnSync("python", ["-c", "import docx"], { encoding: "utf8", timeout: 15000 });
  if (probe.status !== 0) return t.skip("python-docx 不可用");
  const blocks = [
    {
      type: "table",
      rows: [
        ["聚焦方面", "自查要点", "问题"],
        ["贯彻落实", "(一)标题", "1. 内容"],
        ["", "", "2. 内容"],
        ["", "", "3. 内容"],
      ],
      merges: [
        { r: 1, c: 0, rowSpan: 3, colSpan: 1 },
        { r: 1, c: 1, rowSpan: 3, colSpan: 1 },
      ],
    },
  ];
  const docx = blocksToDocx(blocks, { title: "合并测" });
  const dir = mkdtempSync(join(tmpdir(), "ocr-merge-"));
  const file = join(dir, "merge.docx");
  writeFileSync(file, docx);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(
    "python",
    [
      "-c",
      "import zipfile,sys,re\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\ndoc=z.read('word/document.xml').decode()\nassert doc.count('<w:vMerge w:val=\"restart\"/>')==2, 'restart 应 2 处'\nassert doc.count('<w:tcPr><w:vMerge/></w:tcPr>')==4, 'continuation 应 4 处(2 合并x2 续行)'\nassert doc.count('<w:tcPr><w:vMerge/></w:tcPr><w:p/>')==4, '续格须补空 w:p（ECMA-376 块级元素要求）'\nfrom docx import Document as D\nd=D(sys.argv[1])\ntb=d.tables[0]\nassert len(tb.rows)==4 and len(tb.columns)==3\nprint('OK')",
      file,
    ],
    { encoding: "utf8", timeout: 30000 }
  );
  assert.equal(r.status, 0, `python 校验失败: ${r.stderr}`);
  assert.ok(r.stdout.includes("OK"));
});

test("表头行：真加粗（w:b）+ 跨页重复表头（tblHeader）", () => {
  const xml = blocksToDocumentXml([{ type: "table", rows: [["项目", "数值"], ["长度", "12"]] }]);
  assert.ok(xml.includes("<w:tr><w:trPr><w:tblHeader/></w:trPr>"), "首行标 tblHeader");
  assert.ok(xml.includes("<w:b/>"), "表头 run 加粗");
});

test("omml 模式：$…$ 转 Word 原生公式对象，解析失败回退原文", () => {
  const xml = blocksToDocumentXml([{ type: "p", text: "质能式 $E=mc^2$ 与未闭合 $\\frac{1" }], { formulaMode: "omml" });
  assert.ok(xml.includes('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'), "m 命名空间");
  assert.ok(xml.includes("<m:oMath>"), "行内公式对象");
  assert.ok(xml.includes("<m:sSup>"), "上标结构");
  assert.ok(xml.includes("$\\frac{1"), "未闭合公式回退原文");
  // unicode（默认）模式不产生公式对象
  const plain = blocksToDocumentXml([{ type: "p", text: "质能式 $E=mc^2$" }]);
  assert.ok(!plain.includes("<m:oMath>"));
});

test("omml 模式货币守卫：$5 至 $6 保持纯文本不转公式对象", () => {
  const xml = blocksToDocumentXml([{ type: "p", text: "价格 $5，运费 $6" }], { formulaMode: "omml" });
  assert.ok(!xml.includes("<m:oMath>"), "货币不成公式");
  assert.ok(xml.includes("$5，运费 $"), "金额定界符原文保留");
});

test("空表格块不产出 <w:tbl>（#20：旧版 Math.max(...[]) 造出空 tblGrid 的非法表格）", () => {
  const xml = blocksToDocumentXml([{ type: "table", rows: [], merges: [] }, { type: "p", text: "正文" }]);
  assert.ok(!xml.includes("<w:tbl>"), "空表不得产出表格元素");
  assert.ok(xml.includes("正文"), "正文照常输出");
});

test("omml 行内公式长度帽（#math：相隔很远的两个 $ 不吞整行当公式）", () => {
  const long = "价格 $" + "x".repeat(60) + "$ 元"; // 62 字符跨度 > 40 帽
  const xml = blocksToDocumentXml([{ type: "p", text: long }], { formulaMode: "omml" });
  assert.ok(!xml.includes("<m:oMath>"), "超长 $ 跨度不得转公式对象");
  assert.ok(xml.includes("x".repeat(60)), "原文保留");
  // 帽内正常转换不受影响
  const ok = blocksToDocumentXml([{ type: "p", text: "式 $E=mc^2$ 完" }], { formulaMode: "omml" });
  assert.ok(ok.includes("<m:oMath>"));
});

// ── 产物确定性（复审 ②）────────────────────────────────────────────────────
// docx 曾有两处时间戳走 new Date()：zip 每个条目的 mtime（dosDateTime）与
// docProps/core.xml 的 dcterms:created/modified。同一输入两次导出字节不同，
// golden 快照 / 产物 diff / 导出缓存全部失效。以下用例锁住"可复现"。
test("docx 确定性：同输入间隔跨秒两次导出，字节完全一致", async () => {
  const a = blocksToDocx(SAMPLE_BLOCKS, { title: "确定性" });
  await new Promise((r) => setTimeout(r, 1100)); // 越过秒边界：旧实现此处 zip mtime/core.xml 必不同
  const b = blocksToDocx(SAMPLE_BLOCKS, { title: "确定性" });
  assert.ok(a.equals(b), "两次导出字节必须一致（zip mtime + core.xml 均已固定）");
});

test("docx 确定性：createdAt 透传到 core.xml，且不同时间戳确实产出不同字节", () => {
  const t = Date.UTC(2026, 9, 15, 12, 0, 0);
  const a = blocksToDocx([{ type: "p", text: "x" }], { createdAt: t });
  const b = blocksToDocx([{ type: "p", text: "x" }], { createdAt: t });
  assert.ok(a.equals(b), "同一 createdAt 必须字节一致");
  assert.ok(a.toString("latin1").includes("2026-10-15T12:00:00Z"), "core.xml 使用透传时间戳");
  const c = blocksToDocx([{ type: "p", text: "x" }], { createdAt: t + 60000 });
  assert.ok(!a.equals(c), "时间戳不同 → 字节不同（证明该参数真生效，而非被忽略）");
});

test("docx 确定性：SOURCE_DATE_EPOCH 可复现构建惯例覆盖默认时间戳", () => {
  const prev = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = "1000000000"; // 2001-09-09T01:46:40Z
  try {
    const a = blocksToDocx([{ type: "p", text: "x" }]);
    assert.ok(a.toString("latin1").includes("2001-09-09T01:46:40Z"), "env 覆盖未生效");
  } finally {
    if (prev === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = prev;
  }
});

test("docx 确定性：多节路径 blocksToDocxPages 同样可复现", () => {
  const pages = [
    { blocks: [{ type: "p", text: "页一" }] },
    { blocks: [{ type: "p", text: "页二" }] },
  ];
  const t = Date.UTC(2026, 0, 2, 3, 4, 5);
  const a = blocksToDocxPages(pages, { createdAt: t });
  const b = blocksToDocxPages(pages, { createdAt: t });
  assert.ok(a.equals(b), "多节两次导出字节必须一致");
  assert.ok(a.toString("latin1").includes("2026-01-02T03:04:05Z"), "多节 core.xml 用透传时间戳");
});

test("docx 确定性：DOS 时间值域外的 createdAt 被夹取，不得崩溃（1970 / 2200）", () => {
  // DOS 时间字段只能表达 1980–2107；越界会让 writeUInt16LE 抛 ERR_OUT_OF_RANGE。
  // 源文件 mtime 被 touch 成 1970 时必须仍能导出，而不是整个导出失败。
  const a = blocksToDocx([{ type: "p", text: "x" }], { createdAt: 0 }); // 1970-01-01 → 夹到基准
  assert.equal(a.readUInt32LE(0), 0x04034b50, "1970 时间戳应被夹取而非抛错");
  const b = blocksToDocx([{ type: "p", text: "x" }], { createdAt: Date.UTC(2200, 0, 1) }); // → 夹到上界
  assert.equal(b.readUInt32LE(0), 0x04034b50, "2200 时间戳应被夹取而非抛错");
  // 同日再次调用仍可复现
  assert.ok(a.equals(blocksToDocx([{ type: "p", text: "x" }], { createdAt: 0 })));
});

test("docx 确定性：zip 条目时间按 UTC 编码（跨时区导出字节一致）", () => {
  // DOS 时间字段不带时区。若用本地分量编码，同一源文件在 GMT+8 与 UTC 的机器上
  // 会导出不同字节，"同一输入 → 同一字节"就跨不了机器。此处直接钉住 UTC 编码值。
  const t = Date.UTC(2026, 9, 15, 12, 34, 56); // 2026-10-15T12:34:56Z
  const buf = zipStore([{ name: "a.txt", data: "x" }], { dtime: t });
  assert.equal(buf.readUInt16LE(10), (12 << 11) | (34 << 5) | 28, "DOS 时间字段应为 UTC 12:34:56");
  assert.equal(buf.readUInt16LE(12), ((2026 - 1980) << 9) | (10 << 5) | 15, "DOS 日期字段应为 UTC 2026-10-15");
  // 同一时刻重复打包必须字节一致
  assert.ok(buf.equals(zipStore([{ name: "a.txt", data: "x" }], { dtime: t })));
  // core.xml 亦为 UTC（toISOString 本身即 UTC），与此保持同一时刻
  const docx = blocksToDocx([{ type: "p", text: "x" }], { createdAt: t });
  assert.ok(docx.toString("latin1").includes("2026-10-15T12:34:56Z"), "core.xml 与 zip 条目应是同一 UTC 时刻");
});

test("段落文本 \n 转 <w:br/>（后端整页目录识别为一块时行结构不丢）", () => {
  // OOXML 的 <w:t> 内 \n 在 Word 里不换行；须显式 <w:br/>（同表格路径口径）
  const xml = blocksToDocumentXml([{ type: "p", text: "初版序言 ..... 1\n再版序言 ..... 2" }]);
  assert.ok(xml.includes("初版序言 ..... 1</w:t></w:r><w:r><w:br/></w:r>"), "换行处应为 <w:br/>");
  assert.ok(!/<w:t[^>]*>[^<]*\n/.test(xml), "<w:t> 内不得残留裸 \n");
  // 标题同口径
  const h = blocksToDocumentXml([{ type: "h2", text: "第三章 国家与革命\n馬克思的分析" }]);
  assert.ok(h.includes("<w:br/>"));
  // CRLF 亦按换行处理
  const crlf = blocksToDocumentXml([{ type: "p", text: "甲\r\n乙" }]);
  assert.ok(crlf.includes("<w:br/>"));
  assert.ok(!crlf.includes("甲\r"));
});
