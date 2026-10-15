// lib/docmodel.js — 统一文档模型（v0.4）：版面页块 → DocumentModel → content-list JSON。
// DocumentModel 是 content-list 输出、复刻度评分（fidelity.js）、sandwich PDF（replica.js）、
// 文档库引用（index.js /ocr lib）的公共底座。块仅保留公共字段（_pos/_fontUnits 等私有元数据不外露）。
// 确定性：不含时间戳字段（golden 快照与重复运行必须逐字节一致）。
import { layoutToPageBlocks } from "./layout.js";

/** 嵌套单元格公共化：{nested:{rows,merges}} 递归展开；普通单元格原样。 */
function pubCell(c) {
  if (c && typeof c === "object" && c.nested) {
    return {
      nested: { rows: (c.nested.rows ?? []).map((r) => r.map(pubCell)), merges: c.nested.merges ?? [] },
      ...(c.text ? { text: c.text } : {}),
    };
  }
  return c ?? "";
}

function pubBlock(b) {
  return {
    type: b?.type ?? "p",
    ...(b?.text != null ? { text: b.text } : {}),
    ...(b?.rows ? { rows: (b.rows ?? []).map((r) => r.map(pubCell)) } : {}),
    ...(b?.merges?.length ? { merges: b.merges } : {}),
    ...(b?.url ? { url: b.url } : {}),
    ...(b?.caption ? { caption: b.caption } : {}),
    ...(b?.level ? { level: b.level } : {}),
    ...(Array.isArray(b?.bbox) ? { bbox: b.bbox } : {}),
  };
}

/** 版面 JSON → DocumentModel。opts 透传 layoutToPageBlocks（filterHeaderFooter/formulaMode/mergeMode/paraMerge），
 *  另接受 source/engine/provider 进 meta。 */
export function layoutToDocModel(parseJson, opts = {}) {
  const pages = layoutToPageBlocks(parseJson, opts);
  return {
    pages: pages.map((p, i) => ({
      index: i + 1,
      width: Math.round(p._pageW || 0),
      height: Math.round(p._pageH || 0),
      orientation: p.isLandscape ? "landscape" : "portrait",
      blocks: (p.blocks ?? []).map(pubBlock),
    })),
    meta: {
      source: opts.source ?? "",
      engine: opts.engine ?? "vl",
      provider: opts.provider ?? "",
      pagesCount: pages.length,
    },
  };
}

/** markdown 块流 → DocumentModel（无版面坐标的降级路径：bbox 缺失、单页视角）。 */
export function blocksToDocModel(blocks, meta = {}) {
  return {
    pages: [
      {
        index: 1,
        width: 0,
        height: 0,
        orientation: "portrait",
        blocks: (blocks ?? []).map(pubBlock),
      },
    ],
    meta: { source: "", engine: meta.engine ?? "", provider: meta.provider ?? "", pagesCount: 1 },
  };
}

/** DocumentModel → content-list JSON 对象（结构对齐 MinerU content_list：
 *  pages[].blocks[] = { type, text|rows|url, bbox(0–1000), level?, caption? }）。 */
export function docModelToContentList(dm) {
  return {
    meta: {
      source: dm.meta.source ?? "",
      engine: dm.meta.engine ?? "",
      provider: dm.meta.provider ?? "",
      pagesCount: dm.meta.pagesCount ?? dm.pages?.length ?? 0,
    },
    pages: (dm.pages ?? []).map((p) => ({
      index: p.index,
      width: p.width,
      height: p.height,
      orientation: p.orientation,
      blocks: (p.blocks ?? []).map(pubBlock),
    })),
  };
}
