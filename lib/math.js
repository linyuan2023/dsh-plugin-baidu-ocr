// lib/math.js — 公式处理双出口（零依赖，markdown.js / layout.js / ooxml.js 共用）
//  1) cleanMath：LaTeX → 可读 Unicode 文本（md/txt/csv/pdf/gongwen 路径）。
//     原则：已知命令精确映射；未知命令保留字面（可恢复，不丢内容）；
//     货币型 "$5 至 $6" 不当数学定界符处理。
//  2) latexToOmml：最小 LaTeX → OOXML OMML（docx 原生公式对象）。
//     覆盖 frac/sqrt/上下标/希腊字母/常用符号；结构不认识时返回 null，调用方回退纯文本。

// ── 字符映射表 ───────────────────────────────────────────────────────────────
const GREEK = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
  xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ",
  chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
  Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const SYMBOLS = {
  ...GREEK,
  times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·", ast: "∗", star: "⋆",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", equiv: "≡", approx: "≈", sim: "∼", simeq: "≃", propto: "∝",
  infty: "∞", degree: "°", circ: "∘", prime: "′", angle: "∠", perp: "⊥", parallel: "∥",
  because: "∵", therefore: "∴", in: "∈", notin: "∉", owns: "∋",
  subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅",
  forall: "∀", exists: "∃", nexists: "∄", partial: "∂", nabla: "∇", surd: "√",
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
  rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔",
  Leftrightarrow: "⇔", uparrow: "↑", downarrow: "↓", updownarrow: "↕", mapsto: "↦", leadsTo: "↝",
  ldots: "…", cdots: "⋯", dots: "…", vdots: "⋮", ddots: "⋱", bullet: "•",
  quad: " ", qquad: "  ", space: " ",
};

const SUPERSCRIPT = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", " ": " ",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ",
  m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ", K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ",
  O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ",
};

const SUBSCRIPT = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ",
  r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ", beta: "ᵦ", gamma: "ᵧ", rho: "ᵨ", phi: "ᵩ", chi: "ᵪ",
};

const ROOTS = { "2": "√", "3": "∛", "4": "∜" };

// ── LaTeX → Unicode 文本 ─────────────────────────────────────────────────────
const isSingleToken = (g) => /^[0-9A-Za-z]$/.test(g);
const wrapGroup = (g) => (isSingleToken(g) ? g : `(${g})`);

/** 上/下标组内容 → Unicode 上/下标串；存在映射不了的字符时保留原样（^…/_… 形式可恢复） */
function scriptForm(exp, table) {
  const chars = [...exp];
  const mapped = chars.map((c) => table[c]).join("");
  return mapped.length === chars.length && mapped ? mapped : null;
}

function supOrKeep(e) {
  return scriptForm(e, SUPERSCRIPT) ?? `^(${e})`;
}
function subOrKeep(e) {
  return scriptForm(e, SUBSCRIPT) ?? `_(${e})`;
}

/** LaTeX 片段（不含 $ 定界符）→ 可读文本。 */
export function cleanLatex(input) {
  let s = String(input ?? "").trim();
  if (!s) return "";
  // \left( \right) 等排版壳 → 只留定界符。词界保护：不能吃 \rightarrow/\leftarrow/\leftrightarrow 的前缀（#math）
  s = s.replace(/\\left(?![a-zA-Z])\s*|\\right(?![a-zA-Z])\s*/g, "");
  // 转义间距/标点（反斜杠+非字母，"未知命令"规则覆盖不到的盲区）：
  // \, \; \: \! 细空格 → 空格；\- 断字提示、\/ 斜体校正 → 删
  s = s.replace(/\\[,;:! ]/g, " ").replace(/\\[-/]/g, "");
  // 转义符号字面还原：\% \$ \& \# \_（\{ \} 保留字面，防被尾部花括号清理吃掉）
  s = s.replace(/\\([%$&#_])/g, "$1");
  // 字体/文字包裹命令 → 保留内容
  s = s.replace(
    /\\(?:text|textrm|textbf|textit|texttt|mathrm|mathbf|mathit|mathbb|mathcal|mathfrak|mathsf|mbox|hbox|operatorname)\s*\{([^{}]*)\}/g,
    "$1"
  );
  // 双层分组花括号折叠：\frac{{1}}{{2}} → \frac{1}{2}。LaTeX 生成器的冗余分组，
  // 不折叠会让下面所有 [^{}]* 正则失配（frac/sqrt/上下标全部保留字面，#math）
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/\{\{([^{}]*)\}\}/g, "{$1}");
    if (next === s) break;
    s = next;
  }
  // \frac（循环替换先吃最内层，兼容一层嵌套）
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${wrapGroup(a)}/${wrapGroup(b)}`);
    if (next === s) break;
    s = next;
  }
  // \sqrt[3]{x} / \sqrt{x}
  s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (_, n, e) =>
    ROOTS[n.trim()] ? `${ROOTS[n.trim()]}(${e})` : `√[${n.trim()}](${e})`
  );
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, e) => `√(${e})`);
  // 带花括号的上下标
  s = s.replace(/\^\s*\{([^{}]*)\}/g, (_, e) => supOrKeep(e));
  s = s.replace(/_\s*\{([^{}]*)\}/g, (_, e) => subOrKeep(e));
  // 裸数字上下标（x^2、H_2O）：只吃连续数字——字母参数须带花括号（x^2y 是 x²y 不是 x²ʸ）
  s = s.replace(/\^\s*([0-9]+)/g, (_, e) => scriptForm(e, SUPERSCRIPT) ?? `^${e}`);
  s = s.replace(/_\s*([0-9]+)/g, (_, e) => scriptForm(e, SUBSCRIPT) ?? `_${e}`);
  // 已知命令 → 符号；未知命令保留字面（不删内容，可恢复）
  s = s.replace(/\\([a-zA-Z]+)/g, (m, name) => SYMBOLS[name] ?? m);
  // 残留花括号：无未知命令时清掉（纯分组记号）；仍有未知命令时保留 LaTeX 原样
  if (!s.includes("\\")) s = s.replace(/[{}]/g, "");
  return s.replace(/\s{2,}/g, " ").trim();
}

/** 货币/普通文本判定：$…$ 内容无字母且无数学记号（如 $5 至 $6）→ 不是公式 */
export function isCurrencyText(m) {
  return !/[a-zA-Z\\^_{}]/.test(m);
}

/** 文本中的 $…$ / $$…$$ / \(…\) / \[…\] 数学段 → 可读文本。
 *  货币守卫：成对 $ 内容"无字母且无数学记号"（如 $5 至 $6）视为金额，保留原样。 */
export function cleanMath(s) {
  let out = String(s ?? "");
  // \(...\) 行内 / \[...\] 显示定界符（部分 PaddleOCR 版本使用）
  out = out.replace(/\\\(([^]+?)\\\)/g, (_, m) => cleanLatex(m));
  out = out.replace(/\\\[([^]+?)\\\]/g, (_, m) => ` ${cleanLatex(m)} `);
  out = out.replace(/\$\$([^$]+?)\$\$/g, (_, m) => ` ${cleanLatex(m)} `);
  out = out.replace(/\$([^$\n]{1,40}?)\$/g, (whole, m) => (isCurrencyText(m) ? whole : cleanLatex(m)));
  return out;
}

// ── 最小 LaTeX → OMML（docx 原生公式）────────────────────────────────────────
function ommlEsc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tokenize(s) {
  const toks = [];
  let run = "";
  const flush = () => {
    if (run) {
      toks.push({ t: "run", v: run });
      run = "";
    }
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      if (m) {
        flush();
        toks.push({ t: "cmd", v: m[1] });
        i += m[0].length - 1;
        continue;
      }
    }
    if ("{}^_[]".includes(c)) {
      flush();
      toks.push({ t: c });
      continue;
    }
    run += c;
  }
  flush();
  return toks;
}

function parseBraceGroup(toks, i, open, close) {
  if (toks[i]?.t !== open) return null;
  const items = [];
  let j = i + 1;
  // 嵌套组由 parseItem 递归消费并返回 next——循环落点处的 close 即本层配对括号。
  // 旧实现额外维护 depth，把已被递归消费的内层 { 重复计数，最外层 } 永远配不上 → OMML 恒 null（#math）
  while (j < toks.length) {
    if (toks[j].t === close) return { items, next: j + 1 };
    const ni = parseItem(toks, j, items);
    if (ni < 0) return null;
    j = ni;
  }
  return null;
}

function parseAtom(toks, i) {
  const tk = toks[i];
  if (!tk) return null;
  if (tk.t === "{") {
    const g = parseBraceGroup(toks, i, "{", "}");
    return g ? { node: { kind: "group", items: g.items }, next: g.next } : null;
  }
  if (tk.t === "run") return { node: { kind: "run", v: tk.v }, next: i + 1 };
  if (tk.t === "cmd") {
    const r = parseCmd(toks, i, []);
    return r;
  }
  return null; // ^ _ } ] 不能作为参数原子
}

/** 解析一个命令节点（含 frac/sqrt 的多组参数）。items：已产出的兄弟节点（供上下标回挂） */
function parseCmd(toks, i, out) {
  const name = toks[i].v;
  if (name === "frac" || name === "dfrac" || name === "tfrac") {
    const a = parseBraceGroup(toks, i + 1, "{", "}");
    if (!a) return null;
    const b = parseBraceGroup(toks, a.next, "{", "}");
    if (!b) return null;
    out.push({ kind: "frac", num: a.items, den: b.items });
    return { next: b.next };
  }
  if (name === "sqrt") {
    const deg = parseBraceGroup(toks, i + 1, "[", "]");
    const body = parseBraceGroup(toks, deg ? deg.next : i + 1, "{", "}");
    if (!body) return null;
    out.push({ kind: "sqrt", deg: deg?.items ?? null, items: body.items });
    return { next: body.next };
  }
  const ch = SYMBOLS[name];
  if (ch) {
    out.push({ kind: "run", v: ch });
    return { next: i + 1 };
  }
  out.push({ kind: "run", v: `\\${name}` }); // 未知命令保留字面
  return { next: i + 1 };
}

function parseItem(toks, i, out) {
  const tk = toks[i];
  if (!tk) return -1;
  if (tk.t === "run") {
    out.push({ kind: "run", v: tk.v });
    return i + 1;
  }
  if (tk.t === "{") {
    const g = parseBraceGroup(toks, i, "{", "}");
    if (!g) return -1;
    out.push({ kind: "group", items: g.items });
    return g.next;
  }
  if (tk.t === "^" || tk.t === "_") {
    const arg = parseAtom(toks, i + 1);
    if (!arg || !out.length) return -1;
    const base = out.pop();
    if (base.kind === "scripts") {
      if (tk.t === "^" ? base.sup : base.sub) return -1; // 双上标/双下标不支持
      if (tk.t === "^") base.sup = arg.node;
      else base.sub = arg.node;
      out.push(base);
    } else {
      out.push(tk.t === "^" ? { kind: "scripts", base, sup: arg.node } : { kind: "scripts", base, sub: arg.node });
    }
    return arg.next;
  }
  if (tk.t === "cmd") {
    const r = parseCmd(toks, i, out);
    return r ? r.next : -1;
  }
  return -1; // 裸 } 或 ]
}

function renderItems(items) {
  return items.map(renderNode).join("");
}

function renderNode(n) {
  switch (n.kind) {
    case "run":
      return `<m:r><m:t xml:space="preserve">${ommlEsc(n.v)}</m:t></m:r>`;
    case "group":
      return renderItems(n.items);
    case "frac":
      return `<m:f><m:num>${renderItems(n.num)}</m:num><m:den>${renderItems(n.den)}</m:den></m:f>`;
    case "sqrt": {
      const deg = n.deg ? `<m:deg>${renderItems(n.deg)}</m:deg>` : "<m:deg/>";
      const hide = n.deg ? "" : '<m:radPr><m:degHide m:val="1"/></m:radPr>';
      return `<m:rad>${hide}${deg}<m:e>${renderItems(n.items)}</m:e></m:rad>`;
    }
    case "scripts": {
      const base = `<m:e>${renderNode(n.base)}</m:e>`;
      if (n.sup && n.sub) {
        return `<m:sSubSup>${base}<m:sub>${renderNode(n.sub)}</m:sub><m:sup>${renderNode(n.sup)}</m:sup></m:sSubSup>`;
      }
      if (n.sup) return `<m:sSup>${base}<m:sup>${renderNode(n.sup)}</m:sup></m:sSup>`;
      return `<m:sSub>${base}<m:sub>${renderNode(n.sub)}</m:sub></m:sSub>`;
    }
    default:
      return "";
  }
}

/** LaTeX（不含 $ 定界符）→ OMML 片段；结构不支持时返回 null（调用方回退纯文本）。 */
export function latexToOmml(latex) {
  const s = String(latex ?? "").trim();
  if (!s) return null;
  try {
    const toks = tokenize(s);
    const items = [];
    let i = 0;
    while (i < toks.length) {
      if (toks[i].t === "}" || toks[i].t === "]") return null; // 不平衡
      const ni = parseItem(toks, i, items);
      if (ni < 0) return null;
      i = ni;
    }
    if (!items.length) return null;
    return renderItems(items);
  } catch {
    return null;
  }
}
