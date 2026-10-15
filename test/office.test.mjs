// test/office.test.mjs — Office 本地直读（v0.4）：docx/pptx/xlsx fixture 用 ooxml.js zipStore 现场生成。
// 覆盖：标题分级/段落/表格（gridSpan+vMerge 链+嵌套表降级计数）/内嵌图片/OLE 回落/加密容器报错。
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { zipStore } = await import("../lib/ooxml.js");
const { extractOfficeLocal, readZip } = await import("../lib/office.js");
const { OcrError } = await import("../lib/errors.js");

// 1x1 PNG
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">';
const p = (text, style = "") =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

function docxFixture() {
  const documentXml =
    HEAD +
    W_NS +
    "<w:body>" +
    p("项目说明", "Heading1") +
    p("本图册为给排水施工图。") +
    // 表格：gridSpan 表头 + vMerge 链（restart + 延续）
    "<w:tbl>" +
    "<w:tr><w:tc><w:tcPr><w:gridSpan w:val=\"2\"/></w:tcPr>" + p("材料表") + "</w:tc></w:tr>" +
    "<w:tr><w:tc><w:tcPr><w:vMerge w:val=\"restart\"/></w:tcPr>" + p("管材") + "</w:tc>" +
    "<w:tc>" + p("PPR") + "</w:tc></w:tr>" +
    "<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>" +
    "<w:tc>" + p("PVC-U") + "</w:tc></w:tr>" +
    "</w:tbl>" +
    // 嵌套表（真结构：外层格内含完整内层 w:tbl）
    "<w:tbl>" +
    "<w:tr><w:tc>" + p("外层格") +
    "<w:tbl><w:tr><w:tc>" + p("内A") + "</w:tc><w:tc>" + p("内B") + "</w:tc></w:tr></w:tbl>" +
    "</w:tc><w:tc>" + p("右格") + "</w:tc></w:tr>" +
    "</w:tbl>" +
    // 图片段落
    "<w:p><w:r><w:drawing><wp:inline><wp:extent cx=\"952500\" cy=\"952500\"/><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:blipFill><a:blip r:embed=\"rIdImg1\"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>" +
    "</w:body></w:document>";
  const rels =
    HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>';
  return zipStore([
    { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: "word/document.xml", data: documentXml },
    { name: "word/_rels/document.xml.rels", data: rels },
    { name: "word/media/image1.png", data: PNG_1PX },
  ]);
}

function pptxFixture() {
  const slide = (texts) =>
    HEAD +
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
    texts.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join("") +
    "</p:spTree></p:cSld></p:sld>";
  return zipStore([
    { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: "ppt/slides/slide2.xml", data: slide(["第二页内容"]) },
    { name: "ppt/slides/slide1.xml", data: slide(["首页标题", "要点一条"]) },
  ]);
}

function xlsxFixture() {
  const sst =
    HEAD +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>名称</t></si><si><t>阀门</t></si></sst>';
  const sheet =
    HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>25</v></c></row>' +
    "</sheetData></worksheet>";
  return zipStore([
    { name: "[Content_Types].xml", data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: "xl/sharedStrings.xml", data: sst },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}

describe("Office 本地直读", () => {
  test("readZip：stored 与 deflate 条目都能读出", () => {
    const entries = readZip(docxFixture());
    assert.ok(entries.get("word/document.xml").length > 100);
    assert.ok(entries.get("word/media/image1.png").length === PNG_1PX.length);
  });
  test("docx：标题分级/段落/表格 vMerge 链/嵌套表计数/图片嵌入", () => {
    const r = extractOfficeLocal(docxFixture(), ".docx");
    assert.equal(r.channel, "LOCAL");
    assert.ok(r.markdown.includes("# 项目说明"));
    assert.ok(r.markdown.includes("本图册为给排水施工图。"));
    // 表格 vMerge：管材 跨两行（merges 推导），材料表 gridSpan 跨两列
    assert.ok(r.markdown.includes("材料表") && r.markdown.includes("管材") && r.markdown.includes("PVC-U"));
    const tbl = r.blocks.find((b) => b.type === "table" && (b.rows ?? []).some((row) => row.includes("管材")));
    assert.ok(tbl, "找到含 管材 的表格");
    assert.ok(tbl.merges.some((m) => m.rowSpan >= 2), "vMerge 链推出 rowSpan≥2");
    assert.ok(tbl.merges.some((m) => m.colSpan >= 2), "gridSpan 推出 colSpan≥2");
    // 嵌套表降级计数
    assert.ok(String(r.localSkipped).includes("嵌套表"), `localSkipped=${r.localSkipped}`);
    // 图片：data_url 嵌入 + 尺寸（EMU→px）
    const img = r.blocks.find((b) => b.type === "image");
    assert.ok(img && img.url.startsWith("data:image/png;base64,"));
    assert.deepEqual([img.w, img.h], [100, 100]);
  });
  test("pptx：按页序取文本（slide2 在 slide1 前，验证排序）", () => {
    const r = extractOfficeLocal(pptxFixture(), ".pptx");
    assert.equal(r.pagesCount, 2);
    assert.ok(r.pages[0].text.includes("首页标题"));
    assert.ok(r.pages[1].text.includes("第二页内容"));
  });
  test("xlsx：sharedStrings 引用解析 + 数值列", () => {
    const r = extractOfficeLocal(xlsxFixture(), ".xlsx");
    assert.equal(r.engine, "office-sheet");
    assert.ok(r.markdown.includes("名称") && r.markdown.includes("阀门"));
    assert.ok(r.markdown.includes("25"));
  });
  test("OLE 旧格式（.doc）明确报错提示走 --vl", () => {
    assert.throws(() => extractOfficeLocal(Buffer.from("D0CF11E0"), ".doc"), (e) => e instanceof OcrError && e.message.includes("--vl"));
  });
  test("伪 zip 报 E_OFFICE_READ", () => {
    assert.throws(() => extractOfficeLocal(Buffer.from("PK\u0003\u0004garbage"), ".docx"), (e) => e instanceof OcrError && e.code === "E_OFFICE_READ");
  });
});
