import type { Vulnerability, ChaosResult } from "../schemas";
import type { SectionsAResult } from "./ai-renderer";
import {
  renderVulnerabilitiesSection,
  renderChaosSection,
} from "./template-renderer";

/**
 * P0-2 改进：assembleDocument 不再依赖正则解析
 * 路线 A 已改为结构化输出，直接用模板拼接
 */
export function assembleDocument(
  sectionsA: SectionsAResult,
  p0Vulnerabilities: Vulnerability[],
  section4Text: string,
  chaosResults: ChaosResult[]
): string {
  // §1 方案评估 — 从结构化数据渲染（100% 确定性）
  const section1 = `### 1. 方案评估
- [架构逻辑]：${sectionsA.section1_评估.架构逻辑}
- [技术选型]：${sectionsA.section1_评估.技术选型}
- [状态流转]：${sectionsA.section1_评估.状态流转}`;

  // §2 潜在风险 — 模板硬渲染
  const section2 = `### 2. 潜在风险 (P0 级，严控 ${p0Vulnerabilities.length} 条)\n\n${renderVulnerabilitiesSection(p0Vulnerabilities)}`;

  // §3 优化建议 — 从结构化数据渲染（100% 确定性）
  const defensiveItems = sectionsA.section3_优化.防御性方案
    .map((item) => `    - ${item}`)
    .join("\n");
  const costItems = sectionsA.section3_优化.降本增效
    .map((item) => `    - ${item}`)
    .join("\n");
  const section3 = `### 3. 优化建议
- [防御性方案]：
${defensiveItems}
- [降本增效]：
${costItems}`;

  // §4 深度解析 — AI 生成文本（确保有标题前缀）
  const section4 = section4Text.includes("### 4")
    ? section4Text.trim()
    : `### 4. 深度解析\n\n${section4Text.trim()}`;

  // §5 混沌测试 — 模板硬渲染
  const section5 = `### 5. 混沌测试：缺失降级兜底的模块\n\n${renderChaosSection(chaosResults)}`;

  return [section1, "", section2, "", section3, "", section4, "", section5].join(
    "\n"
  );
}
