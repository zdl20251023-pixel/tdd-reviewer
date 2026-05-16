import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { EntitySchema, type Entity } from "../schemas";
import { config } from "../config";
import { withRetry } from "../utils/retry";
import { splitDocument } from "../utils/truncate";
import type { TokenTracker } from "../utils/token-tracker";

/**
 * P0-1 改进：双重提取 + 合并去重
 * 对长文档分段提取，短文档单次提取，最终按 entity.id 合并去重
 */
export async function extractEntities(
  tddContent: string,
  tracker: TokenTracker
): Promise<Entity[]> {
  const needsDualExtraction =
    tddContent.length > config.dualExtractionThreshold;

  if (needsDualExtraction) {
    console.log(
      `   📐 文档长度 ${tddContent.length} 字符，启用双重提取模式...`
    );
    const [firstHalf, secondHalf] = splitDocument(tddContent);

    const [resultA, resultB] = await Promise.all([
      extractFromSegment(firstHalf, "前半段", tracker),
      extractFromSegment(secondHalf, "后半段", tracker),
    ]);

    // 按 entity.id 合并去重，前半段优先
    const merged = mergeEntities(resultA, resultB);
    console.log(
      `   🔗 合并去重：前半段 ${resultA.length} + 后半段 ${resultB.length} → 合并后 ${merged.length} 个实体`
    );
    return merged;
  } else {
    return extractFromSegment(tddContent, "全文", tracker);
  }
}

async function extractFromSegment(
  content: string,
  label: string,
  tracker: TokenTracker
): Promise<Entity[]> {
  const result = await withRetry(
    async () => {
      // @ts-ignore - generateObject is deprecated in AI SDK v6, but fully functional
      const { object, usage } = await generateObject({
        model: google(config.models.extraction),
        system: `你是一个结构化提取器。阅读传入的 TDD 文档，执行以下步骤：

1. 拆解出核心的系统功能模块（Entity），每个模块应对应一个独立的业务流或技术组件
2. 为每个 Entity 的 components 填充详细数据（不是简单的 true/false，而是具体的存储类型、隔离机制、共享资源等）
3. 从原文中截取与该模块直接相关的段落作为 sourceExcerpt，必须保留代码片段、接口名、变量名等关键细节

不要做任何优劣评价，只做客观结构化提取。宁可多提取一个模块，也不要遗漏。`,
        prompt: content,
        schema: z.object({
          entities: z
            .array(EntitySchema)
            .describe("从文档中提取出的核心功能模块列表"),
        }),
      });
      tracker.record(`Phase1:Extract(${label})`, usage);
      return object.entities;
    },
    `EntityExtractor(${label})`,
    config.retry.maxAttempts,
    config.retry.backoffMs
  );
  return result;
}

/**
 * 按 entity.id 合并两组实体，id 相同时保留前半段的版本
 */
function mergeEntities(groupA: Entity[], groupB: Entity[]): Entity[] {
  const seenIds = new Set<string>();
  const merged: Entity[] = [];

  for (const entity of [...groupA, ...groupB]) {
    if (!seenIds.has(entity.id)) {
      seenIds.add(entity.id);
      merged.push(entity);
    }
  }
  return merged;
}
