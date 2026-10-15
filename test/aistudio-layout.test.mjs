// AI Studio 版面映射（asLayoutJson）与阅读顺序守卫的回归测试。
// 背景：AI Studio 的 prunedResult 带完整版面（逐页 width/height、块级 bbox、label），
// 此前被整包丢弃 → layoutJson 恒空 → 页尺寸基准不生效、复刻/HQ/fidelity 不可达、
// 且 markdown 路径把 <div><img/></div> 剥壳成空串导致图片全丢。
import { test } from "node:test";
import assert from "node:assert/strict";
import { asLayoutJson, parseJsonlPages } from "../lib/aistudio.js";
import { layoutToPageBlocks, layoutToBlocks } from "../lib/layout.js";

// ── 合成一份最小 AI Studio 报文（结构对齐真实 prunedResult，去掉真实 BOS 鉴权 URL）──
function sampleResult() {
  return {
    prunedResult: {
      page_count: null,
      width: 1000,
      height: 1400,
      parsing_res_list: [
        { block_label: "text", block_content: "第一段正文", block_bbox: [100, 200, 900, 240], block_id: 0 },
        { block_label: "image", block_content: "", block_bbox: [300, 300, 700, 800], block_id: 1 },
        { block_label: "table", block_content: "<table><tr><td>甲</td><td>乙</td></tr></table>", block_bbox: [100, 900, 900, 1100], block_id: 2 },
        { block_label: "header_image", block_content: "", block_bbox: [10, 10, 100, 100], block_id: 3 },
        { block_label: "chart", block_content: "", block_bbox: [100, 1150, 400, 1350], block_id: 4 },
      ],
    },
    markdown: {
      images: {
        // 键名前缀随块类型变（image/header_image/chart），映射须按末尾 4 个数字匹配
        "imgs/img_in_image_box_300_300_700_800.jpg": "https://cdn.example/a.jpg",
        "imgs/img_in_header_image_box_10_10_100_100.jpg": "https://cdn.example/h.jpg",
        "imgs/img_in_chart_box_100_1150_400_1350.jpg": "https://cdn.example/c.jpg",
      },
    },
  };
}

test("asLayoutJson：页尺寸带出（layout.js 据此走页矩形基准）", () => {
  const lj = asLayoutJson([sampleResult()]);
  assert.equal(lj.pages.length, 1);
  assert.equal(lj.pages[0].width, 1000);
  assert.equal(lj.pages[0].height, 1400);
});

test("asLayoutJson：block_bbox [x1,y1,x2,y2] → position [x,y,w,h]", () => {
  const lj = asLayoutJson([sampleResult()]);
  const l0 = lj.pages[0].layouts[0];
  assert.deepEqual(l0.position, [100, 200, 800, 40], "x2-x1 / y2-y1 须转成宽高");
  assert.equal(l0.type, "text");
  assert.equal(l0.text, "第一段正文");
});

test("asLayoutJson：图片按 bbox 匹配 URL（三种键名前缀都要命中）", () => {
  const lj = asLayoutJson([sampleResult()]);
  const byId = new Map(lj.pages[0].images.map((i) => [i.layout_id, i.data_url]));
  assert.equal(byId.get("1"), "https://cdn.example/a.jpg", "img_in_image_box");
  assert.equal(byId.get("3"), "https://cdn.example/h.jpg", "img_in_header_image_box");
  assert.equal(byId.get("4"), "https://cdn.example/c.jpg", "img_in_chart_box");
  const kinds = new Map(lj.pages[0].layouts.map((l) => [l.layout_id, l]));
  assert.equal(kinds.get("1").type, "image", "image 块 → image");
  assert.equal(kinds.get("4").type, "image", "chart 块 → image（有 URL 时）");
  assert.equal(kinds.get("3").type, "header_image", "页眉图保留原标签（走页眉过滤）");
  assert.equal(kinds.get("1").text, "", "图片块文本留空，避免被当文本段落下发");
});

test("asLayoutJson：table 块 → page.tables[](table_html)，并留纯文本兜底", () => {
  const lj = asLayoutJson([sampleResult()]);
  assert.equal(lj.pages[0].tables.length, 1);
  assert.match(lj.pages[0].tables[0].table_html, /<table>/);
  assert.equal(lj.pages[0].tables[0].layout_id, "2");
  const tbl = lj.pages[0].layouts.find((l) => l.layout_id === "2");
  assert.equal(tbl.type, "table");
  assert.ok(tbl.text.includes("甲"), "兜底文本须保住单元格内容");
  assert.ok(!tbl.text.includes("<"), "兜底文本不得残留 HTML 标签");
});

test("asLayoutJson：无有效页返回 null（调用方回退 markdown 路径）", () => {
  assert.equal(asLayoutJson([]), null);
  assert.equal(asLayoutJson([{ prunedResult: { width: 10, height: 10, parsing_res_list: [] } }]), null);
  assert.equal(asLayoutJson([null, undefined]), null);
});

test("asLayoutJson：坐标畸形/缺 bbox 的块被跳过，不影响其余块", () => {
  const res = sampleResult();
  res.prunedResult.parsing_res_list.push(
    { block_label: "text", block_content: "无坐标", block_bbox: null, block_id: 90 },
    { block_label: "text", block_content: "坏坐标", block_bbox: [1, 2, 3], block_id: 91 },
    { block_label: "text", block_content: "非数值", block_bbox: ["a", "b", "c", "d"], block_id: 92 }
  );
  const lj = asLayoutJson([res]);
  assert.equal(lj.pages[0].layouts.length, 5, "畸形块不入 layouts");
  assert.ok(!lj.pages[0].layouts.some((l) => l.text === "无坐标"));
});

test("映射后端到端：_base=page 生效，图片不再丢失", () => {
  const lj = asLayoutJson([sampleResult()]);
  const pages = layoutToPageBlocks(lj);
  assert.equal(pages[0]._base, "page", "有页尺寸时必须走页矩形基准（方案 A）");
  assert.equal(pages[0]._pageW, 1000);
  assert.equal(pages[0]._pageH, 1400);
  const imgBlocks = pages[0].blocks.filter((b) => b.type === "image");
  assert.equal(imgBlocks.length, 2, "image + chart 都要落成图片块（header_image 属页眉，默认过滤）");
  assert.ok(pages[0].blocks.some((b) => b.type === "table"), "表格块保留");
  assert.equal(pages[0].isLandscape, false);
});

test("映射后端到端：bbox 按页矩形归一化到 0–1000", () => {
  const lj = asLayoutJson([sampleResult()]);
  const blocks = layoutToPageBlocks(lj)[0].blocks;
  const first = blocks.find((b) => typeof b.text === "string" && b.text.includes("第一段正文"));
  assert.deepEqual(first.bbox, [100, 143, 900, 171], "x/1000*1000, y/1400*1000 ...");
});

test("parseJsonlPages：逐页挂上原始 _layout（供映射使用）", () => {
  const line = JSON.stringify({ result: { layoutParsingResults: [sampleResult()] } });
  const pages = parseJsonlPages(line);
  assert.equal(pages.length, 1);
  assert.ok(pages[0]._layout, "须保留原始 prunedResult 条目");
  assert.equal(pages[0]._layout.prunedResult.width, 1000);
});

// ── 阅读顺序：N 栏误判守卫（单栏页块宽/缩进不同 → 中心 x 聚出错簇）───────────────
// 实测：某单栏页因正文块宽度差异被判成 3 栏，段落被重排到页尾（内容不丢、顺序全乱）。
// 真栏是「并排」的：x 区间须真正分离 **且** y 区间显著重叠。两条都缺就退回 y 排序。

function mkPage(layouts) {
  const maxR = Math.max(...layouts.map((l) => l.position[0] + l.position[2]));
  return { pages: [{ width: maxR, height: 1200, layouts: layouts.map((l, i) => ({ layout_id: String(i), text: l.text, type: l.type ?? "text", position: l.position })) }] };
}

test("阅读顺序：单栏页的 3 个 x 簇（y 不重叠）不得被判成 3 栏", () => {
  // 三簇按中心 x 聚类成立（相距 >12% 页宽），但**簇间 y 区间不重叠** → 是单栏的纵向流。
  // 关键：簇的（按 x 的）先后 与 y 先后 故意不一致 —— 缺守卫时按"栏"输出 A,B,C，
  // 有守卫时按 y 输出 B,C,A。两者结果不同，这条才真正锁住守卫。
  const lj = mkPage([
    // A 簇：最左，但在页面底部
    { text: "A1", position: [100, 700, 120, 30] },
    { text: "A2", position: [100, 750, 120, 30] },
    { text: "A3", position: [100, 800, 120, 30] },
    // B 簇：居中，在页面顶部
    { text: "B1", position: [300, 100, 400, 30] },
    { text: "B2", position: [300, 150, 400, 30] },
    { text: "B3", position: [300, 200, 400, 30] },
    // C 簇：最右，在页面中部
    { text: "C1", position: [800, 400, 200, 30] },
    { text: "C2", position: [800, 450, 200, 30] },
    { text: "C3", position: [800, 500, 200, 30] },
  ]);
  const got = layoutToBlocks(lj).blocks.map((b) => b.text);
  assert.deepEqual(
    got,
    ["B1", "B2", "B3", "C1", "C2", "C3", "A1", "A2", "A3"],
    "单栏页须按 y 排序；若输出 A1,A2,A3,B1,… 说明误判成 3 栏"
  );
});

test("阅读顺序：真 3 栏（x 分离且 y 重叠）仍按栏序阅读", () => {
  const col = (x, texts) => texts.map((t, i) => ({ text: t, position: [x, 100 + i * 120, 280, 40] }));
  const lj = mkPage([
    ...col(50, ["左1", "左2", "左3"]),
    ...col(360, ["中1", "中2", "中3"]),
    ...col(670, ["右1", "右2", "右3"]),
  ]);
  const got = layoutToBlocks(lj).blocks.map((b) => b.text);
  assert.deepEqual(
    got,
    ["左1", "左2", "左3", "中1", "中2", "中3", "右1", "右2", "右3"],
    "真多栏须保持栏序（守卫不能把正常多栏也拒掉）"
  );
});
