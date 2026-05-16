import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { VulnerabilitySchema, type Entity, type Vulnerability } from "../schemas";
import { config } from "../config";
import { withRetry } from "../utils/retry";
import type { TokenTracker } from "../utils/token-tracker";

/** System 3: AI 资源耗尽系统 — Query: ai.involved && concurrency.involved */
export async function runAiConcurrencySystem(
  entities: Entity[],
  tracker: TokenTracker
): Promise<Vulnerability[]> {
  const targets = entities.filter(
    (e) => e.components.ai.involved && e.components.concurrency.involved
  );
  if (targets.length === 0) return [];
  console.log(`   -> [System:AiConcurrency] 命中 ${targets.length} 个实体`);

  return withRetry(
    async () => {
      // @ts-ignore
      const { object, usage } = await generateObject({
        model: google(config.models.analysis),
        system: `你是一个冷酷苛刻的架构师，专精高并发下的 AI 服务稳定性。
针对传入的模块（每个模块附带了原文摘录和详细的并发入口/共享资源数据），寻找：
- 高并发下 AI 接口限流、Token 超载、连接池耗尽的具体触发路径
- 基于模块的 entryPoints 和 sharedResources 推演雪崩效应
- 必须引用模块中的具体代码实体/接口名
严格以 P0/P1 级别输出。`,
        prompt: JSON.stringify(targets, null, 2),
        schema: z.object({ vulnerabilities: z.array(VulnerabilitySchema) }),
      });
      tracker.record("Phase2:AiConcurrency", usage);
      return object.vulnerabilities;
    },
    "System:AiConcurrency",
    config.retry.maxAttempts,
    config.retry.backoffMs
  );
}
