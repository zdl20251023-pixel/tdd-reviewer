import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { VulnerabilitySchema, type Entity, type Vulnerability } from "../schemas";
import { config } from "../config";
import { withRetry } from "../utils/retry";
import type { TokenTracker } from "../utils/token-tracker";

/** System 5: 防腐层审计系统 — Query: ai.involved */
export async function runAntiCorruptionAuditSystem(
  entities: Entity[],
  tracker: TokenTracker
): Promise<Vulnerability[]> {
  const targets = entities.filter((e) => e.components.ai.involved);
  if (targets.length === 0) return [];
  console.log(
    `   -> [System:AntiCorruptionAudit] 审计 ${targets.length} 个 AI 实体的防腐层`
  );

  return withRetry(
    async () => {
      const { object, usage } = await generateObject({
        model: google(config.models.analysis),
        system: `你是一个防腐层（Anti-Corruption Layer）专项审计师。
针对传入的 AI 模块，逐一检查：
1. AI 输出是否有 Schema 校验包裹？（检查 hasAntiCorruptionLayer 字段）
2. 如果校验失败，是否有降级路径？
3. AI 的 contextAssembly 方式是否存在上下文超限风险？
4. nonDeterministicRisks 中列出的风险是否都有对应的防御措施？

对于缺乏防腐层的模块，输出 P0 级漏洞。`,
        prompt: JSON.stringify(targets, null, 2),
        schema: z.object({ vulnerabilities: z.array(VulnerabilitySchema) }),
      });
      tracker.record("Phase2:AntiCorruptionAudit", usage);
      return object.vulnerabilities;
    },
    "System:AntiCorruptionAudit",
    config.retry.maxAttempts,
    config.retry.backoffMs
  );
}
