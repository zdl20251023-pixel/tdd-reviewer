import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { ChaosResultSchema, type Entity, type ChaosResult } from "../schemas";
import { config } from "../config";
import { withRetry } from "../utils/retry";
import { smartTruncate } from "../utils/truncate";
import type { TokenTracker } from "../utils/token-tracker";

/** System 4: 混沌注入系统 — Query: 所有实体 */
export async function runChaosInjectionSystem(
  entities: Entity[],
  tddContent: string,
  tracker: TokenTracker
): Promise<ChaosResult[]> {
  console.log(
    `   -> [System:ChaosInjection] 对 ${entities.length} 个实体注入故障场景`
  );

  // P1-2 改进：智能截断替代硬编码 slice
  const truncatedContent = smartTruncate(tddContent, config.contextMaxTokens);

  return withRetry(
    async () => {
      // @ts-ignore
      const { object, usage } = await generateObject({
        model: google(config.models.analysis),
        system: `你是一个混沌工程师。针对传入的系统模块，对每个模块注入以下故障场景并推演后果链：
1. AI/第三方接口超时 10 秒
2. 并发写入同一资源冲突
3. 上下文/Session 突然丢失
4. 上游返回格式错误或空数据

重点关注：系统当前设计是否有降级容灾兜底？如果没有，后果是什么？
必须基于传入的原文摘录和组件数据进行推演，不要凭空想象。`,
        prompt: `【系统模块】:\n${JSON.stringify(
          entities,
          null,
          2
        )}\n\n【原始TDD摘要】:\n${truncatedContent}`,
        schema: z.object({ chaosResults: z.array(ChaosResultSchema) }),
      });
      tracker.record("Phase2:ChaosInjection", usage);
      return object.chaosResults;
    },
    "System:ChaosInjection",
    config.retry.maxAttempts,
    config.retry.backoffMs
  );
}
