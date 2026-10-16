// test/markdown.test.mjs — markdown ⇄ 块结构
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToBlocks, blocksToMarkdown, stripInline, extractTables, stripPageNumberLines } from "../lib/markdown.js";

test("标题层级映射（h4-h6 截到 h3）", () => {
  const blocks = markdownToBlocks("# 一\n## 二\n### 三\n#### 四");
  assert.deepEqual(blocks.map((b) => b.type), ["h1", "h2", "h3", "h3"]);
  assert.equal(blocks[0].text, "一");
});

test("连续普通行合并为一段（CJK 不加空格、西文加空格）", () => {
  const blocks = markdownToBlocks("你好\n世界\nHello\nWorld");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "你好世界 Hello World");
  const en = markdownToBlocks("Hello\nWorld");
  assert.equal(en[0].text, "Hello World");
});

test("标准 md 表格解析成 rows，并对齐列宽", () => {
  const md = "| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 |";
  const blocks = markdownToBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].rows, [
    ["名称", "数量"],
    ["苹果", "3"],
    ["香蕉", ""],
  ]);
});

test("代码围栏整块保留", () => {
  const blocks = markdownToBlocks("前文\n```\nconst a=1;\nconst b=2;\n```\n后文");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["p", "code", "p"]
  );
  assert.deepEqual(blocks[1].lines, ["const a=1;", "const b=2;"]);
});

test("blocksToMarkdown 表格往返", () => {
  const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
  const blocks = markdownToBlocks(md);
  const out = blocksToMarkdown(blocks);
  assert.equal(out, md);
});

test("blocksToMarkdown 标题与段落", () => {
  const out = blocksToMarkdown([
    { type: "h1", text: "标题" },
    { type: "p", text: "正文" },
  ]);
  assert.equal(out, "# 标题\n\n正文");
});

test("stripInline 剥离加粗/斜体/行内代码/链接", () => {
  assert.equal(stripInline("**加粗**普通"), "加粗普通");
  assert.equal(stripInline("`code` x"), "code x");
  assert.equal(stripInline("[文字](http://x.y)"), "文字");
  assert.equal(stripInline("*斜体*"), "斜体");
});

test("extractTables 只取表格块", () => {
  const blocks = markdownToBlocks("# t\n| a | b |\n| --- | --- |\n| 1 | 2 |\n正文");
  const tables = extractTables(blocks);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0][0], ["a", "b"]);
});

test("CRLF 与空行容错", () => {
  const blocks = markdownToBlocks("行一\r\n\r\n行二\r");
  assert.deepEqual(blocks.map((b) => b.text), ["行一", "行二"]);
});

test("公式清洗：unicode 默认开、raw 保留 LaTeX 源", () => {
  const blocks = markdownToBlocks("圆周率 $\\pi\\approx 3.14$");
  assert.equal(blocks[0].text, "圆周率 π≈ 3.14");
  const raw = markdownToBlocks("圆周率 $\\pi\\approx 3.14$", { formulaMode: "raw" });
  assert.equal(raw[0].text, "圆周率 $\\pi\\approx 3.14$");
});

test("货币金额不成对当数学定界符剥离", () => {
  const blocks = markdownToBlocks("价格 $5，运费 $6");
  assert.equal(blocks[0].text, "价格 $5，运费 $6");
});

test("缺首尾竖线的 md 表格可识别（GFM 风格）", () => {
  const md = "名称 | 数量\n--- | ---\n苹果 | 3";
  const blocks = markdownToBlocks(md);
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].rows, [["名称", "数量"], ["苹果", "3"]]);
});

test("\\| 转义竖线不拆列", () => {
  const md = "| 名称 | 别名 |\n| --- | --- |\n| 甲\\|乙 | 丙 |";
  const blocks = markdownToBlocks(md);
  assert.deepEqual(blocks[0].rows, [["名称", "别名"], ["甲|乙", "丙"]]);
});

test("blocksToMarkdown：单元格含 | 转义为 \\|，再解析不拆列（#9）", () => {
  const out = blocksToMarkdown([{ type: "table", rows: [["名称", "别名"], ["甲|乙", "丙|丁"]] }]);
  assert.equal(out, "| 名称 | 别名 |\n| --- | --- |\n| 甲\\|乙 | 丙\\|丁 |");
  const blocks = markdownToBlocks(out);
  assert.deepEqual(blocks[0].rows, [["名称", "别名"], ["甲|乙", "丙|丁"]]);
});

test("<html> 包裹的表格输出提取其中全部表格", () => {
  const md = "<html><body><table><tr><td>a</td><td>b</td></tr></table></body></html>";
  const blocks = markdownToBlocks(md);
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].rows, [["a", "b"]]);
});

test("stripPageNumberLines：≥10 行孤立数字整体剥离（markdown 路径页码），少量保留", () => {
  const md = Array.from({ length: 12 }, (_, i) => `内容段${i}\n\n${i + 1}`).join("\n\n");
  const r = stripPageNumberLines(md);
  assert.equal(r.removed, 12);
  assert.ok(!/\n\n1\n\n/.test(r.text), "页码行已删");
  assert.ok(r.text.includes("内容段0"));
  // 少量孤立数字（可能是正文）不剥
  assert.equal(stripPageNumberLines("内容一\n\n3\n\n内容二").removed, 0);
  // 带文字的编号行不是孤立数字
  assert.equal(stripPageNumberLines("3. 工艺流程\n4. 验收标准\n5. 成品保护\n6. 效果图\n7. 附图\n8. 附表\n9. 记录\n10. 样表\n11. 清单\n12. 说明").removed, 0);
});

test("行尾双空格硬换行：同段保形为 \n，软换行仍按 CJK/西文规则合并", () => {
  // 目录页实测形态：每条一行、行尾两个空格——行结构必须保住，不能并成流水段
  const toc = markdownToBlocks("初版序言 ..... 1  \n再版序言 ..... 2  \n第一章 阶级社会和国家 ..... 3");
  assert.equal(toc.length, 1);
  assert.equal(toc[0].type, "p");
  assert.equal(toc[0].text, "初版序言 ..... 1\n再版序言 ..... 2\n第一章 阶级社会和国家 ..... 3");
  // 混排：硬换行处保形，软换行处仍合并（CJK 无空格）
  const mixed = markdownToBlocks("第一行  \n第二行\n第三行");
  assert.equal(mixed[0].text, "第一行\n第二行第三行");
  // 行尾单个空格不是硬换行
  const soft = markdownToBlocks("甲 \n乙");
  assert.equal(soft[0].text, "甲乙");
});

test("blocksToMarkdown：段内 \n 回写为行尾双空格硬换行，往返保形", () => {
  const blocks = [{ type: "p", text: "初版序言 ..... 1\n再版序言 ..... 2" }];
  const md = blocksToMarkdown(blocks);
  assert.equal(md, "初版序言 ..... 1  \n再版序言 ..... 2");
  const reparsed = markdownToBlocks(md);
  assert.equal(reparsed[0].text, blocks[0].text);
});
