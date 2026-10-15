// lib/index.js — dsh-plugin-baidu-ocr 插件入口
// 形态对齐 dsh-plugin-notify：导出 { name, inject, apply }，apply(ctx) 内注册
// settings / tools / commands / webServer。全程零第三方依赖（仅 node 内置 + 宿主提供的 schemastery）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { OcrError } from "./errors.js";
import { cachedToken, getToken, clearCache, dataDir } from "./auth.js";
import { recognize, resumeTask, logLine } from "./pipeline.js";
import { expandPath, IMAGE_EXTS, PDF_EXTS, VL_ONLY_EXTS } from "./files.js";
import { listTasks } from "./tasks.js";
import { cacheClear } from "./cache.js";
import { listLib, findLib } from "./libstore.js";

var name = "dsh-plugin-baidu-ocr";
var inject = ["commands", "webServer", "tools", "settings"];

var PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
var CONFIG_FILE = join(dataDir(), "config.json");

var ENGINES = ["general", "accurate", "handwriting", "doc", "vl"];
var FORMATS = ["none", "txt", "md", "docx", "docx-gongwen", "pdf", "pdf-replica", "csv", "content-list"];
var FORMULA_MODES = ["unicode", "raw", "omml"];
var MERGE_MODES = ["strict", "loose", "off"];
var TIERS = ["auto", "flash", "basic", "standard", "advanced"];

var DEFAULTS = {
  apiKey: "",
  secretKey: "",
  defaultEngine: "general",
  defaultFormat: "md",
  saveDir: "",
  requestTimeoutMs: 30000,
  vlPollTimeoutMs: 300000,
  keepHeaderFooter: false,
  formulaMode: "unicode",
  provider: "baidu",
  aistudioUrl: "",
  aistudioToken: "",
  asDocOrientation: true,
  asDocUnwarping: false,
  asChartRecognition: false,
  vlSegmentPages: 40,
  vlVectorHq: true,
  crossPageMerge: "strict",
  paraMerge: true,
  hybridThinRatio: 0,
  providerFallback: "off",
  defaultTier: "auto",
  officeLocalRead: true,
  replicaDpi: 200,
  fontSizeFromLayout: true,
};

var _settingsScope = null;

// ── 配置分层：设置面板 → 环境变量 → config.json → 默认值（沿用 notify 的兜底模式）──
// config.json 是用户手编文件：数值/布尔字段做类型校验，坏类型（如 requestTimeoutMs:"abc"）
// 落到默认值而不是透传——NaN 超时会让所有请求 0ms 立即 abort，极难排查。
const NUM_CFG_KEYS = new Set(["requestTimeoutMs", "vlPollTimeoutMs", "vlSegmentPages", "replicaDpi", "hybridThinRatio"]);
const BOOL_CFG_KEYS = new Set([
  "keepHeaderFooter", "asDocOrientation", "asDocUnwarping", "asChartRecognition",
  "vlVectorHq", "paraMerge", "officeLocalRead", "fontSizeFromLayout",
]);
function sanitizeCfgValue(key, v) {
  if (NUM_CFG_KEYS.has(key)) return Number.isFinite(Number(v)) ? Number(v) : undefined;
  if (BOOL_CFG_KEYS.has(key)) return typeof v === "boolean" ? v : undefined;
  return typeof v === "string" ? v : undefined;
}

function loadConfig() {
  if (_settingsScope) {
    try {
      const v = _settingsScope.get();
      if (v && typeof v === "object") {
        return { ...DEFAULTS, ...v, ...envOverrides() };
      }
    } catch {}
  }
  const cfg = { ...DEFAULTS, ...envOverrides() };
  try {
    const d = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    for (const k of Object.keys(DEFAULTS)) {
      if (d[k] != null && d[k] !== "") {
        const v = sanitizeCfgValue(k, d[k]);
        if (v !== undefined) cfg[k] = v;
      }
    }
  } catch {}
  return cfg;
}

function envOverrides() {
  const env = {};
  if (process.env.BAIDU_OCR_API_KEY) env.apiKey = process.env.BAIDU_OCR_API_KEY;
  if (process.env.BAIDU_OCR_SECRET_KEY) env.secretKey = process.env.BAIDU_OCR_SECRET_KEY;
  if (process.env.AISTUDIO_OCR_URL) env.aistudioUrl = process.env.AISTUDIO_OCR_URL;
  if (process.env.AISTUDIO_OCR_TOKEN) env.aistudioToken = process.env.AISTUDIO_OCR_TOKEN;
  return env;
}

async function saveConfig(patch) {
  if (_settingsScope) {
    await _settingsScope.update(patch);
    loadConfig();
    return;
  }
  const cur = (() => {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch {
      return {};
    }
  })();
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  // 原子写（tmp 带 pid，同 tasks.js）：直写目标文件时进程中断会留下半截 JSON，
  // 下次启动 parse 失败静默回落默认值 = 密钥无声丢失
  const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...cur, ...patch }, null, 2), "utf8");
  try {
    renameSync(tmp, CONFIG_FILE);
  } catch {
    rmSync(tmp, { force: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...cur, ...patch }, null, 2), "utf8");
  }
}

// ── 工具 / 命令的公共描述 ──
var ENGINE_HINT =
  "general=通用标准（默认，快、免费额度大）；accurate=高精度；handwriting=手写；doc=办公文档识别（仅图片）；" +
  "vl=PaddleOCR-VL 文档解析（异步，输出带标题/表格结构的 markdown，适合 PDF/Word/PPT 或要成文档的场景）";

function maskKey(v) {
  if (!v) return "";
  // 不回显任何尾位（即便仅 localhost 可达）：降低密钥/令牌泄露风险（#pipeline low）
  return "****";
}
function isMasked(v) {
  return !v || v === "__KEEP__" || v === "__CLEAR__" || /^\*{4}/.test(v);
}

// 整 token 匹配一个 flag（以空白或字符串边界为界），避免 "--doc" 吞掉 "--docx"、
// "--md" 吞掉 "--md-assets" 这类子串误匹配（#1/#3）。返回 [是否命中, 剔除该 token 后的串]。
function stripFlag(str, f) {
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(^|\\s)" + esc + "(\\s|$)");
  if (!re.test(str)) return [false, str];
  const next = str.replace(re, (_, a, b) => (a && b ? " " : ""));
  return [true, next];
}

// ── apply ──
function apply(ctx) {
  // 1) 设置节（面板可配；schemastery 懒加载——缺失时降级 config.json 而不是炸掉整个 bundle）。
  //    参照 0.1.7 升级教训：bundle 内插件激活失败会阻断整个 web UI，因此这里绝不让 import 失败传播。
  let z = null;
  try {
    z = createRequire(join(PACKAGE_ROOT, "package.json"))("@deepseek-ai/schemastery");
  } catch (e) {
    console.error("[ocr] schemastery 不可用，设置降级为 config.json 模式:", e.message);
  }
  if (z) {
    try {
      const ocrSchema = z.object({
        apiKey: z.string().default(""),
        secretKey: z.string().default(""),
        defaultEngine: z.string().default("general"),
        defaultFormat: z.string().default("md"),
        saveDir: z.string().default(""),
        requestTimeoutMs: z.number().default(30000),
        vlPollTimeoutMs: z.number().default(300000),
        keepHeaderFooter: z.boolean().default(false),
        formulaMode: z.string().default("unicode"),
        provider: z.string().default("baidu"),
        aistudioUrl: z.string().default(""),
        aistudioToken: z.string().default(""),
        asDocOrientation: z.boolean().default(true),
        asDocUnwarping: z.boolean().default(false),
        asChartRecognition: z.boolean().default(false),
        vlSegmentPages: z.number().default(40),
        vlVectorHq: z.boolean().default(true),
        crossPageMerge: z.string().default("strict"),
        paraMerge: z.boolean().default(true),
        hybridThinRatio: z.number().default(0),
        providerFallback: z.string().default("off"),
        defaultTier: z.string().default("auto"),
        officeLocalRead: z.boolean().default(true),
        replicaDpi: z.number().default(200),
        fontSizeFromLayout: z.boolean().default(true),
      });
      _settingsScope = ctx.settings?.register("ocr", ocrSchema, { applies: "live" });
      if (_settingsScope) console.log("[ocr] 已注册原生设置（设置界面可配置 OCR）");
    } catch (e) {
      console.error("[ocr] settings 注册失败，降级 config.json:", e.message);
      _settingsScope = null;
    }
  }

  // 2) 工具
  ctx.tools?.register?.({
    name: "ocr_recognize",
    description:
      "调用百度云端 OCR（或本地解析）识别图片/PDF/文档中的文字，可保存为 txt/md/docx/GB-T公文docx/pdf/csv/content-list(json)。" +
      "用户让你“提字/识别截图/抄录图片文字/把 PDF 转成文档”时使用。" +
      `档位 tier（推荐）：auto=按路由规则；flash=最快提字；basic=高精度；standard=VL 结构化；advanced=极致复刻（VL+矢量重截+版面 docx）。` +
      `引擎选择（细粒度，可覆盖档位）：${ENGINE_HINT}。` +
      "docx/pptx/xlsx 默认本地直读（零配额，不含图片内文字）；超大 PDF 自动分段：每次调用处理下一个未完成段并返回进度，返回的 note 提示未完成时请再次调用本工具（参数完全相同即可），全部段完成后自动生成完整文档；已完成段走缓存重复调用零配额。" +
      "超时任务可用 resumeTaskId 找回。返回的 libId 可用 /ocr lib <id尾部> 预览与引用（ocr://<id>#page=N）。" +
      "注意：识别时文件内容会发送到所配置的云端后端（百度智能云/AI Studio）；本地直读不上传。path 必须是绝对路径（本地文件）；url 亦可（公网图片，vl 引擎走 file_url）。format=none 只返回不落盘。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件绝对路径（图片 png/jpg/jpeg/bmp/tiff/pnm/webp、pdf、doc/docx/ppt/pptx/xlsx）" },
        url: { type: "string", description: "公网图片 URL（与 path 二选一）" },
        tier: { type: "string", enum: TIERS, description: "档位（推荐）：auto=按路由规则（默认）；flash=最快提字；basic=高精度；standard=VL 结构化；advanced=极致复刻。显式 engine 优先于 tier" },
        effort: { type: "string", enum: ["low", "high"], description: "low=速度优先（分段更大/矢量重截关）；high=质量优先（默认）" },
        engine: { type: "string", enum: ENGINES, description: "识别引擎（细粒度，优先于 tier）。vl=文档解析（PDF/Word/PPT/截图→结构化 markdown）；纯提字选 general/accurate/handwriting/doc；留空按 tier/默认引擎" },
        format: { type: "string", enum: FORMATS, description: "结果保存格式：none=不落盘只返回（默认）；txt；md=markdown；docx=Word 文档（版面还原：图片嵌入/标题分级/HTML 表格/页尺寸钉死）；docx-gongwen=GB/T 9704 公文 docx；pdf=版面保真 PDF；pdf-replica=复刻 PDF（原页位图+隐形文字层，视觉100%可检索）；csv（仅表格）；content-list=结构化 JSON（含 0–1000 归一化 bbox，附复刻度评分）" },
        outDir: { type: "string", description: "保存目录（绝对路径）。默认会话工作区下 ocr-output/" },
        formulaMode: { type: "string", enum: FORMULA_MODES, description: "公式输出模式（覆盖全局设置，仅本次）：unicode=LaTeX 清洗为可读文本；raw=保留 LaTeX 源；omml=docx 原生公式对象" },
        resumeTaskId: { type: "string", description: "恢复此任务的轮询并取回结果（超时任务的 id，可只给尾部几位；提供后忽略 path/url/engine）" },
        mdAssets: { type: "boolean", description: "format=md 时下载图片到 <产物名>.assets/ 并写相对路径（默认 false 引用 30 天直链）" },
      },
      required: [],
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (args, value) => [
        {
          type: "text",
          text: value?.error
            ? `OCR 失败（${value.engine ?? "?"}）：${value.error}`
            : `OCR 完成（${value.engine}${value.note ? "，" + value.note : ""}）：${value.chars} 字` +
              (value.savedFiles?.length ? `，已保存 ${value.savedFiles.join("、")}` : "（未落盘）"),
        },
      ],
    },
    execute: async (args, exec) => {
      try {
        const cfg = loadConfig();
        const resumeId = String(args.resumeTaskId ?? "").trim();
        if (resumeId) {
          return await resumeTask({
            cfg,
            id: resumeId,
            format: FORMATS.includes(args.format) ? args.format : undefined,
            outDir: args.outDir,
            mdAssets: args.mdAssets === true,
            exec,
          });
        }
        const p = String(args.path ?? "").trim();
        const u = String(args.url ?? "").trim();
        if (!p && !u) {
          return { error: "path 与 url 至少提供一个" };
        }
        // path 传了 URL：不展开（否则会被拼上 workspace 前缀，报误导性的"文件不存在"），
        // 交给 loadInputFile 给出"请改用 url 参数"的明确指引
        const tierArg = TIERS.includes(args.tier) ? args.tier : undefined;
        const r = await recognize({
          cfg,
          path: p && !/^https?:\/\//i.test(p) ? expandPath(p, exec?.agent?.workspace) : p || undefined,
          url: u || undefined,
          engine: ENGINES.includes(args.engine) ? args.engine : tierArg ? undefined : cfg.defaultEngine,
          tier: tierArg,
          effort: ["low", "high"].includes(args.effort) ? args.effort : undefined,
          format: FORMATS.includes(args.format) ? args.format : undefined,
          outDir: args.outDir,
          exec,
          formulaMode: FORMULA_MODES.includes(args.formulaMode) ? args.formulaMode : undefined,
          mdAssets: args.mdAssets === true,
          segmentLimit: 1, // 工具整体 360s：大文档只跑第 1 段，note 里提示用命令续跑
        });
        return r;
      } catch (e) {
        const msg = e instanceof OcrError ? e.message : `插件内部错误：${e.message}`;
        logLine({ ok: false, error: msg.slice(0, 200) });
        return { error: msg };
      }
    },
    isConcurrencySafe: () => false, // 云端配额有限流，串行执行
    timeoutMs: 360000, // vl 轮询上限 5 分钟 + 余量
  });

  // 3) 命令 /ocr
  ctx.commands?.register?.({
    name: "ocr",
    description:
      "OCR 识别图片/PDF/文档并保存。/ocr <文件路径|URL> [--accurate|--handwriting|--doc|--vl] [--flash|--basic|--standard|--advanced] [--effort low|high] [--txt|--md|--docx|--gongwen|--pdf|--pdf-replica|--csv|--content-list] [--formula <unicode|raw|omml>] [--md-assets] [--no-save] [--out <目录>]；--dir 批量；/ocr resume <任务id尾部> 取回超时任务；/ocr tasks 查看任务；/ocr cache clear 清缓存；/ocr lib [id尾部|find <关键词>] 文档库",
    input: { hint: "<路径|URL|resume|tasks|cache|lib> [--vl|--advanced] [--txt|--md|--docx|...]" },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? "").trim();
      if (!raw) {
        return { kind: "error", text: "用法：/ocr <文件路径|URL> [--vl|--advanced] [--txt|--md|--docx|--csv] [--no-save] [--out <目录>]\n" +
          "/ocr resume <任务id尾部>        取回超时/中断任务的结果\n" +
          "/ocr tasks                     查看最近任务\n" +
          "/ocr cache clear               清除结果缓存\n" +
          "/ocr lib [id尾部|find <词>]    文档库：列表 / 预览 / 全文检索\n" +
          "例：/ocr D:\\shot.png --md；/ocr D:\\大图册.pdf --advanced" };
      }
      const cfg = loadConfig();

      // ── 子命令：resume / tasks / cache / lib ──
      const resumeM = /^resume\s+(\S+)/.exec(raw);
      if (resumeM) {
        let fmt2;
        let mdAssets2 = false;
        let rest2 = raw;
        for (const f of ["--txt", "--md", "--docx", "--gongwen", "--pdf", "--pdf-replica", "--content-list", "--csv"]) {
          const [hit, next] = stripFlag(rest2, f);
          if (hit) {
            fmt2 = f.replace("--", "").replace("gongwen", "docx-gongwen");
            rest2 = next;
          }
        }
        const [maHit, maNext] = stripFlag(rest2, "--md-assets");
        if (maHit) {
          mdAssets2 = true;
          rest2 = maNext;
        }
        try {
          const r = await resumeTask({ cfg, id: resumeM[1], format: fmt2, mdAssets: mdAssets2 });
          const lines = [`✅ 任务结果已取回（${r.note ? r.note + "，" : ""}共 ${r.chars} 字）`];
          if (r.savedFiles?.length) lines.push(`已保存：\n${r.savedFiles.map((f2) => "- " + f2).join("\n")}`);
          lines.push("", "----- 识别预览 -----", r.preview || "（无文字）");
          return { kind: "success", text: lines.join("\n") };
        } catch (e) {
          return { kind: "error", text: `[ocr] ${e.message}` };
        }
      }
      if (/^tasks\b/.test(raw)) {
        const tasks = listTasks(10);
        if (!tasks.length) return { kind: "success", text: "暂无任务记录" };
        const lines = tasks.map((t) => {
          const time = new Date(t.submittedAt || Date.now()).toLocaleString();
          const name = t.fileName || t.sourcePath || "?";
          const extra = t.status === "running" ? `，可 /ocr resume ${String(t.id).slice(-8)}` : "";
          return `- [${t.status}] ${String(t.id).slice(-8)} ${name}（${t.provider}，${time}${extra}）`;
        });
        return { kind: "success", text: `最近任务：\n${lines.join("\n")}` };
      }
      const cacheM = /^cache\s+clear/.exec(raw);
      if (cacheM) {
        cacheClear();
        return { kind: "success", text: "结果缓存已清除" };
      }
      // /ocr lib：文档库（v0.4）——列表 / 尾缀预览 / 全文检索
      const libM = /^lib(?:\s+(.*))?$/.exec(raw);
      if (libM) {
        const libArg = (libM[1] ?? "").trim();
        const findM = /^find\s+(.+)$/i.exec(libArg);
        const readPreview = (p) => {
          try {
            return readFileSync(p, "utf8").slice(0, 1500);
          } catch {
            return "（文件已不存在或不可读）";
          }
        };
        if (findM) {
          const q = findM[1].trim();
          const hits = [];
          for (const e of listLib(200)) {
            for (const f of e.files ?? []) {
              try {
                if (/\.(md|txt)$/i.test(f) && readFileSync(f, "utf8").includes(q)) {
                  hits.push(`- ${e.id} ${f}（${e.format}，${e.chars} 字，${new Date(e.at).toLocaleString()}）`);
                  break;
                }
              } catch {}
            }
            if (hits.length >= 20) break;
          }
          return { kind: "success", text: hits.length ? `“${q}” 命中 ${hits.length} 条：\n${hits.join("\n")}` : `文档库中没有包含“${q}”的产物` };
        }
        if (libArg) {
          const e = findLib(libArg);
          if (!e) return { kind: "error", text: `[ocr] 没有找到文档库条目 ${libArg}（/ocr lib 查看全部）` };
          const lines = [`📄 ${e.id}（${e.format}，${e.chars} 字，${new Date(e.at).toLocaleString()}）`, ...`源：${e.source || "?"}`, ...(e.contentListPath ? [`引用定位：ocr://${e.id}#page=N（结构化：${e.contentListPath}）`] : []), "", "----- 预览 -----", readPreview(e.files?.[0])];
          return { kind: "success", text: lines.filter(Boolean).join("\n") };
        }
        const entries = listLib(20);
        if (!entries.length) return { kind: "success", text: "文档库为空（识别并保存后自动登记）" };
        const lines = entries.map((e) => `- ${e.id} [${e.format}] ${(e.files?.[0] ?? "?").split(/[\\/]/).pop()}（${e.chars} 字，${new Date(e.at).toLocaleString()}）`);
        return { kind: "success", text: `最近产物（/ocr lib <id尾部> 预览；/ocr lib find <词> 检索）：\n${lines.join("\n")}` };
      }

      let rest = raw;
      const flag = (f) => {
        const [hit, next] = stripFlag(rest, f);
        if (hit) {
          rest = next;
          return true;
        }
        return false;
      };
      let engine = cfg.defaultEngine;
      if (flag("--accurate")) engine = "accurate";
      else if (flag("--handwriting")) engine = "handwriting";
      else if (flag("--doc")) engine = "doc";
      else if (flag("--vl")) engine = "vl";
      // tier 档位旗标（v0.4）：与 engine 并存，显式 engine 优先（recognize 内处理优先级）
      let tier;
      if (flag("--flash")) tier = "flash";
      else if (flag("--basic")) tier = "basic";
      else if (flag("--standard")) tier = "standard";
      else if (flag("--advanced")) tier = "advanced";
      let effort;
      const effortM = /--effort\s+(low|high)/.exec(rest);
      if (effortM) {
        effort = effortM[1];
        rest = rest.replace(effortM[0], "");
      }
      let format;
      if (flag("--txt")) format = "txt";
      else if (flag("--md")) format = "md";
      else if (flag("--docx")) format = "docx";
      else if (flag("--gongwen")) format = "docx-gongwen";
      else if (flag("--pdf")) format = "pdf";
      else if (flag("--pdf-replica")) format = "pdf-replica";
      else if (flag("--content-list")) format = "content-list";
      else if (flag("--csv")) format = "csv";
      const noSave = flag("--no-save");
      const dir = flag("--dir");
      const mdAssets = flag("--md-assets");
      let formulaMode;
      const formulaM = /--formula\s+(unicode|raw|omml)/.exec(rest);
      if (formulaM) {
        formulaMode = formulaM[1];
        rest = rest.replace(formulaM[0], "");
      }
      let outDir;
      const outM = /--out\s+("[^"]+"|\S+)/.exec(rest);
      if (outM) {
        outDir = outM[1].replace(/^"|"$/g, "");
        rest = rest.replace(outM[0], "");
      }
      const target = expandPath(rest.trim().replace(/^"|"$/g, ""));
      if (!target) return { kind: "error", text: "请提供文件路径或 URL" };
      const fmt = noSave ? "none" : format;

      try {
        if (dir) {
          return await runDirectory(cfg, target, engine, fmt, outDir, { tier, effort, formulaMode, mdAssets });
        }
        const r = await recognize({ cfg, path: target, engine: engine !== cfg.defaultEngine ? engine : undefined, tier, effort, format: fmt, outDir, formulaMode, mdAssets });
        const lines = [`✅ 识别完成（${r.engine}${r.note ? "，" + r.note : ""}），共 ${r.chars} 字`];
        if (r.savedFiles?.length) lines.push(`已保存：\n${r.savedFiles.map((f) => "- " + f).join("\n")}`);
        lines.push("", "----- 识别预览 -----", r.preview || "（无文字）");
        return { kind: "success", text: lines.join("\n") };
      } catch (e) {
        return { kind: "error", text: `[ocr] ${e instanceof OcrError ? e.message : e.message}` };
      }
    },
  });

  // 4) HTTP API（设置面板后端 + 连通性自测）
  ctx.webServer?.register?.({
    kind: "exact",
    path: "/ocr/api/settings",
    handler: async (req, res) => {
      const sendJson = (code, obj) => {
        const data = Buffer.from(JSON.stringify(obj), "utf8");
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": data.length });
        res.end(data);
      };
      try {
        if (req.method === "GET") {
          const cfg = loadConfig();
          sendJson(200, {
            config: {
              ...cfg,
              apiKey: maskKey(cfg.apiKey),
              secretKey: maskKey(cfg.secretKey),
              aistudioToken: maskKey(cfg.aistudioToken),
              hasApiKey: Boolean(cfg.apiKey),
              hasSecretKey: Boolean(cfg.secretKey),
              hasAistudioToken: Boolean(cfg.aistudioToken),
            },
          });
          return;
        }
        if (req.method === "POST") {
          // 请求体体积上限（防滥用），超限直接 413（#11）
          const MAX_BODY = 64 * 1024;
          let size = 0;
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY) {
              sendJson(413, { error: "请求体过大（上限 64KB）" });
              return;
            }
            chunks.push(chunk);
          }
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            sendJson(400, { error: "请求体不是合法 JSON" });
            return;
          }
          if (typeof body !== "object" || body === null) {
            sendJson(400, { error: "请求体必须是 JSON 对象" });
            return;
          }
          const patch = {};
          // defaultEngine / defaultFormat 走白名单枚举，杜绝写入非法引擎（如 turbo，#11）
          if (typeof body.defaultEngine === "string" && ENGINES.includes(body.defaultEngine)) patch.defaultEngine = body.defaultEngine;
          if (typeof body.defaultFormat === "string" && FORMATS.includes(body.defaultFormat)) patch.defaultFormat = body.defaultFormat;
          if (typeof body.saveDir === "string") patch.saveDir = body.saveDir;
          if (typeof body.keepHeaderFooter === "boolean") patch.keepHeaderFooter = body.keepHeaderFooter;
          if (typeof body.formulaMode === "string" && FORMULA_MODES.includes(body.formulaMode)) patch.formulaMode = body.formulaMode;
          for (const k of ["asDocOrientation", "asDocUnwarping", "asChartRecognition"]) {
            if (typeof body[k] === "boolean") patch[k] = body[k];
          }
          if (typeof body.provider === "string" && ["baidu", "aistudio"].includes(body.provider)) patch.provider = body.provider;
          if (typeof body.aistudioUrl === "string") patch.aistudioUrl = body.aistudioUrl.trim();
          if (body.aistudioToken === "__CLEAR__") patch.aistudioToken = "";
          else if (!isMasked(body.aistudioToken)) patch.aistudioToken = String(body.aistudioToken).trim();
          for (const k of ["requestTimeoutMs", "vlPollTimeoutMs", "vlSegmentPages"]) {
            const n = Number(body[k]);
            if (!Number.isFinite(n) || n <= 0) continue;
            if (k === "vlPollTimeoutMs") {
              // vlPollTimeoutMs 封顶 330s：工具整体超时 360s，需留余量
              patch[k] = Math.min(n, 330000);
            } else if (k === "requestTimeoutMs") {
              // 单请求超时夹在 [5s, 120s]：过小必超时，过大失去超时保护意义
              patch[k] = Math.min(Math.max(n, 5000), 120000);
            } else {
              // vlSegmentPages 夹在 [1, 500] 且取整：1 页/段会放大配额消耗，无上限失去分段意义
              patch[k] = Math.min(500, Math.max(1, Math.round(n)));
            }
          }
          if (typeof body.vlVectorHq === "boolean") patch.vlVectorHq = body.vlVectorHq;
          if (typeof body.crossPageMerge === "string" && MERGE_MODES.includes(body.crossPageMerge)) patch.crossPageMerge = body.crossPageMerge;
          // v0.4 新增配置（与面板字段一一对应）
          if (typeof body.paraMerge === "boolean") patch.paraMerge = body.paraMerge;
          if (typeof body.officeLocalRead === "boolean") patch.officeLocalRead = body.officeLocalRead;
          if (typeof body.fontSizeFromLayout === "boolean") patch.fontSizeFromLayout = body.fontSizeFromLayout;
          if (typeof body.providerFallback === "string" && ["off", "auto"].includes(body.providerFallback)) patch.providerFallback = body.providerFallback;
          if (typeof body.defaultTier === "string" && TIERS.includes(body.defaultTier)) patch.defaultTier = body.defaultTier;
          {
            const dpiN = Number(body.replicaDpi);
            if (Number.isFinite(dpiN) && dpiN > 0) patch.replicaDpi = Math.min(400, Math.max(96, dpiN));
            const thinN = Number(body.hybridThinRatio);
            if (Number.isFinite(thinN) && thinN >= 0) patch.hybridThinRatio = Math.min(1, thinN);
          }
          if (body.clearCache === true) cacheClear();
          // __CLEAR__ 哨兵：清除已存密钥（面板"清除已存密钥"按钮）
          if (body.apiKey === "__CLEAR__") patch.apiKey = "";
          if (body.secretKey === "__CLEAR__") patch.secretKey = "";
          if (!isMasked(body.apiKey)) patch.apiKey = String(body.apiKey).trim();
          if (!isMasked(body.secretKey)) patch.secretKey = String(body.secretKey).trim();
          if (patch.aistudioUrl !== undefined || patch.aistudioToken !== undefined) {
            patch.aistudioUrl = patch.aistudioUrl ?? loadConfig().aistudioUrl; // URL 与 Token 一起保存
          }
          if (patch.apiKey !== undefined || patch.secretKey !== undefined) clearCache();
          await saveConfig(patch);
          sendJson(200, { ok: true });
          return;
        }
        sendJson(405, { error: "method not allowed" });
      } catch (e) {
        sendJson(500, { error: e.message });
      }
    },
  });
  ctx.webServer?.register?.({
    kind: "exact",
    path: "/ocr/api/tasks",
    handler: async (req, res) => {
      const sendJson = (code, obj) => {
        const data = Buffer.from(JSON.stringify(obj), "utf8");
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": data.length });
        res.end(data);
      };
      try {
        const tasks = listTasks(20).map((t) => ({
          id: t.id,
          idTail: String(t.id).slice(-8),
          provider: t.provider,
          status: t.status,
          fileName: t.fileName || t.sourcePath || "",
          pagesHint: t.pagesHint ?? null,
          submittedAt: t.submittedAt ?? null,
          doneAt: t.doneAt ?? null,
          error: t.error ?? null,
        }));
        sendJson(200, { tasks });
      } catch (e) {
        sendJson(500, { error: e.message });
      }
    },
  });
  ctx.webServer?.register?.({
    kind: "exact",
    path: "/ocr/api/ping",
    handler: async (req, res) => {
      const sendJson = (code, obj) => {
        const data = Buffer.from(JSON.stringify(obj), "utf8");
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": data.length });
        res.end(data);
      };
      try {
        const cfg = loadConfig();
        const token = await getToken(cfg);
        const c = cachedToken();
        sendJson(200, {
          ok: true,
          hasToken: Boolean(token),
          expiresAt: c?.expiresAt ? new Date(c.expiresAt).toISOString() : null,
        });
      } catch (e) {
        sendJson(200, { ok: false, error: e.message });
      }
    },
  });

  console.log(`[ocr] dsh-plugin-baidu-ocr 已加载（数据目录 ${dataDir()}）`);
}

/** --dir 批量：串行 + 500ms 间隔防限流，单次上限 30 个文件 */
async function runDirectory(cfg, dirPath, engine, format, outDir, opts = {}) {
  if (!existsSync(dirPath)) return { kind: "error", text: `[ocr] 目录不存在：${dirPath}` };
  const exts = new Set([...IMAGE_EXTS, ...PDF_EXTS, ...VL_ONLY_EXTS]);
  const matched = readdirSync(dirPath, { withFileTypes: true })
    // 大小写不敏感（Windows 常见 .PNG/.JPG），否则静默跳过
    .filter((d) => d.isFile() && exts.has((/\.([A-Za-z0-9]+)$/.exec(d.name)?.[0] ?? "").toLowerCase()))
    .map((d) => join(dirPath, d.name));
  const skipped = Math.max(0, matched.length - 30); // 单次上限 30，告知跳过了多少（#pipeline low）
  const files = matched.slice(0, 30);
  if (!files.length) return { kind: "error", text: `[ocr] 目录中没有可识别的文件（支持图片/pdf/doc/ppt）：${dirPath}` };
  const results = [];
  for (let i = 0; i < files.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await recognize({ cfg, path: files[i], engine, format, outDir, ...opts });
      results.push(`✅ ${files[i]}（${r.chars} 字${r.savedFiles?.length ? "，已保存" : ""}）`);
    } catch (e) {
      results.push(`❌ ${files[i]}：${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  const warn = skipped > 0 ? `⚠ 目录中可识别文件共 ${matched.length} 个，单次上限 30，已跳过 ${skipped} 个（可分批或多次 /ocr --dir）\n` : "";
  return {
    kind: "success",
    text: warn + `批量识别完成（${results.filter((r) => r.startsWith("✅")).length}/${results.length} 成功）：\n` + results.join("\n"),
  };
}

export { apply, inject, name, stripFlag };
