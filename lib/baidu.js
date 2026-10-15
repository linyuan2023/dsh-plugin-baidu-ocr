// lib/baidu.js — 百度云端 OCR 接口层（全部 HTTPS 调用收敛于此，零第三方依赖）
//
// 通道 A（同步）：POST /rest/2.0/ocr/v1/<endpoint>?access_token=...
//   Content-Type: application/x-www-form-urlencoded；image/pdf_file=urlencoded(base64)
// 通道 B（异步，PaddleOCR-VL 文档解析）：提交 → task_id → 轮询 → 拉取 markdown_url
//   端点/字段已于 2026-10-11 按官方文档实测确认（快照见 docs/vl-api-snapshot.md），
//   保留 BAIDU_OCR_VL_SUBMIT_URL / BAIDU_OCR_VL_QUERY_URL 环境变量作为覆盖逃生口。
import { OcrError, describeBaiduError, isTokenError, isRetryableCode } from "./errors.js";
import { getToken } from "./auth.js";
import { recordTask, markTask } from "./tasks.js";

const OCR_BASE = "https://aip.baidubce.com/rest/2.0/ocr/v1";

// 引擎 → 通道 A endpoint。pdf 仅 general/accurate 支持走 pdf_file 参数。
const SYNC_ENDPOINTS = {
  general: "general_basic",
  accurate: "accurate_basic",
  handwriting: "handwriting",
  doc: "doc_analysis",
};

// 通道 B：文档解析（PaddleOCR-VL）真实端点（2026-10-11 官方文档实测确认：
// https://cloud.baidu.com/doc/OCR/s/Qmncwhwdt ；仍保留环境变量覆盖能力）
const VL_BASE = "https://aip.baidubce.com/rest/2.0/brain/online/v2/paddle-vl-parser";
const VL_SUBMIT_URL = process.env.BAIDU_OCR_VL_SUBMIT_URL || `${VL_BASE}/task`;
const VL_QUERY_URL = process.env.BAIDU_OCR_VL_QUERY_URL || `${VL_BASE}/task/query`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formBody(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

async function postForm(url, fields, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs, 5000));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formBody(fields),
      signal: ac.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new OcrError("E_BAD_REPLY", `百度接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
  } catch (e) {
    if (e instanceof OcrError) throw e;
    if (e.name === "AbortError") throw new OcrError("E_TIMEOUT", `请求超时（>${timeoutMs}ms）：百度接口无响应`);
    throw new OcrError("E_NETWORK", `网络错误：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 统一重放逻辑：token 类错误刷新后重放一次；限流/服务端错误指数退避重试 2 次 */
async function withRetry(cfg, run) {
  let token = await getToken(cfg);
  let refreshed = false;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run(token);
    } catch (e) {
      lastErr = e;
    }
    const err = lastErr;
    // run 内部抛出的已归一化错误带 baiduCode
    const code = err?.baiduCode;
    if (code != null && isTokenError(code) && !refreshed) {
      refreshed = true;
      token = await getToken(cfg, { forceRefresh: true });
      continue;
    }
    const transient = err?.code === "E_NETWORK" || err?.code === "E_TIMEOUT" || err?.code === "E_BAD_REPLY" ||
      (code != null && isRetryableCode(code));
    if (transient && attempt < 2) {
      await sleep(1000 * (attempt + 1) * (attempt + 1)); // 1s、4s
      continue;
    }
    throw err;
  }
  // 防御：token 刷新若发生在最后一次尝试，continue 会跳出循环——必须抛最后一次错误，
  // 绝不能隐式返回 undefined（下游会以 "Cannot read properties of undefined" 报错，掩盖真实原因）
  throw lastErr;
}

function assertApiOk(body) {
  // 注意：VL 通道成功响应也带 error_code=0，只有非 0 才是错误
  if (body && typeof body === "object" && body.error_code != null && Number(body.error_code) !== 0) {
    const e = new OcrError("E_BAIDU", describeBaiduError(body.error_code, body.error_msg));
    e.baiduCode = Number(body.error_code);
    throw e;
  }
}

/** 通道 A：同步识别。input: { imageBase64 | pdfBase64 | url } */
export async function syncRecognize(cfg, engine, input) {
  const endpoint = SYNC_ENDPOINTS[engine];
  if (!endpoint) throw new OcrError("E_ENGINE", `引擎 ${engine} 不支持同步识别通道（仅 general/accurate/handwriting/doc 走同步）`);
  const fields = {};
  if (input.url) fields.url = input.url;
  else if (input.pdfBase64) fields.pdf_file = input.pdfBase64;
  else fields.image = input.imageBase64;

  const body = await withRetry(cfg, async (token) => {
    const resp = await postForm(`${OCR_BASE}/${endpoint}?access_token=${encodeURIComponent(token)}`, fields, cfg.requestTimeoutMs ?? 30000);
    assertApiOk(resp);
    return resp;
  });

  // 归一化不同端点的返回结构：
  // - general/accurate/handwriting → words_result[].words
  // - doc_analysis（办公文档识别） → results[].words.word（附带 words_location 位置框）
  let lines = [];
  if (Array.isArray(body.words_result)) {
    lines = body.words_result.map((w) => String(w.words ?? "")).filter((s) => s.length > 0);
  } else if (Array.isArray(body.results)) {
    lines = body.results.map((r) => String(r?.words?.word ?? "")).filter((s) => s.length > 0);
  }
  return {
    engine,
    channel: "A",
    pages: [{ text: lines.join("\n") }],
    text: lines.join("\n"),
    lineCount: lines.length,
    logId: body.log_id,
  };
}

// ── 通道 B：PaddleOCR-VL 文档解析（异步） ────────────────────────────────────

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
}

function extractTaskId(resp) {
  const id = pick(resp?.result ?? {}, "task_id") ?? pick(resp, "task_id", "request_id", "job_id") ??
    pick(resp?.data ?? {}, "task_id");
  return id != null ? String(id) : null;
}

/** 轮询响应 → { done, failed, status, markdownUrl, parseResultUrl, taskError } */
function extractVlStatus(resp) {
  const result = resp?.result ?? resp?.data ?? {};
  const status = String(pick(result, "status") ?? pick(resp, "task_status", "status") ?? "").toLowerCase();
  const markdownUrl = pick(result, "markdown_url") ?? pick(result?.data ?? {}, "markdown_url");
  const parseResultUrl = pick(result, "parse_result_url") ?? pick(result?.data ?? {}, "parse_result_url");
  const failed = status === "failed" || status.includes("fail") || status.includes("error") || status === "rejected";
  const done = failed || ["success", "succeed", "finished", "completed", "done"].includes(status);
  return { done, failed, status: status || "(无状态字段)", markdownUrl, parseResultUrl, taskError: result.task_error, rawKeys: Object.keys(resp ?? {}) };
}

async function fetchText(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs, 10000));
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new OcrError("E_VL_DOWNLOAD", `拉取解析结果失败（HTTP ${res.status}）`);
    return await res.text();
  } catch (e) {
    if (e instanceof OcrError) throw e;
    throw new OcrError("E_VL_DOWNLOAD", `拉取解析结果网络错误：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取已完成任务的结果（markdown 双拉 + 版面 JSON），供 vlDocParse 与 /ocr resume 共用。 */
async function collectVlResult(cfg, taskId, st, timeoutMs) {
  if (!st.markdownUrl) {
    throw new OcrError(
      "E_VL_RESULT_SHAPE",
      `任务已完成但响应中没有 markdown_url，原始字段：[${Object.keys(st.raw ?? {}).join(", ")}]。` +
        `请核对 https://cloud.baidu.com/doc/OCR/s/Qmncwhwdt 并调整 extractVlStatus 的字段兼容列表`
    );
  }
  // 双拉：markdown_url（线性文本，保底）+ parse_result_url（版面 JSON：layouts/images/tables，版面保真用）
  // parse JSON 结构实测见 docs/layout-improvement-analysis.md §8.1；拉取失败不影响主流程（layoutJson=null 降级）
  const markdown = await fetchText(st.markdownUrl, timeoutMs);
  let layoutJson = null;
  if (st.parseResultUrl) {
    try {
      layoutJson = JSON.parse(await fetchText(st.parseResultUrl, timeoutMs));
    } catch (e) {
      console.error("[ocr] parse_result_url 拉取/解析失败（降级为 markdown 输出）:", e.message);
    }
  }
  markTask(taskId, { status: "done" });
  return { engine: "vl", channel: "B", markdown, text: markdown, taskId, status: st.status, layoutJson };
}

/** 轮询任务直到完成并取回结果；超时抛可恢复错误（任务已登记，可 /ocr resume）。
 *  供 vlDocParse 首次跑与 resumeTask 恢复共用。 */
export async function pollVlUntilDone(cfg, taskId, { onProgress, timeoutMs } = {}) {
  const reqTimeoutMs = timeoutMs ?? cfg.requestTimeoutMs ?? 30000;
  // 工具 timeoutMs 固定 360s：轮询上限封顶 330s 留余量，避免用户把 vlPollTimeoutMs 配得过大后被工具超时硬砍
  const VL_POLL_CAP_MS = 330000;
  const pollTimeoutMs = Math.min(cfg.vlPollTimeoutMs ?? 300000, VL_POLL_CAP_MS);
  const pollIntervalMs = 5000; // 官方建议提交后 5~10s 起轮询（提交 QPS=2，查询 QPS=5）

  const deadline = Date.now() + pollTimeoutMs;
  if (onProgress) onProgress(`任务 ${taskId} 轮询中…`);
  await sleep(pollIntervalMs);

  while (Date.now() < deadline) {
    const status = await withRetry(cfg, async (token) => {
      const resp = await postForm(`${VL_QUERY_URL}?access_token=${encodeURIComponent(token)}`, { task_id: taskId }, reqTimeoutMs);
      assertApiOk(resp);
      return resp;
    });
    const st = { ...extractVlStatus(status), raw: status };
    if (st.failed) {
      const detail = st.taskError ? JSON.stringify(st.taskError).slice(0, 200) : "";
      markTask(taskId, { status: "failed", error: `status=${st.status}${detail ? "，" + detail : ""}` });
      throw new OcrError("E_VL_FAILED", `文档解析任务失败（status=${st.status}${detail ? "，" + detail : ""}，task_id=${taskId}）`);
    }
    if (st.done) return await collectVlResult(cfg, taskId, st, reqTimeoutMs);
    await sleep(pollIntervalMs);
  }
  // 任务仍在云端执行：保持 running 状态，凭 id 可恢复
  throw new OcrError(
    "E_VL_TIMEOUT",
    `文档解析超时（>${Math.round(pollTimeoutMs / 1000)}s）：任务仍在云端执行（task_id=${taskId}）。` +
      `稍后可用 /ocr resume ${taskId.slice(-8)} 取回结果，或减小文档篇幅/启用分段`
  );
}

/**
 * 通道 B：提交 + 轮询（官方文档 2026-10-11 版）。
 * input: { imageBase64 | pdfBase64 | docBase64, url, fileName, sourcePath?, bytes?, pagesHint? }
 * 成功后从 result.markdown_url（30 天有效的 BOS 链接）拉取 markdown 正文。
 * 返回 { engine:"vl", channel:"B", markdown, text, taskId, status, layoutJson }
 */
export async function vlDocParse(cfg, input, { onProgress } = {}) {
  // 提交超时随 payload 放大（百 MB 级 PDF 上传/解析易超时）：基础 30s + 1s/MB，封顶 300s（#pipeline low）
  const bytes = input.pdfBase64 ? Math.ceil((input.pdfBase64.length * 3) / 4) : 0;
  const timeoutMs = Math.min(300000, Math.max(cfg.requestTimeoutMs ?? 30000, 30000 + Math.floor(bytes / 1024 / 1024) * 1000));
  const fields = input.url
    ? { file_url: input.url, file_name: input.fileName || "remote.png" }
    : {
        file_data: input.pdfBase64 || input.docBase64 || input.imageBase64,
        file_name: input.fileName || `upload.${input.pdfBase64 ? "pdf" : input.docBase64 ? "docx" : "png"}`,
      };

  const taskId = await withRetry(cfg, async (token) => {
    const resp = await postForm(`${VL_SUBMIT_URL}?access_token=${encodeURIComponent(token)}`, fields, timeoutMs);
    assertApiOk(resp);
    const id = extractTaskId(resp);
    if (!id) {
      throw new OcrError(
        "E_VL_SUBMIT_SHAPE",
        `提交接口未返回 task_id，原始字段：[${Object.keys(resp ?? {}).join(", ")}]。` +
          `接口可能已调整，请核对 https://cloud.baidu.com/doc/OCR/s/Qmncwhwdt 并更新 lib/baidu.js（见 docs/vl-api-snapshot.md）`
      );
    }
    return id;
  });

  recordTask({
    id: taskId,
    provider: "baidu",
    engine: "vl",
    sourcePath: input.sourcePath ?? null,
    fileName: input.fileName ?? null,
    bytes: input.bytes ?? null,
    pagesHint: input.pagesHint ?? null,
  });
  if (onProgress) onProgress(`已提交文档解析任务（task_id=${taskId}），轮询中…`);
  return await pollVlUntilDone(cfg, taskId, { onProgress, timeoutMs });
}
