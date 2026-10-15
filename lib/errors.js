// lib/errors.js — 百度 OCR error_code → 可读中文 + 插件统一错误类型
// 错误码对照官方文档 https://cloud.baidu.com/doc/OCR/s/dk3h7y5vr （M5 验收时补全冷门码）

const ERROR_TEXT = {
  1: "服务器内部错误，请重试",
  2: "服务暂时不可用，请重试",
  4: "请求量超限（bs 错误码）",
  17: "每日流量超限：当日免费/购买额度已用完，请明日再试或到控制台购买资源包",
  18: "QPS 超限：请求太快被限流，请稍后重试",
  19: "请求总量超限：总额度已用完，请到控制台查看配额",
  100: "access_token 无效：请检查 API Key / Secret Key 是否正确",
  110: "access_token 过期：插件会自动刷新，请重试；若反复出现请重新配置密钥",
  111: "access_token 失效：token 已被重置，插件会自动刷新，请重试",
  216100: "图片文本不存在或为空",
  216101: "图片格式不是 Base64",
  216200: "图片为空：文件可能损坏或读入了 0 字节",
  216201: "图片格式错误：支持 png/jpg/jpeg/bmp/tiff/pnm/webp",
  216202: "图片大小超限：编码后不能超过 4MB，请压缩图片或改用 --vl 通道",
  216300: "图片尺寸超限：高最短 15px、最长 4096px",
  216400: "URL 图片下载失败：请确认公网可访问",
  282000: "百度服务端未知错误，请稍后重试",
};

// 这些错误码值得换新 token 后重放一次
const TOKEN_ERROR_CODES = new Set([100, 110, 111]);
// 这些错误码值得退避重试（限流/服务端瞬时故障）
const RETRYABLE_CODES = new Set([1, 2, 18]);
// VL 文档解析（PaddleOCR-VL）错误码族 336xxx-337xxx：官方按任务维度返回、无逐码文档，
// 族级中文指引比"未知错误"兜底有用（#12）
const VL_ERROR_MIN = 336000;
const VL_ERROR_MAX = 337000;

/** 插件统一错误：userMessage 面向用户，code 可选（百度 error_code 或插件内部码） */
export class OcrError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "OcrError";
    this.code = code;
  }
}

export function describeBaiduError(code, msg) {
  const known = ERROR_TEXT[code];
  const detail = String(msg ?? "").trim();
  if (known) return detail ? `${known}（error_code=${code}，${detail}）` : `${known}（error_code=${code}）`;
  const n = Number(code);
  if (Number.isFinite(n) && n >= VL_ERROR_MIN && n < VL_ERROR_MAX) {
    return `文档解析（VL）任务错误：${detail || "云端解析失败"}（error_code=${code}）。` +
      `请确认文件在限额内（图片 ≤10MB/8192px、PDF ≤100MB/500 页、Word/PPT ≤50MB）后重试；` +
      `持续失败可改用 general/accurate 同步通道提字`;
  }
  return detail
    ? `百度接口报错：${detail}（error_code=${code ?? "未知"}）`
    : `百度接口报错（error_code=${code ?? "未知"}），详情见官方错误码文档`;
}

export function isTokenError(code) {
  return TOKEN_ERROR_CODES.has(Number(code));
}

export function isRetryableCode(code) {
  return RETRYABLE_CODES.has(Number(code));
}
