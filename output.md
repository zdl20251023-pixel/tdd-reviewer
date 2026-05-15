### 1. 方案评估
- [架构逻辑]：`LLMOrchestrator` 缺乏防腐层（ACL），用户指令可直接诱导模型绕过 `nl_to_hand` 校验逻辑，将非法数据直接注入 `PokerCoachAdviceTool`，架构存在越权风险。`NLToHandTool` 采用内存存储，服务重启或扩容会导致 Session 状态丢失，无法满足长对话复盘需求。
- [技术选型]：四层校验逻辑（尤其是 `hand_simulator` 动态推演）在 Node.js 主线程执行，高并发 SSE 请求下会造成事件循环阻塞，导致心跳超时和连接雪崩。`aiService` 缺少熔断与超时控制，后端 C++ 引擎慢响应会直接拖垮前端响应链。
- [状态流转]：`convertGameHandToAiRequest` 数据流转路径存在严重隐患，映射阶段引用了可变的 `table_Type` 对象，在并发环境下会导致 `AIHandData` 发生脏写。`hand_simulator` 的状态变更非原子性，校验失败后内存中的牌局状态无法回滚，造成状态机死锁。

### 2. 潜在风险 (P0 级，严控 5 条)

- 致命漏洞：convertGameHandToAiRequest 在 table_Type 映射阶段的共享引用导致 AIHandData 脏写
  - 触发路径：NLToHandTool 完成校验输出 LatestHandType JSON -> 多个并发请求进入 PokerCoachAdviceTool -> 异步调用 convertGameHandToAiRequest -> 若 table_Type 存在内存对象复用且未进行深拷贝 -> getAiReqData(table) 在组装 AIHandData 时读取到被后续请求覆盖的中间态数据 -> aiService.getPokerDecision 发送错误的牌局快照至 C++ 引擎 -> 返回错误的策略分布
  - 降维剖析：内存池
  - 防御方案：在 convertGameHandToAiRequest 转换入口强制执行 LatestHandType 到 table_Type 的深拷贝 (Deep Copy)，并利用 Snowflake ID 实现请求上下文的完全闭包隔离
- 致命漏洞：NLToHandTool 的 hand_simulator 内存状态在 post-parse 修复阶段缺乏事务原子性
  - 触发路径：AI 产生筹码深度幻觉 -> Zod 校验透传 -> post-parse 尝试对 LatestHandType 执行启发式修改 -> hand_simulator 执行动态推演导致内存状态变更 -> 最终结算守恒校验失败抛出异常 -> 内存中 Session 状态已处于中间态污染
  - 降维剖析：状态机
  - 防御方案：实施快照回滚机制，确保 LatestHandType 的所有 mutationPoints 仅在四层校验完整通过后才提交至 Session 主内存
- 致命漏洞：aiService.getPokerDecision 连接池耗尽导致的 SSE 响应链式崩溃
  - 触发路径：高并发 SSE 请求触发 LLMOrchestrator 指导分支 -> 强制调用 get_poker_coach_advice -> 密集执行 convertGameHandToAiRequest -> 大量异步请求涌入 aiService.getPokerDecision -> C++ AI 引擎连接池达到物理上限且无排队超时机制 -> SSE 句柄长时间挂起不释放 -> Node.js 事件循环句柄泄露 -> 服务整体 OOM 或拒绝连接。
  - 降维剖析：内存池
  - 防御方案：对 aiService.getPokerDecision 实施令牌桶限流并强制设置引擎侧 RequestTimeout。
- 致命漏洞：nl_to_hand 的四层校验逻辑在高并发下引发的 CPU 调度饥饿
  - 触发路径：用户通过 HTTP API/SSE 输入复杂非法牌谱 -> NLToHandTool 触发 Zod 校验与 hand_simulator 动态推演 -> 四层校验（尤其是结算守恒）涉及大量数值计算与状态回溯 -> 多路 SSE 并发请求同时执行密集计算 -> 阻塞 Node.js 主线程单线程循环 -> LLM 响应心跳超时 -> 连接大量重连进一步加剧 CPU 负载（雪崩）。
  - 降维剖析：帧同步
  - 防御方案：将 hand_simulator 的校验逻辑卸载至独立 Worker Threads 或微服务，通过消息队列解耦计算压力。
- 致命漏洞：LLMOrchestrator 缺乏防腐层导致业务路由逻辑发生指令劫持
  - 触发路径：用户输入特定指令诱导 -> LLM 编排层由于无 ACL 校验直接解析意图 -> 绕过 nl_to_hand 的牌谱校验环节 -> 下游接口接收到未经验证的非法数据导致逻辑崩溃
  - 降维剖析：状态机
  - 防御方案：为编排层引入基于 JSON Schema 的意图识别校验层，强制断言路由结果必须包含合法的 Tool Call 序列。

### 3. 优化建议
- [防御性方案]：
    - **隔离执行**：将 `hand_simulator` 校验逻辑移入 `Worker Threads`，避免阻塞主线程。
    - **快照机制**：针对 P0 级状态污染，在 `nl_to_hand` 执行前对 `LatestHandType` 进行深拷贝，校验全通过后再提交 `commit` 到 Session。
    - **流量整形**：在 `aiService.getPokerDecision` 前端挂载令牌桶限流器，并为 C++ 引擎调用设置 5s 硬超时。
    - **意图强校验**：为 `LLMOrchestrator` 增加 JSON Schema 断言，强制要求 `Coach Mode` 必须前置 `nl_to_hand` 的成功标识。
- [降本增效]：将校验通过的结构化 JSON 持久化至 Redis 缓存，减少大模型重复解析非结构化文本的 Token 消耗；使用请求 ID 绑定上下文，避免在 SSE 链路中传递冗余的牌谱全集。

### 4. 深度解析
- [底层原理]：核心痛点在于**竞态条件下的对象生命周期管理**。当多个 SSE 请求共享同一个 `table_Type` 映射逻辑时，异步非阻塞模型由于缺乏互斥锁，会导致指针级或引用级的覆盖。此外，德州扑克的状态推演是强一致性逻辑，任何中间态的非法修改若不具备“回滚（Rollback）”能力，都会导致后续状态转换序列彻底失效。
- [底层逻辑映射]：
    - **内存池 (Memory Pool)**：将 `table_Type` 视为待分配的缓冲区，必须实现**请求级隔离**（Request-Scoped Isolation），模仿内存池的分页保护机制，禁止跨请求写操作。
    - **状态机 (State Machine)**：牌谱推演本质是**确定性有限自动机（DFA）**。当前的校验失败污染问题，是由于状态转移函数没有遵循“事务原子性”，应参考**写时复制（Copy-on-Write）**策略，在临时状态机上推演，成功后再更新主状态机指针。

### 5. 混沌测试：缺失降级兜底的模块

- [PokerCoachAdviceTool] AI 接口超时 10 秒
  - 级联后果：调用 aiService.getPokerDecision 时阻塞 -> SSE 流式交互长时间无响应 -> 用户前端 UI 转圈超时 -> 最终返回 504 错误或 AI 引擎连接池资源耗尽导致后续请求全部堆积。
  - 建议：在 aiService 调用层设置严格的超时阈值（如 5s），并在超时发生时降级为‘AI 思考中，请稍后再试’或返回基于 LLM 生成的基础策略建议而非 C++ 引擎解算。
- [LLMOrchestrator] 并发写入同一资源冲突
  - 级联后果：用户在 SSE 流尚未结束时连续发送指令 -> 多个线程尝试同时读写内存中的‘Session 状态’ -> 导致牌谱状态（LatestHandType）出现竞争条件 -> 下一步调用工具时使用了被破坏的中间态数据。
  - 建议：引入基于 SessionId 的 Redis 分布式锁或请求队列，确保同一会话内的请求串行处理，防止内存状态并发污染。
- [NLToHandTool] 上下文/Session 突然丢失
  - 级联后果：用户描述牌局后，由于内存存储（storageType: 内存）丢失 -> 第二步调用 get_poker_coach_advice 时找不到校验过的 LatestHandType -> 系统提示‘找不到相关牌局’ -> 用户体验中断。
  - 建议：将‘守门员’校验通过后的合法牌谱 JSON 持久化到 Redis 或数据库，而非仅保留在内存中，以支持无状态服务的横向扩展与故障恢复。