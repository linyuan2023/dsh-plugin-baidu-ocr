// lib/tasks.js — VL/解析任务持久化：提交成功即记录 id，超时/中断后可凭 id 恢复轮询取回结果。
// 数据文件 ~/.dsh/ocr/tasks.json（跟随 DSH_OCR_TOKEN_FILE 隔离），最多保留 50 条。
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { dataDir } from "./auth.js";

const MAX_TASKS = 50;

function tasksFile() {
  return join(dataDir(), "tasks.json");
}

function load() {
  try {
    const j = JSON.parse(readFileSync(tasksFile(), "utf8"));
    return Array.isArray(j.tasks) ? j.tasks : [];
  } catch {
    return [];
  }
}

function save(tasks) {
  try {
    const f = tasksFile();
    mkdirSync(dirname(f), { recursive: true });
    // 原子写：先写临时文件再 rename，避免进程中断把 tasks.json 写坏导致全部 resume 任务静默丢失（#pipeline low）。
    // tmp 带 pid：多进程共用数据目录时固定 tmp 名会互相截断，半截 JSON 会被对方 rename 成正式文件。
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
    renameSync(tmp, f);
  } catch (e) {
    console.error("[ocr] 任务表写入失败（不影响本次调用）:", e.message);
  }
}

/** 提交成功后登记（同 id 覆盖旧记录） */
export function recordTask(t) {
  if (!t?.id) return;
  const tasks = load().filter((x) => x.id !== t.id);
  tasks.unshift({ status: "running", submittedAt: Date.now(), ...t });
  save(tasks.slice(0, MAX_TASKS));
}

export function markTask(id, patch) {
  if (!id) return;
  const tasks = load();
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch, { doneAt: Date.now() });
  save(tasks);
}

/** 精确 id 或后缀匹配（用户常只记尾部几位） */
export function findTask(idOrSuffix) {
  const s = String(idOrSuffix ?? "").trim();
  if (!s) return null;
  const tasks = load();
  return tasks.find((x) => x.id === s) ?? tasks.find((x) => x.id.endsWith(s)) ?? null;
}

export function listTasks(limit = 50) {
  return load().slice(0, Math.max(1, limit));
}
