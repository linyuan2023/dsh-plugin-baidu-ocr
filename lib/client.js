window.__ModuleLoader__.load({ id: "dsh-plugin-baidu-ocr", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

// 设置面板：DSH 设置 → OCR。AK/SK 打码回显，留空即保持不变。
var React = require("react");
var { useState, useEffect } = React;
var DSW = (v) => `var(--dsw-alias-${v})`;

function OcrSettingsSection() {
  const [cfg, setCfg] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [asToken, setAsToken] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [pinging, setPinging] = useState(false);
  const [pingMsg, setPingMsg] = useState("");

  const [tasks, setTasks] = useState(null);

  const load = async () => {
    try {
      const r = await fetch("/ocr/api/settings");
      const d = await r.json();
      if (d.config) setCfg(d.config);
    } catch (e) {
      setMsg("读取失败: " + e.message);
    }
    try {
      const r2 = await fetch("/ocr/api/tasks");
      const d2 = await r2.json();
      setTasks(Array.isArray(d2.tasks) ? d2.tasks : []);
    } catch {
      setTasks([]);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    setMsg("");
    try {
      const body = {
        defaultEngine: cfg.defaultEngine || "general",
        defaultFormat: cfg.defaultFormat || "md",
        saveDir: cfg.saveDir || "",
        requestTimeoutMs: Number(cfg.requestTimeoutMs) || 30000,
        vlPollTimeoutMs: Number(cfg.vlPollTimeoutMs) || 300000,
        keepHeaderFooter: cfg.keepHeaderFooter === true,
        formulaMode: cfg.formulaMode || "unicode",
        asDocOrientation: cfg.asDocOrientation !== false,
        asDocUnwarping: cfg.asDocUnwarping === true,
        asChartRecognition: cfg.asChartRecognition === true,
        vlSegmentPages: Math.min(200, Math.max(10, Number(cfg.vlSegmentPages) || 40)),
        vlVectorHq: cfg.vlVectorHq !== false,
        crossPageMerge: cfg.crossPageMerge || "strict",
        paraMerge: cfg.paraMerge !== false,
        providerFallback: cfg.providerFallback || "off",
        defaultTier: cfg.defaultTier || "auto",
        officeLocalRead: cfg.officeLocalRead !== false,
        fontSizeFromLayout: cfg.fontSizeFromLayout !== false,
        replicaDpi: Math.min(400, Math.max(96, Number(cfg.replicaDpi) || 200)),
        hybridThinRatio: Math.min(1, Math.max(0, Number(cfg.hybridThinRatio) || 0)),
      };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      if (secretKey.trim()) body.secretKey = secretKey.trim();
      body.provider = cfg.provider || "baidu";
      body.aistudioUrl = cfg.aistudioUrl || "";
      if (asToken.trim()) body.aistudioToken = asToken.trim();
      const r = await fetch("/ocr/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      setMsg(r.ok ? "已保存，立即生效" : "保存失败: " + (d.error || r.status));
      if (r.ok) { setApiKey(""); setSecretKey(""); setAsToken(""); await load(); }
    } catch (e) {
      setMsg("保存失败: " + e.message);
    }
    setSaving(false);
  };

  const clearKeys = async () => {
    if (!window.confirm("确定清除已配置的 API Key / Secret Key？清除后需重新填写才能识别。")) return;
    setSaving(true);
    setMsg("");
    try {
      const r = await fetch("/ocr/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "__CLEAR__", secretKey: "__CLEAR__" }),
      });
      setMsg(r.ok ? "已清除密钥" : "清除失败: " + r.status);
      if (r.ok) await load();
    } catch (e) {
      setMsg("清除失败: " + e.message);
    }
    setSaving(false);
  };

  const ping = async () => {
    setPinging(true);
    setPingMsg("");
    try {
      const r = await fetch("/ocr/api/ping", { method: "POST" });
      const d = await r.json();
      // 不回显 token 尾段（安全修复后服务端也不再返回 tokenTail，曾显示"undefined"，#3）
      setPingMsg(d.ok
        ? `✅ 连接成功${d.expiresAt ? "（token 有效期至 " + new Date(d.expiresAt).toLocaleString() + "）" : ""}`
        : "❌ " + (d.error || "连接失败"));
    } catch (e) {
      setPingMsg("❌ " + e.message);
    }
    setPinging(false);
  };

  // 读取失败时也要把原因显示出来：旧实现在 msg 渲染前就被 null 门禁挡下，永远转圈（#11）
  if (!cfg) {
    return React.createElement(
      "div",
      { style: { color: DSW(msg ? "label-secondary" : "label-tertiary"), fontSize: "13px", padding: "12px 0" } },
      msg ? `读取失败：${msg}` : "加载中…"
    );
  }
  const set = (key, value) => setCfg((c) => ({ ...c, [key]: value }));
  const styles = {
    row: { display: "flex", alignItems: "center", gap: "10px", margin: "10px 0", fontSize: "13px" },
    label: { color: DSW("label-secondary"), width: "130px", flex: "none", fontSize: "12.5px" },
    input: { flex: "1", background: DSW("bg-module-platform"), border: "1px solid " + DSW("border-l2"), color: DSW("label-primary"), borderRadius: "8px", padding: "7px 10px", fontSize: "13px", outline: "none", maxWidth: "280px", fontFamily: DSW("font-family") },
    hint: { color: DSW("label-tertiary"), fontSize: "11.5px", marginTop: "6px" },
    btn: { background: DSW("button-info-fill"), border: "none", color: "#fff", borderRadius: "8px", padding: "8px 22px", fontSize: "13px", cursor: "pointer", marginTop: "14px", fontWeight: 500 },
    btnGhost: { background: "transparent", border: "1px solid " + DSW("border-l2"), color: DSW("label-secondary"), borderRadius: "8px", padding: "8px 16px", fontSize: "12.5px", cursor: "pointer", marginTop: "14px" },
    msg: { color: DSW("label-secondary"), fontSize: "12px", marginTop: "8px", marginLeft: "10px" },
  };
  return React.createElement(
    "div",
    null,
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "识别后端"),
      React.createElement(
        "select",
        { style: styles.input, value: cfg.provider || "baidu", onChange: (e) => set("provider", e.target.value) },
        React.createElement("option", { value: "baidu" }, "百度智能云（AK/SK，版面 JSON 完整）"),
        React.createElement("option", { value: "aistudio" }, "AI Studio 星河社区（限时免费，20000 页/日）")
      )
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "API Key"),
      React.createElement("input", {
        type: "password", style: styles.input, value: apiKey,
        placeholder: cfg.hasApiKey ? `已配置（${cfg.apiKey}），留空保持不变` : "百度智能云 API Key（AK）",
        onChange: (e) => setApiKey(e.target.value),
      })
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "Secret Key"),
      React.createElement("input", {
        type: "password", style: styles.input, value: secretKey,
        placeholder: cfg.hasSecretKey ? `已配置（${cfg.secretKey}），留空保持不变` : "百度智能云 Secret Key（SK）",
        onChange: (e) => setSecretKey(e.target.value),
      })
    ),
    React.createElement("div", { style: styles.hint, }, "密钥来自百度智能云控制台 → 文字识别 OCR → 应用列表。也可以用环境变量 BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY。"),
    React.createElement("div", { style: styles.tplLabel }, "AI Studio 星河社区后端（识别后端选 aistudio 时使用）"),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "API 地址"),
      React.createElement("input", { type: "text", style: { ...styles.input, maxWidth: "360px" }, value: cfg.aistudioUrl || "", placeholder: "aistudio.baidu.com/paddleocr/task 调用示例中的 API_URL", onChange: (e) => set("aistudioUrl", e.target.value) })
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "Access Token"),
      React.createElement("input", { type: "password", style: styles.input, value: asToken, placeholder: cfg.hasAistudioToken ? `已配置（${cfg.aistudioToken}），留空保持不变` : "星河社区 Access Token", onChange: (e) => setAsToken(e.target.value) })
    ),
    React.createElement("div", { style: styles.hint }, "星河社区限时免费（今日解析页数额度见其控制台）。该后端无版面 JSON，docx/pdf 走 markdown 排版路径。"),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("input", { type: "checkbox", id: "ocr-asorient", checked: cfg.asDocOrientation !== false, onChange: (e) => set("asDocOrientation", e.target.checked) }),
      React.createElement("label", { htmlFor: "ocr-asorient", style: { ...styles.label, width: "auto", cursor: "pointer" } }, "方向分类（旋转/倒置扫描页的表格识别依赖它，默认开）")
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("input", { type: "checkbox", id: "ocr-asunwarp", checked: cfg.asDocUnwarping === true, onChange: (e) => set("asDocUnwarping", e.target.checked) }),
      React.createElement("label", { htmlFor: "ocr-asunwarp", style: { ...styles.label, width: "auto", cursor: "pointer" } }, "文档矫正（拍摄变形/弯曲书页，更耗时，默认关）")
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("input", { type: "checkbox", id: "ocr-aschart", checked: cfg.asChartRecognition === true, onChange: (e) => set("asChartRecognition", e.target.checked) }),
      React.createElement("label", { htmlFor: "ocr-aschart", style: { ...styles.label, width: "auto", cursor: "pointer" } }, "图表识别（图表转表格，更耗时，默认关）")
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "默认引擎"),
      React.createElement(
        "select",
        { style: styles.input, value: cfg.defaultEngine || "general", onChange: (e) => set("defaultEngine", e.target.value) },
        React.createElement("option", { value: "general" }, "通用·标准（默认，免费额度大）"),
        React.createElement("option", { value: "accurate" }, "通用·高精度"),
        React.createElement("option", { value: "handwriting" }, "手写文字"),
        React.createElement("option", { value: "doc" }, "办公文档识别（仅图片）"),
        React.createElement("option", { value: "vl" }, "PaddleOCR-VL 文档解析（PDF/Word → 结构化 md）")
      )
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "默认保存格式"),
      React.createElement(
        "select",
        { style: styles.input, value: cfg.defaultFormat || "md", onChange: (e) => set("defaultFormat", e.target.value) },
        React.createElement("option", { value: "md" }, "Markdown"),
        React.createElement("option", { value: "txt" }, "纯文本"),
        React.createElement("option", { value: "docx" }, "Word 文档（版面还原）"),
        React.createElement("option", { value: "docx-gongwen" }, "公文 Word（GB/T 9704）"),
        React.createElement("option", { value: "pdf" }, "保真 PDF（图片内嵌）"),
        React.createElement("option", { value: "pdf-replica" }, "复刻 PDF（原页位图+隐形文字层）"),
        React.createElement("option", { value: "content-list" }, "结构化 JSON（content-list，含坐标）"),
        React.createElement("option", { value: "csv" }, "CSV（仅表格结果）")
      )
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "公式输出模式"),
      React.createElement(
        "select",
        { style: styles.input, value: cfg.formulaMode || "unicode", onChange: (e) => set("formulaMode", e.target.value), title: "unicode：LaTeX 清洗为可读文本（π、√、上下标）；raw：保留 LaTeX 源；omml：docx 内嵌 Word 原生公式对象（pdf/公文/csv 自动按 unicode 兜底）" },
        React.createElement("option", { value: "unicode" }, "可读文本（默认：π、√、上下标）"),
        React.createElement("option", { value: "raw" }, "保留 LaTeX 源码"),
        React.createElement("option", { value: "omml" }, "Word 原生公式对象（仅 docx）")
      )
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "保存目录"),
      React.createElement("input", { type: "text", style: styles.input, value: cfg.saveDir || "", placeholder: "留空 = 会话工作区下 ocr-output/", onChange: (e) => set("saveDir", e.target.value) })
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("input", { type: "checkbox", id: "ocr-keephf", checked: cfg.keepHeaderFooter === true, onChange: (e) => set("keepHeaderFooter", e.target.checked) }),
      React.createElement("label", { htmlFor: "ocr-keephf", style: { ...styles.label, width: "auto", cursor: "pointer" } }, "保留页眉页脚（浏览器截图的标签页/网址也会被当作页眉页脚过滤，开启后保留并由版面类型标注）")
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "请求超时（毫秒）"),
      React.createElement("input", { type: "number", min: 5000, step: 1000, style: styles.input, value: cfg.requestTimeoutMs ?? 30000, onChange: (e) => set("requestTimeoutMs", Number(e.target.value) || 30000) })
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "VL 轮询上限（毫秒）"),
      React.createElement("input", { type: "number", min: 30000, max: 330000, step: 10000, style: styles.input, value: Math.min(cfg.vlPollTimeoutMs ?? 300000, 330000), onChange: (e) => set("vlPollTimeoutMs", Number(e.target.value) || 300000), title: "最大 330000（330 秒）：工具整体超时 360 秒，轮询上限需留余量" })
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "大 PDF 分段阈值"),
      React.createElement("input", { type: "number", min: 10, max: 200, step: 10, style: styles.input, value: cfg.vlSegmentPages ?? 40, onChange: (e) => set("vlSegmentPages", Number(e.target.value) || 40), title: "vl 引擎识别超过此页数的本地 PDF 时自动按段拆分提交（每段独立缓存可重试）；0/留空按默认 40" })
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("input", { type: "checkbox", id: "ocr-vlhq", checked: cfg.vlVectorHq !== false, onChange: (e) => set("vlVectorHq", e.target.checked) }),
      React.createElement("label", { htmlFor: "ocr-vlhq", style: { ...styles.label, width: "auto", cursor: "pointer" } }, "矢量图纸高清重截（本地 PDF 的图片区域按版面坐标以 220 DPI 本机重摄，替代后端低清区域图）")
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "跨页表格拼接"),
      React.createElement(
        "select",
        { style: styles.input, value: cfg.crossPageMerge || "strict", onChange: (e) => set("crossPageMerge", e.target.value) },
        React.createElement("option", { value: "strict" }, "严格（表头逐字相同才拼，默认）"),
        React.createElement("option", { value: "loose" }, "宽松（列数一致且前表到页底也拼）"),
        React.createElement("option", { value: "off" }, "关闭")
      )
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("input", { type: "checkbox", id: "ocr-paramerge", checked: cfg.paraMerge !== false, onChange: (e) => set("paraMerge", e.target.checked) }),
      React.createElement("label", { htmlFor: "ocr-paramerge", style: { ...styles.label, width: "auto", cursor: "pointer" } }, "跨页段落合并（页尾无句读时与下页首段拼接，默认开）")
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("input", { type: "checkbox", id: "ocr-officelocal", checked: cfg.officeLocalRead !== false, onChange: (e) => set("officeLocalRead", e.target.checked) }),
      React.createElement("label", { htmlFor: "ocr-officelocal", style: { ...styles.label, width: "auto", cursor: "pointer" } }, "Office 本地直读（docx/pptx/xlsx 本机解析零配额，失败自动回落云端，默认开）")
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("input", { type: "checkbox", id: "ocr-fontsize", checked: cfg.fontSizeFromLayout !== false, onChange: (e) => set("fontSizeFromLayout", e.target.checked) }),
      React.createElement("label", { htmlFor: "ocr-fontsize", style: { ...styles.label, width: "auto", cursor: "pointer" } }, "字号还原（按版面块高折算原文字号，仅 docx/pdf 且本地原件可用时生效）")
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "复刻 PDF DPI"),
      React.createElement("input", { type: "number", min: 96, max: 400, step: 24, style: styles.input, value: cfg.replicaDpi ?? 200, onChange: (e) => set("replicaDpi", Number(e.target.value) || 200), title: "pdf-replica 复刻模式的原页位图清晰度：越高越清晰、文件越大" })
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "薄页自动补识别"),
      React.createElement("input", { type: "number", min: 0, max: 1, step: 0.05, style: styles.input, value: cfg.hybridThinRatio ?? 0, onChange: (e) => set("hybridThinRatio", Number(e.target.value) || 0), title: "0=关（默认）。文本层直取时，无文本层页占比≤该值则逐页走同步通道补识别（耗配额）" })
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "后端故障切换"),
      React.createElement(
        "select",
        { style: styles.input, value: cfg.providerFallback || "off", onChange: (e) => set("providerFallback", e.target.value) },
        React.createElement("option", { value: "off" }, "关闭（默认）"),
        React.createElement("option", { value: "auto" }, "自动（主后端失败切另一后端重试）")
      )
    ),
    React.createElement(
      "div",
      { style: styles.row },
      React.createElement("span", { style: styles.label }, "默认档位"),
      React.createElement(
        "select",
        { style: styles.input, value: cfg.defaultTier || "auto", onChange: (e) => set("defaultTier", e.target.value), title: "auto=按路由规则；flash=最快；basic=高精度；standard=VL 结构化；advanced=VL+矢量重截+版面 docx" },
        React.createElement("option", { value: "auto" }, "自动（按路由规则，默认）"),
        React.createElement("option", { value: "flash" }, "极速（提字优先）"),
        React.createElement("option", { value: "basic" }, "高精度"),
        React.createElement("option", { value: "standard" }, "结构化（VL）"),
        React.createElement("option", { value: "advanced" }, "极致复刻（VL+高清+版面 docx）")
      )
    ),
    React.createElement("div", { style: { ...styles.hint, marginTop: "10px" } }, "数据流向：识别时文件内容会发送到所选后端（百度智能云 / AI Studio）；密钥、缓存、产物、文档库全部只存本机 ~/.dsh/ocr/。"),
    React.createElement("button", { style: styles.btn, disabled: saving, onClick: save }, saving ? "保存中…" : "保存设置"),
    React.createElement("button", { style: { ...styles.btnGhost, marginLeft: "10px" }, disabled: saving, onClick: clearKeys, title: "清除已保存的 API Key / Secret Key" }, "清除已存密钥"),
    React.createElement("button", { style: { ...styles.btnGhost, marginLeft: "10px" }, disabled: pinging, onClick: ping }, pinging ? "测试中…" : "测试连接"),
    React.createElement("span", { style: styles.msg }, msg || pingMsg),
    React.createElement("div", { style: { ...styles.hint, marginTop: "16px" } }, "最近解析任务（超时任务可用 /ocr resume <id尾部> 取回）"),
    React.createElement(
      "div",
      { style: { fontSize: "11.5px", color: DSW("label-tertiary"), lineHeight: "1.7", margin: "4px 0 8px" } },
      !tasks ? "加载中…"
        : tasks.length === 0 ? "暂无任务记录"
        : tasks.slice(0, 5).map((t) =>
            React.createElement(
              "div",
              { key: t.id },
              `[${t.status}] ${t.idTail} ${t.fileName || "?"}（${t.provider}${t.pagesHint ? `，约 ${t.pagesHint} 页` : ""}）`
            )
          )
    )
  );
}

var name = "dsh-plugin-baidu-ocr";
var inject = ["slots"];
function apply(ctx) {
  // 两段式注册（同 dsh-plugin-notify）：等设置外壳就绪后再挂载本节
  ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name: "settings.section", id: "ocr", order: 110, label: "OCR" },
    OcrSettingsSection
  )));
}
module.exports = { name, inject, apply };
return module.exports; } });
