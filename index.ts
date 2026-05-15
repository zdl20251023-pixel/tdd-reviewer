import { generateObject, generateText } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";

// 定义输入输出路径
const INPUT_PATH = path.resolve(__dirname, "input.md");
const OUTPUT_PATH = path.resolve(__dirname, "output.md");

// ==========================================
// ECS Types: 增强型结构定义
// ==========================================

// Component 不再是布尔开关，而是携带具体数据的结构体
const StateComponentSchema = z.object({
  involved: z.boolean().describe("是否涉及状态变更"),
  storageType: z.string().optional().describe("存储类型：Redis / PostgreSQL / 内存 / 文件 / 无"),
  consistencyLevel: z.string().optional().describe("一致性要求：强一致 / 最终一致 / 无要求"),
  mutationPoints: z.array(z.string()).optional().describe("具体的状态变更点列表，如：写入用户表、更新缓存键 xxx"),
});

const AIComponentSchema = z.object({
  involved: z.boolean().describe("是否涉及 AI/LLM 调用"),
  modelCalls: z.number().optional().describe("该模块中 LLM 调用次数"),
  hasAntiCorruptionLayer: z.boolean().optional().describe("AI 输出是否有 Schema 校验或防腐层包裹"),
  contextAssembly: z.string().optional().describe("上下文组装方式描述，如：拼接历史消息 + System Prompt"),
  nonDeterministicRisks: z.array(z.string()).optional().describe("已知的非确定性风险点，如：幻觉、截断、格式不符"),
});

const ConcurrencyComponentSchema = z.object({
  involved: z.boolean().describe("是否面临并发场景"),
  entryPoints: z.array(z.string()).optional().describe("并发入口列表，如：WebSocket 连接、HTTP API、定时任务"),
  isolationMechanism: z.string().optional().describe("当前隔离机制：分布式锁 / 队列 / Actor / Session隔离 / 无"),
  sharedResources: z.array(z.string()).optional().describe("共享资源列表，如：连接池、Session 内存、全局状态"),
});

const EntitySchema = z.object({
  id: z.string().describe("该功能模块的唯一标识，如 UserLoginFlow / AICoachPipeline"),
  description: z.string().describe("该模块的具体业务逻辑描述（2-3句话）"),
  sourceExcerpt: z.string().describe("从原文中截取与该模块直接相关的原始段落，包括代码片段、时序描述、接口定义等关键细节。务必保留原文中的技术术语和变量名"),
  components: z.object({
    state: StateComponentSchema,
    ai: AIComponentSchema,
    concurrency: ConcurrencyComponentSchema,
  }),
});

type Entity = z.infer<typeof EntitySchema>;

const VulnerabilitySchema = z.object({
  level: z.enum(["P0", "P1", "P2"]).describe("P0=致命架构漏洞 P1=高风险 P2=普通优化点"),
  title: z.string().describe("一句话标题，必须引用具体的代码实体/接口名，如：session_manager 的 RPC 复用导致脏数据污染"),
  triggerPath: z.string().describe("触发路径：从用户操作到故障发生的完整因果链"),
  underlyingConcept: z.string().describe("降维类比：强制映射为 状态机/行为树/ECS/帧同步/状态同步/渲染管线/内存池/AOI 中的一个概念进行剖析"),
  defensiveSuggestion: z.string().describe("一句话防御性方案"),
});

type Vulnerability = z.infer<typeof VulnerabilitySchema>;

const ChaosResultSchema = z.object({
  entityId: z.string().describe("被注入故障的实体 ID"),
  faultScenario: z.string().describe("注入的故障场景，如：AI 接口超时 10 秒"),
  cascadeEffect: z.string().describe("级联后果链：从故障点到最终用户可感知的影响"),
  hasGracefulDegradation: z.boolean().describe("当前设计是否有该故障的降级兜底"),
  recommendation: z.string().describe("如果没有降级方案，给出建议"),
});

type ChaosResult = z.infer<typeof ChaosResultSchema>;

// ==========================================
// System 函数定义
// ==========================================

/** System 1: 状态竞态系统 — Query: state.involved && concurrency.involved */
async function runStateConcurrencySystem(entities: Entity[]): Promise<Vulnerability[]> {
  const targets = entities.filter(e => e.components.state.involved && e.components.concurrency.involved);
  if (targets.length === 0) return [];
  console.log(`   -> [System:StateConcurrency] 命中 ${targets.length} 个实体`);

  const { object } = await generateObject({
    model: google("gemini-3-flash-preview"),
    system: `你是一个冷酷苛刻的架构师，专精并发竞态分析。
针对传入的模块（每个模块附带了原文摘录和详细的组件数据），寻找：
- 基于其具体的共享资源和隔离机制，推演脏数据回流、竞态条件、死锁
- 必须引用模块中的具体代码实体/接口名/变量名
- 不要泛泛而谈，不要输出"可能存在竞态"这种废话
严格以 P0/P1 级别输出。`,
    prompt: JSON.stringify(targets, null, 2),
    schema: z.object({ vulnerabilities: z.array(VulnerabilitySchema) }),
  });
  return object.vulnerabilities;
}

/** System 2: AI 非确定性污染系统 — Query: ai.involved && state.involved */
async function runAiStateSystem(entities: Entity[]): Promise<Vulnerability[]> {
  const targets = entities.filter(e => e.components.ai.involved && e.components.state.involved);
  if (targets.length === 0) return [];
  console.log(`   -> [System:AiState] 命中 ${targets.length} 个实体`);

  const { object } = await generateObject({
    model: google("gemini-3-flash-preview"),
    system: `你是一个冷酷苛刻的架构师，专精 AI 系统的防腐层审计。
针对传入的模块（每个模块附带了原文摘录、AI 组件详情和状态组件详情），寻找：
- AI 非确定性输出（幻觉、截断、格式错误）如何直接污染具体的数据库/缓存状态
- 重点审查 hasAntiCorruptionLayer=false 的模块
- 必须引用模块中的具体代码实体/接口名
严格以 P0/P1 级别输出。`,
    prompt: JSON.stringify(targets, null, 2),
    schema: z.object({ vulnerabilities: z.array(VulnerabilitySchema) }),
  });
  return object.vulnerabilities;
}

/** System 3: AI 资源耗尽系统 — Query: ai.involved && concurrency.involved */
async function runAiConcurrencySystem(entities: Entity[]): Promise<Vulnerability[]> {
  const targets = entities.filter(e => e.components.ai.involved && e.components.concurrency.involved);
  if (targets.length === 0) return [];
  console.log(`   -> [System:AiConcurrency] 命中 ${targets.length} 个实体`);

  const { object } = await generateObject({
    model: google("gemini-3-flash-preview"),
    system: `你是一个冷酷苛刻的架构师，专精高并发下的 AI 服务稳定性。
针对传入的模块（每个模块附带了原文摘录和详细的并发入口/共享资源数据），寻找：
- 高并发下 AI 接口限流、Token 超载、连接池耗尽的具体触发路径
- 基于模块的 entryPoints 和 sharedResources 推演雪崩效应
- 必须引用模块中的具体代码实体/接口名
严格以 P0/P1 级别输出。`,
    prompt: JSON.stringify(targets, null, 2),
    schema: z.object({ vulnerabilities: z.array(VulnerabilitySchema) }),
  });
  return object.vulnerabilities;
}

/** System 4: 混沌注入系统 — Query: 所有实体 */
async function runChaosInjectionSystem(entities: Entity[], tddContent: string): Promise<ChaosResult[]> {
  console.log(`   -> [System:ChaosInjection] 对 ${entities.length} 个实体注入故障场景`);

  const { object } = await generateObject({
    model: google("gemini-3-flash-preview"),
    system: `你是一个混沌工程师。针对传入的系统模块，对每个模块注入以下故障场景并推演后果链：
1. AI/第三方接口超时 10 秒
2. 并发写入同一资源冲突
3. 上下文/Session 突然丢失
4. 上游返回格式错误或空数据

重点关注：系统当前设计是否有降级容灾兜底？如果没有，后果是什么？
必须基于传入的原文摘录和组件数据进行推演，不要凭空想象。`,
    prompt: `【系统模块】:\n${JSON.stringify(entities, null, 2)}\n\n【原始TDD摘要】:\n${tddContent.slice(0, 3000)}`,
    schema: z.object({ chaosResults: z.array(ChaosResultSchema) }),
  });
  return object.chaosResults;
}

/** System 5: 防腐层审计系统 — Query: ai.involved */
async function runAntiCorruptionAuditSystem(entities: Entity[]): Promise<Vulnerability[]> {
  const targets = entities.filter(e => e.components.ai.involved);
  if (targets.length === 0) return [];
  console.log(`   -> [System:AntiCorruptionAudit] 审计 ${targets.length} 个 AI 实体的防腐层`);

  const { object } = await generateObject({
    model: google("gemini-3-flash-preview"),
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
  return object.vulnerabilities;
}

// ==========================================
// 渲染管线: 结构化数据 → Markdown（模板 + 轻量 AI 混合）
// ==========================================

function renderVulnerabilitiesSection(vulnerabilities: Vulnerability[]): string {
  if (vulnerabilities.length === 0) return "- 未发现 P0 级致命漏洞。\n";
  return vulnerabilities
    .map(v => `- 致命漏洞：${v.title}
  - 触发路径：${v.triggerPath}
  - 降维剖析：${v.underlyingConcept}
  - 防御方案：${v.defensiveSuggestion}`)
    .join("\n");
}

function renderChaosSection(chaosResults: ChaosResult[]): string {
  const unprotected = chaosResults.filter(c => !c.hasGracefulDegradation);
  if (unprotected.length === 0) return "- 所有模块均具备降级兜底机制。\n";
  return unprotected
    .slice(0, 3) // 只展示最严重的 3 个
    .map(c => `- [${c.entityId}] ${c.faultScenario}
  - 级联后果：${c.cascadeEffect}
  - 建议：${c.recommendation}`)
    .join("\n");
}

// ==========================================
// Main: ECS 审查管线入口
// ==========================================

async function main() {
  console.log("🚀 [System Start] 启动增强型 ECS 审查管线 v2...");

  try {
    // 0. 读取原始 TDD 文档
    const tddContent = await fs.readFile(INPUT_PATH, "utf-8");
    if (!tddContent) throw new Error("输入文档为空");
    console.log(`📄 [I/O] 成功读取输入文档，长度: ${tddContent.length} chars`);

    // ==========================================
    // Phase 1: 实体提取系统 (Entity Extractor System)
    // 增强：Component 携带具体数据 + sourceExcerpt 保留原文细节
    // ==========================================
    console.log("⚙️ [Phase 1] 运行 Enhanced Entity Extractor...");
    const { object: extractResult } = await generateObject({
      model: google("gemini-3-flash-preview"),
      system: `你是一个结构化提取器。阅读传入的 TDD 文档，执行以下步骤：

1. 拆解出核心的系统功能模块（Entity），每个模块应对应一个独立的业务流或技术组件
2. 为每个 Entity 的 components 填充详细数据（不是简单的 true/false，而是具体的存储类型、隔离机制、共享资源等）
3. 从原文中截取与该模块直接相关的段落作为 sourceExcerpt，必须保留代码片段、接口名、变量名等关键细节

不要做任何优劣评价，只做客观结构化提取。宁可多提取一个模块，也不要遗漏。`,
      prompt: tddContent,
      schema: z.object({
        entities: z.array(EntitySchema).describe("从文档中提取出的核心功能模块列表"),
      }),
    });

    const entities = extractResult.entities;
    console.log(`✅ [Phase 1] 提取完成，共发现 ${entities.length} 个功能实体：`);
    entities.forEach(e => {
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
      runStateConcurrencySystem(entities),
      runAiStateSystem(entities),
      runAiConcurrencySystem(entities),
      runChaosInjectionSystem(entities, tddContent),
      runAntiCorruptionAuditSystem(entities),
    ]);

    // 合并所有漏洞，代码层硬过滤
    const allVulnerabilities = [
      ...stateConcurrencyVulns,
      ...aiStateVulns,
      ...aiConcurrencyVulns,
      ...antiCorruptionVulns,
    ];
    const p0Vulnerabilities = allVulnerabilities
      .filter(v => v.level === "P0")
      .slice(0, 5);

    console.log(`✅ [Phase 2] 审查完成：${allVulnerabilities.length} 个漏洞，${p0Vulnerabilities.length} 个 P0，${chaosResults.length} 个混沌测试结果`);

    // ==========================================
    // Phase 3: 混合渲染管线
    // 结构化数据用模板渲染，评估和深度解析用轻量 AI 生成
    // ==========================================
    console.log("🔨 [Phase 3] 启动混合渲染管线...");

    // 3a. 方案评估 + 优化建议 + 深度解析 — 需要 AI 综合分析能力（传入原文 + 漏洞数据）
    const { text: aiGeneratedSections } = await generateText({
      model: google("gemini-3-flash-preview"),
      system: `你是一个最终决策节点。像原始人一样回复，只说结果，不废话，不客套。严禁使用任何问候语。
基于传入的原始 TDD 文档、提取的系统实体、P0 漏洞列表和混沌测试结果，输出以下 3 个章节（不要输出第 2 节，那个由模板渲染）：

### 1. 方案评估
- [架构逻辑]：直接指出不合理处，引用具体模块名和接口名。
- [技术选型]：直接指出性能/吞吐/效率短板。
- [状态流转]：指出未闭环或存在歧义的数据流，引用具体的数据流转路径。

### 3. 优化建议
- [防御性方案]：给出行业最佳实践的替代架构，必须针对传入的 P0 漏洞给出对应方案。
- [降本增效]：给出具体的 Token 控制或中间件优化策略。

### 4. 深度解析
- [底层原理]：挑选方案中最易踩坑的核心技术点，剥开表层讲解底层机制。
- [底层逻辑映射]：强制映射为 状态机/行为树/ECS/帧同步/状态同步/渲染管线/内存池/AOI 中的概念进行对比剖析。至少映射 2 个不同概念。`,
      prompt: `【原始 TDD 文档（前4000字）】:
${tddContent.slice(0, 4000)}

【提取到的系统实体概况】:
${JSON.stringify(entities.map(e => ({ id: e.id, description: e.description, components: e.components })), null, 2)}

【P0 漏洞列表】:
${JSON.stringify(p0Vulnerabilities, null, 2)}

【混沌测试结果（无降级兜底的模块）】:
${JSON.stringify(chaosResults.filter(c => !c.hasGracefulDegradation), null, 2)}`,
    });

    // 3b. 第 2 节 — 模板硬渲染（100% 格式可控）
    const section2 = `### 2. 潜在风险 (P0 级，严控 ${p0Vulnerabilities.length} 条)\n\n${renderVulnerabilitiesSection(p0Vulnerabilities)}`;

    // 3c. 混沌测试附录 — 模板硬渲染
    const chaosSection = `### 5. 混沌测试：缺失降级兜底的模块\n\n${renderChaosSection(chaosResults)}`;

    // 3d. 组装最终文档
    // 从 AI 生成的文本中拆分出第 1、3、4 节
    const finalMarkdown = assembleDocument(aiGeneratedSections, section2, chaosSection);

    // 4. 写入文件
    await fs.writeFile(OUTPUT_PATH, finalMarkdown, "utf-8");
    console.log(`🎉 [I/O] 增强型 ECS 审查报告已写入至: ${OUTPUT_PATH}`);
  } catch (error) {
    console.error("❌ [System Crash] 管线执行失败:", error);
    process.exit(1);
  }
}

/**
 * 组装最终文档：将 AI 生成的章节与模板渲染的章节按正确顺序拼接
 */
function assembleDocument(
  aiSections: string,
  section2: string,
  chaosSection: string,
): string {
  // 从 AI 输出中提取各章节
  const section1Match = aiSections.match(/### 1\. 方案评估[\s\S]*?(?=### [234]|$)/);
  const section3Match = aiSections.match(/### 3\. 优化建议[\s\S]*?(?=### [45]|$)/);
  const section4Match = aiSections.match(/### 4\. 深度解析[\s\S]*?$/);

  const section1 = section1Match?.[0]?.trim() || "### 1. 方案评估\n\n- 解析失败，请检查管线输出。";
  const section3 = section3Match?.[0]?.trim() || "### 3. 优化建议\n\n- 解析失败，请检查管线输出。";
  const section4 = section4Match?.[0]?.trim() || "### 4. 深度解析\n\n- 解析失败，请检查管线输出。";

  return [section1, "", section2, "", section3, "", section4, "", chaosSection].join("\n");
}

// 启动引擎
main();
