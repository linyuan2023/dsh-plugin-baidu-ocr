// lib/files.js — 输入文件校验：扩展名 + 魔数识别、尺寸读取、base64 与大小限制
// 全部用 Node 内置 API，不引依赖；图片只对 PNG/JPEG/BMP 精确读尺寸（占绝大多数场景），
// 其余格式只校验魔数与大小，尺寸交给百度服务端兜底报错。
import { statSync, readFileSync } from "node:fs";
import { OcrError } from "./errors.js";

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".pnm", ".webp"]);
export const PDF_EXTS = new Set([".pdf"]);
export const VL_ONLY_EXTS = new Set([".doc", ".docx", ".ppt", ".pptx", ".xlsx"]);

export const MAX_ENCODED_BYTES = 4 * 1024 * 1024; // 百度限制：base64 编码后 ≤ 4MB

export function extOf(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p ?? ""));
  return m ? `.${m[1].toLowerCase()}` : "";
}

/** 魔数 → 真实类型（扩展名可伪造，以魔数为准；识别不出时退回扩展名判断） */
export function sniffKind(buf, ext) {
  if (!buf || buf.length < 12) return { kind: "unknown", mime: "" };
  const b = buf;
  const u32 = (o) => b.readUInt32BE(o);
  if (u32(0) === 0x89504e47) return { kind: "image", mime: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "jpeg" };
  if (b[0] === 0x42 && b[1] === 0x4d) return { kind: "image", mime: "bmp" };
  if ((u32(0) === 0x49492a00 || u32(0) === 0x4d4d002a)) return { kind: "image", mime: "tiff" };
  if (u32(0) === 0x52494646 && u32(8) === 0x57454250) return { kind: "image", mime: "webp" };
  // PNM: P1-P6
  if (b[0] === 0x50 && b[1] >= 0x31 && b[1] <= 0x36 && (b[2] === 0x0a || b[2] === 0x0d || b[2] === 0x20)) {
    return { kind: "image", mime: "pnm" };
  }
  if (b.subarray(0, 5).toString("ascii") === "%PDF-") return { kind: "pdf", mime: "pdf" };
  // OOXML 容器（docx/pptx）：PK 头 + 内部含 word/ 或 ppt/ 目录。
  // 扫描窗取 64KB：word/document.xml 的条目名通常在文件前部，但大 docx 的
  // Content_Types/rels 可能超过 4KB，窗口太小会把合法 docx 误判成 zip（#17）
  if (b[0] === 0x50 && b[1] === 0x4b) {
    const head = b.subarray(0, Math.min(b.length, 65536)).toString("latin1");
    if (head.includes("word/")) return { kind: "word", mime: "docx" };
    if (head.includes("ppt/")) return { kind: "ppt", mime: "pptx" };
    if (head.includes("xl/")) return { kind: "excel", mime: "xlsx" };
    return { kind: "zip", mime: "zip" };
  }
  // OLE 复合文档（旧版 .doc/.ppt/.xls）：签名 D0 CF 11 E0（上面曾有一个错误的
  // "PO^Q`" 判断——那不是 OLE 签名，已删，#17）
  if (u32(0) === 0xd0cf11e0) return { kind: "office_legacy", mime: ext === ".ppt" ? "ppt" : "doc" };
  return { kind: "unknown", mime: "" };
}

/** JPEG EXIF Orientation 解析（v0.4）：APP1/Exif 的 IFD0 tag 0x0112，返回 1–8；无/畸形/非 JPEG 返回 0。
 *  只向前扫到 SOF/SOS 即停；全程防御（长度越界/非法 offset 一律 0）。不改变字节流——只读取。 */
export function readJpegExifOrientation(buf) {
  try {
    if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 0;
    let off = 2;
    while (off + 4 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      if (marker === 0xda || (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
        return 0; // 到达 SOS/SOF：APP1 不存在
      }
      const segLen = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && segLen >= 8 && off + 2 + segLen <= buf.length) {
        // 段内校验 "Exif\0\0"
        if (buf.toString("ascii", off + 4, off + 10) !== "Exif\u0000\u0000") {
          off += 2 + segLen;
          continue;
        }
        const tiff = off + 10;
        const bo = buf.toString("ascii", tiff, tiff + 2) === "MM" ? "big" : buf.toString("ascii", tiff, tiff + 2) === "II" ? "little" : null;
        if (!bo) return 0;
        const u16 = (p) => (bo === "big" ? buf.readUInt16BE(p) : buf.readUInt16LE(p));
        const u32 = (p) => (bo === "big" ? buf.readUInt32BE(p) : buf.readUInt32LE(p));
        const ifd0 = tiff + u32(tiff + 4);
        if (ifd0 + 2 > buf.length) return 0;
        const nEntries = u16(ifd0);
        for (let e = 0; e < nEntries; e++) {
          const entry = ifd0 + 2 + e * 12;
          if (entry + 12 > buf.length) return 0;
          if (u16(entry) === 0x0112) {
            const v = u16(entry + 8); // SHORT 内联在 value 字段（前 2 字节，按端序）
            return v >= 1 && v <= 8 ? v : 0;
          }
        }
        return 0;
      }
      off += 2 + Math.max(0, segLen);
    }
  } catch {}
  return 0;
}

/** PNG/JPEG/BMP 像素尺寸；读不出返回 null。JPEG 附带 orientation（EXIF，1–8；无则 1）。
 *  注意：宽高为原始存储值（不按 EXIF 旋转换算）——现有限额判定用 min/max（互换不变），
 *  orientation 供方向异常提示与后续本地处理使用。 */
export function imageSize(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      let orientation = 0;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        // SOF0-SOF15（DHT C4 / DAC CC / RST 除外）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7), orientation: orientation || 1 };
        }
        if (marker === 0xe1 && orientation === 0) orientation = readJpegExifOrientation(buf);
        off += 2 + buf.readUInt16BE(off + 2);
      }
      return null;
    }
    if (buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
    }
  } catch {
    return null;
  }
  return null;
}

export function checkEncodedSize(buf, limitBytes = MAX_ENCODED_BYTES) {
  const encoded = Math.ceil((buf.length + 2) / 3) * 4;
  if (encoded > limitBytes) {
    const mb = (encoded / 1048576).toFixed(1);
    const capMb = (limitBytes / 1048576).toFixed(0);
    throw new OcrError("E_TOO_LARGE", `文件 base64 编码后约 ${mb}MB，超过 ${capMb}MB 限制；请压缩后重试`);
  }
}

// 通道限额（官方：A=编码后≤4MB/边≤4096px；VL=图片≤10MB、版式pdf≤100MB、流式doc/ppt≤50MB、边≤8192px）
export const VL_CAPS = {
  image: 10 * 1048576,
  pdf: 100 * 1048576,
  word: 50 * 1048576,
  ppt: 50 * 1048576,
  excel: 50 * 1048576, // xlsx 仅本地直读（不上传），上限沿用 Office 50MB
};
export const VL_MAX_PX = 8192;

/** 通道感知限额校验（在路由确定后调用）。url 输入由百度侧拉取，本地不设限。 */
export function checkChannelLimits(route, input) {
  if (!input || input.kind === "url") return;
  const buf = input.buffer;
  const dims = input.dims;
  const fmtMB = (n) => `${(n / 1048576).toFixed(1)}MB`;
  const encoded = Math.ceil((buf.length + 2) / 3) * 4;
  if (route.channel === "A") {
    if (encoded > MAX_ENCODED_BYTES) {
      throw new OcrError(
        "E_TOO_LARGE",
        `文件 base64 编码后约 ${fmtMB(encoded)}，超过同步通道 4MB 限制；请压缩后重试，或改用 vl 引擎（图片 ≤10MB、PDF ≤100MB）`
      );
    }
    if (dims && Math.max(dims.w, dims.h) > 4096) {
      throw new OcrError(
        "E_TOO_BIG_PX",
        `图片尺寸 ${dims.w}x${dims.h} 超限：同步通道最长边 ≤4096px，请缩放后重试（vl 通道支持 8192px）`
      );
    }
  } else {
    const cap = VL_CAPS[input.kind] ?? VL_CAPS.image;
    if (encoded > cap) {
      throw new OcrError("E_TOO_LARGE", `文件 base64 编码后约 ${fmtMB(encoded)}，超过 vl 通道 ${fmtMB(cap)} 限制`);
    }
    if (dims && Math.max(dims.w, dims.h) > VL_MAX_PX) {
      throw new OcrError("E_TOO_BIG_PX", `图片尺寸 ${dims.w}x${dims.h} 超限：vl 通道最长边 ≤8192px`);
    }
  }
}

/** 校验本地文件并读入内存 → { buffer, ext, kind, mime, size, dims }
 *  注意：大小/像素限额是通道相关的，这里不做——路由确定后由 checkChannelLimits 校验。 */
export function loadInputFile(path, { allowUrl = false } = {}) {
  if (allowUrl && /^https?:\/\//i.test(String(path))) {
    return { url: String(path), kind: "url" };
  }
  if (/^https?:\/\//i.test(String(path))) {
    throw new OcrError("E_URL_INPUT", "path 收到的是 URL：URL 识别请改用 url 参数（path 仅接受本地文件路径）");
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new OcrError("E_NOT_FOUND", `文件不存在或不可读：${path}`);
  }
  if (!st.isFile()) throw new OcrError("E_NOT_FILE", `不是常规文件：${path}`);
  let ext = extOf(path);
  let buffer = readFileSync(path);
  if (!IMAGE_EXTS.has(ext) && !PDF_EXTS.has(ext) && !VL_ONLY_EXTS.has(ext)) {
    // 无扩展名（如聊天上传的临时附件）时，按文件魔数嗅探真实类型，避免直接拒绝
    const probe = sniffKind(buffer, ext);
    const MIME_TO_EXT = { png: ".png", jpeg: ".jpg", bmp: ".bmp", tiff: ".tiff", webp: ".webp", pnm: ".pnm", pdf: ".pdf", docx: ".docx", pptx: ".pptx", xlsx: ".xlsx", doc: ".doc", ppt: ".ppt", office_legacy: ext || ".doc" };
    const resolved = MIME_TO_EXT[probe.mime];
    if (!resolved || probe.kind === "unknown") {
      throw new OcrError(
        "E_BAD_EXT",
        `不支持的扩展名 ${ext || "(无)"}：图片支持 png/jpg/jpeg/bmp/tiff/pnm/webp，文档支持 pdf/doc/docx/ppt/pptx`
      );
    }
    ext = resolved; // 以嗅探到的真实类型继续正常流程
  }
  if (!buffer.length) throw new OcrError("E_EMPTY", `文件为空：${path}`);
  const { kind, mime } = sniffKind(buffer, ext);
  if (kind === "unknown") {
    throw new OcrError("E_BAD_MAGIC", `文件内容与扩展名 ${ext} 不符（魔数无法识别），可能已损坏或被重命名`);
  }
  const dims = imageSize(buffer);
  if (dims && Math.min(dims.w, dims.h) < 15) {
    throw new OcrError("E_TOO_SMALL", `图片尺寸 ${dims.w}x${dims.h} 过小：最短边不能小于 15px`);
  }
  return { buffer, ext, kind, mime, size: st.size, dims };
}

/** 展开保存目录里的 ~ 与相对路径占位 */
export function expandPath(p, baseDir) {
  let s = String(p ?? "").trim();
  if (!s) return s;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (s.startsWith("~")) s = home + s.slice(1);
  if (!/^[A-Za-z]:[\\/]/.test(s) && !s.startsWith("\\\\") && baseDir) s = `${baseDir}/${s}`.replace(/\\/g, "/");
  return s;
}
