import { generateObject, generateText } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import type { Entity, Vulnerability, ChaosResult } from "../schemas";
import { config } from "../config";
import { withRetry } from "../utils/retry";
import { smartTruncate } from "../utils/truncate";
import type { TokenTracker } from "../utils/token-tracker";

/**
 * P0-2 改进：路线 A 改用 generateObject 结构化输出
 * 彻底消除正则解析的脆弱性
 */

// 路线 A 结构化输出 Schema
const SectionsASchema = z.object({
  section1_评估: z.object({
    架构逻辑: z
      .string()
      .describe("直接指出不合理处，引用具体模块名和接口名"),
    技术选型: z
      .string()
      .describe("直接指出性能/吞吐/效率短板"),
    状态流转: z
      .string()
      .describe("指出未闭环或存在歧义的数据流，引用具体的数据流转路径"),
  }),
  section3_优化: z.object({
    防御性方案: z
      .array(z.string())
      .describe("行业最佳实践的替代架构，针对 P0 漏洞给出对应方案"),
    降本增效: z
      .array(z.string())
      .describe("具体的 Token 控制或中间件优化策略"),
  }),
});

export type SectionsAResult = z.infer<typeof SectionsASchema>;

/**
 * 路线 A: 方案评估 + 优化建议（结构化输出，不需要 Few-Shot）
 */
export async function renderSectionsA(
  structuredContext: string,
  tracker: TokenTracker
): Promise<SectionsAResult> {
  return withRetry(
    async () => {
      // @ts-ignore - generateObject is deprecated in AI SDK v6, but fully functional
      const { object, usage } = await generateObject({
        model: google(config.models.rendering),
        system: `你是一个最终决策节点。像原始人一样回复，只说结果，不废话，不客套。严禁使用任何问候语。
基于传入的原始 TDD 文档、提取的系统实体、P0 漏洞列表和混沌测试结果，输出方案评估和优化建议。

方案评估要求：
- [架构逻辑]：直接指出不合理处，引用具体模块名和接口名。
- [技术选型]：直接指出性能/吞吐/效率短板。
- [状态流转]：指出未闭环或存在歧义的数据流，引用具体的数据流转路径。

优化建议要求：
- [防御性方案]：给出行业最佳实践的替代架构，必须针对传入的 P0 漏洞给出对应方案。
- [降本增效]：给出具体的 Token 控制或中间件优化策略。`,
        prompt: structuredContext,
        schema: SectionsASchema,
      });
      tracker.record("Phase3:SectionsA", usage);
      return object;
    },
    "Render:SectionsA",
    config.retry.maxAttempts,
    config.retry.backoffMs
  );
}

/**
 * 路线 B: 深度解析（注入 Few-Shot 样本，用更强模型）
 * P1-3 改进：使用 deepAnalysis 模型
 */
export async function renderSection4(
  structuredContext: string,
  fewShotExample: string,
  tracker: TokenTracker
): Promise<string> {
  // 构造 Few-Shot 消息序列
  const fewShotMessages: { role: "user" | "assistant"; content: string }[] =
    fewShotExample
      ? [
          {
            role: "user" as const,
            content:
              "请对这份技术设计文档进行深度解析，输出底层原理剖析和底层逻辑映射。",
          },
          {
            role: "assistant" as const,
            content:
              fewShotExample.match(/### 4\. 深度解析[\s\S]*$/)?.[0]?.trim() ||
              fewShotExample,
          },
        ]
      : [];

  return withRetry(
    async () => {
      const { text, usage } = await generateText({
        model: google(config.models.deepAnalysis),
        system: `你是一个首席技术架构师，负责撰写技术审查报告的"深度解析"章节。

## 你的写作风格要求（最高优先级）
1. 像原始人一样回复，只说结果，不废话，不客套。
2. 必须引用原始文档中的具体代码实体、接口名、变量名（如 session_manager、Healing Loop、nl_to_hand）。
3. 降维类比必须极其贴合业务场景，不要为了映射而映射。
   - 好的例子：将"前端提前渲染但后端可能拒绝"映射为"客户端表现预测（Client-side Prediction）缺少状态回滚（Rollback）"。
   - 差的例子：泛泛地说"这是一个状态机问题"或"类似计算着色器"。
4. [底层逻辑映射] 必须用至少 2 个不同的底层概念（状态机/行为树/ECS/帧同步/状态同步/渲染管线/内存池/AOI）进行深入对比剖析。每个映射都必须建立完整的类比关系（原文概念 → 底层概念 → 映射后的洞察），而不是一笔带过。

仅输出以下一个章节：

### 4. 深度解析
- [底层原理]：挑选方案中最易踩坑的核心技术点，剥开表层讲解底层机制。要像解剖一样逐层深入，不要停留在表面。
- [底层逻辑映射]：强制使用上述概念体系进行对比剖析。`,
        messages: [
          ...fewShotMessages,
          {
            role: "user" as const,
            content: `现在请基于以下全新的技术文档和审查数据，撰写深度解析章节。\n\n${structuredContext}`,
          },
        ],
      });
      tracker.record("Phase3:Section4(DeepAnalysis)", usage);
      return text;
    },
    "Render:Section4",
    config.retry.maxAttempts,
    config.retry.backoffMs
  );
}

/**
 * 构建供渲染管线使用的结构化上下文
 * P1-2 改进：使用 smartTruncate 替代硬编码 slice
 */
export function buildStructuredContext(
  tddContent: string,
  entities: Entity[],
  p0Vulnerabilities: Vulnerability[],
  chaosResults: ChaosResult[]
): string {
  const truncatedContent = smartTruncate(
    tddContent,
    config.renderContextMaxTokens
  );

  return `【原始 TDD 文档摘要】:
${truncatedContent}

【提取到的系统实体概况】:
${JSON.stringify(
  entities.map((e) => ({
    id: e.id,
    description: e.description,
    components: e.components,
  })),
  null,
  2
)}

【P0 漏洞列表】:
${JSON.stringify(p0Vulnerabilities, null, 2)}

【混沌测试结果（无降级兜底的模块）】:
${JSON.stringify(
  chaosResults.filter((c) => !c.hasGracefulDegradation),
  null,
  2
)}`;
}
