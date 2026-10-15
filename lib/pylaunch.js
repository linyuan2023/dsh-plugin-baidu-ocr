// lib/pylaunch.js — 探测可用的 python 启动器（Windows 只有 py 启动器时，
// 硬编码 "python" 会让大 PDF 分段/文本层直取静默降级，#pipeline/segment/html）。
// 探测顺序：优先 python → python3 → py（Windows），命中即缓存复用。
import { spawnSync } from "node:child_process";

let cached = null;

export function pythonCmd() {
  if (cached) return cached;
  const candidates =
    process.platform === "win32"
      ? ["python", "python3", "py"]
      : ["python3", "python"];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (r.status === 0) {
        cached = c;
        return c;
      }
    } catch {}
  }
  cached = "python"; // 兜底（不可用时会由调用方的错误路径报错）
  return cached;
}
