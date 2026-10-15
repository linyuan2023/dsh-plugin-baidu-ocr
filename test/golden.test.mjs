// test/golden.test.mjs — 端到端 golden 回归（v0.4）：真实结构版面 JSON → 块流/产物 快照对比。
// 防线：版面重建（排序/图注表注/页码剥离/表格/段落合并/嵌套）任何改动导致产物变化都会在此显形。
// 刷新：UPDATE_GOLDEN=1 node --test test/golden.test.mjs（缺失快照自动生成并通过，输出提示）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "layout");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const { layoutToBlocks } = await import("../lib/layout.js");
const { blocksToMarkdown } = await import("../lib/markdown.js");

const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json") && !f.includes(".expected.")).sort();

for (const name of fixtures) {
  test(`golden：${basename(name, ".json")}`, () => {
    const layoutJson = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
    const built = layoutToBlocks(layoutJson, {
      filterHeaderFooter: true,
      formulaMode: "unicode",
      mergeMode: "strict",
      paraMerge: true,
    });
    const snap = JSON.stringify({ blocks: built.blocks, stats: built.stats }, null, 1);
    const md = blocksToMarkdown(built.blocks);
    const expectedJson = join(FIXTURES, name.replace(/\.json$/, ".expected.json"));
    const expectedMd = join(FIXTURES, name.replace(/\.json$/, ".expected.md"));
    if (UPDATE || !exists(expectedJson)) {
      writeFileSync(expectedJson, snap, "utf8");
      if (UPDATE) console.log(`[golden] 已刷新 ${basename(expectedJson)}`);
    }
    if (UPDATE || !exists(expectedMd)) {
      writeFileSync(expectedMd, md, "utf8");
      if (UPDATE) console.log(`[golden] 已刷新 ${basename(expectedMd)}`);
    }
    assert.equal(snap, readFileSync(expectedJson, "utf8"), `块流快照不一致：${name}（确认改动符合预期后用 UPDATE_GOLDEN=1 刷新）`);
    assert.equal(md, readFileSync(expectedMd, "utf8"), `markdown 快照不一致：${name}`);
  });
}

function exists(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}
