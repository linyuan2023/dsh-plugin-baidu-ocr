// 冒烟：saveResult 端到端（合成 layoutJson：公式+合并格表格+跨页续表）→ md/docx/csv 三格式落盘
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { layoutToPageBlocks } from "../../lib/layout.js";
import { saveResult } from "../../lib/export.js";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), "ocr-e2e-smoke");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const th = (t) => `<tr><th>${t}</th></tr>`;
const json = {
  pages: [
    {
      layouts: [
        { type: "doc_title", text: "验收方案 $\\frac{v^2}{r}$ 向心力", position: [0, 0, 500, 40] },
        { type: "text", text: "圆周率 $\\pi\\approx 3.14$，货币 $5 至 $6。", position: [0, 60, 500, 30] },
        { type: "table", table_html: "<tr><th>名称</th><th>数量</th></tr><tr><td rowspan=\"2\">水果</td><td>3</td></tr>", position: [0, 120, 500, 200] },
      ],
      images: [],
    },
    {
      layouts: [{ type: "table", table_html: "<tr><th>名称</th><th>数量</th></tr><tr><td>香蕉</td><td>4</td></tr>", position: [0, 0, 500, 200] }],
      images: [],
    },
  ],
};

// 1) 版面块流直查（unicode 清洗 + 续表拼接）
const pages = layoutToPageBlocks(json);
const table0 = pages[0].blocks.find((b) => b.type === "table");
console.log("页0块型:", pages[0].blocks.map((b) => b.type).join(","));
console.log("续表拼接:", table0.rows.length === 3 ? "✓ 3行" : "✗ " + table0.rows.length + "行");
console.log("公式清洗:", pages[0].blocks[1].text);

// 2) 三格式落盘
const result = { engine: "vl", channel: "B", layoutJson: json, markdown: "", text: "" };
const md = await saveResult(result, { format: "md", saveDir: dir, sourcePath: "smoke.pdf" });
const dx = await saveResult(result, { format: "docx", saveDir: dir, sourcePath: "smoke.pdf" });
const cv = await saveResult({ ...result, markdown: "| a | b |\n| --- | --- |\n| 甲\\|乙 | 2 |", layoutJson: null }, { format: "csv", saveDir: dir, sourcePath: "smoke.pdf" });
console.log("saved:", [...md.files, ...dx.files, ...cv.files].map((f) => f.split("/").pop()).join(" "));
const mdText = readFileSync(md.files[0], "utf8");
console.log("md含清洗公式:", mdText.includes("π≈ 3.14"), "| md表头重复已拼:", (mdText.match(/\| 名称 \| 数量 \|/g) ?? []).length === 1);
const csvHead = readFileSync(cv.files[0], "utf8").startsWith("\uFEFF");
console.log("csv BOM:", csvHead ? "✓" : "✗", "| 转义竖线还原:", readFileSync(cv.files[0], "utf8").includes("甲|乙"));
console.log("docx 存在:", existsSync(dx.files[0]));
rmSync(dir, { recursive: true, force: true });
