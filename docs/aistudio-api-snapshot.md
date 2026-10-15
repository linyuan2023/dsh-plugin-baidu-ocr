# AI Studio PaddleOCR-VL 作业 API 报文结构快照（2026-10-15 实测确认 ✅）

> 端点：`https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`（与百度智能云的 `paddle-vl-parser`
> **不是同一套 API**，报文结构完全不同，见 `vl-api-snapshot.md` 对比）。
> 数据来源：本机 `~/.dsh/ocr/raw/*.jsonl`（`aistudio.js` 的 `dumpRawJsonl` 落盘，保留最近 10 份），
> 统计口径：10 份报文 / 396 页 / 8069 个版面块。

## 一、结果获取链路（已固化进 lib/aistudio.js）

1. **提交** `POST {aistudioUrl}`，Header `Authorization: bearer <Token>`，`multipart/form-data`
   （`file` 二进制 + `model` + `optionalPayload`）或 JSON（`fileUrl`）→ `{ data: { jobId } }`
2. **轮询** `GET {aistudioUrl}/{jobId}` → `data.state ∈ pending|running|done|failed`；
   `running` 带 `data.extractProgress { totalPages, extractedPages }`
3. **取结果** `data.resultUrl.jsonUrl` → **JSONL**，每行一条记录，形如
   `{ logId, result: { layoutParsingResults: [...] }, errorCode, errorMsg }`

## 二、`layoutParsingResults[]` —— 每页一项（此前被整包丢弃的正是这里）

单个条目的字段：

| 字段 | 含义 |
|---|---|
| `prunedResult` | 该页版面结构（见下），**核心** |
| `markdown.text` | 该页 markdown（含 `<div style="text-align:center"><img src=...></div>`、`##`/`###` 标题、HTML 表格） |
| `markdown.images` | `{ 占位键: 绝对 URL }`，键名**编码了块 bbox**（见三） |
| `outputImages.layout_det_res` | 版面检测可视化图 |
| `inputImage` | 该页原图 URL |

### `prunedResult` 字段（396/396 页全部存在）

| 字段 | 含义 |
|---|---|
| `page_count` | 恒为 `null`（实测），**不要用它判页数** |
| `width` / `height` | **该页像素尺寸**（如纵版 1225×1719，横版 1719×1225；同一文档内混排 → 真实页几何） |
| `parsing_res_list` | 块级版面列表（见下），**正文/标题/表格/公式的唯一结构化来源** |
| `layout_det_res.boxes` | 检测框：`{ cls_id, label, score, coordinate, order, polygon_points }`（比 `parsing_res_list` 多出 `inline_formula` 等类） |
| `model_settings` / `doc_preprocessor_res` | 模型参数与预处理结果 |

### `parsing_res_list[]` 单项

```json
{ "block_label": "text", "block_content": "…", "block_bbox": [x1, y1, x2, y2],
  "block_id": 0, "block_order": null, "group_id": 0, "block_polygon_points": [[x1,y1],[x2,y1],[x2,y2],[x1,y2]] }
```

- **坐标量纲**：`block_bbox` 是**页像素空间**（`0 ≤ x ≤ width`），**全部为整数**（实测 8069/8069 无小数、无畸形）。
- `block_label` 实测全集（括号内为出现次数）：
  `text`(3736)、`paragraph_title`(1585)、`figure_title`(1081)、`image`(992)、`number`(362)、
  `vision_footnote`(231)、`table`(30)、`aside_text`(17)、`reference_content`(12)、
  `header`(8)、`header_image`(5)、`footnote`(4)、`display_formula`(2)、`chart`(2)、`doc_title`(2)
- `block_content` 形态随 label 变：
  - 文本类（text/标题/脚注/…）= 纯文本，内联公式保留 LaTeX（`$ 10^{-2}cm/s $`）
  - `table` = **HTML 表格**（实测 30/30），且带字面 `\n`（后端转义串，非真换行）
  - `display_formula` = `$$ … $$` LaTeX
  - `image` / `chart` / `header_image` = **空串**（内容只能靠 `markdown.images` 拿，见三）
- `block_order` **约 66% 为 null**（5337/8069），不能作为阅读顺序的可靠依据 → 用坐标排序。

> ⚠️ `table_res_list` **在 AI Studio 报文里不存在**（实测 396/396 页都没有）。
> `export.js` 的 `appendAiStudioTables` 与 `parseJsonlPages` 里读它的分支对本通道是**死代码**；
> 表格一律从 `parsing_res_list` 的 `table` 块取。

## 三、图片块 ↔ URL 的连接方式（关键）

`markdown.images` 的键名把 bbox 编进去了，前缀随块类型变：

```
imgs/img_in_image_box_159_167_615_507.jpg          ← image 块（1100 个）
imgs/img_in_header_image_box_858_91_971_194.jpg    ← header_image 块（5 个）
imgs/img_in_chart_box_100_1150_400_1350.jpg        ← chart 块（2 个）
```

**匹配规则：取键名里「扩展名之前的最后 4 个整数」作为 bbox，与 `block_bbox` 直接比对。**
不要硬编码前缀（前缀随 label 变）。实测匹配率 **image 992/992、chart 2/2 = 100%**。

## 四、历史坑：markdown 路径会丢光图片

`markdown.text` 里的图片是 `<div style="text-align:center;"><img src="URL" …></div>`。
`lib/markdown.js` 的 div 分支会剥掉全部标签，`<img>` 自身不产生文本 → 剥完是空串 → **整块被丢弃**。
实测 40 页 / 60 张后端图片，markdown 路径产出 **0 个 image 块**。

因此 `lib/aistudio.js` 用 `asLayoutJson()` 把 `prunedResult` 还原为内部 `layoutJson`
（`pages[].{width,height,layouts,images,tables}`），让导出走版面路径：
页尺寸基准生效（`_base="page"`）、图片落到 image 块、复刻/HQ/fidelity/content-list 全部可达。
