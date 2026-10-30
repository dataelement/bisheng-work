# Patch 与 Plugin 规范

适用于 DSH Desktop 对 Harness 的宿主定制，以及为这些定制维护的第三方补丁。本文是跨目录规则的唯一维护位置；包加载和补丁重放的具体要求分别见 `packages/AGENTS.md`、`patches/AGENTS.md`。preload 能否直接改页面 DOM 的判定见 `src/preload/AGENTS.md`，不在本文重复。

### Chat 登录前说明（2026-10-26）

`createChatNavigation` 管理未登录的 Chat 选择意图，以 `signInPromptOpen` 呈现原生 Harness Modal；显式登录操作打开既有 `enterprise-account` 设置区，关闭操作保留当前 Work。连接状态通过轮询或宿主订阅变为已登录时，清除提示；登录成功导航沿用既有账号状态同步。弹窗使用原生焦点、Esc 与遮罩行为，说明和按钮通过 `desktop.chatWork` 的中英文词典提供。账号页继续由企业插件拥有，新增说明随登录前/授权中/登录后状态切换。

### 首次引导与原生 Chat 的展示归属（2026-10-26）

引导使用 body portal 展示，并通过 `#root.inert` 管理宿主背景的交互。Chat 使用独立的 Electron `WebContentsView`，因此内容贡献项同时读取这一原生 DOM 状态：主界面 inert 时向宿主发送 `visible: false`，恢复后重新计算 Chat / 设置页的展示状态与原有坐标。引导在 layout effect 建立该边界；内容贡献项首次挂载读取现值，随后仅观察 root 的 inert 属性，卸载时释放 observer。设置、审批和账号弹窗继续沿用各自的可见状态。

该修改直接调整自有插件，复用 Harness Modal 和现有宿主 presentation IPC。引导保存失败时保留前景与重试入口，成功后释放边界；跳转模型设置时 Chat 继续保持隐藏。行为回归见 `test/desktop-modes-ui.test.mjs`，覆盖启动顺序、尺寸变化、确认成功/失败、设置交接、返回用户与卸载清理。

### 输入候选菜单的滚动归属（2026-10-21）

Harness 0.2.0-rc.2 的 `dsh-client-ui-input-trigger` 将 pointer hover 与 keyboard move 归入同一个 highlight，原视图对每次变化调用 `scrollIntoView`。鼠标悬停底部部分可见的候选时会推动列表，调用还可能滚动外层会话容器。修复直接在 reducer 的 highlight 上记录可选的 `origin`，悬停更新高亮，键盘导航按候选与列表的可见边界调整该列表的 `scrollTop`。初始候选仍按边界检查，菜单的原有高度计算、主题、溢出渐隐和滚轮行为保持。

变更在依赖安装时由 patch-package 重放，类型声明同步；行为回归见 `test/input-trigger-scroll.test.mjs`，覆盖部分可见行悬停、手动滚动后的结果刷新、键盘循环及鼠标转键盘操作。上游提供同等输入来源区分与列表内滚动后删除本地兼容变更，并保留行为回归。此修复只影响原生 Work 候选菜单，网页 Chat 使用自己的菜单实现。

### 原生语言同步（Harness 0.2.0-rc.2，2026-10-20）

直接消费上游 `dsh-client-locale` 的 `__DSH_LOCALE__.read()/onChange(active)` 接口，不新增补丁、插件或语言偏好副本。preload 只暴露读取系统语言与上报活动语言两项能力；main 复用可信主窗口与主 frame 校验，并仅接受 `zh` / `en`。初始化返回系统语言顺序与 `preference: null`，持久偏好由 Harness 已有 configForms 从当前 Profile 提供；Client 初始化后立即上报解析值，后续通过上游 locale/change 上报。main 在内存保留该值供手机桥及原生文案使用，尚未激活 Client 的启动/恢复页面保留现有回退。此改动不参与 Profile 组合、包解析或客户端加载图。

手机桌面配对页的已认证 `/desktop/status` 响应携带当前语言，页面沿用现有轮询检测变化并重新请求 HTML；连接模式切换期间延后刷新，不重建手机桥、隧道、配对 token 或 PIN。旧客户端忽略新增响应字段。原账号菜单继续由官方 slot 和 Harness locale 控制；preload 仅同步未加载账号插件时的既有手机按钮，不新增 DOM 入口。网页自身语言机制不受影响。

### Work 工具消息的名称与模型身份（Harness 0.2.1-rc.2，2026-10-27）

桌面工具引用通过发送前的账号可用性校验后，序列化为 `[Selected tool: mcp__bisheng__bisheng_tool_<id>; label: "名称"]`。`label` 使用 JSON 字符串编码，消息持久化保留名称快照与模型需要的工具身份；连接身份继续仅参与发送前校验。名称要求为有内容的单行文本。

宿主插件通过 `uiConversation.userText.register` 注册纯同步解析规则，通过 `conversation.user.text.node` 的 `desktop-tool` keyed slot 呈现名称与现有工具图标。该注册独立于工具菜单和 Skills 服务，历史展示直接读取正文中的名称。旧版 `[Selected tool: <id>]` 记录显示本地化“已选工具”；缺失的历史名称保持未知，账号目录变化仅影响之后的新选择。异常引用保留原始文字，名称作为 React 文本节点处理。模型上下文与存储原文保持工具身份，已有权限和审批继续由发送、执行边界控制。

扩展复用当前 Harness 的公开接口。规则、slot、语言和样式均由插件生命周期管理。回归使用已安装 Harness 的提交、文本评估和渲染实现，覆盖名称持久化、正文修改重发、旧消息、多个引用、特殊字符与卸载重装。

### 嵌入页面的窗口级模态展示（2026-10-28）

页面 body portal 的模态状态由 presentation preload 汇总，经当前账号、主 frame、origin 与 pathname 校验传给 `EnterpriseChatView`。弹窗期间子视图覆盖窗口，`#root` 保留内容区坐标，透明背景保留原生侧栏与页面原色，网页弹窗组件统一决定展示样式。关闭最后一个 portal 后恢复内容区；多层弹窗及退场动画共用该生命周期。设置内容页继续采用宿主设置容器范围。

这是原生窗口展示接缝：Harness slot 位于另一个 renderer。preload 只观察 portal 与 root 的背景隔离属性，按动画帧汇总变化；隐藏时暂停，卸载时释放。语义为普通浮层的 popover 保持原范围。知识空间旧展示入口触发同一个汇总状态刷新。验证入口为 `test/enterprise-modal.test.mjs`、`test/enterprise-chat-view.test.ts` 和跨平台 `scripts/verify-enterprise-modal.mjs`。

### 安全模式管理页的原生视图展示（2026-10-29）

安全模式 preload 已通过 `html[data-dsh-safe-mode-page]` 声明管理页占用内容区。桌面内容贡献项读取当前属性并仅观察该属性变化，通过现有 presentation IPC 隐藏背景 Chat 子视图；关闭管理页后按当前模式恢复。远程设置仍作为前景内容展示，`#root.inert` 继续管理宿主模态边界。观察器随贡献项卸载释放。该修复直接修改自有插件；验证见 `test/desktop-modes-ui.test.mjs` 与 [macOS 原生验证记录](status/safe-mode-panel-20261029.md)。
### About 弹窗与原生 Chat（2026-10-29）

实际 About 入口通过 `html[data-dsh-about-open]` 声明宿主前景状态，桌面内容贡献项读取现值并观察该属性，将 Chat 和嵌入式设置页交给已有 presentation IPC 管理。关闭时按当前模式与宿主模态状态恢复；观察器和 About 键盘监听分别随组件、文档生命周期释放。主进程在派发 About 前把焦点交给宿主 renderer。该变更属于窗口 UI 接缝，直接修改自有代码并保留当前 IPC 权限边界。验证见 [About 记录](status/about-chat-visibility-20261029.md)。

## 1. 按能力选扩展方式

产品能力和长期维护的桌面表现优先放在宿主代码或插件中；patch 用于修复上游缺陷或补足必要的扩展接缝。插件不能通过隐藏的 DOM 改写、内部方法替换，把实际的上游耦合伪装成无补丁扩展。

| 需求 | 首选位置 | 允许使用 patch 的边界 |
| --- | --- | --- |
| 品牌、颜色、间距等视觉调整 | 宿主 UI 插件的样式，使用公开主题变量或稳定标记 | 上游缺少稳定标记/变量时补最小接缝 |
| 新增面板、按钮或功能入口 | 现有 slot 注册项与宿主服务；不默认走 preload DOM 注入 | 缺少合适挂载位置时补扩展点，不能偷偷借用不相干 slot |
| 改变一个现有操作的位置 | 已有位置配置或可选择注册项的布局能力 | 缺少能力时做最小结构调整，并检查其他注册项是否受影响 |
| 调整上游内部组件布局 | 上游提供的布局配置/扩展 API | 无扩展点时允许局部 React 渲染树补丁，需明确兼容范围 |
| 上游错误、缺失 Remote/API 行为 | 对应上游包的局部缺陷补丁 | 不复制整套组件或 runtime；保留跟随上游修复的退出路径 |
| 文件、进程、窗口和更新能力 | Electron main 的服务及窄 IPC | 不能通过放宽 renderer 权限实现 |

- 先检查目标版本实际发布的 API、slot 和加载产物，不能凭名称猜测可用能力。
- 不为很小的定制创造通用框架，也不为追求“零 patch”复制上游组件或在 preload 中移动 React 管理的 DOM。
- 接缝允许独立存在时，卸载定制插件后保留上游默认行为。若 patch 与插件必须同时加载，应声明依赖，并在缺失时给出可诊断的降级或错误。
- 可复用的扩展点优先设计成可向上游提交的能力；是否提交上游 issue/PR 由用户授权，不自动发送。

## 2. Slot 契约包含布局与生命周期

下列任一变化都应在评审中明确，不能仅以“slot 名称未变”判断兼容：

| 契约维度 | 要保持或解释的内容 |
| --- | --- |
| 声明 | 名称、`kind`（single/list 等）、scope、由谁声明 |
| 数据与上下文 | Props、注入服务、locale、会话及状态来源 |
| 贡献项 | ID、排序、替换/竞争规则，是否允许多个插件共同贡献 |
| 渲染 | 出现条件、挂载次数、所在位置及父容器布局 |
| 可用空间 | 宽度、换行、溢出、定位、层级和键盘焦点顺序 |
| 生命周期 | 会话切换、卸载、重载后的订阅、局部状态和清理 |

- 移动 `renderSlot(...)` 会移动该出口渲染的贡献项集合。只想移动一个按钮时，不得无说明地移动整个 list slot。
- 不删除、重命名、缩窄或改变既有 slot 的用途来容纳 Desktop 私有需求。确需改变公共契约，记录受影响插件、迁移方式和兼容限制；局部能力优先新增语义明确的扩展点。
- 新 slot 要定义用途、kind/scope、Props、容器约束和默认行为，并同步目标包适用的运行时声明与类型声明。声明存在、出口可达、贡献项可见必须分别验证。
- 禁止为了保留旧位置再额外渲染同一份有状态贡献项，造成双挂载、重复订阅或重复副作用。
- 替换既有贡献项仅使用目标版本明确支持的机制；不要猜测 ID 覆盖、优先级或过滤参数的行为。
- `data-dsh-*` 只是样式/定位接缝，不是 slot，也不能代替 slot 的上下文或生命周期契约。自有标记需有明确归属和用途，避免与上游及其他插件冲突。

### Work surface viewport overlays (2026-10-27)

The desktop Work grid uses `isolation: isolate` to keep its stacking boundary while fixed-position Harness overlays retain the viewport as their containing block. The installed Tooltip reads its trigger with `getBoundingClientRect()` and writes viewport coordinates to a fixed bubble. Layout/paint containment on the Work grid added the sidebar and header offsets a second time. The grid and its relative-positioned layout remain the owners of conversation and inspector sizing.

Run `node scripts/verify-session-tooltips.mjs` on a native desktop for the geometry regression. It renders the installed Tooltip implementation and production desktop styles in an isolated Electron profile, covering sidebar widths, inspector visibility, scroll, three zoom factors, top/bottom placement, hover/focus events and dismissal. This is a deterministic browser-layout fixture; real-account native acceptance is a separate gate.

## 3. Plugin 的职责与可卸载性

- 展示、文案、交互和桌面特有业务留在自有模块；与第三方内部实现的兼容逻辑集中在小范围适配层，不散布到多个插件。
- 工作台类第三方插件属于可选贡献项。单个工作台插件导入、激活或渲染失败时，只隔离该插件并保留可诊断信息；不得阻断核心运行时、插件/工作台市场和其他插件。宿主核心项及未声明为工作台的插件仍按各自启动策略处理。
- 注册项、事件订阅、timer、observer、注入样式及异步任务需有明确所有者。遵循 Cordis 的 effect/disposer 机制；不能假设插件只会加载一次。
- 卸载或切换会话后，旧异步结果不得更新新实例；重载后不得重复注册或残留样式。共享资源按引用/所有权处理，不能删除其他插件的资源。
- CSS 限定到自有根节点或明确的宿主接缝；不依赖压缩类名、翻译文字或宽泛的全局选择器。覆盖主题时保留 hover、disabled、focus 等状态。
- 不能为一个插件更改全局 slot registry 的竞争规则、屏蔽其他贡献项或绕过依赖校验。

### Enterprise tool availability synchronization (Harness 0.2.1-rc.2, 2026-10-27)

The identity-owned enterprise browser observes completed HTTP 200 PUT requests to its own `/api/v1/dsh/capabilities/<id>/availability` endpoint. It validates the current browser instance, account generation, request origin and WebContents ID, then sends a payload-free `enterprise-chat:tools-changed` notification to the local renderer. The existing host bridge exposes a disposable listener. The enterprise client invokes the authenticated local tool route with `operation: refresh`; the host rereads the permission-filtered MCP catalog. The observer is removed when the browser session closes, and the client releases its listener and requests on unload. A refresh notification carries no permission decision or tool metadata.

The system-prompt package adds an awaited, scope-filtered `system-prompt/prepare` event before reading providers. The existing `system-prompt/assemble` waterfall runs after collection and therefore cannot provide this freshness boundary. Main Work agents refresh their enterprise catalog at preparation; native tool ordering, PTC presentation and scoped restrictions remain owned by the original providers. Concurrent readers join an existing synchronization and then start a fresh read, so a response captured before a toggle can finish without becoming the next request's catalog. Refresh failure clears stale registrations and rejects that assembly; a subsequent request retries. Background polling continues as supplemental synchronization.

This extension modifies `dsh-system-prompt@0.2.1-rc.2` runtime and event types through the versioned install replay file. A scope without preparation listeners retains the existing provider and waterfall pipeline. Replace this extension when Harness provides an equivalent awaited provider-preparation boundary. Tests in `enterprise-tool-sync.test.mjs` use the installed AgentLoop, model adapter boundary, ToolRuntime and MCP SDK; browser ownership is covered in `enterprise-chat-view.test.ts`. After `npm run build`, `node scripts/verify-enterprise-tool-save.mjs` exercises the production browser host in native Electron with loopback HTTP saves and renderer IPC. Successful PUT responses each emit one refresh; reads and rejected writes preserve the current catalog. The content-safety integration fixture supplies an empty MCP catalog so its queued Agent requests exercise the new admission boundary. Real-account desktop acceptance remains a separate check.

## 4. Patch 的最小范围与退出路径

- 对样式定制，patch 尽量只补标记/变量；CSS 放自有文件。对结构缺口，patch 只补必要的出口、配置或局部结构；不要把后续业务功能不断堆进编译 bundle。
- 直接修复上游缺陷时允许改其实现；“最小”指职责和影响范围，不按 diff 行数评判。
- 现有补丁无需一次性重写；修改某项定制时评估能否把自有逻辑移出，避免继续扩大耦合。
- 每项新增或实质修改的补丁在 PR 中说明：目标包/版本、解决的问题、现有扩展点为何不足、受影响的 slot/插件、已执行验证、何时可删除。不能只写“优化 UI”。
- 同一版本包的多项修改可以保留在同一个 patch-package 文件中，但评审和测试需能区分各项行为；不要为了文件数量强拆补丁。
- 上游提供等价修复或扩展点后，切换自有实现并移除对应补丁；确认没有重复注入、重复渲染或遗留样式。

## 5. 按影响做组合验证

| 改动 | 最小验证范围 |
| --- | --- |
| 纯 CSS | 实际页面、深浅主题、相关交互状态及窄窗口；检查样式不外溢 |
| Slot 出口、容器或渲染条件 | 无贡献项、单贡献项、多贡献项；已有与测试贡献项并存；尺寸/焦点/重复挂载 |
| 插件注册或副作用 | 加载、卸载、重载，以及相关会话切换/异步过期场景 |
| Patch 与插件共同实现能力 | 干净安装重放、实际加载路径；缺少可选插件时的预期行为 |
| 原生能力或分发行为 | 对应平台及实际安装包流程，按根规范执行 |

测试贡献项应包含长文案或占满容器宽度等情况，以暴露仅有内置按钮时看不到的布局问题。涉及 slot 的变更，应验证数量、位置及事件行为；只检查 patch 字符串或只截图内置组件，不构成兼容验证。

## 6. 示例：设置操作与输入框仪表

PR #357 展示了两种应区别处理的变化：

- “+”背景和间距属于视觉定制，可由最小标记补丁加宿主样式承载。
- 将 `settings.action` 从标题区移到侧栏，会影响整个操作列表。若意图仅移动 `open-document`，应保留其他贡献项的语义，评估独立 footer 出口或目标版本支持的定向布局机制。
- ContextMeter 原本直接渲染；把它挪到 dock 旁边并不自动让它成为 slot。若采用新的位置配置/独立贡献机制，需要先实现相应契约；同时验证原 dock 贡献项的空间和挂载条件。

这些是设计选择示例，不表示所提新扩展 API 已存在。本文是开发与评审约束；当前尚无自动 slot 契约门禁。

### Agent preset configuration tooltips (Harness 0.2.1-rc.2, 2026-10-27)

The preset configuration button renders the existing Harness `Tooltip` with `portal: true`, top placement and end alignment. The bubble belongs to the body overlay layer and uses the primitive's viewport fitting, theme tokens and hover/focus lifecycle. The previous absolutely positioned `data-tip` pseudo-element belonged to the card inside the settings scroll container, which clipped the English label at the right edge. Its attribute and CSS rules are removed together.

The button keeps its accessible name, configuration action and viewer focus-return reference. The roster, settings slots, import/export and preset selection retain their existing ownership. The installed agent-preset renderer owns this button and exposes no tooltip configuration slot, so the direct component change is recorded in its existing versioned install replay file. Remove this change when Harness provides equivalent portal rendering for this action.

`node scripts/verify-agent-settings-tooltips.mjs` renders the installed section and Tooltip in an isolated native Electron window. It covers English/Chinese, light/dark theme tokens, two window widths, three zoom levels, scroll, hover/focus, click dispatch, dismissal and unmount cleanup. Remote data and unrelated dialogs use fixture stubs; real-account desktop acceptance remains a separate check.

## Chat / Work 接缝（Harness 0.2.0-rc.2）

`dsh-client-ui-layout` 声明 root/single 的 `desktop.mode.content`，owner 为 `work: ReactNode`、`columns: string`、`resizeHandle: ReactNode`。位置只覆盖第二、三列；贡献项占据这两列并保持 Work 挂载一次。默认 fallback 使用原内容和 frame 坐标的拖拽柄；桌面贡献项使用内容区域坐标的拖拽柄。左侧原生 SidebarRoot 始终挂载。

`dsh-client-ui-workspace` 声明 root/single 的 `sidebar.workspaces.collection`，由 WorkspaceBrowser 内的 SessionTree、FlatList 和 SearchResults 呈现。owner 提供 `mode: projects | flat | search`、`query`、`archivedOnly`、`projects(active): ReactNode` 和只读 `items`。每项包含 id、updatedAt、pinned、blank、`render(active): ReactNode`。项目视图的 items 来自原生 deriveFlat 对未分组 sessionIds 的投影，项目成员与归档过滤继续由 Harness 拥有；原生 renderer 保持行菜单、状态及选择行为。默认 fallback 保持原项目树、单列表或搜索结果。

WorkspaceBrowser 向 SessionTree、FlatList、SearchResults 完整传递同一个 `renderSlot`，搜索结果和结果行沿用宿主集合及行扩展协议。`test/session-search-recovery.test.mjs` 运行已安装组件，覆盖原生 fallback、桌面合并集合、两种分组，以及输入、打开结果、清空、Escape、延迟返回和请求失败；`node scripts/verify-session-search.mjs` 在隔离 Electron 窗口运行同一组件流程。

桌面贡献项将云端历史与上述本地 items 按来源命名空间和更新时间组合，项目节点独立呈现在最近之前。Chat 模式通过 active=false 清除本地选中态；会话行直接呈现标题与时间，来源继续由数据与导航控制。云端搜索匹配已加载的标题；归档专用视图仅呈现有归档元数据的本地记录。`sidebar.history` 已由这个集合接缝替代，SidebarRoot 持续呈现唯一 workspace browser。

`uiWorkspace.registerNavigationHandler(handler)` 为多订阅者的导航接缝，handler 接收 `open | new` 和可选 workspaceId。`new` 返回 true 表示全局新建已由 Chat 接管；`open` 只通知呈现模式，原 Work 导航和工作台 starter/opener 继续处理。本地任务查询、持久化和执行由原 Harness 服务负责。解绑按 Cordis/React 生命周期执行。

`dsh-client-ui-settings-general` 接收 `dsh-desktop:open-settings-section`（detail.id 对应已注册页）及 `dsh-desktop:close-settings`，绑定现有 store actions；发送 `dsh-desktop:settings-visibility`（detail.open 布尔值），设置打开时暂停原生 Chat view 展示，关闭后恢复。事件只控制本地呈现，认证由主进程执行。

主进程仅向可信宿主主 frame 暴露 Chat history(page) 与 open(id)，固定 API 路径、校验页码和标识。使用内存隔离 cookie session；会话打开按本次身份查询到的路径映射执行。身份 generation 改变后丢弃异步响应并清理云端列表、路径和网页存储。远程网页使用独立的展示状态 preload，仅暴露 reportLanding(boolean)，由主进程校验当前视图、主 frame、企业来源、路径和身份代际。

毕昇 `/workspace/?embed=dsh` 在路由跳转前记录本浏览会话的嵌入布局标识，嵌入布局由 React 直接呈现内容。独立网页继续显示自己的聊天导航。该标识参与布局与主题呈现；语言覆盖另要求原生展示桥，见下文“桌面与独立网页的语言隔离”。

上游提供等价内容/历史 slot、导航订阅和设置可见状态 API 后迁移并移除对应兼容扩展。每次变更执行全新 npm ci 重放、模式/导航/身份回归和原生布局检查。

### Chat 文档生命周期与页面内导航（2026-10-16）

企业身份拥有一个远程 Chat 文档；Work/设置切换只改变展示状态，隐藏时保留网页尺寸与背景。贡献项卸载时清理展示，身份代际变化时由主进程清理文档和凭据。首次加载的 dshTheme 查询参数仅携带 dark/light 呈现值。

主进程 open(id) 先从该身份已读取的历史路由映射得到路径，再发送可取消的 dsh:navigate 事件；网页 Root 校验 c、linsight、chat 三种明确路由结构后确认并调用 React Router。宿主以 defaultPrevented 作为页面内导航确认，旧网页沿用完整加载。异步返回检查身份 epoch 和视图所有权。路由事件携带页面路径。网页专用 preload 仅上报欢迎页状态，企业凭据和本地执行 API 由宿主独立持有。

### 首次发送的即时模式收起（2026-10-16）

Work 从 sessions.binding(id).session 订阅当前主视图的 pendingSubmissions、blank、running、awaitingFirstTurn，发送回显到达后立即收起模式选择；会话切换和卸载释放旧订阅。ChatView 使用自己的乐观消息状态在 layout effect 上报欢迎页状态，KeepAlive 页面只在路由匹配时上报。主进程经受限 preload 接收布尔值，向可信宿主推送快照，旧轮询响应按 revision 丢弃。轮询继续刷新历史及连接兜底，首次发送的模式收起由实时状态驱动。新会话恢复选择；发送拒绝后的可见状态与实际消息列表一致。

### 统一桌面导航（2026-10-19）

基于 bisheng-work/V1.2.0 e9f2063 与 Harness 0.2.0-rc.2。sidebar.primaryNavigation single/root 接缝位于原生新会话、quickSwitcher 之后，传递 wide、startSession、panels、selectPanel、renderPanelIcon、expandSidebar 与 renderAction。新会话及快捷键由 Harness 持续渲染一次；无贡献项时使用原生面板列表。renderAction 复用 PanelRow 的展示组件、Tooltip、主题、焦点及展开状态。桌面贡献项将全部企业入口和本地面板收进 Harness Menu，折叠状态打开菜单时展开原生侧栏。嵌入网页边界取内容区域与侧栏右边界的交集，并订阅两者尺寸变化，保留原生侧栏操作区域。sidebar.workspaces.title single/root 仅提供 flat 状态，默认仍使用 Harness 文案；桌面使用项目/所有会话标题。上游提供同等接缝后迁移。

企业网页在 MainLayout 中上报实际可见菜单（权限、预览开关、名称、顺序和选中项均由网页决定）。远程 preload 仅上报展示数据；主进程校验视图、主 frame、企业来源、当前路径和身份代际，逐项校验菜单 ID 与固定路由。宿主 openPage 只接受当前账号已上报的菜单 ID。身份切换清空菜单及页面状态。网页的路由和主题桥接覆盖整个 MainLayout，功能页复用现有页面。Work 本地项目与会话继续由 Harness 管理。

### 收起侧栏后的原生操作区（2026-10-23）

macOS 收起侧栏后，Harness 将展开与新会话控件挂载到既有 `[data-shell-leading]` 操作区。普通 Chat 的模式选择器在进入会话后释放顶部空间，原生 WebContentsView 若仍占据该区域，会盖住 DOM 控件，CSS z-index 无法修复。桌面内容贡献项因此在操作区与 Chat 顶部重叠时，按实际操作区右边界为 Chat 留出左侧空间，保持原有顶部坐标与内容高度，避免标题另起一行；展开侧栏、操作区卸载后恢复完整内容宽度。WebContentsView 为矩形边界，此留白作用于整个嵌入视图，而非仅标题文字。沿用原有按钮、slot 和快捷键，不新增上游补丁或另一份操作控件。

仅观察内容贡献项的直接 frame 子节点/收起属性及操作区尺寸变化，不观察流式正文；卸载时释放 observer。设置页的独立 bounds 不受影响。行为回归在 `test/desktop-modes-ui.test.mjs`，覆盖活动会话收起、展开后恢复和卸载清理；真实 Electron 的点击与视图遮挡仍需独立验收。

### 模块页深浅色与加载超时（2026-10-19）

毕昇客户端的 ThemeProvider 把 `<html>` 固定为 `light`，而 `@bisheng/ui` 的 tokens.css 已定义完整 `.dark` 变量块。宿主因此接管模块页的深色：`src/main/enterprise/chat-module-theme.ts` 的 `moduleThemeScript` 在每次呈现、完整加载和页面内路由变化后向嵌入文档执行，写 `dshHostTheme` 与 `data-dsh-page`、派发 `dsh:appearance`，并且仅当路径匹配 `MODULE_ROUTE_PATTERN`（knowledge / channel / apps / skills / square，与宿主导航可达的模块一致）且宿主为深色时给 `<html>` 加 `dark` 与 `dsh-module-dark`。脚本在页内安装一次性 MutationObserver 守卫，在 ThemeProvider 挂载后重写 `light` 时重新断言；守卫只撤销宿主自己加过的 `dark`（`owned` 标记），不碰网页在聊天路由上自行维护的 `html.dark`，否则两边互相覆盖会把网页主线程卡死。聊天路由不加 `dark`，继续使用网页的 `data-dsh-chat-theme`。

脚本同时在宿主为深色时给任意路由的 `<html>` 加 `dsh-host-dark`：这是工具类覆盖的作用域，聊天路由也适用（参考来源面板、引用标签、来源头像等硬编码白底在网页自行维护的 `html.dark` 下同样需要）；`dsh-module-dark` 仍只标记宿主接管 `html.dark` 的模块页。替换值全部指向 token 变量，若网页未按 `dshTheme` 进入深色，变量解析为浅色值，覆盖不改变观感。

`MODULE_THEME_CSS` 在每次完整加载后由 `insertCSS` 注入：模块页固定规则（`color-scheme`、body/#root 底色、表头、知识空间首页文件夹磁贴反色）以 `html.dsh-module-dark` 为前缀，工具类覆盖以 `html.dsh-host-dark` 为前缀，只覆盖硬编码的浅色工具类。类名清单取自 3006 bundle 与毕昇源码的并集，hex 同时生成大小写两种写法；替换值不手工指定，而是按颜色明度与色度由 `darkDeclaration` 推导到 token 变量（深字→text-1/2、中灰→text-3/4、浅底→bg-page/arco-gray-1..3、浅边→border-base），有彩度的品牌与状态色、本来就深的底色保持不变，带透明度修饰的工具类保留原透明度；每个工具类同时生成 `hover: / focus: / active: / fine-pointer:hover: / group-hover: / data-[state=open]: / has-[[data-state=open]]:` 变体（`VARIANTS`），基础类与各变体分别放入 `:is()` 列表后按变体的选择器形状包裹，背景类的交互变体比静态替换高一级表面 token（`liftSurface`），否则深色下 hover 不可见；`from-* / via-* / to-*` 渐变停色按 Tailwind 3 的自定义属性语义替换（`from-*` 同时重置透明的 `--tw-gradient-to`，`via-*` 保留两端），用于列表底部淡入提问栏的白色蒙版。代码块的 highlight.js token 颜色由 `HLJS_DARK` 提供 GitHub Dark 配色（网页只带浅色调色）；组件以内联 `style` 写死的颜色（灵思执行流调色板与结果卡片）按序列化后的属性值匹配并以 `!important` 覆盖，清单在 `INLINE_STYLE_COLORS`，同样走明度推导；该清单跟随网页源码维护，网页改用 token 后应删除对应项。表头的浅色底来自组件样式而非工具类，按 `thead` / `th` / `[role=columnheader]` 统一给深色底。写死 `#FFF` 停色的任意值渐变（知识广场卡片 `bg-[linear-gradient(...,#FFF_50%,...)]`）按类名子串匹配，替换为 token 渐变；知识空间首页的文件夹磁贴是内联 SVG 配固定粉彩填充，名称用 token 白字压在上面，宿主对该 SVG 做 `invert + hue-rotate` 反色而不改文字。订阅文章阅读区是同源 srcdoc iframe，内部 `background:#fff !important` 且正文带来源站内联颜色，token 覆盖无法到达：脚本对每个可访问的 `iframe[srcdoc]` 文档注入 `FRAME_DARK_CSS`（整页反色、媒体再反色一次、html 底色选在反色后落到页面深色），并在 iframe `load`（切换文章会重建文档）和新 iframe 挂载时重新处理；带 `sandbox` 且无 `allow-same-origin` 的产物预览 frame 不可访问，保持原样。宿主转回浅色时移除 frame 样式。网页为模块页补齐自身深色样式后，应删除本层而不是继续扩充。

嵌入文档的首次加载与页面内导航都经 `loadWithin` 限时 45 秒。平台重新部署期间 `loadURL` 可能永不返回，超时前会把会话钉在 connecting 且不出现重连入口；超时后抛出 `status: 'timeout'`，进入错误态并记 `session_failed status=timeout`，重连可用。

### 桌面与独立网页的语言隔离（2026-10-19）

宿主插件从 Harness locale 服务读取并订阅当前语言，通过 presentation 的可选 `locale: zh | en` 字段交给主进程；缺省时兼容旧调用方。主进程严格校验，在首次/完整加载的 URL 携带 `dshLocale`，并在文档就绪、呈现和页面内路由变化后设置 `data-dsh-host-locale`、派发 `dsh:locale`。设置页隐藏嵌入文档期间仍投递语言，避免导航保留旧文案；投递失败记录 `locale_delivery_failed`。该接缝只影响当前身份的隔离文档，不改变插件/依赖加载链路，也不写用户语言配置。

配套网页只在嵌入状态且存在原生 `dshChatPresentation` 时采用覆盖，映射到既有 `zh-Hans` / `en` 词典。初始化时禁用嵌入实例的 i18next 偏好缓存；运行中更新文档语言和当前实例，保留网页 lang cookie、持久化 lang atom 与独立网页偏好。宿主覆盖可在当前 sessionStorage 保留以支持硬刷新，身份 session 清理时一并释放。网页默认菜单文案切换后沿用现有导航上报；管理员自定义名称保留原文。两端必须配套更新，旧网页不会消费新增语言事件。

### 工作台欢迎区配置与模式过渡（2026-10-20）

`conversation.hero.brand.title` 为 root/single、空 owner 的标题接缝，位于原生 titleGroup 内；无贡献项沿用原生标题和徽标。桌面贡献项读取当前企业文档上报的公开 branding，与现有 mark 接缝共同呈现工作台欢迎语和图标；本地无企业配置时使用毕昇默认欢迎区。branding 只携带欢迎语及图标 enabled/HTTP URL，由导航报告的同源、主 frame、路径、身份代际校验保护，参数有长度和协议边界；身份变化沿用 navigation 清空流程。后台管理仍为构建→工作台既有配置。

`data-dsh-hero-controls` 标记原生 Work 首页控件行，样式由桌面插件拥有。鼠标切入 Work 采用 180ms 从左向右揭示，结束后清除裁切；键盘切换与 reduced-motion 即时呈现。标记不改变控件 slot、布局或挂载次数。上游提供等价标题 slot 和控件标记后迁移并移除本地接缝。

## 账号与用量组合（2026-10-22）

`dsh-desktop-enterprise` 的 `enterprise-account` 设置贡献项声明 `desktop.account.usage`（single/root）。仅登录时在账号资料与安全操作之间渲染一次，owner 提供 `credits`、`creditsLabel`、`creditsHelp` 展示字符串及 `models` ReactNode；用量贡献项将模型区挂载一次，位于热力图之后、存储之前（用量加载/失败时仍呈现模型区），无贡献项时 fallback 同样保留模型列表。容器宽度跟随设置内容区；用量贡献项不得另建弹窗或改变登录流程。`dsh-desktop-settings` 将原用量组件注册到该出口，不再注册独立的用量导航项。无贡献项时账号页仍显示剩余积分；卸载企业插件时用量贡献项随 slot 注入生命周期释放。统计请求、身份代际隔离与取消过期响应继续由原组件管理。

概览 Token/消息数来自用量接口的统计期汇总（不是全生命周期统计），界面显式标注每日桶起止日期。月份、每日用量、Token/消息切换及存储均复用原数据；账号安全与模型授权仍由企业插件拥有。此组合仅使用宿主插件自有出口，不新增第三方 patch，也不改变启动和认证协议。

## V1.2.0 模型授权与积分组合

`conversation/input-before-submit` 保留知识空间引用快照及取消信号；随后模型目录完成撤权恢复和可路由检查，再提交消息。目录恢复与模型名称补丁共同适用于 Harness 0.2.0-rc.2。目录不可用时返回可恢复错误并保留草稿；配置模型名称只用于展示，调用仍使用原稳定路由 ID。上游支持这些行为后删除相应补丁并迁入正式 API。

本次检查同时覆盖知识空间引用、撤权后的默认模型恢复、历史用量名称及企业插件；patch-package 重放、完整测试和构建通过。实际安装版与新后端的联合验收单列在 STATUS 中。

### Model authorization changes (Harness 0.2.0-rc.2, 2026-10-21)

The shared `ModelDirectory` reconciles its durable session selection with each successfully loaded catalog. It retains an available selection; a withdrawn selection switches through `session.selectModel` to the available configured default, then a model from the same provider, then the first available provider. The replacement uses its own reasoning default. Provider discovery failures preserve the saved selection for recovery. Attempts are shared per catalog and selection, and the existing selection generation protects later manual choices and session disposal.

`conversation.input.model` keeps its existing ownership and layout. Its caption uses the advertised name, an actionable selection label, or “暂无可用模型”. The ordinary composer awaits directory recovery before sending; empty and unresolved catalogs return a localized failure through the existing draft/attachment restoration path. Addressed subagents retain their own transport. Cancellation is checked after recovery.

The official DeepSeek catalog uses the request path's credential resolver, so automatic selection considers configured official providers. This reuses the credential discovery fix from PR #60 for V1.1.0.

These changes belong to `dsh-client-ui-model-selection`, `dsh-client-ui-conversation`, and `dsh-llm-deepseek-api-key` at `0.2.0-rc.2`. Existing slots expose rendering contributions; shared selection reconciliation and the composer send boundary live inside the upstream implementations, so these corrections are recorded as replayable dependency changes. Remove the corresponding hunks when Harness supplies equivalent behavior. Regressions: `test/model-revocation.test.mjs`, `test/deepseek-model-credentials.test.mjs`, and `test/deepseek-model-credentials-runtime.test.ts`.

The conversation model trigger, menu/search labels, tooltips, and `/model` rows share an enterprise display-name formatter. A missing, blank, or internal-ID display name becomes localized “企业模型 {index}” / “Enterprise model {index}”; configured names remain intact. The catalog and selection requests retain their original IDs. Model-label regression cases cover both locales and distinguish multiple unnamed models.

### Turn usage model labels (Harness 0.2.0-rc.2, 2026-10-21)

`TurnUsagePanel` resolves each recorded provider/model route through the same model catalog that supplies the composer selector. The catalog retains advertised names for the current Host generation, allowing completed turns to keep their labels after authorization changes. Connection reset clears those names and rejects late catalog responses from the previous generation. Missing names use localized copy. Route attribution and token accounting retain their existing values.

The chat package explicitly declares its model-selection client dependency and receives the shared catalog through the existing turn-tail registration. The rendering slot keeps its ownership and layout. The bundled `dsh-client-ui-chat` renderer owns the usage row and exposes no label formatter slot; `dsh-client-ui-model-selection` owns the catalog. Both dependency changes are replayable against `0.2.0-rc.2`, with matching type declarations. Remove these changes when Harness supplies the same label resolution and lifecycle contract.

`test/turn-usage-model-names.test.mjs` renders the actual usage component with React and exercises catalog arrival, authorization withdrawal, multiple routes, localized missing/empty names, connection reset, late responses, and dialog closing. Geometry hooks are fixture stubs. Saved logs that predate this change and reference a model absent from the current connection have no recoverable name; they show the localized fallback.


### 目标指令的知识空间提交（Harness 0.2.1-rc.2，2026-10-23）

Work 知识空间引用在原生输入的 `plain` 和 `claimed` 两个可编辑阶段更新，提交阶段冻结选择。目标属于原生 command claim，复用编辑器提供的引用节点和插入坐标，知识空间选择与目标文本共用同一草稿。

原生 `SessionInputShell.beginSubmit` 通过可选 `beforeCommandSubmit` 在执行 claim 前等待宿主校验；InputHub 把提交时捕获的引用快照、命令名称/参数和取消信号发送到现有 `conversation/input-before-submit` 串行事件。普通消息继续沿用该事件，旧贡献项可忽略新增的可选 command 元数据。失败沿用原生命令错误处理，保留草稿和附件。

宿主知识空间贡献项只对目标创建和编辑提交范围；目标查看、暂停、恢复、清除、缺少编辑内容及其他指令保留已有范围。范围通过企业账号和空间权限校验后才允许目标执行；后续目标轮次复用 session 选择，输入框发送后的清空保持该选择。普通新消息沿用现有明确替换范围的规则。

扩展点放在已有 conversation 兼容文件中，由 patch-package 在安装时重放，运行时声明与事件类型同步。该文件承载原生输入语义，现有 slots 只提供渲染入口，无法覆盖 command 提交边界。上游提供同等 command 提交前扩展点后迁移并移除对应变更。行为验证见 `test/work-knowledge-composer.test.mjs`，包括命令原生提交方法、权限撤销、取消、范围快照和真实工具注册的检索请求。


### 技能菜单的复用图标（Harness 0.2.1-rc.2，2026-10-23）

原生 popupSelect 的 `SelectOption.badgeIcon` 接收 option owner 的装饰图标组件，在名称旁以 inline-flex 垂直居中显示；文字 badge 沿用原有上标容器。技能 owner 复用菜单 `NavigationIcon(id=skills)` 的 SVG 路径，尺寸 12px、颜色继承原生次级文字 token；其他调用方保持既有文字 badge 和可访问名称。此接缝仅扩展原生候选行的渲染数据，不改变列表、搜索、选择或序列化。实现与类型由 commands 兼容文件重放，上游支持等价图标字段后切换并移除该变更。

### 企业来源统一 Plugin Manager（Harness 0.2.1-rc.2）

企业插件的安装、启停、卸载入口经过现有 `pluginManager`；设置页仍使用企业目录和配置接口。Manager 增加可选的 `profileManagedBundleSource` 宿主服务接缝：`accepts(target)`、`listBundles()` 和 `change(request)`。来源操作使用 Manager 的 Profile 操作锁、统一 `ChangeResult` 和 changed 事件；未匹配来源继续走原有 Profile 路径。此接缝不是新的 runtime 或第二个管理器。

企业来源由 `dsh-desktop-enterprise/managed-market.js` 实现。清单身份包含当前账号摘要与企业插件 ID，安装使用只存在于后端的一次性票据；旧账号目标及已消费票据拒绝执行。业务校验在串行队列真正执行时再次核对账号。来源后端保留现有发布快照、`.enterprise-generations` 和实例凭据撤销，加载改用下述 Harness 根组合内存层；不把受在线授权控制的插件写进普通 Profile 的 bundles。离线、撤权和账号切换继续通过现有控制器卸载实例。配置与授权自动收敛属于企业来源职责。

加载阶段：企业插件仍从经校验的企业 generation 读取入口，并以该包解析客户端和 bundle；普通 Profile 不新增企业持久投影，Safe Mode 不加载此来源。实例激活失败保留原始诊断并走已有更新回退。Manager 必须保留来源报告的 `applied`，不能套用普通 Profile 的 `no-hmr`；来源清单不返回目录、配置或凭据。

企业工作台仍通过 Broker 获取并核验临时 `.tgz`，安装改为 `pluginManager.installBundle`，启停与卸载使用既有 Manager 路径。临时文件保持到整个操作结束，再释放。回移植 upstream V0.13.0 的 `expectedName` / `expectedVersion` / `replace` 接口形态与 verified backend 能力声明：安装后端在发布前校验包身份，Manager 在接受 bundle 前再次核对；不支持或拒绝校验时不得退回普通 pnpm。页面区分已应用、待重启、覆盖、失败及取消，不能把退出码 0 当成激活成功。

升级到 upstream V0.13.0 时，用上游 verified-install 实现替换这部分回移植，保留企业授权来源接缝，除非上游已提供等价的账号范围生命周期 API。不得直接删除企业目录、授权与凭据撤销边界。企业旧 ZIP/npm 包和账号安装记录不迁移格式；本改动统一管理接口，不合并授权存储与普通 Profile 存储。

回归入口：`test/enterprise-plugin-manager.test.mjs` 验证真实 Manager 方法、来源隔离、单次票据、结果语义与 verified backend；`test/enterprise-market.test.ts` 的隔离子进程运行实际 Plugin Manager + Cordis Loader，覆盖安装、启停、坏版本回退及停止。普通 generation 与开关测试保留原契约。真实企业服务、GUI 和 Windows 安装包需另行验收。


### 企业 bundle 的可撤销根组合层（Harness 0.2.1-rc.2）

加载变更覆盖 Profile 组合、后端导入与客户端发现：从已校验的 `.enterprise-generations/<generation>/node_modules/<package>` 读取声明，以该包的 `package.json` URL 为解析基准，通过 Harness 的 `resolvePluginResource` 使用 Node ESM 条件导出解析。普通 Profile 使用此路径；Safe Mode 不提供该接缝。入口解析和内部依赖错误保留原始 cause，控制器继续使用已安装旧版本回退和启停恢复入口。

删除企业 `MarketTree`、独立 group、手工 `packageEntry` 加载和 `createRequire().resolve()`。bundle patches 由标准 `loadOverlayPatches` 读取，插入入口锚定为实际模块 URL，交给 Harness 根 Include；已声明的插件 ID 保持稳定，匿名条目由标准 Loader 分配 ID，重复插入 ID 会明确拒绝，不再随机改写 bundle 身份。patch 的 name 仍是匹配断言。插件直接修改宿主根条目（例如禁用 `compaction-basic`），不再对空树应用补丁。客户端沿用现有 ClientModuleRegistry 的实际模块位置发现机制。

app-boot 增加可选 `profileRuntimeLayers.set/remove` 内存接缝，使用原生 `recomposeCore`、激活审计与回滚。内存层按启用顺序应用在持久 Profile patches 之后，不写 manifest、用户 patch 或 Profile 投影；普通配置重载/HMR 组合保留这些层。移除后使用最新持久层恢复宿主配置，失败不重新添加已撤权层。企业入口自身处于卸载事务时，先撤销凭据并停止自身插件，再排队恢复根配置，避免等待正在等待自己的根事务；排队恢复失败记录日志。

实例 grant 在激活前准备，通过 Cordis 既有 `internal/plugin` 事件绑定到新 fiber context；绝不绑定共享根或可复用 entry context。解绑保留 tombstone，旧实例在新授权后仍不可用。账号、在线授权、Broker、generation 校验和旧版本回退继续由企业适配层负责。

新增子进程行为回归 `test/helpers/enterprise-root-smoke.mjs`，由 `test/enterprise-market.test.ts` 启动：import-only exports、自引用子路径、根替换与恢复、标准客户端 graph/脚本响应、私有依赖、缺少宿主 peer、多个内存层、持久配置重载、坏版本回滚、旧凭据隔离和 owner 卸载。原 isolated Profile/PluginManager 子进程改用真实 root Include；Safe Mode 测试确认不注册内存层。上述不替代浏览器执行挂载、真实企业服务、Windows 和正式安装包验收。

upstream V0.13.0 本身没有企业授权层，合并不会自动替代此接缝。升级时重新验证 app-boot root composition 与 Cordis 事件时序；上游提供等价可撤销层后删除本地补丁并改用官方 API，保留授权与撤权回归。不能保证跨版本无冲突合并。

相关 SDK、community bundle 与 search-market 测试统一改为 root Include fixture；SDK 从同一记录重复挂载改为两个独立记录，另验证重复 ID 被拒绝。缺少服务的断言接受原生激活审计中的 `enterpriseAuth` 诊断，原有搜索选择、用户后续修改和异步清理断言保留。

### 输入框资源图标（Harness 0.2.1-rc.2，2026-10-27）

技能、工具与知识空间的原生引用分别携带 `appearance: skill | tool | folder`，菜单与引用共同使用 `ReferenceIconRegular`。技能与锤子路径来自当前 BISHENG `bisheng-icons@0.2.36` 的 Outlined.Skill / Outlined.Hammer；文件夹复用 Harness 的 FolderClose。图标只承担展示，source、ref、clipboardText、权限校验与模型序列化继续由原 owner 管理。

现有 appearance 协议只有 session/file/folder；本次在原生渲染器、类型与草稿校验枚举中加入 skill/tool，支持保存和恢复。原生节点继续负责整体选中、删除和撤销，布局与主题使用原 ReferenceChip。第三方分发变更通过已有 primitives/conversation 兼容文件记录，并已从恢复的原始文件重放及逐字节比较；上游提供相同类型和图标后迁移至对应发行版，移除本次兼容段并保留行为回归。宿主 ResourceIcon 统一菜单和候选图标，侧边栏导航保留原实现。

回归覆盖菜单插入、真实 ReferenceChip 渲染、草稿持久化、未知枚举拒绝、原 file/session/纯文字草稿兼容及资源序列化。使用局部真实运行时代码的组件验证与完整账号验收分别登记。

实际加载补充：Harness web-frontend 把 primitives 预编译进共享模块，插件 require 与原生引用消费的是该共享模块。`scripts/prepare-reference-icons.mjs` 在安装、开发、构建和测试前从上述唯一图标定义生成对应分支；按公开 `ReferenceIconRegular` 导出定位实现，发现压缩符号并保留内置 session/file/folder 分支，生成区域可重复覆盖。版本或结构变化时构建失败，入口带内容摘要刷新缓存。生成内容留在依赖分发目录，Git 维护生成器和原定义。上游共享前端支持这些类型后一起移除生成步骤。

`test/frontend-reference-icons.test.mjs` 执行完整前端入口及 vendor 依赖，捕获传给 Harness loader 的真实 staticModules，并用其中的 React 与 ReferenceIconRegular 渲染五类图标，覆盖实际运行包与库文件不同步的回归。

### Windows enterprise content navigation (2026-10-28)

Windows window dragging belongs to the existing 40px caption row. The Desktop
mode header and the isolated enterprise Chat header use content-area dragging
only on macOS. `chatLayoutCss(platform)` selects the embedded document's chrome
from the host platform, and the host plugin uses its existing macOS marker.
This keeps the Windows knowledge-space navigation in the client area when the
enterprise view occupies the former Chat / Work header bounds. The host platform owns this boundary for both native views.

The change lives in the owning Desktop stylesheet and enterprise view loader.
The knowledge-space buttons keep their existing navigation and menu handlers.
Run `node scripts/verify-workspace-navigation.mjs` for a temporary-profile
Electron fixture covering host/child regions, Chat → files, directory-menu
selection and back-button SVG clicks, sidebar widths, zoom, locale and theme.
The script reports its native OS explicitly; Windows installation and real-account
acceptance require a Windows run. `verify-chat-window-drag.mjs` retains the
macOS header regression.

### Enterprise usage recovery (2026-10-28)

The account usage slot consumes separately validated summary and storage sections
through the existing host IPC. Each section owns its success/error state, so its
sibling can display available data. Host reads remain fixed to the authenticated
self-service endpoints and the identity-owned cookie session. A 401 renews that
session once per usage operation; both reads share the renewal, and identity
checks bracket renewal, requests and final publication. Logs identify the failed
section and HTTP status while response bodies remain host-owned.

The Usage subscription tracks identity and connection readiness. Mounting and
explicit retry request a host read, which establishes the session when needed;
a ready transition refreshes the data. In-flight reads coalesce readiness events,
and account changes invalidate earlier responses. Repeated error notifications
wait for an explicit retry or a ready transition.

The native fixture `node scripts/verify-usage-recovery.mjs` uses an isolated
Electron profile and the actual settings plugin to verify pointer retry, ready
transitions and independently failing sections. Real-account acceptance remains
an environment-specific check.

### 安全模式语言同步（2026-10-29）

安全模式侧栏复用 preload 已消费的 Harness 活动语言。状态 IPC 只决定安全模式是否启用；侧栏在异步状态返回后读取当前语言，并在每次语言变化时原位刷新文字、辅助说明与折叠按钮名称。按钮节点和操作状态由现有挂载生命周期保留。

主进程语言回调刷新当前安全模式页的完整 view model；每轮页面操作拥有自己的刷新回调和加载序号，操作结束时释放。市场检查结果与语言变化复用同一更新通道，保留已取得的检查数据。页面原位刷新文案、问题分组和插件行，保留勾选、焦点、详细信息展开状态和操作处理中状态。启动恢复提示与恢复记录读取错误携带双语说明及原始诊断；显示时选用活动语言，原始诊断放入可展开的详细信息。智能修复请求在点击时读取语言。

此变更属于自有主进程、preload 和恢复页源码，复用 Harness `__DSH_LOCALE__` 与既有安全模式 frame 通道。独立恢复页仍使用主进程系统语言回退。验证入口为 `test/safe-mode-locale.test.mjs` 与 `node scripts/verify-safe-mode-locale.mjs`；后者使用临时 Profile、真实构建 preload、隔离 IPC 及恢复 HTML，Windows 安装版验收单独登记。
### Work completion notifications (Harness 0.2.1-rc.2, 2026-10-29)

The desktop client UI host registers `desktopWorkCompletion` through the public `sessionProjections` registry. The fold counts successful `turn/end` events after a model step in an ordinary session's own log. Fork-inherited events and subagent sessions retain a zero count. The wire view contains only a monotone completion count, latest turn, event sequence and timestamp; prompt and response text remain in the session. This adds a projection unit to the existing authenticated control stream and preserves its reconnect and cached-baseline semantics. The plugin declares the already shipped Zod dependency and the Harness projection peer.

The desktop client subscribes to the session catalog independently of conversation selection and animation frames. An initial projection establishes the historical baseline; a completion timestamp at or after subscription also admits a fast task that finishes before its first catalog delivery. Later count advances include work completed during a transport interruption. A coalesced advance produces one notification summarizing the number of completed turns. Client lifetime state and the main process's per-session sequence watermark consume repeated snapshots once. Desktop HMR installs one owned subscription and click listener, and releases both on disposal.

The preload exposes `dshDesktopNotifications.completed` and `onClicked` using contextBridge. Main validates the sending WebContents, main frame and scalar payload, then uses native visibility, focus and minimized state to decide delivery. A focused visible window consumes the completion silently; a background, hidden or minimized window requests the Electron notification with the packaged app icon. Clicking shows/restores/focuses the window and opens the corresponding Work session through `uiWorkspace.openSession`. Windows initializes the NSIS identity (`io.bisheng`, or `io.bisheng.dev` for development) before readiness and notification registration. The browser Notification API retains its native implementation and permission state.

Notification audit records go to the existing `harness.log` with `[desktop-notification]`: rejected, foreground, unsupported, requested, shown, failed and clicked. `shown` records Electron's callback; Windows visual acceptance remains a separate gate. Failures retain bounded system error detail with URL and credential-value redaction. Audit facts contain session identifiers and completion metadata only.

Regression coverage: `test/work-completion-notifications.test.mjs` exercises the installed projection registry and a real AgentLoop with a fixture model transport; `test/desktop-notification.test.ts` covers the native policy and toast lifecycle at the Electron API boundary. `node scripts/verify-work-notifications.mjs` launches an isolated real Electron window with context isolation and sandbox enabled, exercises the actual preload/main IPC, icon decoding, file audit and click/session routing, and replaces only the OS toast object. Windows installed-package NOTICE-001/002/003 testing covers native sender identity, icon, visible toast, focus and restoration.
