# dsh-llm-agentrouter

[![test](https://github.com/aqiu817/dsh-llm-agentrouter/actions/workflows/test.yml/badge.svg)](https://github.com/aqiu817/dsh-llm-agentrouter/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

![?](https://img.cdn1.vip/i/6aae264923a5d_1789797961.png)
本模组曾因中转站渠道进入 probation、上游校验不一致而暂停更新。**2.1.0 起恢复维护**：出站请求已能同时满足当前全部上游池（围栏新增直连传输绕过 WAF 质询、工具 schema 补齐 `required`、声明 DeepSeek 思考协议，见下文与致谢）。

把 AgentRouter 中转站接入 DeepSeek Harness 的 profile bundle：一条 provider 路由、五个模型及其推理档位，一个在「设置 → 插件」里切换国内 / 国际端点的开关，以及一层让出站请求符合该中转站要求的兼容处理。

## 它做了什么

| 组成 | 位置 | 职责 |
| --- | --- | --- |
| 路由声明 | `cordis.patch.yml` | 覆盖 `llm-pi-ai` 行，声明单条 `agentrouter` 路由，`baseURL` 指向一个哨兵主机 |
| 端点 + 请求兼容 | `lib/index.js` | 注册 `llm-agentrouter` 设置分节；把哨兵主机改写为所选端点，把 `user-agent` 换成该中转站要求的取值，按端点绕过进程代理直连，并给缺失 `required` 数组的工具 schema 补上空数组（部分上游池按 null 校验并拒绝） |
| 路由自愈 | `lib/route.js` | 路由的运行时副本。profile 自己的补丁层会整体覆盖 `llm-pi-ai.providers`（见「桌面端支持」），围栏据此把这条路由重新声明回去 |
| 端点开关 + 重试开关 | `lib/client.js` | 注册「插件」页里的 AgentRouter 卡片：端点分段控件、静默重试开关、最大尝试次数。设置数据由宿主 `settings.describe` 提供，写入走 `configForms` 的 `mutate` |
| 行为测试 | `test/` | 65 项：浏览器 bundle 5 项、bundle patch 8 项、改写语义 9 项（含 3 项 402 注释）、直连传输 10 项、工具 schema 补齐 3 项、静默重试 7 项、路由自愈 17 项、运行时路由与补丁一致 4 项、活体流式 2 项（无 key 时跳过） |

## 为什么是一条路由，而不是两条

中转站在国内与国际两个源站上提供同样的模型，差别只在 origin。曾经每个端点各声明一条路由，代价是模型选择器里每个模型出现两次，而「用哪个端点」这个与模型无关的选择，被迫在每次换模型时重做一遍。它不是模型属性，而是一项部署级设置——于是它成了本插件自己的设置分节，选择器里只留一个 AgentRouter 分组。

适配器读不到本插件的命名空间，所以路由的 `baseURL` 指向一个**故意不可解析**的哨兵主机（`.internal` 保留域），由围栏在出站时改写为所选端点。围栏本来就必须在请求路径上——见下一节——因此这没有引入新的机制。

本插件使用兼容方式支持了 AgentRouter 中转站请求。

## 当前版本所支持的模型与参数

| 模型 ID | 名称 | 上下文窗口 | 最大输出 | 推理强度（档位） | 备注 |
| --- | --- | --- | --- | --- | --- |
| `claude-opus-5` | Claude Opus 5 | 1,000,000 | 128,000 | off / low / medium / high / xhigh / max |  |
| `claude-opus-4-8` | Claude Opus 4.8 | 1,000,000 | 128,000 | off / low / medium / high / xhigh / max |  |
| `gpt-5.6-sol` | GPT 5.6 Sol | 272,000 | 128,000 | off / minimal / low / medium / high / xhigh / max |  |
| `gpt-6-astra` | GPT 6 Astra | 272,000 | 128,000 | off / minimal / low / medium / high / xhigh / max | 暂同 GPT 5.6 Sol——该模型上线时 Claude / GPT 预算池恰已耗尽（402），档位与上限未能活体验证，额度刷新后校订 |
| `deepseek-v4-flash` | DeepSeek V4 Flash | 1,000,000 | 256,000 | off / low / high / max | 档位对齐第一方目录；`off` 送出 `none` 而非留空 |

> 所有模型均走 `/v1/chat/completions`。两个端点的 `/v1/models` 返回同一组 ID。`maxTokens` 上限来自中转站返回值约束，上下文窗口以「大海捞针」实测为准。

## 安装

**从 npm 快速安装**（推荐）：

```bash
# 1) 装进 profile（本例为 web profile）
dsh plugin --profile web add dsh-llm-agentrouter

# 2) 存入中转站 key（不写进任何配置文件）
#    Web 的「模型」设置页可直接写入 ~/.dsh/.credentials.yaml，
#    或让 AGENTROUTER_API_KEY 存在于进程环境中

# 3) 重启 host。模型选择器里出现 AgentRouter 分组，
#    「设置 → 插件 → AgentRouter 中转站」出现端点开关
```

`dsh plugin add` 会从 npm 拉取 `dsh-llm-agentrouter`，并因包声明了 `dsh.bundle` 自动把它纳入 `dsh.profile.bundles` 层（排在 `@deepseek-ai/dsh-base` 之后，其 `llm-pi-ai` 覆盖才生效），无需手动编辑 `~/.dsh/profiles/web/package.json`。

**从源码安装**（开发或本地修改时）：

```bash
# 0) 取得源码
git clone https://github.com/aqiu817/dsh-llm-agentrouter.git

# 1) 装进 profile（本例为 web profile）
dsh plugin --profile web add link:/path/to/dsh-llm-agentrouter

# 2) 把它列入 bundle 顺序（编辑 ~/.dsh/profiles/web/package.json）
#    dsh.profile.bundles: [..., 'dsh-llm-agentrouter']
#    必须排在 @deepseek-ai/dsh-base 之后，其 llm-pi-ai 覆盖才生效

# 3) 存入中转站 key（同快速安装第 2 步）

# 4) 重启 host（同快速安装第 3 步）
```

源码安装建议用 `link:`（pnpm 符号链接），这样改源码立刻生效；`file:` 在 `nodeLinker: hoisted` 下是**复制**，改了源码不会传播，容易误以为修复没生效。两种方式都能解析对等依赖：本仓库自带 `node_modules/@deepseek-ai/schemastery`，符号链接下 Node 沿真实路径解析时正好落在它上面。

**桌面端**：profile 名是 `desktop`，安装命令相同，只是要用桌面端自带的 CLI（宿主对 `dsh --profile desktop` 直接拒绝，因为该 profile 由 Electron 应用独占管理）：

```bash
# Windows 默认安装位置；macOS 把路径换成 .app 内的同名 runtime
"$LOCALAPPDATA/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd" \
  plugin --profile desktop add dsh-llm-agentrouter
```

装完重启桌面端即可。桌面端 profile 自己声明了 provider，会覆盖掉本插件的路由，插件在启动时把它重新声明回去——见「桌面端支持」。

## 端点切换

入口是侧边栏「插件」页里的 **AgentRouter 中转站** 卡片（不是「设置 → 内置插件」，那里只有只读清单）：一个国内 / 国际分段控件、一个静默重试开关、一个最大尝试次数输入框，点「保存」写入。点开 `dsh-llm-agentrouter` 这张 bundle 卡片的详情页，同一个表单也出现在那里。

它写的是 **profile 的补丁文件**，即 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中本插件那一行：

```yaml
- id: llm-agentrouter
  name: dsh-llm-agentrouter
  config:
    endpoint: cn   # 或 intl
```

无浏览器时直接编辑该文件即可，语义完全一致。

**0.1.7 起设置页的注册方式**：0.1.2–0.1.5 的手绘卡片走浏览器端 `settingsScope` + `settings.plugin.item`，随上游移除这两个而退役。0.1.7 起 `settings.describe` 会为每个已激活 entry 报告一份表单，并带 `autoGenerate` 标志——但该标志的文档写明是「给从 schema 构建页面的客户端用」，而**当前发布的客户端没有一个这样做**。因此仅把 `endpoint` 标成 `.volatile()` 并不会让页面出现，浏览器半边必须像官方配套设置页那样显式注册。

「插件」页把一个 bundle 的配置分成三个插槽，光注册一个是不够的：`plugins.bundle.config` 按 **bundle 包名** 取键，画的是点开 bundle 卡片后的详情页；`plugins.row.config` 按 `<bundle>#<rowId>` 取键，画的是组件行的详情页；`plugins.item` 是列表插槽，会在「官方」组里额外造一张独立卡片。三者都经 `configForms.whileServed([SETTINGS_NS], …)` 守住命名空间，宿主没挂载 Host 半边时页面不出现。本版三个都注册。

表单控制器以**注入属性** `agentRouterForm` 到达组件，而不是取页面自带的 `form` 参数——`plugins.bundle.config` 根本不会传这个参数，注入一份控制器让三处挂载共用同一条代码路径。`settings.describe` 尚未回答时组件渲染「正在读取设置…」，避免对着 undefined 画控件。

volatile 字段在激活时以**引用单元**形态交给插件：设置写入原地更新单元而不重载 fiber，因此围栏每次请求都经 `resolveVolatile` 解包取当前值——「下一次请求生效」的语义不变，且切换无需任何重装。其余字段（endpoints/sentinel/userAgent/directEndpoints/announce）保持 shell/发布层管理，不在设置页暴露。

模型选择器里为何不能直接切？那个菜单不渲染任何子插槽，每个分组只显示 `displayName`，每个模型只显示名称与「适配器提供的描述」——而手工声明的 pi-ai 路由没有可填描述的字段。分组名是唯一可落笔处，但它是名字而不是告示，因此仍写作 `AgentRouter`；解释留在真正能改动它的地方。

## 国际端点

`agentrouter.org` 从本机直连不通。若要使用国际端点，启动 host 时给它一个出站代理：

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://<代理主机>:<端口> dsh web
```

`NODE_USE_ENV_PROXY=1` 是必需的：Node 22 的 `fetch` 默认忽略 `HTTPS_PROXY`，只有该开关才会启用 `EnvHttpProxyAgent`（目前仍标记为实验特性）。

**国内端点则相反，必须绕过代理。** 中转站的 WAF 会质询来自数据中心出口 IP 的请求（代理跳板正是这种出口），回一个 200 的 HTML 验证页而非 SSE 流——在 SDK 眼里就是一次莫名其妙的传输失败。因此围栏对被覆盖的端点自建了直连传输（`lib/direct-fetch.js`）：只要启动环境里存在代理变量，国内端点的请求就不再经过进程代理，默认行为，无需配置。国际端点不受影响，仍然走代理。`directEndpoints: none` 可以关掉这个行为。

## 静默重试

中转站把一个模型 ID 轮询到多个上游渠道，而这些渠道对「历史里的推理内容该怎么回传」要求不一致：DeepSeek 形态的渠道要求每条 assistant 消息带回 `reasoning_content`，Anthropic 形态的渠道要求 `content[].thinking`。同一个请求落到哪个渠道，就决定它被接受还是被拒——因此**同一次请求重发一遍，通常就能成功**。健康度不佳的渠道则直接回 5xx。

对 harness 而言这两类都是终局错误：默认可重试集合是 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`，**不含 `INVALID_REQUEST`**，而中转站把渠道方言拒绝报成普通 400，于是被归类为 `INVALID_REQUEST`，一次 400 就结束该轮对话。

这正是围栏而不是适配器承担这件事的原因：围栏已经握着序列化好的请求体，能原样重发**同一份字节**——失败属于抽到这个请求的渠道，不属于请求本身。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `silentRetry` | `false` | 打开后，围栏把中转站的瞬时拒绝（5xx，或正文匹配渠道方言的 400）自行重发，harness 只看到最终结果 |
| `silentRetryAttempts` | `3` | 单次请求的总发送次数上限（含首次），1–10 |

两个字段都标了 `.volatile()`，因此都在「设置 → 插件」页里，改完下一次请求即生效。

**默认关闭**，因为重发只对「中转站能重复服务的请求」免费，而把一个真正的 400 悄悄吞掉，是用一次莫名其妙的空回答换掉一条明确报错。判定刻意保守：只有正文命中 `must be passed back to the API` / `upstream rejected the request as invalid` / `null is not of type "array"` 这类渠道方言的 400 才会重发，其余 400 原样上抛；重发之间按 200ms 递增退避，请求被取消则立即停止并交回最后一个响应。

**正文读不出来时不重发、也不吞掉状态。** 若 400 的正文被截断或连接中途断开，围栏判定为「不可重试」并把原始响应原样交回——此时开关开与关的结果完全一致。这个开关存在的意义是隐藏中转站的渠道抖动，不是隐藏断掉的连接：连自己都没读到的正文，重发也无从判断；而吞掉状态码会把一个可诊断的 400 变成一句无信息的传输错误。这一条有回归测试钉住（`test/silent-retry.test.mjs`），用修复前的实现跑会失败。

## 桌面端支持

**桌面端（`desktop` profile）的 profile 补丁层会覆盖 `llm-pi-ai.providers`，从而抹掉本插件的路由。** 这不是本插件的 bug，而是加载器的补丁语义：profile 补丁在**所有** bundle 层之后应用，且一个补丁的 `config` 是**整体赋值**而非深合并——只深入一层，所以 `providers` 整个字典被替换。桌面端 profile 自己声明了 `rina` 等 provider，于是 `agentrouter` 这条路由随之消失，每次调用都以 `NO_ADAPTER` 失败。任何自建了第二个中转站的 profile 都有同样的问题（本机 `web` profile 就是如此）。

围栏把**自己这一条**路由合并回去：并入 profile 已有的 provider 字典（不动别人的，也不覆盖 profile 自己声明的同名路由）。合并发生在**配置解析期**，而不是往 entry 里写一次。

这不是实现偏好，是必须如此：宿主在启动后几秒会重新读取 profile 补丁文件并据其重建 entry（`dsh-hmr` 的 profile 监视），**一次性写入会被它原样抹掉**——而且是在第一轮请求已经成功之后，所以表面上完全看不出来。挂在解析链上的合并没有可被抹回的持久状态，因此长期有效。附带的一次性写入只用来触发一次早期解析：`llm-pi-ai` 属于 base bundle，激活早于本插件，插件到位时它已经注册完路由了。

已验证（0.2.0-rc.2 的 web 宿主，`patchReload: live`）：静态组合出的配置里 `relay.agentrouter.internal` 确实不存在；启动后路由恢复，并且在宿主的 profile 重建（约 2–4 秒）之后、以及启动 65 秒后仍然存在，`deepseek-v4-flash` 正常出流；profile 自己的 `rina` 路由全程保留；**profile 文件不被改写**，`cordis.patch.yml` 里仍然只有 profile 自己声明的东西。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `claimRoute` | `true` | 路由被 profile 补丁层挤掉时把它重新声明回去 |

默认开启，否则这个 bundle 恰恰在最需要它的 profile 里静默失效。设 `false` 的用途是：你打算自己管理这条路由，宁可看见冲突，也不希望它被在底下悄悄解决。`claimRoute` 与 `announce` 一样是普通字段，只在激活时读一次——在 profile 补丁里改它会重载 fiber 并重挂解析钩子，而这本来也是它唯一能起作用的时机。

## 配置

路由写在 `cordis.patch.yml` 里作为组合 base；用户层 `~/.dsh/settings.yaml` 的 `llm-pi-ai:` 分节按 provider 逐键合并，可覆盖单个字段或增删模型，下一次请求即生效。

插件自身的分节（`llm-agentrouter:`）全部字段：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `endpoint` | `cn` | 选中的端点键，`cn` 或 `intl`——端点开关写的就是它 |
| `endpoints` | `{cn: ps.air-outer.com, intl: agentrouter.org}` | 每个端点键对应的主机；源站搬迁是一次设置改动，不是一次发版 |
| `sentinel` | `relay.agentrouter.internal` | 路由 `baseURL` 中被改写的占位主机，必须保持不可解析 |
| `directEndpoints` | `cn` | 哪些端点绕过进程级代理（`HTTPS_PROXY` 等）直连中转站。中转站 WAF 会质询代理出口 IP，国内端点必须直连；`none` 关闭，`both` 两个端点都直连 |
| `userAgent` | 见 `lib/index.js` 中的默认值 | 送往中转站的 `User-Agent`。中转站将来若改钉另一个取值，只需改这里，不必改代码 |
| `announce` | `true` | 激活时在日志里报告一次已装的围栏 |
| `quotaHint` | `Claude / GPT 本批额度已用完，请等待下一批投放。` | 附加在 402 配额错误信息后的提示文案；空字符串关闭此功能 |
| `silentRetry` | `false` | 见「静默重试」 |
| `silentRetryAttempts` | `3` | 见「静默重试」 |
| `claimRoute` | `true` | 见「桌面端支持」 |


## 密钥安全

`apiKeyEnv` 是**引用**，密钥存在 `~/.dsh/.credentials.yaml` 或环境变量中，适配器按请求解析。

**不要把密钥写进 `headers`。** 该字典会被适配器的 `describe()` 原样返回并渲染进设置界面——这是上游 README 明确记录的已知限制。

## 已知边界

- **图片输入未声明。** 路由是 `defaultInput: [text]`。探测中转站的图片请求得到超时与 Bedrock 429，未能确认，因此按保守一侧声明：少声明的代价是一次点名该模型的拒绝，多声明的代价是消息已持久化后再被提供方拒绝，会话将不断重试一个不可能成功的请求。
- **这层兼容处理是进程级的全局替换。** 它按主机分派，对其他主机零影响；但同一进程内若有另一个包装层在它之后安装，卸载时本插件会主动让位，不去夺回全局。
- **一条凭据服务两个端点。** 因为它们是同一个中转站账号。若两个端点日后使用不同账号，需要拆回两条路由。
- **浏览器 bundle 是手写的。** 生成它的 `clientBundle` tsdown 预设未发布，所以 `lib/client.js` 直接以加载器的 lazy-CJS 工厂格式写成。测试因此覆盖了通常由构建保证的部分：注册协议、导出形状、以及「插件」页插槽的注册。
- **设置页只在宿主提供该命名空间时出现。** 页面通过 `configForms.whileServed(['llm-agentrouter'])` 注册，未组合宿主半边（或命名空间被禁用）的部署里不会出现这张卡片，也不会留下痕迹。
- **端点切换不影响进行中的请求。** 它在下一次 `fetch` 生效；正在流式返回的那一轮仍走旧端点。
- **模型选择器里既不能切换，也不作提示。** 见上文；若上游日后给模型条目加上适配器可填的描述字段，或给该菜单开出子插槽，端点状态才可能显示在贴近选择的位置。
- **Claude / GPT 配额耗尽时以 402 呈现。** 中转站在 Claude / GPT 预算池额度用尽时返回 HTTP 402，且把 JSON 错误体错标成 `text/event-stream`。围栏识别这类响应：保留中转站原始错误信息，并追加 `quotaHint` 提示（默认「Claude / GPT 本批额度已用完，请等待下一批投放。」），让提供方 SDK 把它当作真正的 API 错误而非传输失败。
- **静默重试不是重试策略。** 它只重发中转站自己的瞬时拒绝，靠的是「下一次抽到另一个渠道」；它不处理超时、限流、凭证错误，也不与 dsh 自己的 `llm-retry` 策略叠加。打开它并不改变 400 在 harness 里的分类，只是让这类 400 根本到不了 harness。
- **路由自愈只补自己这一条。** 它把 `agentrouter` 合并进 profile 已声明的 provider 字典，不重排、不删除、不改动别人的字段；如果 profile 把 `providers` 写成了非字典，它会报告 `unusable` 而不是覆盖掉——那是 profile 的问题，应当被看见。
- **桌面端仍受上游 profile 管理方式约束。** `desktop` profile 由 Electron 应用独占管理（宿主对 `dsh --profile desktop` 直接拒绝），自愈因此在进程内完成，不触碰任何磁盘文件；桌面端的 profile 补丁由应用自己维护，本插件不介入。

## 兼容性

本插件在 DSH 宿主进程内运行，`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 由宿主提供，保持**不限版本且可选**——用到的都是多个版本里稳定不变的部分，钉死版本只会在宿主升级时凭空造出一次安装失败。下表是已实测跑通的组合，供对照，不是下限：

| 依赖 | 已验证版本 |
| --- | --- |
| Node.js | 22 |
| DeepSeek Harness | 0.2.0-rc.2（含桌面端 Electron 运行时 0.2.0-rc.2） |
| `@deepseek-ai/cordis` | 4.0.2 |
| `@deepseek-ai/schemastery` | 3.18.4（devDependencies 与宿主对齐；`.volatile()` 在 3.18.2 上不存在） |

浏览器端 bundle 是宿主静态模块表的一员；它从 `react` 与 `@deepseek-ai/dsh-client-ui-primitives` 取渲染原语，二者都在宿主的平台 seed 表里，因此无需 `dsh.client.external` 声明。

### 版本与 dsh 的对应

| 插件版本 | 适配的 dsh | 说明 |
| --- | --- | --- |
| 2.4.0 | 0.2.x | 设置页显式注册到全部三个插槽（`plugins.bundle.config` / `plugins.row.config` / `plugins.item`）；端点 + 静默重试 + 尝试次数 |
| 2.3.0 | 0.1.7+ / 0.2.x | 静默重试开关 + 桌面端支持（profile 覆盖路由时自愈） |
| 2.2.1 | 0.1.7+ | 依赖 `autoGenerate` 自动页 + `.volatile()` 引用单元；宿主客户端不渲染 schema 自动页，故设置入口实际不可见 |
| 2.1.0 | 0.1.2 – 0.1.5 | 直连传输 + 工具 schema 补齐；宿主 0.1.5 移除 `settings.installSection` 后宿主半边静默失效 |
| 0.1.0 | 0.1.1 | 初版 |

## 开发

```bash
npm ci        # 仅测试所需的 devDependencies
npm test      # 64 项
```

`lib/route.js` 由 `cordis.patch.yml` 生成，不要手改：

```bash
node _gen-route.mjs
```

`test/route-parity.test.mjs` 会比对两者，改了一处而忘了重跑生成器会被测试拦下。

克隆后即可跑：64 项中 62 项完全离线，2 项活体测试在无 key 时自动跳过（空字符串等同于无 key——未配置的 GitHub Actions secret 正是以空串到达）。CI（`.github/workflows/test.yml`）跑的就是这一条命令；仓库若配置了 `AGENTROUTER_API_KEY` secret，那两项也会真跑。


活体测试需要一个可解析的 key，否则自动跳过——因此离线也能跑完整套。key 的来源，按优先级：

| 来源 | 说明 |
| --- | --- |
| `AGENTROUTER_API_KEY` 环境变量 | 在 CI 中用这一种（配置为仓库 secret） |
| `$DSH_HOME/.credentials.yaml` 的 `refs.AGENTROUTER_API_KEY` | dsh 模型设置页写入的位置 |

测试从不打印、记录或断言密钥本身。可用 `AGENTROUTER_ENDPOINT`（`cn`/`intl`）选择活体测试所用端点、`AGENTROUTER_HOST` 直接覆盖主机，用 `DSH_PI_AI_DIST` 指定 pi-ai 的 `dist` 路径（默认按 require 解析，再退回 Node 旁的 dsh 全局安装）。

## 致谢

- 感谢 [@dabai214109（大白）](https://github.com/dabai214109)——[PR #2](https://github.com/aqiu817/dsh-llm-agentrouter/pull/2) 独立定位并修复了两个上游池校验问题：出站工具 schema 缺失 `required` 数组被部分上游池以 `null is not of type "array"` 或「Upstream rejected the request as invalid」拒绝，以及 `deepseek-v4-flash` 的 DeepSeek 思考协议声明与 `reasoning_content` 多轮回放。本版本的工具 schema 补齐与模型 compat 声明均来自该 PR，相关行为测试（`test/tool-schema.test.mjs`、`test/patch.test.mjs`）同源。
- 感谢所有在 issue 与群里报告问题的用户，本版本对代理出口被中转站 WAF 质询导致断流的修复（围栏直连传输）源于这些现场证据。

## 贡献与许可

Issue 与 PR 都欢迎。改动请附带能说明意图的测试——本仓库的测试同时充当规格说明。

MIT，见 `LICENSE`。仓库中不含任何密钥、账号或本机绝对路径。
