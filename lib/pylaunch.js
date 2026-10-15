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
      // 必须 Python 3：Python 2 的 --version 同样退出码 0（版本在 stderr），
      // 误选会让 pymupdf 探测失败 → 分段/文本层/重截全链路静默降级
      const out = String(r.stdout || "") + String(r.stderr || "");
      if (r.status === 0 && /Python\s+3\./.test(out)) {
        cached = c;
        return c;
      }
    } catch {}
  }
  cached = "python"; // 兜底（不可用时会由调用方的错误路径报错）
  return cached;
}
