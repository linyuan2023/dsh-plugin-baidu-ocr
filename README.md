# dsh-plugin-baidu-ocr

DeepSeek Harness 插件：百度云端 OCR + 本地直读——图片 / PDF / Office 文字识别 + **文档复刻**。

调用百度智能云 OCR（通用/高精度/手写/办公文档）与 **PaddleOCR-VL 文档解析**（异步，双后端：百度智能云 / AI Studio 星河社区），识别结果可保存为 **txt / markdown / docx（版面还原）/ 公文 docx / 保真 PDF / 复刻 PDF / csv / 结构化 content-list**。支持 **476 页级大文档自动分段识别**、结果缓存、超时任务找回、复刻度评分。

## 功能

**文档复刻（v0.4，北极星：完美复刻识别的文档）**：
- **复刻 PDF**（`--pdf-replica`）：原页高 DPI 位图打底 + 版面文本按坐标叠加**隐形文字层**——视觉 100% 复刻 + 全文可检索可复制（扫描件的最优解）；
- **复刻度评分**：`--content-list` 落盘时对本地 PDF 原件量化 textCoverage / blockIoU / pageMatch，每次改动可量化"离完美近了多少"；
- **docx 页几何钉死**：非 A4 原件（16开/B5/图纸）按原件真实页尺寸输出，分页不再漂移；
- **字号还原**：按版面块高折算原文字号（docx/pdf，本地原件可用时）；
- **结构化输出**（`--content-list`）：每块带类型/文本/**0–1000 归一化 bbox**，供 Agent/RAG 引用（`ocr://<id>#page=N`）。

**内容完整性（v0.4）**：
- **跨页段落合并**：页尾无句读段落与下页首段自动拼接（md/csv/分段路径，`paraMerge` 可关）；
- **Office 本地直读**：docx/pptx/xlsx 本机解析秒出零配额（标题分级/表格 vMerge/内嵌图片），失败自动回落云端；
- **薄页检测**：文本层直取时列出无文本层页码（疑扫描页），不再静默丢内容；
- **页级混合补识别**（默认关，`hybridThinRatio`）：薄页占比低于阈值时逐页走同步通道补识别；
- **档位路由**（`tier`）：flash（最快）/ basic（高精度）/ standard（结构化）/ advanced（极致复刻），engine 之上的翻译层，显式 engine 优先。

**版面保真**（智能云 VL 路径）：VL 通道同时拉取版面 JSON（layouts 坐标/类型/tables/images），重建阅读顺序后导出：
- **docx**：图片真实嵌入（word/media + drawing）、**逐页分节**（页数/页边界/横竖向与原件一致）、标题按字号分级、表格由 matrix+cells 还原（合并格/**真嵌套**）、中文文档样式（仿宋正文/黑体一级/楷体二级）、表注吸附；
- **pdf**：块流 → HTML（图片 base64 内嵌、真实页尺寸）→ Edge/LibreOffice headless 逐页打印，溢出自动缩字号；
- **3+ 栏阅读顺序**：双栏保守判定保留，三/四栏按中心聚类泛化；
- **矢量图纸高清重截**：本地 PDF 的图片区域按版面坐标以 220 DPI 本机重摄（pymupdf）——CAD 矢量图册的关键能力；
- **页眉页脚过滤 + 页码剥离**：浏览器截图噪音、页首尾孤立页码自动剥离（版面与 markdown 双路径）。

**表格与公式**：
- 表格健壮性：**真嵌套**（docx 原生 w:tbl 嵌套；md/csv 摊平不丢内容）、colspan/rowspan 网格还原（docx vMerge/HTML rowspan 双向）、`<br>` 保留单元格换行、缺尾竖线容忍、`\|` 转义、跨页续表拼接（strict/loose 两档）、表头启发式（加粗+跨页重复表头）、csv 带 BOM；
- 公式输出模式 `formulaMode`：**unicode**（LaTeX→可读文本）/ **raw**（保留 LaTeX 源）/ **omml**（docx 内嵌 Word 原生公式对象）。

**大文档能力**（476 页级图册实测）：
- **自动分段**：超过阈值（默认 40 页，可配）的本地 PDF 拆段提交——对话内 Agent 工具**每次调用自动推进一段**、返回进度，全部段完成后自动合并生成完整文档；**分段流式落盘**（partial.md 边跑边出，非最终版）；每段独立缓存，失败只重跑该段；
- **结果缓存**：按文件内容哈希+引擎+后端+页区间缓存后端原始结果——同文档重跑秒出零配额（200MB/7 天自动清理）；
- **任务找回**：提交即登记任务表，超时/中断后 `/ocr resume <id尾部>` 恢复轮询取回结果（云端任务仍在执行时不作废）；
- **图注/表注吸附**、**md 图片本地化**（`--md-assets`）、图片并发下载（6 并发+失败重试）。

**多后端与文档库**：
- **双后端**：百度智能云（版面 JSON 完整）/ AI Studio（免费）；
- **故障自动切换**（默认关，`providerFallback: auto`）：主后端失败自动切备后端重试；
- **/ocr lib 文档库**：产物自动登记，`/ocr lib <id尾>` 预览、`/ocr lib find <词>` 全文检索、稳定引用定位。

**数据流向**：识别时文件内容发送到所选后端（百度智能云 / AI Studio）；本地直读（Office/文本层）不上传。密钥、缓存、产物、文档库全部只存本机 `~/.dsh/ocr/`。

**内容纯度原则**：文档只含原文内容，不添加任何原文没有的元素。零第三方依赖（Node ≥22 内置 fetch/zlib + 自实现 stored-zip OOXML；唯一运行时依赖 schemastery 随包自带）。

## 使用

| 路径 | 示例 |
|---|---|
| Agent 工具 | 对话里说"把这张截图的文字提出来存成 md"，模型自动调 `ocr_recognize` |
| 斜杠命令 | `/ocr D:\shot.png --md`；`/ocr D:\红头.png --vl --gongwen`；`/ocr D:\扫描件.pdf --advanced`（极致复刻档）；`/ocr D:\文档.pdf --vl --pdf-replica`；`/ocr D:\报告.docx --md`（本地直读）；`/ocr D:\表格.xlsx --csv` |
| 大文档 | 对话内直接"识别这个 PDF"——工具自动分段逐段推进；或 `/ocr D:\大图册.pdf --vl --docx` 一次跑完 |
| 任务管理 | `/ocr tasks`；`/ocr resume <id尾部>`；`/ocr cache clear`；`/ocr lib`（文档库）；`/ocr lib find 关键词` |

**档位与引擎**：

| tier | 行为 |
|---|---|
| `auto`（默认） | 按路由规则：纯文字走同步通道 A，要结构走 B（`--vl`）；有文本层 PDF 本机直取 |
| `flash` | 最快提字 |
| `basic` | 高精度（accurate） |
| `standard` | VL 结构化 |
| `advanced` | VL + 矢量重截强制 + 版面 docx |

细粒度引擎仍可用：`general`（默认）/ `accurate` / `handwriting`（仅图片）/ `doc`（仅图片）/ `vl`（PDF/Word/PPT/图片 → 结构化 markdown+版面）。

**导出格式**：`--txt` / `--md`（`--md-assets` 图片本地化）/ `--docx`（内置 OOXML 写入器，逐页分节版面还原+页尺寸钉死）/ **`--gongwen`**（GB/T 9704 公文 docx）/ `--pdf`（逐页保真，Edge 渲染）/ **`--pdf-replica`**（复刻 PDF）/ **`--content-list`**（结构化 JSON+评分）/ `--csv`（仅表格）。`--formula <unicode|raw|omml>`；`--effort low|high`；`--no-save`；`--out <目录>`；`--dir` 批量（串行防限流，≤30 文件）。

## 状态（v0.4.0，2026-10-15）

- ✅ 复刻保真：复刻 PDF / 复刻度评分 / docx 页几何钉死 / 字号还原 / content-list / 3+栏 / 表注 / 真嵌套表
- ✅ 内容完整性：跨页段落合并 / Office 本地直读 / 薄页检测 / 页级混合（补识别默认关）
- ✅ 多后端与文档库：故障自动切换（默认关）/ /ocr lib / tier 档位 / 流式落盘
- ✅ **golden 回归集**（10 组版面样本快照）+ **168 用例全绿**（`npm test`）
- 版本历史：0.1.0 首版 → 0.2.x 表格与公式专项 → 0.3.x 大文档能力（分段/缓存/任务找回/矢量重截）→ **0.4.0 复刻与完整性大版本**（详见 `docs/mineru-upgrade-plan.md` 与 `docs/v0.4.0-upgrade-plan.md`）

**已知降级**：`ctx.settings.register` 在 DSH 0.2.0-rc.2 不可用（notify 同样），配置走 `~/.dsh/ocr/config.json`，面板读写 `/ocr/api/settings` 不受影响。

## 配置

DSH **设置 → OCR** 面板：
- 百度智能云 AK/SK、默认档位/引擎/格式/保存目录、"测试连接"（`/ocr/api/ping`）；
- 公式模式、分段阈值（默认 40 页）、矢量重截开关、跨页表格拼接（strict/loose/off）、**跨页段落合并**、**Office 本地直读**、**字号还原**、**复刻 PDF DPI**、**薄页补识别比例**（默认 0=关）、**后端故障切换**（默认关）；
- AI Studio 后端：API 地址 + Access Token + 方向分类/文档矫正/图表识别三开关；

环境变量兜底：`BAIDU_OCR_API_KEY` / `BAIDU_OCR_SECRET_KEY` / `AISTUDIO_OCR_URL` / `AISTUDIO_OCR_TOKEN`。

数据目录 `~/.dsh/ocr/`：`token.json`、`config.json`（配置事实源）、`tasks.json`（任务表）、`lib.json`（文档库）、`cache/`（结果缓存）、`raw/`（原始 JSONL）、`segments/`（分段工作区，含流式 partial.md）、`logs/`。

## 安装（本机开发态）

```bash
# profiles/web/package.json 需两处：
#   dependencies: "dsh-plugin-baidu-ocr": "link:<插件解压目录>"
#   dsh.profile.bundles: "dsh-plugin-baidu-ocr"
cd ~/.dsh/profiles/web && pnpm install
# 重启：dsh-web-debug.cmd --force
```

## 开发

```bash
cd <插件目录>
npm test        # node --test，168 用例：golden 回归 + 单测 + 集成（pymupdf 缺失自动跳过）
UPDATE_GOLDEN=1 node --test test/golden.test.mjs   # 刷新 golden 快照（先人工确认变更）
node docs/samples/run-ocr.mjs <图片> <engine> <format> [outDir]   # 脱离 DSH 直跑管线
node docs/samples/capture-layout.mjs <PDF> <out.json> [AK] [SK]   # 采集真实版面 JSON（耗配额，一次性）
node docs/samples/cmd-e2e.mjs                                     # /ocr 命令处理器端到端
node docs/samples/smoke-recognize.mjs                             # ⚠ 真实云端冒烟（耗配额）
```

依赖链：`index.js`（注册层）→ `pipeline.js`（路由+档位+管线+分段+缓存+resume+fallback）→ `baidu.js` / `aistudio.js`（双后端）/ `office.js`（Office 直读）/ `files.js`（校验+EXIF）/ `segment.js`（分段）/ `cache.js` / `tasks.js` / `libstore.js`（文档库）/ `hq.js`（矢量重截）/ `export.js` + `docmodel.js`（文档模型）+ `fidelity.js`（评分）+ `replica.js`（复刻 PDF）+ `ooxml.js` + `markdown.js` + `math.js` + `html.js` + `layout.js`（版面）+ `textflow.js`（段落合并）+ `auth.js`；`client.js`（设置面板）。

## 已知边界

- **限额**：同步通道编码后 ≤4MB、最长边 ≤4096px；vl 通道图片 ≤10MB/8192px、PDF ≤100MB/500 页、Word/PPT ≤50MB；QPS/额度受限自动退避重试（1s/4s）并在错误里说明；
- **本地直读不含图片内文字**：docx/pptx/xlsx 与 PDF 文本层直取均为文本层语义，扫描型内容请 `--vl`；文本框/内容控件/SmartArt 静默跳过并计数；
- **复刻 PDF 需要本地 PDF 源与版面数据**：不满足时自动降级为可读 PDF 并注明；表格/公式区域不叠隐形层（位图已含）；
- **AI Studio 无版面坐标**：docx/pdf 退化为 markdown 单节排版（返回 note 明确提示），要版面复刻请用百度智能云 VL；
- **AI Studio 矢量图册无图**（实测）：此类文档要带图版本走智能云 VL；
- **分段跑批仅支持本地 PDF**：url/Office 不切分（超时任务可 `/ocr resume` 找回）；Agent 工具受 360s 框架超时限制；
- **omml 公式仅 docx 生效**；**md 表格合并格摊平**（docx/csv 保留，嵌套表同）；
- **无句读跨页段落合并可能误拼**（保守句读表缓解）：设置可关（paraMerge）；
- **普通文本裸 LaTeX 不清洗**：无 `$` 定界符的 LaTeX 记号维持原样（防 Windows 路径误伤）；
- **xlsx 仅本地直读**：云端不支持；旧版 .doc/.ppt（OLE）走云端 vl。

MIT License.
