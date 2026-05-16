import * as fs from "fs/promises";
import { config } from "./config";
import {
  extractEntities,
  runStateConcurrencySystem,
  runAiStateSystem,
  runAiConcurrencySystem,
  runChaosInjectionSystem,
  runAntiCorruptionAuditSystem,
} from "./systems";
import {
  renderSectionsA,
  renderSection4,
  buildStructuredContext,
  assembleDocument,
} from "./renderers";
import { deduplicateVulnerabilities, TokenTracker } from "./utils";

/**
 * ECS 审查管线主编排器
 * 整合所有改进：P0（双重提取+结构化渲染+重试）、P1（去重+智能截断+Token追踪）、P2（模块化）
 */
export async function runPipeline(): Promise<void> {
  console.log(
    "🚀 [System Start] 启动增强型 ECS 审查管线 v4 (Refactored)..."
  );

  const tracker = new TokenTracker();

  // 0. 读取原始 TDD 文档 + Few-Shot 样本
  const [tddContent, fewShotExample] = await Promise.all([
    fs.readFile(config.inputPath, "utf-8"),
    fs.readFile(config.fewShotPath, "utf-8").catch(() => ""),
  ]);
  if (!tddContent) throw new Error("输入文档为空");
  console.log(`📄 [I/O] 成功读取输入文档，长度: ${tddContent.length} chars`);
  if (fewShotExample) {
    console.log(
      `📎 [I/O] 加载 Few-Shot 样本成功，长度: ${fewShotExample.length} chars`
    );
  } else {
    console.log(`⚠️ [I/O] 未找到 Few-Shot 样本文件，将退化为无样本模式`);
  }

  // ==========================================
  // Phase 1: 实体提取系统 (Enhanced Entity Extractor)
  // P0-1 改进：双重提取 + 合并去重
  // ==========================================
  console.log("⚙️ [Phase 1] 运行 Enhanced Entity Extractor...");
  const entities = await extractEntities(tddContent, tracker);

  console.log(
    `✅ [Phase 1] 提取完成，共发现 ${entities.length} 个功能实体：`
  );
  entities.forEach((e) => {
    const tags = [
      e.components.state.involved && "State",
      e.components.ai.involved && "AI",
      e.components.concurrency.involved && "Concurrent",
    ].filter(Boolean);
    console.log(`   - ${e.id} [${tags.join("+")}]`);
  });

  // ==========================================
  // Phase 2: 并行交叉系统审查 (Parallel Check Systems)
  // 5 个 System 全部并行执行，无数据依赖
  // ==========================================
  console.log("⚔️ [Phase 2] 拉起 5 个并行 Check Systems...");
  const [
    stateConcurrencyVulns,
    aiStateVulns,
    aiConcurrencyVulns,
    chaosResults,
    antiCorruptionVulns,
  ] = await Promise.all([
    runStateConcurrencySystem(entities, tracker),
    runAiStateSystem(entities, tracker),
    runAiConcurrencySystem(entities, tracker),
    runChaosInjectionSystem(entities, tddContent, tracker),
    runAntiCorruptionAuditSystem(entities, tracker),
  ]);

  // 合并所有漏洞 → P1-1 去重 → 代码层硬过滤 P0
  const rawVulnerabilities = [
    ...stateConcurrencyVulns,
    ...aiStateVulns,
    ...aiConcurrencyVulns,
    ...antiCorruptionVulns,
  ];
  const dedupedVulnerabilities = deduplicateVulnerabilities(rawVulnerabilities);
  const p0Vulnerabilities = dedupedVulnerabilities
    .filter((v) => v.level === "P0")
    .slice(0, config.p0Limit);

  console.log(
    `✅ [Phase 2] 审查完成：${rawVulnerabilities.length} 个漏洞 → 去重后 ${dedupedVulnerabilities.length} 个 → P0 筛选 ${p0Vulnerabilities.length} 个，混沌测试 ${chaosResults.length} 个`
  );

  // ==========================================
  // Phase 3: 混合渲染管线 (Structured + Few-Shot Enhanced)
  // P0-2 改进：路线 A 改用 generateObject（消除正则）
  // P1-3 改进：路线 B 使用更强模型
  // ==========================================
  console.log("🔨 [Phase 3] 启动结构化混合渲染管线...");

  const structuredContext = buildStructuredContext(
    tddContent,
    entities,
    p0Vulnerabilities,
    chaosResults
  );

  // 两路并行 AI 调用
  const [sectionsA, section4Text] = await Promise.all([
    renderSectionsA(structuredContext, tracker),
    renderSection4(structuredContext, fewShotExample, tracker),
  ]);

  console.log("✅ [Phase 3] 两路渲染完成。");

  // 组装最终文档（P0-2：不再依赖正则解析）
  const finalMarkdown = assembleDocument(
    sectionsA,
    p0Vulnerabilities,
    section4Text,
    chaosResults
  );

  // 4. 写入文件
  await fs.writeFile(config.outputPath, finalMarkdown, "utf-8");
  console.log(`🎉 [I/O] 增强型 ECS 审查报告已写入至: ${config.outputPath}`);

  // P1-4 改进：输出 Token 用量汇总
  tracker.printSummary();
}
