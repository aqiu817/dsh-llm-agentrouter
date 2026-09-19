# dsh-llm-agentrouter

[![test](https://github.com/aqiu817/dsh-llm-agentrouter/actions/workflows/test.yml/badge.svg)](https://github.com/aqiu817/dsh-llm-agentrouter/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

![?](https://img.cdn1.vip/i/6aae264923a5d_1789797961.png)
本模组因该原因暂时停更。

把 AgentRouter 中转站接入 DeepSeek Harness 的 profile bundle：一条 provider 路由、五个模型及其推理档位，一个在「设置 → 插件」里切换国内 / 国际端点的开关，以及一层让出站请求符合该中转站要求的兼容处理。

## 它做了什么

| 组成 | 位置 | 职责 |
| --- | --- | --- |
| 路由声明 | `cordis.patch.yml` | 覆盖 `llm-pi-ai` 行，声明单条 `agentrouter` 路由，`baseURL` 指向一个哨兵主机 |
| 端点 + 请求兼容 | `lib/index.js` | 注册 `llm-agentrouter` 设置分节；把哨兵主机改写为所选端点，把 `user-agent` 换成该中转站要求的取值，按端点绕过进程代理直连，并给缺失 `required` 数组的工具 schema 补上空数组（部分上游池按 null 校验并拒绝） |
| 端点开关 | `lib/client.js` | 浏览器端插件，在「设置 → 插件」渲染国内 / 国际单选卡片 |
| 行为测试 | `test/` | 38 项：浏览器 bundle 6 项、bundle patch 8 项、改写语义 9 项（含 3 项 402 注释）、直连传输 10 项、工具 schema 补齐 3 项、活体流式 1 项、未经改写必被拒的反向对照 1 项 |

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
dsh plugin --profile web add file:/path/to/dsh-llm-agentrouter

# 2) 把它列入 bundle 顺序（编辑 ~/.dsh/profiles/web/package.json）
#    dsh.profile.bundles: [..., 'dsh-llm-agentrouter']
#    必须排在 @deepseek-ai/dsh-base 之后，其 llm-pi-ai 覆盖才生效

# 3) 存入中转站 key（同快速安装第 2 步）

# 4) 重启 host（同快速安装第 3 步）
```

源码安装务必用 `file:`（pnpm 复制）而非 `link:`：符号链接下 Node 沿真实路径解析，插件将找不到 `@deepseek-ai/schemastery` 等对等依赖。

## 端点切换

「设置 → 插件 → AgentRouter 中转站」是唯一入口：两个单选项，各自标注实际主机名，点选即写入，下一次请求生效。它写的是 `~/.dsh/settings.yaml`：

```yaml
llm-agentrouter:
  endpoint: cn   # 或 intl
```

无浏览器时直接编辑该文件即可，语义完全一致；没有设置服务的场景（headless、服务挂载之前）则回落到 bundle 里组合出的入口配置。

模型选择器里为何不能直接切？那个菜单不渲染任何子插槽，每个分组只显示 `displayName`，每个模型只显示名称与「适配器提供的描述」——而手工声明的 pi-ai 路由没有可填描述的字段。分组名是唯一可落笔处，但它是名字而不是告示，因此仍写作 `AgentRouter`；解释留在真正能改动它的地方。

## 国际端点

`agentrouter.org` 从本机直连不通。若要使用国际端点，启动 host 时给它一个出站代理：

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://<代理主机>:<端口> dsh web
```

`NODE_USE_ENV_PROXY=1` 是必需的：Node 22 的 `fetch` 默认忽略 `HTTPS_PROXY`，只有该开关才会启用 `EnvHttpProxyAgent`（目前仍标记为实验特性）。

**国内端点则相反，必须绕过代理。** 中转站的 WAF 会质询来自数据中心出口 IP 的请求（代理跳板正是这种出口），回一个 200 的 HTML 验证页而非 SSE 流——在 SDK 眼里就是一次莫名其妙的传输失败。因此围栏对被覆盖的端点自建了直连传输（`lib/direct-fetch.js`）：只要启动环境里存在代理变量，国内端点的请求就不再经过进程代理，默认行为，无需配置。国际端点不受影响，仍然走代理。`directEndpoints: none` 可以关掉这个行为。

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

## 密钥安全

`apiKeyEnv` 是**引用**，密钥存在 `~/.dsh/.credentials.yaml` 或环境变量中，适配器按请求解析。

**不要把密钥写进 `headers`。** 该字典会被适配器的 `describe()` 原样返回并渲染进设置界面——这是上游 README 明确记录的已知限制。

## 已知边界

- **图片输入未声明。** 路由是 `defaultInput: [text]`。探测中转站的图片请求得到超时与 Bedrock 429，未能确认，因此按保守一侧声明：少声明的代价是一次点名该模型的拒绝，多声明的代价是消息已持久化后再被提供方拒绝，会话将不断重试一个不可能成功的请求。
- **这层兼容处理是进程级的全局替换。** 它按主机分派，对其他主机零影响；但同一进程内若有另一个包装层在它之后安装，卸载时本插件会主动让位，不去夺回全局。
- **一条凭据服务两个端点。** 因为它们是同一个中转站账号。若两个端点日后使用不同账号，需要拆回两条路由。
- **浏览器 bundle 是手写的。** 生成它的 `clientBundle` tsdown 预设未发布，所以 `lib/client.js` 直接以加载器的 lazy-CJS 工厂格式写成，样式类名自带前缀而非 CSS module 哈希。测试因此覆盖了通常由构建保证的部分：注册协议、所需模块说明符、两份词典的键一致性。
- **端点切换不影响进行中的请求。** 它在下一次 `fetch` 生效；正在流式返回的那一轮仍走旧端点。
- **模型选择器里既不能切换，也不作提示。** 见上文；若上游日后给模型条目加上适配器可填的描述字段，或给该菜单开出子插槽，端点状态才可能显示在贴近选择的位置。
- **Claude / GPT 配额耗尽时以 402 呈现。** 中转站在 Claude / GPT 预算池额度用尽时返回 HTTP 402，且把 JSON 错误体错标成 `text/event-stream`。围栏识别这类响应：保留中转站原始错误信息，并追加 `quotaHint` 提示（默认「Claude / GPT 本批额度已用完，请等待下一批投放。」），让提供方 SDK 把它当作真正的 API 错误而非传输失败。

## 兼容性

本插件在 DSH 宿主进程内运行，`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-settings` 都由宿主提供。`dsh-settings` 声明为 `^0.1.2-rc.1` 的可选 peer——插件的设置分节走 `ctx.settings.installSection`，那是 0.1.2 才有的 API；其余两个保持**不限版本且可选**，用到的都是多个版本里稳定不变的部分，钉死版本只会在宿主升级时凭空造出一次安装失败。下表是已实测跑通的组合，供对照，不是下限：

| 依赖 | 已验证版本 |
| --- | --- |
| Node.js | 22 |
| DeepSeek Harness | 0.1.2-rc.1 |
| `@deepseek-ai/dsh-settings` | 0.1.2-rc.1 |
| `@deepseek-ai/cordis` | 4.0.2 |
| `@deepseek-ai/schemastery` | 3.18.2 |

浏览器端 bundle 面向宿主静态模块表提供的 React 18；卡片只用 `react` 与 `react/jsx-runtime`，不引入任何额外运行时依赖。

## 开发

```bash
npm ci        # 仅测试所需的 devDependencies
npm test      # 38 项
```

克隆后即可跑：38 项中 36 项完全离线，2 项活体测试在无 key 时自动跳过（空字符串等同于无 key——未配置的 GitHub Actions secret 正是以空串到达）。CI（`.github/workflows/test.yml`）跑的就是这一条命令；仓库若配置了 `AGENTROUTER_API_KEY` secret，那两项也会真跑。

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
