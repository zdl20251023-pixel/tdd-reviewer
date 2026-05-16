import { z } from "zod";

export const ChaosResultSchema = z.object({
  entityId: z.string().describe("被注入故障的实体 ID"),
  faultScenario: z.string().describe("注入的故障场景，如：AI 接口超时 10 秒"),
  cascadeEffect: z
    .string()
    .describe("级联后果链：从故障点到最终用户可感知的影响"),
  hasGracefulDegradation: z
    .boolean()
    .describe("当前设计是否有该故障的降级兜底"),
  recommendation: z.string().describe("如果没有降级方案，给出建议"),
});

export type ChaosResult = z.infer<typeof ChaosResultSchema>;
