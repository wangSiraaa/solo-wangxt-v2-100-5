// 规范化序列化 + 内容指纹。
// 指纹用于：发布版本身份、重复导入幂等、证据与任务版本绑定、包文件篡改检测。
// 采用 FNV-1a（32 位，十六进制）——非加密哈希，仅作离线内容身份与完整性校验。

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  }
  return value;
}

/** 键排序、无空白的规范化 JSON（同一内容跨机器/键序产生同一字符串） */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** FNV-1a 32 位十六进制指纹，带 fnv1a- 前缀明示算法 */
export function contentHash(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    // 32 位 FNV 素数乘法（用 Math.imul 保持 32 位语义）
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** 生成各类实体 id */
export function hashId(prefix: string): string {
  const rand = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}_${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${contentHash(rand).slice(6)}${rand.slice(0, 10)}`;
}
