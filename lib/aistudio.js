// lib/aistudio.js — AI Studio 星河社区 PaddleOCR API 适配器（VL-1.6 异步作业模式）
// 契约（官方控制台"异步解析"示例 + 2026-10-12 用户提供）：
//   提交：POST {aistudioUrl}  Header: Authorization: bearer <Token>
//     本地文件：multipart/form-data（file=二进制, model="PaddleOCR-VL-1.6", optionalPayload=JSON串）
//     远程文件：JSON { fileUrl, model, optionalPayload }
//   响应 200：{ data: { jobId } }
//   轮询：GET {aistudioUrl}/{jobId} → data.state = pending|running|done|failed
//     running 带 data.extractProgress {totalPages, extractedPages}
//     done 后 data.resultUrl.jsonUrl = JSONL（每行一页：result.layoutParsingResults[].markdown{text,images{键:url}}）
//   限额：每模型每日解析页数上限（VL-1.6 为 20000 页/日），超限返回 429
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OcrError } from "./errors.js";
import { dataDir } from "./auth.js";
import { recordTask, markTask } from "./tasks.js";
import { mergeCrossPageParagraphs } from "./textflow.js";

const MODEL = process.env.AISTUDIO_MODEL || "PaddleOCR-VL-1.6";

/** 原始 JSONL 落盘（诊断用：云端没给图/内容异常时回溯），每任务一份，仅保留最近 10 份 */
function dumpRawJsonl(jobId, jsonl) {
  try {
    const dir = join(dataDir(), "raw");
    mkdirSync(dir, { recursive: true });
    // jobId 来自服务端响应（且 aistudioUrl 可指向任意端点）：消毒后再拼路径，防 ../ 越目录写
    const safe = String(jobId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    writeFileSync(join(dir, `${safe}.jsonl`), jsonl);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    while (files.length > 10) {
      const x = files.shift();
      try {
        unlinkSync(join(dir, x.f));
      } catch {}
    }
  } catch (e) {
    console.error("[ocr] 原始 JSONL 落盘失败（不影响本次调用）:", e.message);
  }
}

function authHeaders(token) {
  return { Authorization: `bearer ${token}` };
}

async function downloadText(url, timeoutMs, what) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs, 10000));
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new OcrError("E_VL_DOWNLOAD", `拉取${what}失败（HTTP ${res.status}）`);
    return await res.text();
  } catch (e) {
    if (e instanceof OcrError) throw e;
    throw new OcrError("E_VL_DOWNLOAD", `拉取${what}网络错误：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** JSONL → 每页结果数组，并把 markdown 里的图片占位键改写为绝对 URL。
 *  同时防御性提取结构化表格 HTML（prunedResult.table_res_list[].html，字段名按
 *  PP-Structure 惯例多写法兼容；缺失则跳过）——markdown 内嵌表格解析失败时的兜底源。 */
export function parseJsonlPages(jsonlText) {
  const pages = [];
  for (const line of String(jsonlText ?? "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    for (const res of obj?.result?.layoutParsingResults ?? []) {
      const md = res?.markdown ?? {};
      const text = String(md.text ?? "");
      const images = md.images ?? {};
      let out = text;
      for (const [key, url] of Object.entries(images)) {
        out = out.split(key).join(url);
      }
      const tablesHtml = [];
      const pruned = res?.prunedResult ?? res?.pruned_result ?? {};
      const tableList = pruned?.table_res_list ?? pruned?.tableResList ?? [];
      if (Array.isArray(tableList)) {
        for (const t of tableList) {
          const h = t?.html ?? t?.table_html ?? t?.html_text;
          if (typeof h === "string" && /<table/i.test(h)) tablesHtml.push(h);
        }
      }
      pages.push({ markdown: out, images, ...(tablesHtml.length ? { tablesHtml } : {}) });
    }
  }
  return pages;
}

/** 拉取已完成任务的结果（JSONL 按页 markdown），供 aistudioParse 与 /ocr resume 共用。 */
export async function collectAsResult(cfg, { jobId, jsonUrl }, { onProgress, timeoutMs } = {}) {
  const reqTimeoutMs = timeoutMs ?? cfg.requestTimeoutMs ?? 30000;
  const jsonl = await downloadText(jsonUrl, reqTimeoutMs, "解析结果");
  dumpRawJsonl(jobId, jsonl);
  const pages = parseJsonlPages(jsonl);
  // 页拼接改段落合并（v0.4）：页尾无句读段落行与下页首段拼接（cfg.paraMerge 可关）
  const merged = mergeCrossPageParagraphs(pages.map((p) => p.markdown).filter(Boolean), {
    enabled: cfg.paraMerge !== false,
  });
  const markdown = merged.text;
  if (!markdown.trim()) {
    markTask(jobId, { status: "failed", error: "解析完成但结果为空" });
    throw new OcrError("E_EMPTY_RESULT", "解析完成但结果为空（文件里可能没有可识别内容）");
  }
  const imagesFromBackend = pages.reduce((n, p) => n + Object.keys(p.images ?? {}).length, 0);
  markTask(jobId, { status: "done" });
  return {
    engine: "vl",
    channel: "B",
    markdown,
    text: markdown,
    taskId: jobId,
    status: "done",
    provider: "aistudio",
    pagesCount: pages.length,
    ...(merged.merged > 0 ? { paraMerged: merged.merged } : {}),
    tablesHtml: pages.flatMap((p) => p.tablesHtml ?? []),
    imagesFromBackend,
  };
}

/** 带超时的 fetch（挂起连接会被 AbortController 中断，避免无限悬挂，#5） */
async function fetchWithTimeout(url, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs, 10000));
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 轮询 AI Studio 任务直到完成并取回结果；超时抛可恢复错误（任务已登记，可 /ocr resume）。 */
export async function pollAsUntilDone(cfg, jobId, { onProgress } = {}) {
  const timeoutMs = cfg.requestTimeoutMs ?? 30000;
  const pollTimeoutMs = Math.min(cfg.vlPollTimeoutMs ?? 300000, 330000);
  const headers = authHeaders(cfg.aistudioToken);

  const deadline = Date.now() + pollTimeoutMs;
  await new Promise((r) => setTimeout(r, 5000));
  while (true) {
    if (Date.now() > deadline) {
      // 任务仍在云端执行：保持 running 状态，凭 id 可恢复
      throw new OcrError(
        "E_VL_TIMEOUT",
        `解析超时（>${Math.round(pollTimeoutMs / 1000)}s）：任务仍在云端执行（jobId=${jobId}）。` +
          `稍后可用 /ocr resume ${jobId.slice(-8)} 取回结果`
      );
    }
    // 单次查询带超时 + 重试（网络抖动/挂起连接不致命，未到 deadline 就重试，#5）
    let qRes = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        qRes = await fetchWithTimeout(`${cfg.aistudioUrl}/${jobId}`, { headers }, Math.max(timeoutMs, 30000));
        break;
      } catch (e) {
        lastErr = e;
        if (Date.now() > deadline) break; // 整体超时优先
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!qRes) {
      if (Date.now() > deadline) {
        throw new OcrError(
          "E_VL_TIMEOUT",
          `解析超时（>${Math.round(pollTimeoutMs / 1000)}s）：任务仍在云端执行（jobId=${jobId}）。` +
            `稍后可用 /ocr resume ${jobId.slice(-8)} 取回结果`
        );
      }
      throw new OcrError("E_VL_POLL", `查询任务网络错误：${lastErr?.message ?? "未知"}`);
    }
    if (qRes.status !== 200) {
      const t = await qRes.text();
      throw new OcrError("E_VL_POLL", `查询任务失败（HTTP ${qRes.status}）：${t.slice(0, 200)}`);
    }
    let q;
    try {
      q = (await qRes.json())?.data ?? {};
    } catch {
      // 网关偶发 200 + 非 JSON（HTML 登录页/网关错误页）：当一次无效轮询到点重试；
      // 持续到 deadline 由上方超时分支抛 E_VL_TIMEOUT（任务保持 running，可 resume）
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const state = String(q.state ?? "");
    if (state === "failed") {
      markTask(jobId, { status: "failed", error: String(q.errorMsg ?? "未知原因").slice(0, 200) });
      throw new OcrError("E_VL_FAILED", `解析任务失败：${q.errorMsg ?? "未知原因"}（jobId=${jobId}）`);
    }
    if (state === "done") {
      const jsonUrl = q?.resultUrl?.jsonUrl ?? "";
      if (!jsonUrl) {
        markTask(jobId, { status: "failed", error: "任务完成但未返回结果链接" });
        throw new OcrError("E_VL_RESULT_SHAPE", `任务完成但未返回结果链接（jobId=${jobId}），请核对控制台示例并更新 lib/aistudio.js`);
      }
      return await collectAsResult(cfg, { jobId, jsonUrl }, { onProgress, timeoutMs });
    }
    if (state === "running" && onProgress) {
      const prog = q.extractProgress;
      if (prog?.totalPages) onProgress(`解析中 ${prog.extractedPages ?? "?"}/${prog.totalPages} 页`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/**
 * 主入口：VL-1.6 异步作业。cfg { aistudioUrl, aistudioToken, requestTimeoutMs, vlPollTimeoutMs }
 * input { url | buffer, kind, fileName, sourcePath?, bytes?, pagesHint? }，onProgress 可选。
 */
export async function aistudioParse(cfg, input, { onProgress } = {}) {
  if (!cfg.aistudioUrl) {
    throw new OcrError("E_NO_AS_URL", "未配置 AI Studio API 地址：到 aistudio.baidu.com/paddleocr/task 的调用示例里复制 API_URL，填入设置 → OCR");
  }
  if (!cfg.aistudioToken) {
    throw new OcrError("E_NO_AS_TOKEN", "未配置 AI Studio Access Token：星河社区个人中心 accessToken 页面生成，填入设置 → OCR");
  }
  const timeoutMs = cfg.requestTimeoutMs ?? 30000;
  const headers = authHeaders(cfg.aistudioToken);

  // ── 提交 ──
  let jobRes;
  {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs, 15000));
    try {
      if (input.url) {
        jobRes = await fetch(cfg.aistudioUrl, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ fileUrl: input.url, model: MODEL }),
          signal: ac.signal,
        });
      } else {
        if (!input.buffer?.length) throw new OcrError("E_AS_INPUT", "AI Studio 通道缺少文件内容");
        const fd = new FormData();
        fd.append("model", MODEL);
        // 方向分类默认开启（旋转/倒置扫描页的版面与表格识别依赖它）；矫正/图表识别默认关（耗时）
        fd.append("optionalPayload", JSON.stringify({
          useDocOrientationClassify: cfg.asDocOrientation !== false,
          useDocUnwarping: cfg.asDocUnwarping === true,
          useChartRecognition: cfg.asChartRecognition === true,
        }));
        fd.append("file", new Blob([input.buffer]), input.fileName || `upload.${input.kind === "pdf" ? "pdf" : "png"}`);
        jobRes = await fetch(cfg.aistudioUrl, { method: "POST", headers, body: fd, signal: ac.signal });
      }
    } catch (e) {
      if (e instanceof OcrError) throw e;
      if (e.name === "AbortError") throw new OcrError("E_TIMEOUT", `提交任务超时（>${timeoutMs}ms）`);
      throw new OcrError("E_NETWORK", `提交任务网络错误：${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const submitText = await jobRes.text();
  if (jobRes.status === 429) {
    throw new OcrError("E_AS_QUOTA", "AI Studio 今日解析页数额度已用尽（次日自动恢复）；紧急需求可到 设置 → OCR 把识别后端切回百度智能云");
  }
  if (jobRes.status === 401 || jobRes.status === 403) {
    throw new OcrError("E_AS_TOKEN", `AI Studio 鉴权失败（HTTP ${jobRes.status}）：请检查 Access Token 是否为该服务的令牌`);
  }
  if (jobRes.status !== 200) {
    throw new OcrError("E_AS_SUBMIT", `提交任务失败（HTTP ${jobRes.status}）：${submitText.slice(0, 200)}`);
  }
  let submitBody;
  try {
    submitBody = JSON.parse(submitText);
  } catch {
    throw new OcrError("E_BAD_REPLY", `AI Studio 返回非 JSON：${submitText.slice(0, 200)}`);
  }
  const jobId = submitBody?.data?.jobId;
  if (!jobId) {
    throw new OcrError(
      "E_AS_SHAPE",
      `提交成功但未返回 jobId，响应字段：[${Object.keys(submitBody?.data ?? submitBody ?? {}).join(", ")}]`
    );
  }
  recordTask({
    id: jobId,
    provider: "aistudio",
    engine: "vl",
    sourcePath: input.sourcePath ?? null,
    fileName: input.fileName ?? null,
    bytes: input.bytes ?? null,
    pagesHint: input.pagesHint ?? null,
  });
  if (onProgress) onProgress(`已提交 AI Studio 解析任务（jobId=${jobId}）`);
  return await pollAsUntilDone(cfg, jobId, { onProgress });
}
