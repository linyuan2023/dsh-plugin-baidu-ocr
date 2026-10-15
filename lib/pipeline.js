// lib/pipeline.js — 识别管线：引擎×文件类型路由 → 通道调用 → 可选落盘
// 独立于 index.js（不 import schemastery），便于 node --test 直接测试。
// 大文档能力（第 5 期）：结果缓存（重跑零配额）、任务表（超时可找回）、
// 大 PDF 自动分段（476 页级图册在 330s 轮询上限内可完成）。
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { OcrError } from "./errors.js";
import { dataDir } from "./auth.js";
import { syncRecognize, vlDocParse, pollVlUntilDone } from "./baidu.js";
import { aistudioParse, pollAsUntilDone } from "./aistudio.js";
import { loadInputFile, expandPath, checkChannelLimits } from "./files.js";
import { saveResult } from "./export.js";
import { checkGarbled } from "./validate.js";
import { stripPageNumberLines } from "./markdown.js";
import { mergeCrossPageParagraphs } from "./textflow.js";
import { scoreReplica } from "./fidelity.js";
import { extractOfficeLocal } from "./office.js";
import { recordLib } from "./libstore.js";
import { fileHash, cacheKey, cacheGet, cachePut } from "./cache.js";
import { findTask, markTask } from "./tasks.js";
import { pythonCmd } from "./pylaunch.js";
import { planSegments, writeSegmentPdfs, mergeSegmentResults, pdfPageCountSync, segmentDirFor, cleanupSegmentDir } from "./segment.js";

var LOG_DIR = join(dataDir(), "logs"); // 跟随数据目录（尊重 DSH_OCR_TOKEN_FILE 环境变量）

const FORMULA_MODES = ["unicode", "raw", "omml"];

// ── 引擎 × 文件类型路由（方案 5.3 路由矩阵）──
export function resolveRoute(engine, kind) {
  if (kind === "url") {
    // url 输入：vl 引擎走异步通道 B（百度 file_url / AI Studio fileUrl 分支已为 url 写好），
    // 其余同步引擎走通道 A（#4）。此前 url 一律走 A，导致选 vl 时 syncRecognize 报矛盾错误。
    return engine === "vl"
      ? { channel: "B", engine: "vl", note: "url 输入由 vl 文档解析（file_url/fileUrl）处理" }
      : { channel: "A", engine, note: "" };
  }
  if (kind === "image") {
    return engine === "vl" ? { channel: "B", engine, note: "" } : { channel: "A", engine, note: "" };
  }
  if (kind === "pdf") {
    if (engine === "general" || engine === "accurate") return { channel: "A", engine, note: "" };
    if (engine === "handwriting") {
      throw new OcrError("E_BAD_COMBO", "PDF 不支持手写引擎：纯文字请用 general/accurate（同步、快），要版面结构请用 vl");
    }
    return { channel: "B", engine: "vl", note: "" };
  }
  if (kind === "word" || kind === "ppt") {
    if (engine === "vl" || engine === "doc") {
      return { channel: "B", engine: "vl", note: "doc 引擎仅对图片生效，已自动升格为 vl" };
    }
    throw new OcrError(
      "E_BAD_COMBO",
      "Word/PPT 纯文字识别不支持：请先转 PDF 后用 general/accurate，或直接用 vl 引擎（推荐，直接出结构化文档）"
    );
  }
  if (kind === "excel") {
    // xlsx（v0.4）：云端不支持，仅本地直读（office.js）
    return { channel: "LOCAL", engine: "office-sheet", note: "xlsx 仅支持本地直读（不上传云端）" };
  }
  throw new OcrError("E_BAD_KIND", `不支持的输入类型：${kind}`);
}

export function resolveSaveDir({ outDir, cfg, exec, sourcePath }) {
  const cand = outDir || cfg.saveDir;
  if (cand) return expandPath(cand);
  // 探测会话工作区（不同版本字段名不同，全部可选链容错）
  const ws = exec?.agent?.workspace ?? exec?.workspace ?? exec?.agent?.session?.workspace ?? exec?.agent?.cwd;
  if (typeof ws === "string" && ws) return join(ws, "ocr-output");
  // 兜底：源文件所在目录
  return join(dirname(String(sourcePath)), "ocr-output");
}

export function logLine(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const file = join(LOG_DIR, `ocr-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`);
    const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    appendFileSync(file, `${time} ${JSON.stringify(entry)}\n`, "utf8");
  } catch {}
}

/** 可搜索 PDF → 本机文本层直取（pymupdf，零云端配额）。
 *  返回 { pages: [每页文本] }；无文本层/失败/python 缺失返回 null（调用方回落云端 OCR）。 */
export function extractPdfTextLocal(pdfPath, { timeoutMs = 60000, minChars = 100 } = {}) {
  try {
    const script =
      "import sys, pymupdf\n" +
      "d = pymupdf.open(sys.argv[1])\n" +
      "sys.stdout.write('\\n@@PAGE@@\\n'.join(p.get_text() for p in d))";
    const r = spawnPdfScript(script, pdfPath, timeoutMs);
    if (r.status !== 0 || !r.stdout?.trim()) return null;
    const pages = r.stdout
      .split("\n@@PAGE@@\n")
      .map((t) => t.replace(/\u000c/g, "").trim());
    if (!pages.some((t) => t.length >= minChars)) return null; // 扫描件（无文本层）→ 云端
    return { pages };
  } catch {
    return null;
  }
}

function spawnPdfScript(script, pdfPath, timeoutMs) {
  return spawnSync(pythonCmd(), ["-c", script, pdfPath], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 薄页检测（v0.4）：文本长度 < minChars 的页码（1 起始）。整本直取后提示用户哪些页疑为扫描页。 */
export function thinPdfPages(pages, { minChars = 100 } = {}) {
  return (pages ?? [])
    .map((t, i) => ({ page: i + 1, n: String(t ?? "").trim().length }))
    .filter((p) => p.n < minChars)
    .map((p) => p.page);
}

/** 薄页自动补页（v0.4，默认关 hybridThinRatio=0）：把无文本层的页逐页切出提交同步通道，
 *  与本地文本按页序合并。前置：百度同步通道接受单页 PDF（pdf_file）——实测通过后才建议开启。
 *  impl.sync 仅供测试注入；单页失败不整体失败（该页保留直取结果并计数）。 */
export async function autoFillThinPages(cfg, sourcePath, thinPages, { impl = null, onProgress, dir } = {}) {
  const syncFn = impl?.sync ?? syncRecognize;
  const segDir = dir ?? join(dataDir(), "segments", `thin-${Date.now()}`);
  const pages = [];
  let filled = 0;
  let failed = 0;
  try {
    const plan = thinPages.map((p) => ({ index: p, from: p, to: p }));
    writeSegmentPdfs(sourcePath, plan, segDir);
    for (const seg of plan) {
      try {
        onProgress?.(`扫描页补识别：第 ${seg.from} 页…`);
        const segBuf = readFileSync(seg.file);
        const r = await syncFn(cfg, "general", { pdfBase64: segBuf.toString("base64") });
        const text = r?.text ?? (r?.pages ?? []).map((p2) => p2.text ?? "").filter(Boolean).join("\n\n");
        pages.push({ page: seg.from, text: String(text ?? "").trim() });
        filled++;
      } catch {
        failed++;
      }
    }
  } catch {
    failed += thinPages.length;
  } finally {
    try {
      rmSync(segDir, { recursive: true, force: true });
    } catch {}
  }
  return { filled, failed, pages };
}

// ── 通道 B：缓存 / 分段 / 单次 ───────────────────────────────────────────────
function providerName(cfg) {
  return cfg.provider === "aistudio" ? "aistudio" : "baidu";
}

/** 单次（非分段）通道 B 调用 */
async function callChannelB(cfg, input, { onProgress } = {}) {
  if (cfg.provider === "aistudio") {
    return await aistudioParse(cfg, input, { onProgress });
  }
  let fileName = input.fileName;
  if (!fileName) {
    try {
      fileName = decodeURIComponent(input.url?.split(/[?#]/)[0].split("/").pop() ?? "") || undefined;
    } catch {
      fileName = input.url?.split(/[?#]/)[0].split("/").pop(); // 畸形百分号编码时用原始尾段
    }
    if (input.url && !fileName) fileName = "remote.png";
    if (!fileName) fileName = String(input.sourcePath).split(/[\\/]/).pop() || "upload.png";
    // multipart 文件名消毒：非 ASCII 字符替换为下划线（点号保留，扩展名不变）
    fileName = fileName.replace(/[^\x20-\x7E]/g, "_");
  }
  return await vlDocParse(cfg, input.url ? { url: input.url, fileName } : {
    imageBase64: input.kind === "image" ? input.buffer.toString("base64") : undefined,
    pdfBase64: input.kind === "pdf" ? input.buffer.toString("base64") : undefined,
    docBase64: input.kind === "word" || input.kind === "ppt" ? input.buffer.toString("base64") : undefined,
    ext: input.ext,
    fileName,
    sourcePath: input.sourcePath,
    bytes: input.bytes ?? input.size,
    pagesHint: input.pagesHint,
  }, { onProgress });
}

/** 单次（非分段）通道 B 调用（v0.4：主后端失败且备后端可用时自动切换，providerFallback=auto 才启用）。
 *  输入类错误（过大/过小/组合非法）切换后端也无解 → 直接抛；结果带 fallbackNote 供 finishResult 出 note。 */
const NON_FALLBACK_CODES = new Set(["E_TOO_LARGE", "E_TOO_BIG_PX", "E_TOO_SMALL", "E_BAD_COMBO", "E_URL_INPUT", "E_BAD_KIND", "E_LAYOUT_EMPTY"]);
async function callChannelBWithFallback(cfg, input, { onProgress } = {}) {
  const primary = providerName(cfg);
  try {
    return await callChannelB(cfg, input, { onProgress });
  } catch (e) {
    // baidu/aistudio 互为备选
    const other = primary === "baidu" ? "aistudio" : "baidu";
    const otherReady =
      other === "aistudio" ? Boolean(cfg.aistudioUrl && cfg.aistudioToken) : Boolean(cfg.apiKey && cfg.secretKey);
    const switchable = !(e instanceof OcrError && NON_FALLBACK_CODES.has(e.code));
    if (!switchable || cfg.providerFallback !== "auto" || !otherReady) throw e;
    try {
      const r = await callChannelB({ ...cfg, provider: other }, input, { onProgress });
      if (r && typeof r === "object") {
        if (r.provider === undefined) r.provider = other; // resume 按 t.provider 轮询
        r.fallbackNote = `云端解析在主后端（${primary}）失败后已自动切换到 ${other} 后端完成`;
      }
      return r;
    } catch (e2) {
      // 备后端也失败：报主后端的原始错误（更贴近用户配置）
      throw e;
    }
  }
}

/** tier 档位（v0.4，对标 MinerU 4.0 tiers）：engine 之上的翻译层——按速度/质量暴露，路由细节留在插件内。
 *  返回 { engine?, format?, hqForce? }；tier 为 auto/非法返回空对象（走现有路由，完全兼容）。 */
export function resolveTier(tier, kind) {
  if (tier === "flash") return { engine: "general" }; // PDF 有文本层时走本机直取，图片走 general
  if (tier === "basic") return { engine: "accurate" };
  if (tier === "standard") return { engine: "vl" };
  if (tier === "advanced") return { engine: "vl", format: "docx", hqForce: true };
  return {};
}

/** 大 PDF 分段跑批（自动推进）：每次调用处理"第一个未完成段"（其余段全部命中缓存），
 *  全部段完成后合并并缓存整本结果。工具路径 segmentLimit=1 → 一次调用推一段，模型连环
 *  调用即完成整本；命令路径不限 → 一次调用跑完所有缺失段。
 *  adapters 参数仅供测试注入假适配器。返回 { result, incomplete, doneCount, planCount }。 */
export async function recognizeSegmented(cfg, input, sourcePath, { onProgress, segmentLimit, extraNotes, adapters = null } = {}) {
  const impl = adapters ?? { aistudio: aistudioParse, vl: vlDocParse };
  const provider = providerName(cfg);
  // 分段路径同样吃 providerFallback=auto（此前只有单次调用有，大文档最需要兜底的场景反而没有）
  const segCall = async (segInput) => {
    const call = (c) => (providerName(c) === "aistudio" ? impl.aistudio(c, segInput, { onProgress }) : impl.vl(c, segInput, { onProgress }));
    try {
      return await call(cfg);
    } catch (e) {
      const other = provider === "baidu" ? "aistudio" : "baidu";
      const otherReady =
        other === "aistudio" ? Boolean(cfg.aistudioUrl && cfg.aistudioToken) : Boolean(cfg.apiKey && cfg.secretKey);
      const switchable = !(e instanceof OcrError && NON_FALLBACK_CODES.has(e.code));
      if (!switchable || cfg.providerFallback !== "auto" || !otherReady) throw e;
      const r = await call({ ...cfg, provider: other });
      if (r && typeof r === "object") {
        if (r.provider === undefined) r.provider = other;
        r.fallbackNote = `云端解析在主后端（${provider}）失败后已自动切换到 ${other} 后端完成`;
      }
      return r;
    }
  };
  const segSize = Math.max(1, Math.floor(Number(cfg.vlSegmentPages) || 40));
  const totalPages = pdfPageCountSync(sourcePath);
  if (!totalPages) throw new OcrError("E_SEGMENT_COUNT", "无法读取 PDF 页数（python/pymupdf 不可用？），分段识别中止；可改用单次模式");
  const plan = planSegments(totalPages, segSize);
  const fh = input.buffer ? fileHash(input.buffer) : null;
  const spanKey = (seg) => (fh ? cacheKey({ fileHash: fh, engine: "vl", provider, span: `p${seg.from}-${seg.to}` }) : null);
  const dir = segmentDirFor(sourcePath, input.size ?? 0, join(dataDir(), "segments"), fh);

  try {
  const cached = new Map(); // seg.index -> result
  let missing = null;
  for (const seg of plan) {
    const r = cacheGet(spanKey(seg))?.result ?? null;
    if (r) cached.set(seg.index, r);
    else if (!missing) missing = seg;
  }

  const budget = Math.max(1, Number(segmentLimit) || plan.length);
  let processedThisCall = 0;
  let lastSeg = null;
  while (missing && processedThisCall < budget) {
    writeSegmentPdfs(sourcePath, [missing], dir);
    onProgress?.(`第 ${missing.index}/${plan.length} 段（第 ${missing.from}-${missing.to} 页）：提交解析…`);
    const segBuf = readFileSync(missing.file);
    const segInput = {
      pdfBase64: segBuf.toString("base64"),
      buffer: segBuf,
      kind: "pdf",
      fileName: basename(missing.file),
      sourcePath,
      bytes: statSync(missing.file).size,
      pagesHint: missing.to - missing.from + 1,
    };
    const r = await segCall(segInput);
    cachePut(spanKey(missing), r);
    cached.set(missing.index, r);
    // 流式落盘（v0.4）：已完成段重写 partial.md（按段全量重写保证幂等，重试不重复）
    try {
      const doneSoFar = mergeSegmentResults(plan.map((s) => cached.get(s.index)).filter(Boolean), { paraMerge: cfg.paraMerge !== false });
      if (doneSoFar?.markdown) writeFileSync(join(dir, "partial.md"), doneSoFar.markdown, "utf8");
    } catch {}
    lastSeg = missing;
    processedThisCall += 1;
    missing = null;
    for (const seg of plan) {
      if (!cached.has(seg.index) && !cacheGet(spanKey(seg))?.result) {
        missing = seg;
        break;
      }
    }
  }

  const doneResults = plan.map((s) => cached.get(s.index)).filter(Boolean);
  const result = mergeSegmentResults(doneResults, { paraMerge: cfg.paraMerge !== false });
  // 后端结果不一定带 pagesCount（百度 vl 无）：按分段计划的真实页数兜底，避免向调用方误报 pages:0
  if (result && !result.pagesCount) {
    result.pagesCount = plan.reduce((n, s) => n + (s.to - s.from + 1), 0);
  }
  const doneCount = doneResults.length;
  const incomplete = doneCount < plan.length;
  if (incomplete) {
    result.incomplete = true; // 标记：partial 结果不落盘（recognize 据此强制 no-save）
    const partialPath = join(dir, "partial.md");
    extraNotes.push(
      `大文档分段识别：已完成 ${doneCount}/${plan.length} 段` +
        (lastSeg ? `（本次处理第 ${lastSeg.index} 段，第 ${lastSeg.from}-${lastSeg.to} 页）` : "") +
        `。请原样再次调用本识别工具继续下一段（path/engine/format 参数完全不变；` +
        `不要使用 resumeTaskId——那是给超时任务找回用的，不是分段续跑）。` +
        `已完成段走缓存零配额，全部 ${plan.length} 段完成后自动生成文档；` +
        `部分结果已边跑边写入 ${partialPath}（非最终版，仅供预览）`
    );
  } else {
    extraNotes.push(`已按 ${segSize} 页分段识别完成（共 ${plan.length} 段）`);
    cleanupSegmentDir(dir);
    if (fh) cachePut(cacheKey({ fileHash: fh, engine: "vl", provider }), result); // 整本缓存：重跑秒出
  }
  return { result, incomplete, doneCount, planCount: plan.length, partialFile: incomplete ? join(dir, "partial.md") : null };
  } catch (e) {
    // 中断/失败：清理本任务的分段工作目录，避免大 PDF 反复中断持续吃满磁盘（#pipeline low）
    cleanupSegmentDir(dir);
    throw e;
  }
}

/**
 * 识别 + 可选落盘，工具与命令共用的管线。
 * formulaMode：覆盖 cfg.formulaMode（unicode/raw/omml）；segmentLimit：分段时本次最多处理的段数。
 */
export async function recognize({ cfg, path, url, engine, format, outDir, exec, onProgress, formulaMode, segmentLimit, mdAssets, adapters = null, tier, effort }) {
  const started = Date.now();
  const input = loadInputFile(url ?? path, { allowUrl: Boolean(url) });
  const sourcePath = input.url ? "remote-image" : path;
  const kind = input.url ? "url" : input.kind;
  input.sourcePath = sourcePath;
  input.bytes = input.size;

  // tier 档位（v0.4）：显式 engine 优先；tier 只在未指定 engine 时生效（auto=现有路由不变）
  const tierRes = resolveTier(tier, kind);
  if (!engine && tierRes.engine) engine = tierRes.engine;
  if (!engine) engine = cfg.defaultEngine;
  if (!format && tierRes.format) format = tierRes.format;
  // effort=low：分段页数翻倍、矢量重截关——一个旋钮换速度；advanced 反向强制开 hq
  if (effort === "low" || tierRes.hqForce) {
    cfg = {
      ...cfg,
      ...(effort === "low" ? { vlSegmentPages: Math.max(10, Math.floor((Number(cfg.vlSegmentPages) || 40) * 2)) } : {}),
      vlVectorHq: tierRes.hqForce ? true : false,
    };
  }

  const route = resolveRoute(engine, kind);
  engine = route.engine;
  if (route.channel !== "LOCAL") checkChannelLimits(route, input); // 通道感知限额（LOCAL 本地直读不上传，不设限）
  const fm = FORMULA_MODES.includes(formulaMode) ? formulaMode : cfg.formulaMode || "unicode";
  const syncFn = adapters?.sync ?? syncRecognize;

  let savedFiles;
  const extraNotes = [];
  // provider 异常值（如 MinerU 移除后 config.json 的历史残留）在 providerName 处静默回落百度——
  // 给一句提示而不是无声换后端，用户不至于困惑"配置没生效"
  if (cfg.provider && !["baidu", "aistudio"].includes(cfg.provider)) {
    extraNotes.push(`配置的识别后端 "${cfg.provider}" 不存在，已按百度智能云处理；请到 设置→OCR 重新选择后端`);
  }
  let result = null;
  let partial = false; // 分段进行中：结果不完整时不落盘，等全部段完成
  let segPartialFile = null;
  // EXIF 方向提示（v0.4）：竖拍照片（Orientation 3/4/6/8）按原字节上传，方向异常时给用户自助路径
  if ([3, 4, 6, 8].includes(input.dims?.orientation)) {
    extraNotes.push(`照片带 EXIF 旋转标记（方向 ${input.dims.orientation}）：已按原字节上传；若识别文字方向异常，请用系统相册"另存为新照片"后再试`);
  }
  // Office 本地直读（v0.4）：docx/pptx 先本地解析（秒级零配额），失败回落云端 vl；xlsx 在 LOCAL 路由单独处理
  if ((input.kind === "word" || input.kind === "ppt") && route.channel === "B" && cfg.officeLocalRead !== false && [".docx", ".pptx"].includes(input.ext) && !input.url) {
    try {
      result = extractOfficeLocal(input.buffer, input.ext);
      engine = result.engine;
      extraNotes.push("已本地直读（未消耗云端配额）");
      if (result.localSkipped) extraNotes.push(`本地直读未覆盖：${result.localSkipped}`);
      extraNotes.push("文本层直读不含图片内文字；需要全量请 --vl 走云端解析");
    } catch {
      extraNotes.push("本地直读不可用，已回落云端 vl 解析");
    }
  }
  // 可搜索 PDF 纯文字诉求 → 本机文本层直取（零云端配额、秒级）；文本过少（扫描件）自动回落云端
  if (input.kind === "pdf" && route.channel === "A") {
    const local = extractPdfTextLocal(String(sourcePath));
    if (local) {
      const thin = thinPdfPages(local.pages);
      const mergedText = mergeCrossPageParagraphs(local.pages, { enabled: cfg.paraMerge !== false });
      result = {
        engine: "pdf-text",
        channel: "LOCAL",
        pages: local.pages.map((t) => ({ text: t })),
        text: mergedText.text,
        ...(mergedText.merged > 0 ? { paraMerged: mergedText.merged } : {}),
      };
      engine = "pdf-text";
      extraNotes.push("已从 PDF 文本层直取（未消耗云端额度；图片/印章不含在内）");
      if (thin.length) {
        const list = thin.length > 20 ? `第 ${thin.slice(0, 20).join("、")} 等 ${thin.length} 页` : `第 ${thin.join("、")} 页`;
        extraNotes.push(`${list}无文本层（疑为扫描页，其内容不在结果中）；需要完整内容请加 --vl 重跑`);
        // 自动补页（默认关 hybridThinRatio=0）：薄页占比 ≤ 阈值时逐页补同步通道识别
        const ratio = Math.max(0, Number(cfg.hybridThinRatio) || 0);
        if (ratio > 0 && thin.length / local.pages.length <= ratio) {
          const filled = await autoFillThinPages(cfg, String(sourcePath), thin, { impl: adapters, onProgress });
          if (filled.filled > 0) {
            const byPage = new Map(filled.pages.map((p) => [p.page, p.text]));
            result.pages = local.pages.map((t, i) => (byPage.has(i + 1) && byPage.get(i + 1) ? { text: byPage.get(i + 1) } : { text: t }));
            const m2 = mergeCrossPageParagraphs(result.pages.map((p) => p.text), { enabled: cfg.paraMerge !== false });
            result.text = m2.text;
            extraNotes.push(`已对 ${filled.filled} 个扫描页补识别（耗同步通道配额）`);
          }
          if (filled.failed > 0) extraNotes.push(`${filled.failed} 个扫描页补识别失败（该页保留直取结果）`);
        }
      }
    }
  }
  if (result) {
    // 本地直取/本地直读已成功，跳过云端
  } else if (route.channel === "LOCAL") {
    // 仅本地通道（xlsx，v0.4）：office.js 直读；失败直接报错（云端无此通道）
    const local = extractOfficeLocal(input.buffer, input.ext);
    result = local;
    engine = local.engine;
    extraNotes.push("已本地直读（未消耗云端配额）");
    if (local.localSkipped) extraNotes.push(`本地直读未覆盖：${local.localSkipped}`);
  } else if (route.channel === "A") {
    result = await syncFn(cfg, engine, input.url ? { url: input.url } : {
      imageBase64: input.kind === "image" ? input.buffer.toString("base64") : undefined,
      pdfBase64: input.kind === "pdf" ? input.buffer.toString("base64") : undefined,
    });
  } else {
    // 通道 B：先查结果缓存（同文件同引擎重跑秒出、零配额），再走分段/单次
    const fh = input.buffer ? fileHash(input.buffer) : null;
    const key = fh ? cacheKey({ fileHash: fh, engine: "vl", provider: providerName(cfg) }) : null;
    const hit = cacheGet(key);
    if (hit?.result) {
      result = hit.result;
      extraNotes.push("已用本地缓存结果（未消耗云端配额）");
    } else {
      const segSize = Math.max(0, Math.floor(Number(cfg.vlSegmentPages) || 0));
      const canSegment = !input.url && input.kind === "pdf" && segSize > 0;
      const totalPages = canSegment ? pdfPageCountSync(sourcePath) : null;
      if (canSegment && totalPages && totalPages > segSize) {
        const seg = await recognizeSegmented(cfg, input, sourcePath, { onProgress, segmentLimit, extraNotes });
        result = seg.result;
        partial = seg.incomplete;
        segPartialFile = seg.partialFile ?? null;
      } else {
        result = await callChannelBWithFallback(cfg, input, { onProgress });
        if (key) cachePut(key, result);
      }
    }
  }

  // markdown 路径页码剥离（版面路径已在 layoutToPageBlocks 内处理）：
  // 后端 markdown 每页一个孤立纯数字行，≥10 行判定为页码模式整体剥离
  if (route.channel === "B" && result.markdown) {
    const pn = stripPageNumberLines(result.markdown);
    if (pn.removed > 0) {
      result.markdown = pn.text;
      result.text = pn.text;
      extraNotes.push(`已剥离 ${pn.removed} 个页码行`);
    }
  }

  const out = await finishResult({
    cfg,
    result,
    engine,
    channel: route.channel,
    // 分段进行中：结果不完整，强制 no-save（note 已说明全部完成后自动生成文档）
    format: partial ? "none" : format,
    outDir,
    exec,
    sourcePath,
    extraNotes,
    started,
    fm,
    mdAssets,
    routeNote: route.note,
    inputKind: kind,
    provider: providerName(cfg),
  });
  if (partial && segPartialFile) out.partialFile = segPartialFile;
  return out;
}

/** 本地 PDF 逐页尺寸（pymupdf，pt）→ docx 页几何钉死用；不可用返回 null（回退 A4 预设）。 */
function resolvePageSizes(sourcePath, timeoutMs = 60000) {
  if (!sourcePath || !/\.(pdf)$/i.test(String(sourcePath))) return null;
  try {
    const r = spawnPdfScript(
      "import sys, json, pymupdf\nd = pymupdf.open(sys.argv[1])\nsys.stdout.write(json.dumps([[p.rect.width, p.rect.height] for p in d]))",
      String(sourcePath),
      timeoutMs
    );
    if (r.status !== 0 || !r.stdout?.trim()) return null;
    const dims = JSON.parse(r.stdout);
    if (!Array.isArray(dims) || !dims.length) return null;
    return dims.map(([w, h]) => ({ wPt: w, hPt: h, wTwips: Math.round(w * 20), hTwips: Math.round(h * 20) }));
  } catch {
    return null;
  }
}

/** 识别收尾：乱码门禁 → 落盘 → 返回值组装（recognize 与 resumeTask 共用） */
async function finishResult({ cfg, result, engine, channel, format, outDir, exec, sourcePath, extraNotes = [], started, fm, mdAssets, routeNote, inputKind, provider }) {
  let savedFiles;
  const fmt = format || cfg.defaultFormat || "md";
  // 段落合并计数（v0.4）：aistudio/segment/pdf-text 各接入点回传的合并处数统一在此出 note
  if (result.paraMerged > 0) extraNotes.push(`已合并 ${result.paraMerged} 处跨页段落`);
  // 后端自动切换说明（v0.4，providerFallback=auto 时）
  if (result.fallbackNote) extraNotes.push(result.fallbackNote);
  // 不可复刻结果检测（v0.4）：通道 B 无版面坐标时，docx/pdf 的版面保真无法兑现，明确告知而非静默退化
  if (
    channel === "B" &&
    inputKind === "pdf" &&
    !result.layoutJson?.pages?.length &&
    ["docx", "docx-gongwen", "pdf", "pdf-replica"].includes(fmt)
  ) {
    extraNotes.push(
      `该结果无版面坐标（${provider || cfg.provider || "?"} 后端）：docx/pdf 将按 markdown 单节排版（无逐页分节/页方向）；` +
        "需要版面复刻请在 设置→OCR 将后端切换为百度智能云后重跑"
    );
  }
  // 乱码门禁（生成文档前强制校验）：检出即拦截，不产出带乱码的文档
  const fullText = result.pages?.map((p) => p.text).filter(Boolean).join("\n\n") || result.text || "";
  const garbled = checkGarbled(fullText);
  if (garbled) {
    logLine({ engine, channel, ok: false, garbled: garbled.slice(0, 120) });
    if (fmt !== "none") {
      throw new OcrError(
        "E_GARBLED",
        `${garbled}。已停止生成文档。建议：①扫描件/文本层损坏的 PDF 请改用 vl 引擎（AI Studio 或百度云端 OCR，不走文本层）；②截图类换高清原图重试`,
        { cause: garbled }
      );
    }
    extraNotes.push(`⚠ ${garbled}`);
  }

  if (fmt !== "none") {
    const dir = resolveSaveDir({ outDir, cfg, exec, sourcePath });
    const hq = cfg.vlVectorHq !== false && result.layoutJson && sourcePath && /\.(pdf)$/i.test(String(sourcePath))
      ? { pdfPath: sourcePath, dpi: 220 }
      : null;
    // docx/pdf 页几何钉死（v0.4）：本地 PDF 原件逐页尺寸（pt→twips），非 A4 原件分页不再漂移
    const pageSizes = (fmt === "docx" || fmt === "pdf") && result.layoutJson ? resolvePageSizes(sourcePath) : null;
    // 复刻度评分（v0.4）：content-list 落盘时对本地 PDF 原件量化（评分不可用静默跳过）
    if (fmt === "content-list" && sourcePath && /\.(pdf)$/i.test(String(sourcePath)) && result.layoutJson?.pages?.length) {
      const score = scoreReplica({
        sourcePath: String(sourcePath),
        layoutJson: result.layoutJson,
        formulaMode: fm,
        mergeMode: ["strict", "loose", "off"].includes(cfg.crossPageMerge) ? cfg.crossPageMerge : "strict",
        paraMerge: cfg.paraMerge !== false,
      });
      if (score) {
        extraNotes.push(`复刻度评分：overall ${score.overall}（文本 ${score.textCoverage} / 版面 ${score.blockIoU} / 页面 ${score.pageMatch}）`);
      }
    }
    const saved = await saveResult(result, {
      format: fmt,
      saveDir: dir,
      sourcePath,
      keepHeaderFooter: cfg.keepHeaderFooter === true,
      formulaMode: fm,
      mergeMode: ["strict", "loose", "off"].includes(cfg.crossPageMerge) ? cfg.crossPageMerge : "strict",
      hq,
      localizeAssets: mdAssets === true,
      paraMerge: cfg.paraMerge !== false,
      pageSizes,
      replicaDpi: Math.min(400, Math.max(96, Number(cfg.replicaDpi) || 200)),
    });
    savedFiles = saved.files;
    if (saved.note) extraNotes.push(saved.note);
  }

  const text = result.text ?? "";
  logLine({ engine, channel, bytes: 0, ms: Date.now() - started, chars: text.length, ok: true });

  // 文档库登记（v0.4）：/ocr lib 引用定位的底座；content-list 产物记录为 contentListPath（page 定位用）
  let libId = null;
  if (fmt !== "none" && savedFiles?.length) {
    libId = recordLib({
      files: savedFiles,
      sourcePath,
      engine,
      format: fmt,
      chars: text.length,
      contentListPath: fmt === "content-list" ? savedFiles[0] : null,
    });
  }

  const previewText = text.slice(0, 2000);
  // 工具返回值白名单：框架做 lossless JSON 序列化，undefined 等非安全值会导致
  // "value is not lossless JSON" 失败——只放确定存在的原始值与字符串数组
  const out = {
    engine,
    channel,
    chars: text.length,
    preview: text.length > 2000 ? previewText + `
…（共 ${text.length} 字，已截断）` : previewText,
    savedFiles: savedFiles ?? [],
  };
  const note = [routeNote, ...extraNotes].filter(Boolean).join("；");
  if (note) out.note = note;
  const pagesN = result.pages?.length ?? result.pagesCount;
  if (pagesN != null) out.pages = pagesN;
  if (result.taskId != null) out.taskId = result.taskId;
  if (fmt !== "none") out.format = fmt;
  if (libId) out.libId = libId;
  return out;
}

/** 凭任务 id 恢复轮询并取回结果（/ocr resume）。超时的云端任务只要还在执行就能拿回。 */
export async function resumeTask({ cfg, id, format, outDir, exec, onProgress, mdAssets }) {
  const started = Date.now();
  const t = findTask(id);
  if (!t) {
    throw new OcrError("E_NO_TASK", `没有找到任务 ${id}（用 /ocr tasks 查看最近任务）`);
  }
  if (t.status === "done") {
    // 防重入：done 任务的结果已落盘过，重复 resume 只会反复取回同一段（模型曾连环误用 8 次）
    throw new OcrError(
      "E_TASK_DONE",
      `任务 ${t.id} 的结果已取回过，无需再 resume。` +
        `如需重新生成文档：直接重新识别（同文件走本地缓存秒出）；` +
        `大文档分段进行中：请原样再次调用识别工具继续下一段（不要使用 resumeTaskId）。`
    );
  }
  let result;
  try {
    result = t.provider === "aistudio"
      ? await pollAsUntilDone(cfg, t.id, { onProgress })
      : await pollVlUntilDone(cfg, t.id, { onProgress });
  } catch (e) {
    if (e instanceof OcrError && (e.code === "E_VL_FAILED" || e.code === "E_EMPTY_RESULT")) {
      markTask(t.id, { status: "failed", error: e.message.slice(0, 200) });
    }
    throw e;
  }
  if (result.markdown) {
    const pn = stripPageNumberLines(result.markdown);
    if (pn.removed > 0) {
      result.markdown = pn.text;
      result.text = pn.text;
    }
  }
  // 先交付，成功后才标 done：finishResult 内乱码门禁可能抛 E_GARBLED，
  // 若先标 done，E_GARBLED 后任何 resume 撞 E_TASK_DONE 永久拒收（#6）
  const out = await finishResult({
    cfg,
    result,
    engine: "vl",
    channel: "B",
    format,
    outDir,
    exec,
    sourcePath: t.sourcePath ?? t.fileName ?? "resumed-task",
    extraNotes: [`任务 ${t.id} 已取回结果（提交于 ${new Date(t.submittedAt || Date.now()).toLocaleString()}）`],
    started,
    fm: cfg.formulaMode || "unicode",
    mdAssets: mdAssets === true,
    inputKind: /\.(pdf)$/i.test(String(t.sourcePath ?? t.fileName ?? "")) ? "pdf" : undefined,
    provider: t.provider,
  });
  markTask(t.id, { status: "done" });
  return out;
}
