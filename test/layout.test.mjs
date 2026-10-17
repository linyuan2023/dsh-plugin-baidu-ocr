// test/layout.test.mjs — 版面 JSON → 块流（第 1/3 期）：排序/类型映射/双栏/字号分级/头尾过滤/table_html/图片
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutToBlocks, layoutToPageBlocks, htmlToRows, mdTableToRows, mergeCrossPageTables, buildTableFromCells, HEADER_TYPES } from "../lib/layout.js";
import { layoutToDocModel, docModelToContentList } from "../lib/docmodel.js";

const L = (type, x, y, w, h, extra = {}) => ({ type, text: extra.text ?? "", position: [x, y, w, h], ...extra });

test("单栏：按 y 排序，类型映射正确", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("text", 100, 300, 800, 40, { text: "第二段" }),
          L("paragraph_title", 100, 100, 400, 50, { text: "标题" }),
          L("text", 100, 200, 800, 40, { text: "第一段" }),
        ],
        images: [],
      },
    ],
  };
  const { blocks } = layoutToBlocks(json);
  assert.deepEqual(
    blocks.map((b) => `${b.type}:${b.text ?? ""}`),
    ["h2:标题", "p:第一段", "p:第二段"]
  );
});

test("页眉页脚：默认过滤并计数；保留时进 header/footer", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("header", 0, 0, 800, 30, { text: "页眉文字" }),
          L("text", 0, 100, 800, 40, { text: "正文" }),
          L("footer", 0, 1000, 800, 30, { text: "页脚文字" }),
          L("header_image", 0, 10, 100, 40),
        ],
        images: [],
      },
    ],
  };
  const filtered = layoutToBlocks(json, { filterHeaderFooter: true });
  assert.deepEqual(filtered.blocks.map((b) => b.text), ["正文"]);
  assert.equal(filtered.stats.filteredHF, 3); // header + footer + header_image

  const kept = layoutToBlocks(json, { filterHeaderFooter: false });
  assert.deepEqual(kept.blocks.map((b) => b.text), ["正文"]);
  assert.equal(kept.header, "页眉文字");
  assert.equal(kept.footer, "页脚文字");
});

test("table 块：table_html 解析为 rows（内嵌标签/实体剥离）", () => {
  const html = "<table><tr><th>名称<b>x</b></th><th>数量</th></tr><tr><td>A &amp; B</td><td>3</td></tr></table>";
  const json = {
    pages: [{ layouts: [L("table", 0, 0, 500, 100, { table_html: html })], images: [] }],
  };
  const { blocks } = layoutToBlocks(json);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].rows, [
    ["名称x", "数量"],
    ["A & B", "3"],
  ]);
});

test("image 块：按 layout_id 匹配 images[].data_url；无图降级段落", () => {
  const json = {
    pages: [
      {
        layouts: [L("image", 0, 0, 200, 100), L("image", 0, 150, 200, 100, { text: "图注" })],
        images: [],
      },
    ],
  };
  json.pages[0].layouts[0].layout_id = "ly1";
  json.pages[0].images.push({ layout_id: "ly1", data_url: "http://x/0-0.jpg" });
  const { blocks } = layoutToBlocks(json);
  assert.equal(blocks[0].type, "image");
  assert.equal(blocks[0].url, "http://x/0-0.jpg");
  assert.equal(blocks[0].w, 200);
  // 第二个 image 块无匹配图片 → 文本降级段落
  assert.equal(blocks[1].type, "p");
  assert.equal(blocks[1].text, "图注");
});

test("第 3 期双栏重建：左右各 ≥3 块 → 左栏先于右栏；全宽标题前置", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("text", 520, 200, 400, 40, { text: "右1" }), // 右栏
          L("text", 80, 200, 400, 40, { text: "左1" }), // 左栏
          L("paragraph_title", 80, 300, 400, 44, { text: "左2" }), // 左栏（44px 行高）
          L("text", 520, 300, 400, 40, { text: "右2" }),
          L("text", 80, 400, 400, 40, { text: "左3" }),
          L("text", 520, 400, 400, 40, { text: "右3" }),
          L("title", 0, 60, 900, 60, { text: "全文标题" }), // 全宽
        ],
        images: [],
      },
    ],
  };
  const { blocks } = layoutToBlocks(json);
  const texts = blocks.map((b) => b.text);
  assert.deepEqual(texts, ["全文标题", "左1", "左2", "左3", "右1", "右2", "右3"]);
});

test("第 3 期字号分级：标题块高/正文行高 ≥1.4 → h1，≥1.1 → h2，否则 h3", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("text", 0, 100, 800, 40, { text: "单行正文，块高40=行高" }),
          L("paragraph_title", 0, 200, 800, 60, { text: "大标题（60/40=1.5）" }),
          L("paragraph_title", 0, 300, 800, 46, { text: "中标题（46/40=1.15）" }),
          L("paragraph_title", 0, 400, 800, 42, { text: "小标题（42/40=1.05）" }),
          L("text", 0, 500, 800, 40, { text: "正文" }),
        ],
        images: [],
      },
    ],
  };
  const { blocks } = layoutToBlocks(json);
  assert.deepEqual(
    blocks.map((b) => `${b.type}:${b.text}`),
    ["p:单行正文，块高40=行高", "h1:大标题（60/40=1.5）", "h2:中标题（46/40=1.15）", "h3:小标题（42/40=1.05）", "p:正文"]
  );
});

test("span_boxes 防御性解析：元素带 height 时参与标题分级", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("text", 0, 100, 800, 40, { text: "正文" }),
          L("paragraph_title", 0, 200, 800, 40, { text: "标题", span_boxes: [{ height: 64 }] }), // 64/40=1.6 → h1
          L("text", 0, 300, 800, 40, { text: "正文" }),
        ],
        images: [],
      },
    ],
  };
  const { blocks } = layoutToBlocks(json);
  assert.equal(blocks[1].type, "h1");
});

test("字号密度法（v0.4.1）：隐形合并行的 text 块按字符密度折算 em，不再把块高当字号", () => {
  // 实测样例（guojia 142字块）：W=649 H=224 N≈142（全角），真实 6 行、em≈27.4px。
  // 旧算法把它当"多行正文"回退正文行高（72px），折算 pt 后放大 2.6 倍撞 clamp。
  const chars142 = "頸裼决不是“迷恋”，决不是夸张，也决不是論战伎俩。必須不断教育群众，使他們这样來認識暴力革命，而且只能这样來認識暴力革命，这正是馬克思和恩格斯全部學說的基础。現在占統治地位的社會沙文主义和考茨基主义流派對馬克思和恩格斯學說的背叛，最突出地表現在这兩个流派都把这方面的宜传和鼓勵忘訊了。";
  const json = {
    pages: [
      {
        width: 783,
        height: 1175,
        layouts: [
          L("text", 72, 149, 649, 224, { text: chars142 }),
          L("text", 146, 788, 510, 36, { text: "从这一事实中可以得出两个结论：" }), // 单行：字号=块高
          L("text", 0, 900, 600, 80, { text: "显式两行：\n块高80" }), // 显式 \n：80/2=40
        ],
        images: [],
      },
    ],
  };
  const pages = layoutToPageBlocks(json, { mergeMode: "off" });
  const [merged, single, explicit] = pages[0].blocks;
  // em = sqrt(649×224/(1.3×142)) ≈ 28.1，与实测 27.4 相差 <3%
  assert.ok(Math.abs(merged._fontUnits - 28.1) < 1.5, `密度法 em=${merged._fontUnits}，期望 ≈28.1`);
  assert.equal(single._fontUnits, 36, "单行块字号=块高");
  assert.equal(explicit._fontUnits, 40, "显式两行字号=块高/行数");
});

test("未知类型：有文本 → 段落；纯装饰 → 跳过并记录", () => {
  const json = {
    pages: [
      {
        layouts: [L("seal", 0, 0, 100, 100, { text: "印章文字" }), L("watermark", 0, 200, 300, 80)],
        images: [],
      },
    ],
  };
  const { blocks, stats } = layoutToBlocks(json);
  assert.deepEqual(blocks.map((b) => b.text), ["印章文字"]);
  assert.deepEqual(stats.unknownTypes, ["watermark"]);
});

// ── v0.4.1 标题分级 markdown 信号源（P2：扫描书"全 h3"根因修复）──
import { applyMarkdownHeadingLevels } from "../lib/layout.js";

test("markdown 标题分级：guojia 场景（##/### 且块高≈正文）→ h2/h2/h3，不再全落 h3", () => {
  // 实测：guojia 三个 paragraph_title 块高≈正文行高（比值<1.1），旧规则全落 h3；
  // markdown 给出 ## 第 二 章 / ## 国家与革命… / ### 1. 革命的前夜
  const json = {
    pages: [
      {
        layouts: [
          L("text", 0, 100, 800, 40, { text: "正文块，块高40=行高" }),
          L("paragraph_title", 0, 200, 800, 42, { text: "第 二 章" }),
          L("paragraph_title", 0, 300, 800, 42, { text: "国家与革命 1848—1851 年的經驗" }),
          L("paragraph_title", 0, 400, 800, 42, { text: "1. 革命的前夜" }),
          L("text", 0, 500, 800, 40, { text: "正文" }),
        ],
        images: [],
      },
    ],
  };
  applyMarkdownHeadingLevels(json, ["## 第 二 章\n\n## 国家与革命 1848—1851 年的經驗\n\n### 1. 革命的前夜\n\n正文……"]);
  const blocks = layoutToPageBlocks(json, { mergeMode: "off" })[0].blocks;
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["p", "h2", "h2", "h3", "p"]
  );
});

test("markdown 标题分级：xuanyan 基线复现（顶级比值≥1.4 → h1，否则 h2）", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("text", 0, 100, 800, 40, { text: "正文" }),
          L("paragraph_title", 0, 200, 800, 64, { text: "共产党宣言" }), // 64/40=1.6 → h1
          L("paragraph_title", 0, 300, 800, 46, { text: "资产者和无产者" }), // 46/40=1.15 → h2
          L("text", 0, 400, 800, 40, { text: "正文" }),
        ],
        images: [],
      },
    ],
  };
  applyMarkdownHeadingLevels(json, ["## 共产党宣言\n\n## 资产者和无产者"]);
  const blocks = layoutToPageBlocks(json, { mergeMode: "off" })[0].blocks;
  assert.deepEqual(blocks.map((b) => b.type), ["p", "h1", "h2", "p"]);
});

test("markdown 标题分级：text 块命中标题行时晋升（VL 漏标 title 场景）；去空白匹配；围栏内 # 不算标题", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("text", 0, 100, 800, 40, { text: "正文" }),
          L("text", 0, 200, 800, 50, { text: "总 论" }), // markdown "## 总论" 去空白后命中 → 晋升
          L("text", 0, 300, 800, 40, { text: "## 不是标题（围栏内）" }),
          L("paragraph_title", 0, 400, 800, 42, { text: "真标题" }),
        ],
        images: [],
      },
    ],
  };
  applyMarkdownHeadingLevels(json, ["```\n## 不是标题（围栏内）\n```\n\n## 总论\n\n### 真标题"]);
  const blocks = layoutToPageBlocks(json, { mergeMode: "off" })[0].blocks;
  assert.deepEqual(
    blocks.map((b) => `${b.type}:${b.text}`),
    ["p:正文", "h2:总 论", "p:## 不是标题（围栏内）", "h3:真标题"]
  );
});

test("markdown 标题分级：无 markdown/未命中时行为与旧规则完全一致", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("text", 0, 100, 800, 40, { text: "正文" }),
          L("paragraph_title", 0, 200, 800, 42, { text: "小标题（1.05 → h3）" }),
          L("paragraph_title", 0, 300, 800, 64, { text: "大标题（1.6 → h1）" }),
        ],
        images: [],
      },
    ],
  };
  // markdown 里没有对应标题行 → 无标注 → 旧比值规则
  applyMarkdownHeadingLevels(json, ["## 别的文档的标题"]);
  const blocks = layoutToPageBlocks(json, { mergeMode: "off" })[0].blocks;
  assert.deepEqual(blocks.map((b) => b.type), ["p", "h3", "h1"]);
});

test("markdown 标题分级：含 # 封面的完整文档（big40p 场景）→ 章级 h2、节级 h3", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("doc_title", 0, 100, 800, 70, { text: "国家与革命" }),
          L("paragraph_title", 0, 200, 800, 46, { text: "第 二 章" }), // ## → h2（不再被 tier 规则压成 h3）
          L("paragraph_title", 0, 300, 800, 42, { text: "1. 革命的前夜" }), // ### → h3
          L("text", 0, 400, 800, 40, { text: "正文" }),
        ],
        images: [],
      },
    ],
  };
  applyMarkdownHeadingLevels(json, ["# 国家与革命\n\n## 第 二 章\n\n### 1. 革命的前夜"]);
  const blocks = layoutToPageBlocks(json, { mergeMode: "off" })[0].blocks;
  assert.deepEqual(blocks.map((b) => b.type), ["h1", "h2", "h3", "p"]);
});

test("htmlToRows：colspan 网格占位 + merges", () => {
  const h = htmlToRows("<tr><td colspan=\"2\">跨列</td></tr><tr><td>a</td><td>b</td></tr>");
  assert.deepEqual(h.rows, [["跨列", ""], ["a", "b"]]);
  assert.deepEqual(h.merges, [{ r: 0, c: 0, rowSpan: 1, colSpan: 2 }]);
});

test("HEADER_TYPES 覆盖实测枚举", () => {
  for (const t of ["header", "footer", "header_image", "footer_image"]) assert.ok(HEADER_TYPES.has(t), t);
});

test("第 3 期双栏误判防护：单栏文档（真实截图坐标）不启用双栏", () => {
  // 用真实探针数据（学术文章截图，单栏流）——曾经被旧判定误判为双栏
  const layouts = [
    L("paragraph_title", 717, 145, 460, 30, { text: "作者行" }),
    L("text", 451, 217, 980, 357, { text: "摘要" }),
    L("text", 502, 582, 603, 30, { text: "关键词" }),
    L("paragraph_title", 905, 676, 75, 29, { text: "目次" }),
    L("paragraph_title", 454, 728, 152, 29, { text: "一、问题的提出" }),
    L("text", 452, 768, 419, 29, { text: "二、流转后" }),
    L("text", 463, 809, 427, 29, { text: "（一）" }),
    L("text", 464, 850, 448, 28, { text: "（二）" }),
    L("text", 454, 891, 417, 27, { text: "三、流转后" }),
    L("image", 438, 951, 52, 51),
    L("text", 496, 961, 214, 31, { text: "编辑部" }),
  ];
  const { blocks } = layoutToBlocks({ pages: [{ layouts, images: [] }] });
  const texts = blocks.map((b) => b.text);
  // 单栏 y 序：作者行最前，摘要第二……（若误判双栏会变成 摘要→一、→…→编辑部→作者行→关键词→目次）
  assert.deepEqual(texts.slice(0, 3), ["作者行", "摘要", "关键词"]);
});

test("双栏沟判定：左右 x 区间有沟才启用", () => {
  // 有沟：左栏 [80,480]，右栏 [520,920]，沟 40px > 2%*920=18.4
  const good = {
    pages: [{ layouts: [
      L("title", 0, 60, 900, 60, { text: "题" }),
      L("text", 80, 200, 400, 40, { text: "左1" }),
      L("text", 80, 300, 400, 40, { text: "左2" }),
      L("text", 80, 400, 400, 40, { text: "左3" }),
      L("text", 520, 200, 400, 40, { text: "右1" }),
      L("text", 520, 300, 400, 40, { text: "右2" }),
      L("text", 520, 400, 400, 40, { text: "右3" }),
    ], images: [] }],
  };
  const t1 = layoutToBlocks(good).blocks.map((b) => b.text);
  assert.deepEqual(t1.slice(0, 4), ["题", "左1", "左2", "左3"]);
  // 无沟：右栏左移到 [420,820] 与左栏 [80,480] 重叠 → 单栏
  const bad = {
    pages: [{ layouts: [
      L("text", 80, 200, 400, 40, { text: "左1" }),
      L("text", 80, 300, 400, 40, { text: "左2" }),
      L("text", 80, 400, 400, 40, { text: "左3" }),
      L("text", 420, 210, 400, 40, { text: "右1" }),
      L("text", 420, 310, 400, 40, { text: "右2" }),
      L("text", 420, 410, 400, 40, { text: "右3" }),
      L("text", 80, 500, 400, 40, { text: "左4" }),
    ], images: [] }],
  };
  const t2 = layoutToBlocks(bad).blocks.map((b) => b.text);
  assert.deepEqual(t2, ["左1", "右1", "左2", "右2", "左3", "右3", "左4"]); // 纯 y 序
});

test("公文序号分级：一、→h2（即使块高小于正文），（一）→h3，doc_title→h1", () => {
  // 实测自某公文 PDF：标题块高 18-20 反而小于正文块高 29-30，纯字号比对失灵
  const json = {
    pages: [
      {
        layouts: [
          L("doc_title", 100, 89, 500, 25, { text: "某市组织工作实施方案" }),
          L("text", 100, 145, 800, 30, { text: "正文单行，块高30" }),
          L("paragraph_title", 100, 302, 300, 18, { text: "一、目标要求" }), // 18/30 → 字号法会错判 h3
          L("paragraph_title", 100, 350, 300, 18, { text: "（一）加强组织领导" }),
          L("paragraph_title", 100, 400, 300, 18, { text: "附标题无序号" }), // 无序号 → 字号法 → h3
        ],
        images: [],
      },
    ],
  };
  const { blocks } = layoutToBlocks(json);
  assert.deepEqual(
    blocks.map((b) => `${b.type}:${(b.text ?? "").slice(0, 8)}`),
    ["h1:某市组织工作实施", "p:正文单行，块高3", "h2:一、目标要求", "h3:（一）加强组织领", "h3:附标题无序号"]
  );
});

test("第 3 期表格合并：matrix+cells 重建 rows/merges（公文表格数据）", () => {
  const t = {
    layout_id: "T1",
    matrix: [[0, 1, 2], [3, 4, 5], [3, 4, 6], [3, 4, 7]],
    cells: [
      { text: "聚焦方面" }, { text: "自查要点" }, { text: "问题表现形式" },
      { text: "聚焦干部队伍建设和基层组织建设方面" },
      { text: "(一)领导班子自身建设情况。" },
      { text: "1. 表率作用" }, { text: "2. 民主集中制" }, { text: "3. 党内政治生活" },
    ],
    markdown: "| a | b | c |\n| --- | --- | --- |\n| x | 重复 | 填充 |",
  };
  const json = { pages: [{ layouts: [L("table", 0, 0, 900, 600)], tables: [t], images: [] }] };
  const { blocks } = layoutToBlocks(json);
  assert.equal(blocks.length, 1);
  const tb = blocks[0];
  // matrix+cells 优先于 markdown（重复填充被弃用）
  assert.equal(tb.rows[1][0], "聚焦干部队伍建设和基层组织建设方面");
  assert.equal(tb.rows[2][0], ""); // 被合并覆盖的格为空
  assert.deepEqual(tb.merges, [
    { r: 1, c: 0, rowSpan: 3, colSpan: 1 },
    { r: 1, c: 1, rowSpan: 3, colSpan: 1 },
  ]);
  // 表头行不受影响
  assert.deepEqual(tb.rows[0], ["聚焦方面", "自查要点", "问题表现形式"]);
});

test("乱码校验：FFFD/CID/私用区/拉丁连串检出，干净文本放行", async () => {
  const { checkGarbled } = await import("../lib/validate.js");
  assert.equal(checkGarbled("正常的中文识别结果，没有任何问题。"), null);
  assert.ok(checkGarbled("识别出替换符\ufffd和更多\ufffd内容").includes("U+FFFD"));
  assert.ok(checkGarbled("公式 (cid:123) 未映射").includes("CID"));
  assert.ok(checkGarbled("私用区\ue000字符").includes("私用区"));
  assert.ok(checkGarbled("éàûè 连串在中文文档中").includes("编码错乱"));
  assert.equal(checkGarbled("café 的菜单"), null); // 正常西文单词不误伤
});

test("htmlToRows：<br> 保留单元格内换行（旧版剥标签后粘连）", () => {
  const h = htmlToRows("<tr><td>甲<br>乙</td><td>丙</td></tr>");
  assert.deepEqual(h.rows, [["甲\n乙", "丙"]]);
});

test("htmlToRows：嵌套表格 → nested 结构（v0.4 表格真嵌套；格内文本不丢）", () => {
  const h = htmlToRows("<tr><td>外<table><tr><td>内1</td><td>内2</td></tr></table></td><td>右</td></tr>");
  assert.equal(h.rows.length, 1);
  // 嵌套格变为 {nested, text}（docx 原生嵌套 w:tbl 用）；普通格仍是字符串
  assert.equal(h.rows[0][0].text, "外");
  assert.deepEqual(h.rows[0][0].nested.rows, [["内1", "内2"]]);
  assert.equal(h.rows[0][1], "右");
});

test("htmlToRows：末行 rowspan 越界裁掉幻影尾行并收敛 merges", () => {
  const h = htmlToRows("<tr><td rowspan=\"3\">A</td><td>x</td></tr>");
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.merges, []);
});

test("htmlToRows：空 <tr> 保留空行占位（行号对齐来源）", () => {
  const h = htmlToRows("<tr><td>a</td></tr><tr></tr><tr><td>b</td></tr>");
  assert.equal(h.rows.length, 3);
  assert.deepEqual(h.rows[1], [""]);
});

test("跨页续表拼接：重复表头去重合并，merges 行号平移", () => {
  const json = {
    pages: [
      { layouts: [L("table", 0, 0, 500, 400, { table_html: "<tr><th>名称</th><th>数量</th></tr><tr><td>苹果</td><td>3</td></tr>" })], images: [] },
      { layouts: [L("table", 0, 0, 500, 400, { table_html: "<tr><th>名称</th><th>数量</th></tr><tr><td>香蕉</td><td>4</td></tr>" })], images: [] },
    ],
  };
  const pages = layoutToPageBlocks(json);
  assert.equal(pages[0].blocks.length, 1);
  assert.equal(pages[1].blocks.length, 0);
  assert.deepEqual(pages[0].blocks[0].rows, [["名称", "数量"], ["苹果", "3"], ["香蕉", "4"]]);
});

test("跨页续表：首行不同（恰好相邻的两张独立表）不合并", () => {
  const json = {
    pages: [
      { layouts: [L("table", 0, 0, 500, 400, { table_html: "<tr><th>名称</th><th>数量</th></tr><tr><td>苹果</td><td>3</td></tr>" })], images: [] },
      { layouts: [L("table", 0, 0, 500, 400, { table_html: "<tr><th>品名</th><th>数量</th></tr><tr><td>香蕉</td><td>4</td></tr>" })], images: [] },
    ],
  };
  const pages = layoutToPageBlocks(json);
  assert.equal(pages[0].blocks.length, 1);
  assert.equal(pages[1].blocks.length, 1);
});

test("跨页续表 strict：3 页链式合并（#4：旧版第 3 页起挂不上）", () => {
  const hdr = "<tr><th>名称</th><th>数量</th></tr>";
  const json = {
    pages: [
      { layouts: [L("table", 0, 0, 500, 400, { table_html: hdr + "<tr><td>苹果</td><td>3</td></tr>" })], images: [] },
      { layouts: [L("table", 0, 0, 500, 400, { table_html: hdr + "<tr><td>香蕉</td><td>4</td></tr>" })], images: [] },
      { layouts: [L("table", 0, 0, 500, 400, { table_html: hdr + "<tr><td>樱桃</td><td>5</td></tr>" })], images: [] },
    ],
  };
  const pages = layoutToPageBlocks(json);
  assert.equal(pages[0].blocks.length, 1);
  assert.equal(pages[1].blocks.length, 0, "第 2 页表被摘除");
  assert.equal(pages[2].blocks.length, 0, "第 3 页表也被摘除（carry 链式）");
  assert.deepEqual(pages[0].blocks[0].rows, [["名称", "数量"], ["苹果", "3"], ["香蕉", "4"], ["樱桃", "5"]]);
});

test("跨页续表 loose：3 页链式合并且 _pos 前移（#4）", () => {
  const mk = (rows) => ({
    pages: [
      { layouts: [L("table", 0, 700, 500, 200, { table_html: `<tr>${rows[0].map((c) => `<td>${c}</td>`).join("")}</tr>` })], images: [] },
      { layouts: [L("table", 0, 700, 500, 200, { table_html: `<tr>${rows[1].map((c) => `<td>${c}</td>`).join("")}</tr>` })], images: [] },
      { layouts: [L("table", 0, 700, 500, 200, { table_html: `<tr>${rows[2].map((c) => `<td>${c}</td>`).join("")}</tr>` })], images: [] },
    ],
  });
  const json = mk([["名称", "数量"], ["苹果", "3"], ["香蕉", "4"]]);
  const pages = layoutToPageBlocks(json, { mergeMode: "loose" });
  assert.equal(pages[0].blocks.length, 1);
  assert.equal(pages[1].blocks.length, 0);
  assert.equal(pages[2].blocks.length, 0, "第 3 页也拼上（_pos 前移后触底判定对中继页成立）");
  assert.deepEqual(pages[0].blocks[0].rows, [["名称", "数量"], ["苹果", "3"], ["香蕉", "4"]]);
  assert.ok(Array.isArray(pages[0].blocks[0]._pos), "合并后仍带 _pos（就地修改保住元数据）");
});

test("buildTableFromCells：{cell_id,text} 对象数组可寻址；对不上返回 null（#5）", () => {
  const byId = buildTableFromCells({
    matrix: [[0, 1], [2, 2]],
    cells: [
      { cell_id: "c0", text: "名称" },
      { cell_id: "c1", text: "数量" },
      { cell_id: "c2", text: "3" },
    ],
  });
  assert.deepEqual(byId.rows, [["名称", "数量"], ["3", ""]], "原点取最左出现位");
  assert.deepEqual(byId.merges, [{ r: 1, c: 0, rowSpan: 1, colSpan: 2 }]);
  // cells 与 matrix 完全对不上 → null（交回 markdown/table_html 兜底，不产全空表）
  const broken = buildTableFromCells({ matrix: [[7, 8]], cells: [{ cell_id: "zzz", text: "x" }] });
  assert.equal(broken, null);
});

test("matrix/cells 对不上时走 table_html 兜底而非全空表（#5 调用方二道防线）", () => {
  const json = {
    pages: [
      {
        layouts: [L("table", 0, 0, 500, 400, { table_html: "<tr><td>名称</td><td>数量</td></tr><tr><td>苹果</td><td>3</td></tr>" })],
        images: [],
        tables: [{ layout_id: "t1", matrix: [[7, 8]], cells: [{ cell_id: "zzz", text: "x" }] }],
      },
    ],
  };
  json.pages[0].layouts[0].layout_id = "t1";
  const pages = layoutToPageBlocks(json, { mergeCrossPageTables: false });
  assert.deepEqual(pages[0].blocks[0].rows, [["名称", "数量"], ["苹果", "3"]], "兜底到 table_html");
});

test("htmlToRows：colspan/rowspan 上限 100（#7：畸形 HTML 不撑爆内存）", () => {
  const h = htmlToRows('<tr><td colspan="99999999">A</td><td>B</td></tr>');
  assert.equal(h.rows[0][0], "A");
  assert.equal(h.rows[0].length, 101, "100 宽合并 + B 一格");
  assert.equal(h.rows[0][100], "B", "B 落在合并区之后");
  assert.equal(h.merges[0].colSpan, 100, "colSpan 应被夹到 100");
  const h2 = htmlToRows('<tr><td rowspan="88888888">A</td></tr>');
  assert.equal(h2.rows.length, 1, "幻影尾行被裁掉");
  assert.deepEqual(h2.merges, [], "裁剪后退化的合并被剔除");
});

test("orderLayouts：页底通栏表格留在页尾（#13：旧版无条件提到页首）", () => {
  // 左栏 3 块 + 右栏 3 块 + 一个通栏真表格在页底
  const layouts = [
    L("text", 0, 100, 300, 40, { text: "左1" }),
    L("text", 0, 200, 300, 40, { text: "左2" }),
    L("text", 0, 300, 300, 40, { text: "左3" }),
    L("text", 400, 100, 300, 40, { text: "右1" }),
    L("text", 400, 200, 300, 40, { text: "右2" }),
    L("text", 400, 300, 300, 40, { text: "右3" }),
    L("table", 0, 900, 700, 100, { table_html: "<tr><td>合计</td><td>100</td></tr>" }), // w=700 > 800*0.6，且在页底
  ];
  const pages = layoutToPageBlocks({ pages: [{ layouts, images: [] }] }, { mergeCrossPageTables: false });
  const blocks = pages[0].blocks;
  assert.equal(blocks[blocks.length - 1].type, "table", "通栏表格应在页尾");
  assert.equal(blocks[0].text, "左1", "页首仍是左栏");
});

test("attachCaptions：标签号后接续接词是正文引用句，不吸附（#14）", () => {
  const json = {
    pages: [
      {
        layouts: [
          L("image", 0, 0, 500, 300),
          L("text", 0, 310, 500, 30, { text: "表1所示为本项目的投资估算与资金来源情况说明" }),
        ],
        images: [],
      },
    ],
  };
  json.pages[0].layouts[0].layout_id = "i1";
  json.pages[0].images.push({ layout_id: "i1", data_url: "http://x/1.jpg" });
  const pages = layoutToPageBlocks(json, { mergeCrossPageTables: false });
  assert.equal(pages[0].blocks[0].caption, undefined, "正文引用句不得被吸成图注");
  assert.equal(pages[0].blocks[1].text, "表1所示为本项目的投资估算与资金来源情况说明");
});

test("attachCaptions：各式连字符/破折号分隔的图注都能吸附（#21）", () => {
  // 旧字符类 [-−—－.．] 漏了 en dash(U+2013)/figure dash 等，导致这类图注不吸附、沦为普通段落
  for (const sep of ["-", "\u2013", "\u2014", "\u2212", "\uFF0D", "\u2010", "\u2015"]) {
    const text = `图1${sep}2 土方回填断面图`;
    const json = {
      pages: [
        {
          layouts: [L("image", 0, 0, 500, 300), L("text", 0, 310, 500, 30, { text })],
          images: [],
        },
      ],
    };
    json.pages[0].layouts[0].layout_id = "i1";
    json.pages[0].images.push({ layout_id: "i1", data_url: "http://x/1.jpg" });
    const pages = layoutToPageBlocks(json, { mergeCrossPageTables: false });
    assert.equal(pages[0].blocks.length, 1, `分隔符 ${JSON.stringify(sep)} 的图注应被吸附`);
    assert.equal(pages[0].blocks[0].caption, text);
  }
});

test("stripPageNumberBlocks：整页不足 3 块时不剥（#16：孤块数字可能是表单值/年份）", () => {
  const json = {
    pages: [
      { layouts: [L("text", 0, 0, 500, 30, { text: "2026" }), L("text", 0, 100, 500, 40, { text: "封面标题" })], images: [] },
    ],
  };
  const pages = layoutToPageBlocks(json, { mergeCrossPageTables: false });
  assert.deepEqual(pages[0].blocks.map((b) => b.text), ["2026", "封面标题"], "两块的页面不剥");
  assert.equal(pages[0].stats.strippedPN, 0);
});

test("unicode 模式统一清洗版面文本公式（两路径行为一致）；raw 保留", () => {
  const json = { pages: [{ layouts: [L("text", 0, 0, 400, 40, { text: "$\\pi\\approx 3.14$ 圆周率" })], images: [] }] };
  assert.equal(layoutToBlocks(json).blocks[0].text, "π≈ 3.14 圆周率");
  assert.equal(layoutToBlocks(json, { formulaMode: "raw" }).blocks[0].text, "$\\pi\\approx 3.14$ 圆周率");
});

test("mdTableToRows：转义竖线与缺尾竖线", () => {
  const rows = mdTableToRows("| 名称 | 别名 |\n| --- | --- |\n| 甲\\|乙 | 丙");
  assert.deepEqual(rows, [["名称", "别名"], ["甲|乙", "丙"]]);
});

test("单元格字面 \\n 转真换行（AI Studio 后端在单元格文本里输出转义串）", () => {
  const h = htmlToRows("<tr><td>责任领导：\\n责任科室：\\n责任人：</td></tr>");
  assert.equal(h.rows[0][0], "责任领导：\n责任科室：\n责任人：");
  const rows = mdTableToRows("| 甲\\n乙 | 丙 |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(rows[0][0], "甲\n乙");
});

// ── 方案 A（v0.4.1）：归一化基准由「内容极值」改为「页矩形」，杜绝有页边距文档被系统性拉伸 ──
test("方案A：后端给页尺寸时 bbox 按页矩形归一化（不再用内容极值）", () => {
  const json = {
    pages: [
      {
        width: 1000,
        height: 1400, // 页矩形（与 position 同单位）；内容仅占 x:100..700, y:100..560
        layouts: [
          L("text", 100, 100, 600, 40, { text: "正文" }),
          L("footer", 100, 1300, 600, 40, { text: "页脚" }),
        ],
        images: [],
      },
    ],
  };
  const p = layoutToPageBlocks(json, { filterHeaderFooter: true })[0];
  assert.equal(p._base, "page");
  assert.equal(p._pageW, 1000);
  assert.equal(p._pageH, 1400);
  assert.equal(p.isLandscape, false); // 1000×1400 → 纵向（内容极值口径会误判横）
  assert.equal(p.stats.filteredHF, 1); // 页脚被过滤
  // 分母=页矩形：x0=100/1000*1000=100, y0=100/1400*1000≈71
  // （若误用内容极值分母 pageW=700/pageH=1340，会得 [143,75,1000,104]）
  assert.deepEqual(p.blocks[0].bbox, [100, 71, 700, 100]);
});

test("方案A 回退：无页尺寸时 _base=content，bbox 维持内容极值口径（旧行为不变）", () => {
  const json = { pages: [{ layouts: [L("text", 100, 100, 600, 40, { text: "正文" })], images: [] }] };
  const p = layoutToPageBlocks(json)[0];
  assert.equal(p._base, "content");
  assert.equal(p._pageW, 700);
  assert.equal(p._pageH, 140);
  assert.deepEqual(p.blocks[0].bbox, [143, 714, 1000, 1000]); // 100/700、100/140 归一化
});

test("方案A：DocumentModel 携带 base 与页尺寸；content-list 快照不外露 base", () => {
  const json = { pages: [{ width: 1000, height: 1400, layouts: [L("text", 100, 100, 600, 40, { text: "x" })], images: [] }] };
  const dm = layoutToDocModel(json);
  assert.equal(dm.pages[0].base, "page");
  assert.equal(dm.pages[0].width, 1000);
  assert.equal(dm.pages[0].height, 1400);
  const cl = docModelToContentList(dm);
  assert.equal("base" in cl.pages[0], false); // 内部字段不得进入公开 content-list
  assert.equal(cl.pages[0].width, 1000);
});
