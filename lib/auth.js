// lib/auth.js — 百度 access_token 获取/缓存/刷新
// token 有效期约 30 天：落盘 ~/.dsh/ocr/token.json，过期前 1 天主动刷新；
// 并发请求共享同一次刷新（promise 备忘录），避免限流。
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { OcrError } from "./errors.js";

const DATA_DIR = join(homedir(), ".dsh", "ocr");
const TOKEN_FILE = join(DATA_DIR, "token.json");
const REFRESH_MARGIN_MS = 24 * 3600 * 1000; // 到期前 24h 即视为待刷新

let inflight = null; // 同一时刻只放行一次真实刷新

function tokenCacheFile() {
  return process.env.DSH_OCR_TOKEN_FILE || TOKEN_FILE;
}

export function dataDir() {
  return dirname(tokenCacheFile());
}

function readCache() {
  try {
    const raw = JSON.parse(readFileSync(tokenCacheFile(), "utf8"));
    if (raw && typeof raw.access_token === "string" && Number.isFinite(raw.expires_at)) return raw;
  } catch {}
  return null;
}

function writeCache(entry) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    const tmp = `${tokenCacheFile()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    renameSync(tmp, tokenCacheFile());
  } catch (e) {
    console.error("[ocr] token 缓存写入失败（不影响本次调用）:", e.message);
  }
}

export function cachedToken() {
  const c = readCache();
  if (!c) return null;
  return { token: c.access_token, expiresAt: c.expires_at, fresh: Date.now() < c.expires_at - REFRESH_MARGIN_MS };
}

export function clearCache() {
  try {
    writeCache({ access_token: "", expires_at: 0 });
  } catch {}
}

/** 用 AK/SK 换 token（fetch oauth/2.0/token） */
async function fetchToken({ apiKey, secretKey, timeoutMs }) {
  const url =
    `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials` +
    `&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(timeoutMs, 5000));
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, signal: ac.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OcrError("E_AUTH_BAD_REPLY", `获取 access_token 失败：响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!body.access_token) {
      const desc = body.error_description || body.error || `HTTP ${res.status}`;
      throw new OcrError(
        "E_AUTH",
        `获取 access_token 失败：${desc}。请检查 API Key / Secret Key（百度智能云控制台 → 文字识别 → 应用列表）`,
        { cause: body }
      );
    }
    return { access_token: body.access_token, expires_at: Date.now() + Number(body.expires_in ?? 2592000) * 1000 };
  } catch (e) {
    if (e instanceof OcrError) throw e;
    if (e.name === "AbortError") throw new OcrError("E_AUTH_TIMEOUT", `获取 access_token 超时（网络不通或被墙？）`);
    throw new OcrError("E_AUTH_NETWORK", `获取 access_token 网络错误：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取一个可用 token：
 * 1) 缓存新鲜 → 直接用；2) 缓存临期/无缓存 → 刷新并落盘；3) forceRefresh 强制刷新。
 * 同一进程内并发的多次调用共享同一次刷新。
 */
export async function getToken(cfg, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const c = cachedToken();
    if (c?.fresh) return c.token;
  }
  if (!cfg.apiKey || !cfg.secretKey) {
    throw new OcrError(
      "E_NO_KEY",
      "尚未配置百度 OCR 密钥：请到 DSH 设置 → OCR 填入 API Key 与 Secret Key（或设置环境变量 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY）"
    );
  }
  if (!inflight) {
    inflight = fetchToken({ apiKey: cfg.apiKey, secretKey: cfg.secretKey, timeoutMs: cfg.requestTimeoutMs ?? 30000 })
      .then((entry) => {
        writeCache(entry);
        return entry.access_token;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
