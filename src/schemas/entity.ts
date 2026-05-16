import { z } from "zod";

/**
 * P2-2 改进：类型导出
 * Component 不再是布尔开关，而是携带具体数据的结构体
 */

export const StateComponentSchema = z.object({
  involved: z.boolean().describe("是否涉及状态变更"),
  storageType: z
    .string()
    .optional()
    .describe("存储类型：Redis / PostgreSQL / 内存 / 文件 / 无"),
  consistencyLevel: z
    .string()
    .optional()
    .describe("一致性要求：强一致 / 最终一致 / 无要求"),
  mutationPoints: z
    .array(z.string())
    .optional()
    .describe("具体的状态变更点列表，如：写入用户表、更新缓存键 xxx"),
});

export const AIComponentSchema = z.object({
  involved: z.boolean().describe("是否涉及 AI/LLM 调用"),
  modelCalls: z.number().optional().describe("该模块中 LLM 调用次数"),
  hasAntiCorruptionLayer: z
    .boolean()
    .optional()
    .describe("AI 输出是否有 Schema 校验或防腐层包裹"),
  contextAssembly: z
    .string()
    .optional()
    .describe("上下文组装方式描述，如：拼接历史消息 + System Prompt"),
  nonDeterministicRisks: z
    .array(z.string())
    .optional()
    .describe("已知的非确定性风险点，如：幻觉、截断、格式不符"),
});

export const ConcurrencyComponentSchema = z.object({
  involved: z.boolean().describe("是否面临并发场景"),
  entryPoints: z
    .array(z.string())
    .optional()
    .describe("并发入口列表，如：WebSocket 连接、HTTP API、定时任务"),
  isolationMechanism: z
    .string()
    .optional()
    .describe("当前隔离机制：分布式锁 / 队列 / Actor / Session隔离 / 无"),
  sharedResources: z
    .array(z.string())
    .optional()
    .describe("共享资源列表，如：连接池、Session 内存、全局状态"),
});

export const EntitySchema = z.object({
  id: z
    .string()
    .describe("该功能模块的唯一标识，如 UserLoginFlow / AICoachPipeline"),
  description: z.string().describe("该模块的具体业务逻辑描述（2-3句话）"),
  sourceExcerpt: z
    .string()
    .describe(
      "从原文中截取与该模块直接相关的原始段落，包括代码片段、时序描述、接口定义等关键细节。务必保留原文中的技术术语和变量名"
    ),
  components: z.object({
    state: StateComponentSchema,
    ai: AIComponentSchema,
    concurrency: ConcurrencyComponentSchema,
  }),
});

export type Entity = z.infer<typeof EntitySchema>;
export type StateComponent = z.infer<typeof StateComponentSchema>;
export type AIComponent = z.infer<typeof AIComponentSchema>;
export type ConcurrencyComponent = z.infer<typeof ConcurrencyComponentSchema>;
