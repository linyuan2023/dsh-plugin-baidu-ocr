# OFD 输入解析评估（v0.4.0 §3.23，仅评估不实现）

日期：2026-10-15 · 结论：**可行且与 office.js 同构，建议作为 v0.4.x 增量或 v0.5 首项**

## OFD 是什么

GB/T 33190-2016 国产版式文档（电子发票、公文、图纸交付常见）。本质是 **zip + XML**：
- `OFD.xml`（文档索引）→ `Doc_0/Document.xml`（页面树）→ `Doc_0/Pages/Page_N/Content.xml`
- 资源在 `Doc_0/Res/`（图片/字体）；文本以 TextObject（含坐标、字号、字形编码）描述
- 文本可能按「字形编码」存储（需 CF2/gbd 字形表反查），不保证可直读

## 与现有能力的契合度

| 需要的能力 | 现状 |
|---|---|
| zip 读取 | ✅ office.js `readZip` 直接复用 |
| XML 标签流解析 | ✅ scanTags/topRanges 同款手法 |
| 坐标 → bbox 归一化 | ✅ docmodel 通道现成 |
| 字形编码反查 | ⚠ 唯一的硬骨头：遇到加密/自定义编码文本时降级为栅格化（pymupdf 不支持 OFD，需自带渲染或仅提取可读文本） |

## 建议方案（立项时）

1. `lib/ofd.js`：readZip → 解析 Content.xml 的 TextObject/ImageObject → docmodel blocks（复用分级/表格思路，OFD 无表格概念，按线框聚类成本高，v1 只出文本+图）；
2. 路由：files.js 加 `.ofd` 魔数嗅探（PK 头含 `OFD.xml`）→ LOCAL 通道；
3. 验收：真实电子发票 + 公文 OFD 各 1 份，文本层完整提取即达标；字形编码样本明确降级并注明。

## 工作量

文本+图片直读 2–3 人日（复用 office.js 后）；表格聚类另计。
