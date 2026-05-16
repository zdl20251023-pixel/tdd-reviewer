### 1. 方案评估
- [架构逻辑]：AICoachStrategySolver 误用 Snowflake ID 作为隔离手段，导致多个并发请求对 table_Type 共享对象在 convertGameHandToAiRequest 阶段进行非法写操作。
- [技术选型]：AI_Advice_Pipeline 采用 Promise.race 实现超时控制却未配套 AbortController，导致业务层报错后底层 socket 连接持续占用，触发连接池伪溢出。
- [状态流转]：LLM_Orchestrator 依赖内存 Context Window 存储 game_hand 状态，缺乏持久化导致 Session 抖动后牌谱流转中断；NLToHandConverter 的 post-parse 修复逻辑允许直接篡改原子属性，结算守恒校验存在逻辑漏洞。

### 2. 潜在风险 (P0 级，严控 4 条)

- 致命漏洞：AICoachStrategySolver 误将 Snowflake ID 作为隔离机制导致 aiService 连接池请求污染
  - 触发路径：并发调用 getPokerDecision -> Snowflake 仅产生唯一标识而非互斥锁 -> 共享组件 table_Type 被多个线程在 convertGameHandToAiRequest 阶段并发读写 -> getAiReqData(table) 获取到被篡改的中间态数据 -> 发送错误的 AIHandData 至 C++ 引擎导致策略崩坏
  - 降维剖析：内存池
  - 防御方案：废弃 Snowflake ID 作为隔离手段的错误实现，对 table_Type 实施 Request-scoped 副本隔离或 Immutable 转换。
- 致命漏洞：NLToHandConverter 的 post-parse 修复逻辑与结算守恒机制存在状态伪造风险
  - 触发路径：LLM 输出逻辑矛盾的 LatestHandType JSON -> 绕过 Zod 校验 -> post-parse 修复机制强制覆盖内存状态 -> hand_simulator 无法识别语义层面的虚假盈利 -> 最终生成错误的结算信息 JSON 写入持久化层
  - 降维剖析：状态同步
  - 防御方案：引入基于规则引擎的“单向不可逆”模拟审计逻辑，禁止在修复层直接修改影响结算的原子属性。
- 致命漏洞：AI_Advice_Pipeline 的 Promise.race 竞争导致连接池伪溢出
  - 触发路径：高并发下 aiService.getPokerDecision 响应延迟超过 AI_TIMEOUT -> AI_Advice_Pipeline 触发 Promise.race 超时逻辑 -> 业务层抛错但底层连接未释放 -> aiService 连接池被僵尸连接占满 -> 全局 AI 调度瘫痪
  - 降维剖析：内存池
  - 防御方案：引入 AbortController 并在超时后显式调用底层连接的释放或中断逻辑。
- 致命漏洞：AICoachStrategySolver响应端反向防腐层缺失导致数据污染
  - 触发路径：C++策略引擎返回非标准数值（如Infinity或异常精度浮点数）-> AICoachStrategySolver未经校验直接透传回业务层 -> 前端状态管理器处理非法数据导致UI渲染崩溃
  - 降维剖析：状态同步
  - 防御方案：在策略引擎返回结果后强制执行结构化Schema校验（如Zod），对EV和策略分布分布进行数值区间约束。

### 3. 优化建议
- [防御性方案]：
    - 废弃 Snowflake ID 隔离机制，对 table_Type 实施 Request-scoped 副本隔离或 Immutable 转换。
    - 在 AI_Advice_Pipeline 接入 AbortController，确保超时后显式关闭底层 TCP 连接。
    - 引入 Redis 对 nl_to_hand 产生的合法牌谱进行持久化，通过 SessionID 实现断线重连后的状态寻址。
    - 在策略引擎响应端强制执行 Zod Schema 校验，拦截 C++ 引擎产生的非标数值（如 Infinity）以保护前端 UI。
- [降本增效]：
    - 在发送至 LLM 的 LatestHandType 中剔除 name、avatar 等非算力必需字段，实施精简化 Token 策略。
    - 引入基于牌桌 Texture 的语义缓存中间件，对高频出现的牌局状态实施 AI 决策缓存，降低后端 C++ 引擎负载。

### 4. 深度解析

- [底层原理]：`LatestHandType` 到 `AIHandData` 的转换是系统的核心风险点。此过程本质是将一个声明式的、基于事件日志（`hand.actions`）的数据结构，强行重建成一个命令式的、包含大量运行时状态（`currentPlayerIndex`, `curBet`）的内存快照。P0 漏洞“AICoachStrategySolver 误将 Snowflake ID 作为隔离机制”揭示，系统在并发场景下复用了一个可变的 `table_Type` 实例作为中间态，导致多个请求在 `convertGameHandToAiRequest` 阶段互相污染数据。Snowflake ID 仅保证了请求标识唯一，无法为内存中共享的 `table_Type` 对象提供任何互斥或隔离，这是一个根本性的设计谬误。

- [底层逻辑映射]：
    1.  **状态同步 (State Synchronization) 模型错位**：整个 `nl_to_hand` 流程是一个典型的“状态同步”模型。`LatestHandType` 中的 `actions` 数组是客户端（LLM）发来的操作指令集（`Cmd[]`），而 `hand_simulator` 是权威服务器（Authoritative Server），其职责是基于初始状态和指令集，独立推演出唯一的、可信的最终状态。P0 漏洞“post-parse 修复逻辑存在状态伪造风险”表明，系统的权威边界被前置侵犯了。`post-parse` 修复阶段直接修改内存状态，相当于在指令集送达权威服务器前，就对其进行了中间人篡改，破坏了模拟推演的纯粹性。此外，前端基于 `tool-call` 的“提前预渲染”是典型的“客户端表现预测（Client-side Prediction）”，但该机制缺失了状态同步模型中最关键的“状态回滚（Rollback）”设计。一旦 `hand_simulator` 拒绝了 `LatestHandType`，前端没有机制回滚到上一个合法状态，导致渲染卡死。

    2.  **内存池 (Memory Pool) 资源管理滥用**：系统的 `AICoachStrategySolver` 和 `AI_Advice_Pipeline` 模块暴露出严重的资源管理问题，可映射为“内存池”的错误使用。P0 漏洞中被并发污染的共享 `table_Type` 实例，等同于一个大小为 1 的、非线程安全的“对象池”，所有并发请求都在争抢并覆写这唯一的对象，导致数据损坏。正确做法是为每个请求分配独立的内存副本（Request-scoped 副本隔离）。同时，P0 漏洞“Promise.race 竞争导致连接池伪溢出”是典型的资源池泄漏。`aiService.getPokerDecision` 调用从连接池“分配”了一个连接，`Promise.race` 超时后，上层逻辑放弃了等待，但并未“释放”底层的连接资源。这个被遗弃的连接变成了僵尸连接，最终耗尽整个 `aiService` 连接池。引入 `AbortController` 就是为这个异步分配的资源强制实现“回收（de-allocation）”机制。

### 5. 混沌测试：缺失降级兜底的模块

- [LLM_Orchestrator] 上下文/Session 突然丢失
  - 级联后果：LLM Context Window 中的牌局中间态 (game_hand) 丢失 -> 用户后续询问 '我该怎么打' 时，Orchestrator 无法找到已校验的牌谱数据 -> 违反 SOP 中 '必须先调用 nl_to_hand' 的约束 -> 系统要求用户重新输入牌局。
  - 建议：在内存状态机之外，应将 nl_to_hand 校验成功的 LatestHandType 持久化至缓存(如 Redis)，以便在 Session 抖动时能够通过 SessionID 找回状态。
- [DataBridgeConverter] 上游返回格式错误或空数据
  - 级联后果：nl_to_hand 产出的 LatestHandType 虽然通过校验，但关键字段(如 stack 或 actions)在映射至 AIHandData 时出现 null 值 -> convertGameHandToAiRequest 函数崩溃 -> 抛出类型转换异常 -> Coach Mode 链路中断。
  - 建议：在桥接函数 convertGameHandToAiRequest 中增加防御性编程，对缺失的非关键字段(如筹码深度)提供默认值计算逻辑(如默认 100BB)。