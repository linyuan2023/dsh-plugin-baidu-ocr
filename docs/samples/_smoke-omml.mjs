// 冒烟：OMML docx 生成 → Python zipfile + python-docx 双验证（临时脚本，验完即删）
import { blocksToDocx, blocksToDocumentXml } from "../../lib/ooxml.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const blocks = [
  { type: "p", text: "质能方程 $E=mc^2$，圆周率 $\\pi\\approx 3.14$。" },
  { type: "p", text: "分式：$$\\frac{x+1}{x-1}$$ 根式 $\\sqrt{2}$，求和 $\\sum_{i=1}^{n}$。" },
  { type: "p", text: "未知命令保留：$\\vec{v}$ 与货币 $5 至 $6 不动。" },
  { type: "table", rows: [["参数", "数值"], ["光速 c", "3e8"]] },
];

const xml = blocksToDocumentXml(blocks, { formulaMode: "omml" });
console.log("oMath:", (xml.match(/<m:oMath>/g) ?? []).length, "| sSup:", xml.includes("<m:sSup>"), "| f:", xml.includes("<m:f>"), "| rad:", xml.includes("<m:rad>"));
console.log("vec字面保留:", xml.includes("\\vec"), "| 货币不转公式:", !xml.slice(xml.indexOf("货币")).includes("<m:oMath>"));
writeFileSync(join(tmpdir(), "omml-smoke.docx"), blocksToDocx(blocks, { title: "OMML 冒烟", formulaMode: "omml" }));
console.log("docx written");
