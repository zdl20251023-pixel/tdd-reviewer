import type { Vulnerability, ChaosResult } from "../schemas";
import { config } from "../config";

/**
 * §2 潜在风险 — 模板硬渲染（100% 格式可控）
 */
export function renderVulnerabilitiesSection(
  vulnerabilities: Vulnerability[]
): string {
  if (vulnerabilities.length === 0) return "- 未发现 P0 级致命漏洞。\n";
  return vulnerabilities
    .map(
      (v) => `- 致命漏洞：${v.title}
  - 触发路径：${v.triggerPath}
  - 降维剖析：${v.underlyingConcept}
  - 防御方案：${v.defensiveSuggestion}`
    )
    .join("\n");
}

/**
 * §5 混沌测试 — 模板硬渲染（100% 格式可控）
 */
export function renderChaosSection(chaosResults: ChaosResult[]): string {
  const unprotected = chaosResults.filter((c) => !c.hasGracefulDegradation);
  if (unprotected.length === 0) return "- 所有模块均具备降级兜底机制。\n";
  return unprotected
    .slice(0, config.chaosDisplayLimit)
    .map(
      (c) => `- [${c.entityId}] ${c.faultScenario}
  - 级联后果：${c.cascadeEffect}
  - 建议：${c.recommendation}`
    )
    .join("\n");
}
