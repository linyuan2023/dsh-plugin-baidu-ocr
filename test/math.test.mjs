// test/math.test.mjs — 公式处理：LaTeX→Unicode 清洗 + 最小 LaTeX→OMML
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLatex, cleanMath, latexToOmml } from "../lib/math.js";

test("希腊字母全量映射（旧版只映射 μ，其余被删）", () => {
  assert.equal(cleanLatex("\\pi\\approx 3.14"), "π≈ 3.14");
  assert.equal(cleanLatex("\\alpha+\\beta=\\gamma"), "α+β=γ");
  assert.equal(cleanLatex("\\Delta S\\geq 0"), "Δ S≥ 0");
  assert.equal(cleanLatex("\\mu m"), "μ m");
});

test("根号/求和/积分/上下标", () => {
  assert.equal(cleanLatex("\\sqrt{2}"), "√(2)");
  assert.equal(cleanLatex("\\sqrt[3]{x}"), "∛(x)");
  assert.equal(cleanLatex("\\sum_{i=1}^{n}"), "∑ᵢ₌₁ⁿ");
  assert.equal(cleanLatex("\\int_0^1"), "∫₀¹");
  assert.equal(cleanLatex("E=mc^2"), "E=mc²");
  assert.equal(cleanLatex("H_2O"), "H₂O");
});

test("分式（含一层嵌套循环展开）", () => {
  assert.equal(cleanLatex("\\frac{1}{2}"), "1/2");
  assert.equal(cleanLatex("\\frac{x+1}{y}"), "(x+1)/y");
  assert.equal(cleanLatex("\\frac{\\frac{a}{b}}{c}"), "(a/b)/c");
});

test("未知命令保留字面（不删内容，可恢复）", () => {
  assert.equal(cleanLatex("\\vec{v}"), "\\vec{v}");
  assert.equal(cleanLatex("\\mathbb{R}"), "R"); // 字体包裹命令剥壳保留内容
});

test("货币金额不误伤（成对 $ 视为金额而非数学定界符）", () => {
  assert.equal(cleanMath("价格 $5，运费 $6"), "价格 $5，运费 $6");
  assert.equal(cleanMath("总价 $100 元"), "总价 $100 元");
  assert.equal(cleanMath("$x$ 表示未知数"), "x 表示未知数");
  assert.equal(cleanMath("$2x+3y$"), "2x+3y"); // 含字母按公式处理
});

test("转义间距/标点（实测盲区：\\, 是反斜杠+标点，字母命令规则覆盖不到）", () => {
  assert.equal(cleanLatex("50.0\\,cm^{2}"), "50.0 cm²");
  assert.equal(cleanLatex("a\\;b"), "a b");
  assert.equal(cleanLatex("50\\%"), "50%");
  assert.equal(cleanLatex("x\\$y"), "x$y");
  assert.equal(cleanLatex("co\\-op"), "coop"); // 断字提示删除
});

test("\\(...\\) 与 \\[...\\] 定界符公式（部分 PaddleOCR 版本输出形态）", () => {
  assert.equal(cleanMath("\\(50.0\\,cm^{2}\\)"), "50.0 cm²");
  assert.ok(cleanMath("\\[\\frac{1}{2}\\]").includes("1/2"));
  assert.ok(cleanMath("正文 \\(\\pi\\approx 3.14\\) 结束").includes("π≈ 3.14"));
});

test("latexToOmml：frac/sqrt/上下标转 OMML，异常回退 null", () => {
  const frac = latexToOmml("\\frac{1}{2}");
  assert.ok(frac.includes("<m:f>") && frac.includes("<m:num>") && frac.includes("<m:den>"));
  assert.ok(latexToOmml("E=mc^2").includes("<m:sSup>"));
  assert.ok(latexToOmml("x_1").includes("<m:sSub>"));
  assert.ok(latexToOmml("\\sqrt{x}").includes("<m:rad>"));
  assert.ok(latexToOmml("\\pi r^2").includes("π"));
  assert.equal(latexToOmml(null), null);
  assert.equal(latexToOmml(""), null);
  assert.equal(latexToOmml("\\frac{1"), null); // 括号未闭合
});

test("箭头命令不被 \\left/\\right 剥离误伤（#math：旧版 \\rightarrow 被吃成 \"arrow\"）", () => {
  assert.equal(cleanLatex("A \\rightarrow B"), "A → B");
  assert.equal(cleanLatex("x \\leftarrow y"), "x ← y");
  assert.equal(cleanLatex("a \\leftrightarrow b"), "a ↔ b");
  assert.equal(cleanLatex("\\left( x \\right)"), "( x )"); // 真排版壳照常剥离
});

test("双层分组花括号：unicode 与 OMML 双路径都不降级（#math）", () => {
  assert.equal(cleanLatex("\\frac{{1}}{{2}}"), "1/2");
  assert.equal(cleanMath("$\\frac{{a+b}}{{c}}$"), "(a+b)/c");
  const omml = latexToOmml("\\frac{{1}}{{2}}");
  assert.ok(omml && omml.includes("<m:f>"), `双层花括号 OMML 应解析成功: ${omml}`);
  const omml2 = latexToOmml("{{a+b}}");
  assert.ok(omml2 && omml2.includes("a+b"), `纯双层组 OMML: ${omml2}`);
});
