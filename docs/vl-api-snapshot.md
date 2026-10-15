# PaddleOCR-VL 文档解析 API 快照（2026-10-11 已实测确认 ✅）

> 状态：**M0 完成**。真实端点已通过实弹测试验证（样例：`docs/samples/ocr-e2e-political-law/`，
> task-t4VEGl9QoYPJm8QGgxvbF25kTYlf5s59，提交→轮询→markdown 拉取全链路成功）。
> 官方文档：https://cloud.baidu.com/doc/OCR/s/Qmncwhwdt

## 已确认的接口事实（已固化进 lib/baidu.js）

1. **提交**：`POST https://aip.baidubce.com/rest/2.0/brain/online/v2/paddle-vl-parser/task?access_token=...`
   - 参数：`file_data`（base64）与 `file_url` 二选一（优先级 file_data > file_url）；**`file_name` 必填**（如 "1.pdf"，扩展名决定解析器行为）
   - 成功响应也带 `error_code: 0`（断言必须放行 0）
2. **轮询**：`POST .../paddle-vl-parser/task/query`，参数 `task_id`
   - `result.status` ∈ `pending | processing | success | failed`；失败详情在 `result.task_error`
   - **结果正文不在轮询响应里**：`result.markdown_url`（30 天有效 BOS 直链，无需鉴权，GET 即得 markdown）+ `result.parse_result_url`（JSON 版，含 pages[].layouts/tables）
3. **限制**：图片最长边 8192px、≤10M；PDF ≤100M/500 页；流式文档 doc/docx/txt/wps/ppt/pptx ≤50M；提交 QPS=2、查询 QPS=5；建议 5~10s 起轮询
4. 环境变量 `BAIDU_OCR_VL_SUBMIT_URL` / `BAIDU_OCR_VL_QUERY_URL` 保留为覆盖逃生口

## 同日顺带确认

- `doc_analysis`（办公文档识别，通道 A）响应结构是 `results[].words.word` + `results[].words.words_location{left,top,width,height}`（**自带位置框，路线 1 几何重建的免费素材**），不是 `words_result`——baidu.js 已兼容两种结构
- general_basic 在含浏览器 UI 的截图上会混入页面杂讯（标签/网址），VL 则自动忽略浏览器元素且引号/字形更准（"隔阂" vs general 的 "隔闵"）
