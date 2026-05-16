import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { VulnerabilitySchema, type Entity, type Vulnerability } from "../schemas";
import { config } from "../config";
import { withRetry } from "../utils/retry";
import type { TokenTracker } from "../utils/token-tracker";

/** System 2: AI 非确定性污染系统 — Query: ai.involved && state.involved */
export async function runAiStateSystem(
  entities: Entity[],
  tracker: TokenTracker
): Promise<Vulnerability[]> {
  const targets = entities.filter(
    (e) => e.components.ai.involved && e.components.state.involved
  );
  if (targets.length === 0) return [];
  console.log(`   -> [System:AiState] 命中 ${targets.length} 个实体`);

  return withRetry(
    async () => {
      // @ts-ignore
      const { object, usage } = await generateObject({
        model: google(config.models.analysis),
        system: `你是一个冷酷苛刻的架构师，专精 AI 系统的防腐层审计。
针对传入的模块（每个模块附带了原文摘录、AI 组件详情和状态组件详情），寻找：
- AI 非确定性输出（幻觉、截断、格式错误）如何直接污染具体的数据库/缓存状态
- 重点审查 hasAntiCorruptionLayer=false 的模块
- 必须引用模块中的具体代码实体/接口名
严格以 P0/P1 级别输出。`,
        prompt: JSON.stringify(targets, null, 2),
        schema: z.object({ vulnerabilities: z.array(VulnerabilitySchema) }),
      });
      tracker.record("Phase2:AiState", usage);
      return object.vulnerabilities;
    },
    "System:AiState",
    config.retry.maxAttempts,
    config.retry.backoffMs
  );
}
