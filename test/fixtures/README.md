# layout fixtures（golden 回归样本）

来源与规范（docs/v0.4.0-upgrade-plan.md §3.1）：

- **手造样本**（当前 `*.json` 全部为手造）：按实测结构构造（`docs/layout-improvement-analysis.md` §8.1），
  覆盖图文混排/合并格表格/跨页续表对/公文/双栏/三栏/公式/页眉页脚/跨页段落。
- **真实样本采集**：`node docs/samples/capture-layout.mjs <本地PDF> <输出.json>`（一次性耗少量配额，
  之后回归零配额）。采集后按下列规范处理再入库。

## 脱敏规范

1. 默认**保留原文**（复刻度量与 md 快照需要真文本）；样本仅存本机，不入公共仓库。
2. 需入库/分享时：正文文字替换为等长占位（保留标点与数字位数），坐标结构不动。
3. 图片 `data_url` 一律替换为 1×1 像素 PNG 占位（控制体积；块流断言不含位图内容）。

## 快照

- `*.expected.json`：`layoutToBlocks` 的 `{blocks, stats}` 序列化。
- `*.expected.md`：`blocksToMarkdown` 产物。
- 刷新：`UPDATE_GOLDEN=1 node --test test/golden.test.mjs`（先人工确认变更符合预期）。
