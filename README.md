# dsh-llm-agentrouter

[![test](https://github.com/aqiu817/dsh-llm-agentrouter/actions/workflows/test.yml/badge.svg)](https://github.com/aqiu817/dsh-llm-agentrouter/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

把 AgentRouter 中转站接入 DeepSeek Harness 的 profile bundle：一条 provider 路由、三个模型及其推理档位，一个在「设置 → 插件」里切换国内 / 国际端点的开关，以及一层让出站请求符合该中转站要求的兼容处理。

## 它做了什么

| 组成 | 位置 | 职责 |
| --- | --- | --- |
| 路由声明 | `cordis.patch.yml` | 覆盖 `llm-pi-ai` 行，声明单条 `agentrouter` 路由，`baseURL` 指向一个哨兵主机 |
| 端点 + 请求兼容 | `lib/index.js` | 注册 `llm-agentrouter` 设置分节；把哨兵主机改写为所选端点，并把 `user-agent` 换成该中转站要求的取值 |
| 端点开关 | `lib/client.js` | 浏览器端插件，在「设置 → 插件」渲染国内 / 国际单选卡片 |
| 行为测试 | `test/` | 19 项：浏览器 bundle 6 项、bundle patch 5 项、改写语义 6 项、活体流式 1 项、未经改写必被拒的反向对照 1 项 |

## 为什么是一条路由，而不是两条

中转站在国内与国际两个源站上提供同样的三个模型，差别只在 origin。曾经每个端点各声明一条路由，代价是模型选择器里每个模型出现两次，而「用哪个端点」这个与模型无关的选择，被迫在每次换模型时重做一遍。它不是模型属性，而是一项部署级设置——于是它成了本插件自己的设置分节，选择器里只留一个 AgentRouter 分组。

适配器读不到本插件的命名空间，所以路由的 `baseURL` 指向一个**故意不可解析**的哨兵主机（`.internal` 保留域），由围栏在出站时改写为所选端点。围栏本来就必须在请求路径上——见下一节——因此这没有引入新的机制。

## 为什么需要一个插件，而不只是一段配置

中转站以 `User-Agent` 认证客户端：只接受它自己规定的那个取值，其余一概拒绝。而 `dsh-llm-pi-ai` 在发出请求前会把 profile `headers` 中与归因标头同名的键（大小写不敏感）全部剔除，再追加自己的 `user-agent: deepseek-harness/<版本>`——归因是设计上不可抑制的。仅靠配置无法让请求通过，因此需要一层兼容处理。

因此替换只能发生在适配器之下：provider SDK 构造客户端时从全局作用域取 `fetch`，围栏就装在那里。它刻意窄：只改一个标头、只对哨兵与端点主机生效、经 `ctx.effect()` 安装，插件停用或重载即恢复它替换掉的那个 `fetch`。端点选择每次请求现读，改设置后下一次请求即生效，不需要重载任何东西。

## 已在活体中转站上验证的事实

- **UA 是唯一门禁。** 同一 key、同一请求体，带中转站要求的取值得 200；带 harness 归因 UA 得 401 `unauthorized_client_error`。除此之外没有别的客户端校验。这条断言写进了测试，若中转站日后取消门禁，测试会失败，这层兼容处理即可退休。
- **三个模型都走 `/v1/chat/completions`。** `claude-opus-5`、`claude-opus-4-8`、`gpt-5.6-sol` 均返回 200；上游实际模型名分别为 `anthropic/claude-opus-5-ps-aws-dst`、`MaaS_Cl_Opus_4.8_20260528_cache`、`gpt-5.6-sol`。
- **协议形状。** 接受 `system` 角色、`max_tokens`、顶层 `reasoning_effort`、`strict` 工具、`stream_options.include_usage`；`developer` 角色与 `max_completion_tokens` 也不报错，但按更保守的一侧声明 compat。
- **推理档位。** `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` 逐一探测，全部 200。Opus 两款不提供 `minimal`（与官方目录一致）。
- **端点开关在真实 host 上生效。** 通过设置写入切到 `intl`、再切回 `cn`，两次都由真实会话拿到回答；三个模型各自跑通一次完整轮次。
- **国际端点可能需要出站代理。** 在开发这个插件的网络环境中，直连 `agentrouter.org:443` 超时（其 DNS 只解析出 IPv6 地址），经本地 HTTP 代理则得 200。这属于网络环境差异，未必适用于每一台机器；见下方「国际端点」。

## 安装

```bash
# 0) 取得源码
git clone https://github.com/aqiu817/dsh-llm-agentrouter.git

# 1) 装进 profile（本例为 web profile）
dsh plugin --profile web add file:/path/to/dsh-llm-agentrouter

# 2) 把它列入 bundle 顺序（编辑 ~/.dsh/profiles/web/package.json）
#    dsh.profile.bundles: [..., 'dsh-llm-agentrouter']
#    必须排在 @deepseek-ai/dsh-base 之后，其 llm-pi-ai 覆盖才生效

# 3) 存入中转站 key（不写进任何配置文件）
#    Web 的「模型」设置页可直接写入 ~/.dsh/.credentials.yaml，
#    或让 AGENTROUTER_API_KEY 存在于进程环境中

# 4) 重启 host。模型选择器里出现 AgentRouter 分组，
#    「设置 → 插件 → AgentRouter 中转站」出现端点开关
```

安装务必用 `file:`（pnpm 复制）而非 `link:`：符号链接下 Node 沿真实路径解析，插件将找不到 `@deepseek-ai/schemastery` 等对等依赖。

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

`NODE_USE_ENV_PROXY=1` 是必需的：Node 22 的 `fetch` 默认忽略 `HTTPS_PROXY`，只有该开关才会启用 `EnvHttpProxyAgent`（目前仍标记为实验特性）。国内端点不需要代理，代理也不会妨碍它。

## 配置

路由写在 `cordis.patch.yml` 里作为组合 base；用户层 `~/.dsh/settings.yaml` 的 `llm-pi-ai:` 分节按 provider 逐键合并，可覆盖单个字段或增删模型，下一次请求即生效。

插件自身的分节（`llm-agentrouter:`）全部字段：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `endpoint` | `cn` | 选中的端点键，`cn` 或 `intl`——端点开关写的就是它 |
| `endpoints` | `{cn: ps.air-outer.com, intl: agentrouter.org}` | 每个端点键对应的主机；源站搬迁是一次设置改动，不是一次发版 |
| `sentinel` | `relay.agentrouter.internal` | 路由 `baseURL` 中被改写的占位主机，必须保持不可解析 |
| `userAgent` | 见 `lib/index.js` 中的默认值 | 送往中转站的 `User-Agent`。中转站将来若改钉另一个取值，只需改这里，不必改代码 |
| `announce` | `true` | 激活时在日志里报告一次已装的围栏 |

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

## 兼容性

本插件在 DSH 宿主进程内运行，`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-settings` 都由宿主提供，因此声明为**不限版本且可选**的 `peerDependencies`：插件用到的都是这三个包多个版本里稳定不变的部分，钉死版本只会在宿主升级时凭空造出一次安装失败。下表是已实测跑通的组合，供对照，不是下限：

| 依赖 | 已验证版本 |
| --- | --- |
| Node.js | 22 |
| DeepSeek Harness | 0.1.1-rc.2 |
| `@deepseek-ai/dsh-settings` | 0.1.1-rc.2 |
| `@deepseek-ai/cordis` | 4.0.1 |
| `@deepseek-ai/schemastery` | 3.18.1 |

浏览器端 bundle 面向宿主静态模块表提供的 React 18；卡片只用 `react` 与 `react/jsx-runtime`，不引入任何额外运行时依赖。

## 开发

```bash
npm ci        # 仅测试所需的 devDependencies
npm test      # 19 项
```

克隆后即可跑：19 项中 17 项完全离线，2 项活体测试在无 key 时自动跳过（空字符串等同于无 key——未配置的 GitHub Actions secret 正是以空串到达）。CI（`.github/workflows/test.yml`）跑的就是这一条命令；仓库若配置了 `AGENTROUTER_API_KEY` secret，那两项也会真跑。

活体测试需要一个可解析的 key，否则自动跳过——因此离线也能跑完整套。key 的来源，按优先级：

| 来源 | 说明 |
| --- | --- |
| `AGENTROUTER_API_KEY` 环境变量 | 在 CI 中用这一种（配置为仓库 secret） |
| `$DSH_HOME/.credentials.yaml` 的 `refs.AGENTROUTER_API_KEY` | dsh 模型设置页写入的位置 |

测试从不打印、记录或断言密钥本身。可用 `AGENTROUTER_ENDPOINT`（`cn`/`intl`）选择活体测试所用端点、`AGENTROUTER_HOST` 直接覆盖主机，用 `DSH_PI_AI_DIST` 指定 pi-ai 的 `dist` 路径（默认按 require 解析，再退回 Node 旁的 dsh 全局安装）。

## 贡献与许可

Issue 与 PR 都欢迎。改动请附带能说明意图的测试——本仓库的测试同时充当规格说明。

MIT，见 `LICENSE`。仓库中不含任何密钥、账号或本机绝对路径。