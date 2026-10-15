// lib/validate.js — 识别结果乱码校验（生成文档前的门禁）
// 乱码来源：PDF 文本层 CID 字体未映射（(cid:NN) 或私用区）、编码错乱（UTF-8 被按 Latin-1 读出的
// 拉丁扩展连串）、解码失败替换符（U+FFFD）。
export function findGarbled(text, { maxSamples = 3 } = {}) {
  const s = String(text ?? "");
  const patterns = [
    { re: /\uFFFD/g, label: "解码失败替换符(U+FFFD)", min: 1 },
    { re: /\(cid:\d+\)/gi, label: "CID未映射字形(cid:N)", min: 1 },
    { re: /[\uE000-\uF8FF]/g, label: "私用区字符", min: 1 },
    // 拉丁扩展连串：中文文档里出现 4+ 个连续拉丁扩展字母 = 典型 mojibake。
    // 排除 ×(U+00D7)/÷(U+00F7)："××××"分隔线是合法内容，曾被误判触发 E_GARBLED（#8）
    { re: /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]{4,}/g, label: "疑似编码错乱(拉丁扩展连串)", min: 1 },
  ];
  const found = [];
  for (const { re, label, min } of patterns) {
    let m;
    let count = 0;
    const samples = [];
    while ((m = re.exec(s)) !== null) {
      count++;
      if (samples.length < maxSamples) {
        samples.push(`…${s.slice(Math.max(0, m.index - 8), m.index + m[0].length + 8)}…（${label}）`);
      }
      if (m[0].length === 0) re.lastIndex++; // 防空匹配死循环
    }
    if (count >= min) found.push({ label, count, samples });
  }
  return found;
}

/** 校验入口：检出乱码返回描述（供拦截/告警），干净返回 null。 */
export function checkGarbled(text) {
  const found = findGarbled(text);
  if (!found.length) return null;
  const total = found.reduce((n, f) => n + f.count, 0);
  const samples = found.flatMap((f) => f.samples).slice(0, 3).join("；");
  return `检出疑似乱码 ${total} 处（${found.map((f) => `${f.label}×${f.count}`).join("、")}）：${samples}`;
}
