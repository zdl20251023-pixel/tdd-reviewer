import type { Vulnerability } from "../schemas";

/**
 * P1-1 改进：漏洞去重
 * 基于 title 关键词提取进行语义级去重，避免多个 System 输出重复漏洞
 */
export function deduplicateVulnerabilities(
  vulns: Vulnerability[]
): Vulnerability[] {
  const seen = new Set<string>();
  return vulns.filter((v) => {
    // 提取标题中的核心关键词作为去重 key（移除标点和空白）
    const key = v.title
      .replace(/[^a-zA-Z\u4e00-\u9fa5_]/g, "")
      .slice(0, 30)
      .toLowerCase();
    if (seen.has(key)) {
      console.log(`   🔄 [Dedup] 去重跳过: "${v.title.slice(0, 40)}..."`);
      return false;
    }
    seen.add(key);
    return true;
  });
}
