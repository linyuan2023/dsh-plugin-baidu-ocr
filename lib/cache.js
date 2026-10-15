// lib/cache.js — 识别结果缓存：按（文件内容哈希 + 引擎 + 后端 + 页区间）缓存后端原始结果。
// 同文档重跑秒出且不耗云端配额；分段跑批的幂等基础。缓存的是清洗前的原始结果，
// formulaMode 等导出参数变更不需要失效。上限 200MB / 7 天，超出删最旧。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./auth.js";

const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function cacheDir() {
  return join(dataDir(), "cache");
}

/** 源文件内容哈希（16 位 hex，作缓存键主体） */
export function fileHash(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

export function cacheKey({ fileHash: fh, engine, provider, span = "full" }) {
  return [fh, engine, provider, span].join("_");
}

export function cacheGet(key) {
  if (!key) return null;
  try {
    const raw = JSON.parse(readFileSync(join(cacheDir(), `${key}.json`), "utf8"));
    if (raw && raw.result) return raw;
  } catch {}
  return null;
}

export function cachePut(key, result, { savedAt = Date.now() } = {}) {
  if (!key || !result) return;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), `${key}.json`), JSON.stringify({ savedAt, result }));
    cachePrune();
  } catch (e) {
    console.error("[ocr] 结果缓存写入失败（不影响本次调用）:", e.message);
  }
}

/** 删除全部结果缓存（不动 token） */
export function cacheClear() {
  try {
    rmSync(cacheDir(), { recursive: true, force: true });
  } catch {}
  segmentsClear(); // /ocr cache clear 一并清理大 PDF 分段残留（#pipeline low）
  segmentsPrune();
}

/** 删除全部分段工作目录（大 PDF 中断/完成后残留的临时页 PDF，#pipeline low） */
export function segmentsClear() {
  try {
    rmSync(join(dataDir(), "segments"), { recursive: true, force: true });
  } catch {}
}

/** 删除超过 maxAgeMs 的分段子目录（按 mtime，默认 7 天；清理中断残留） */
export function segmentsPrune({ now = Date.now(), maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  const root = join(dataDir(), "segments");
  if (!existsSync(root)) return;
  try {
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > maxAgeMs) rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

/** 总量 >200MB 或单条 >7 天 → 从最旧开始删 */
export function cachePrune({ now = Date.now() } = {}) {
  const dir = cacheDir();
  if (!existsSync(dir)) return;
  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = join(dir, f);
        const st = statSync(p);
        return { p, mtime: st.mtimeMs, size: st.size };
      });
  } catch {
    return;
  }
  files.sort((a, b) => a.mtime - b.mtime); // 最旧在前
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    const expired = now - f.mtime > MAX_AGE_MS;
    if (!expired && total <= MAX_TOTAL_BYTES) break; // 剩下的都更新且总量达标
    try {
      unlinkSync(f.p);
      total -= f.size;
    } catch {}
  }
}
