// lib/libstore.js — /ocr lib 本地文档库（v0.4，对标 MinerU 4.0 document library 的引用定位能力）：
// 每次成功落盘登记 {id, files, source, engine, format, chars, at, contentListPath}，
// Agent 拿到 libId 后可 /ocr lib <id尾> 预览、/ocr lib find <词> 全文检索（零索引，直接读文件）。
// 数据文件 ~/.dsh/ocr/lib.json，最多 200 条淘汰最旧；原子写沿用 tasks.js 范式。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { dataDir } from "./auth.js";

const MAX_LIB = 200;

function libFile() {
  return join(dataDir(), "lib.json");
}

function load() {
  try {
    const j = JSON.parse(readFileSync(libFile(), "utf8"));
    return Array.isArray(j.entries) ? j.entries : [];
  } catch {
    return [];
  }
}

function save(entries) {
  try {
    const f = libFile();
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
    renameSync(tmp, f);
  } catch (e) {
    console.error("[ocr] 文档库写入失败（不影响本次调用）:", e.message);
  }
}

/** 落盘成功后登记。返回 8 位短 id（引用格式 ocr://<id>#page=N）；无可登记文件返回 null。 */
export function recordLib({ files = [], sourcePath, engine, format, chars = 0, contentListPath = null } = {}) {
  const saved = (files ?? []).filter(Boolean);
  if (!saved.length) return null;
  const id = createHash("sha256").update(`${saved[0]}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 8);
  const entries = load().filter((x) => x.id !== id);
  entries.unshift({ id, files: saved, source: sourcePath ?? "", engine: engine ?? "", format: format ?? "", chars: Number(chars) || 0, at: Date.now(), contentListPath: contentListPath ?? null });
  save(entries.slice(0, MAX_LIB));
  return id;
}

export function listLib(limit = 50) {
  return load().slice(0, Math.max(1, limit));
}

/** 精确 id 或尾缀匹配 */
export function findLib(idOrSuffix) {
  const s = String(idOrSuffix ?? "").trim();
  if (!s) return null;
  const entries = load();
  return entries.find((x) => x.id === s) ?? entries.find((x) => x.id.endsWith(s)) ?? null;
}
