# 企业插件市场 · V0.9.2

企业登录有效时，设置的插件页显示“来自企业”。列表显示当前企业提供的插件，支持安装、更新、启用、停用和卸载；退出账号后移除入口，切换企业后重新读取对应目录。页面使用产品语言，支持中英文、加载失败重试和每个插件独立的操作状态。

## 当前管理入口

企业插件的安装、启用、停用和卸载现在统一经 Harness Plugin Manager；企业控制器作为账号范围的来源后端，继续持有在线授权、隔离安装记录和 Loader 实例生命周期。Manager 的清单也包含当前账号的企业插件。旧账号目标不能作用于新账号；设置页保留企业目录与配置编辑。

此次不迁移历史 ZIP/npm 包或用户安装记录，也不把企业插件投影进普通 Profile。实现接缝及升级退出条件见 [Patch 与 Plugin 规范](patch-plugin-contract.md#企业来源统一-plugin-managerharness-021-rc2)。

## 实现边界

- Electron 主进程持有企业凭据，通过限定的 `/v1/market` Broker 请求同一企业服务的 capabilities、catalog、sync 和 artifact 接口。账号标识与请求 epoch 校验隔离切换前后的响应，401 触发一次凭据刷新。
- Harness 侧用在线席位和未签名发布快照校验租户、账号、设备和插件版本；凭据保持在主进程。
- 离线包校验覆盖摘要、文件清单、目标平台、解压路径和宿主 peer 依赖。带根级 `package.json` 的 npm 包用 pnpm 装进同一套企业目录，安装记录保存文件清单摘要；未打进 `bundledDependencies` 的依赖需要可达的 npm registry。带 `manifest.json` 且没有 npm 元数据的离线包仍可离线安装。插件保存在 `profiles/.enterprise-generations`，由真实 Cordis Loader 加载；更新失败恢复旧版本。席位撤销、会话到期或短暂断网时停止运行实例，安装记录保留，恢复连接后按用户开关重新启用。
- 企业后台提供目录和离线包。列表中的插件取决于实际登录的企业数据。市场契约版本为 2。

## 插件包制作

准备生产依赖目录，在 JSON 中定义 `plugin` 元数据和 `targets`（平台到准备目录的映射），运行：

```sh
node scripts/pack-enterprise-plugin.mjs release.json plugin.zip
```

本次企业市场提测插件的制包配置使用 `plugin.desktop_min: "0.9.1"`，使 `0.9.2-test.1` 等测试包通过版本检查。该字段随插件包发布，后台目录应使用重新制包后的 manifest；桌面继续按标准 SemVer 比较。最低版本声明需要与插件实际依赖的宿主能力一致。

脚本读取已准备的依赖树，输出带文件摘要的离线包。详细接收合同由 `offline-bundle.js` 校验。管理员将 ZIP 导入企业后台后，客户端可从“来自企业”安装。

## 通用企业认证通道

市场插件通过 `ctx.enterpriseAuth.getState()` 和 `ctx.enterpriseAuth.request(path, init)` 使用企业认证，不获取企业 token。服务在未登录时仍注册，调用请求时明确返回 `not_connected`。宿主不理解业务 API，不维护业务路径白名单；新增相对 API 路径不需要更新 Desktop。完整接口、安全边界和限制见 [通用企业认证通道](enterprise-auth-channel.zh.md)。

当前授权单位是通过企业市场校验、启用的插件执行实例；实例由宿主 Loader 创建，随机独立凭证由主进程签发，停用、卸载、激活失败和运行时关闭时撤销。**后端若只校验用户 token，则获准使用此通道的插件可以调用该用户有权访问的企业 API。**这不是逐业务接口授权；细粒度控制由企业后端结合宿主覆盖的插件身份头实施。

搜索插件负责注册 provider、选择或替换以及清理恢复。宿主不再提供搜索专属服务或本地搜索 Broker。旧版搜索 ZIP 必须迁移至通用 SDK 后重新发布，不能只依赖安装成功来判断兼容性。宿主企业插件仍显式依赖 `loader`，企业 generation 通过当前安装目录校验缺失的 `@deepseek-ai/*` peer，不从宿主补普通第三方依赖。

源码行为回归：

```sh
npm test -- test/enterprise-auth-transport.test.ts test/enterprise-auth-sdk.test.mjs test/enterprise-search-bridge.test.ts test/enterprise-search-market.test.ts test/enterprise-market.test.ts
```

打包后用实际市场 ZIP 验证（macOS 路径示例，先设置 APP 和 PLUGIN_ZIP）：

```sh
ELECTRON_RUN_AS_NODE=1 "${APP:?}/Contents/MacOS/BISHENG" --expose-internals scripts/verify-enterprise-search.mjs "${APP:?}/Contents/Resources" "${PLUGIN_ZIP:?}"
```

脚本使用临时 DSH_HOME、本地测试 Broker、临时 Ed25519 授权和真实 Cordis Loader，验证实际插件包的下载、摘要和 peer 校验、激活、搜索、停用、启用和卸载；不读取真实账号凭据、不请求生产搜索服务，也不修改现有 Profile。只有该脚本在重建应用与已迁移插件 ZIP 上成功运行，才证明对应打包运行时与插件包可组合；本次尚未执行安装包验证，也不代替真实企业账号、完整 GUI 或 Windows 原生验收。

## 本次迁移

基线：`upstream/V0.9.2@294e9290262dd68f402fa526cfb6aeacd571f627`；Harness：`0.1.5-rc.2`。功能源自本地企业完整试用包 r2 的市场模块，本次保留 V0.9.2 的登录和账号页，并接入该版本的凭据代理与 locale 服务。

自动验证覆盖 UI 登录/退出/租户切换、分页及逐插件操作状态、英文入口、Broker 401 重试和越界请求拒绝、离线包校验、真实 Loader 加载和更新回退。当前分支真实企业登录、安装包截图和 Windows 原生验收标记为 `NOT_RUN`；旧试用包截图可说明产品交互，当前分支验证以本次记录为准。

## PR #519 评审修正

- 桌面版本由 Electron 的 `app.getVersion()` 经企业 Broker 状态传给市场，界面和安装共用后端的 SemVer 判断；缺失版本时提示兼容性受限。发布标签版本、预发布版本均参与标准版本比较。
- 分发不再使用独立签名密钥，也不再读取 `DSH_DESKTOP_MARKET_PUBLIC_KEY`。安装记录只保存设备、已安装插件、用户开关和配置。服务端确认下架、禁用或摘要变化时关闭用户开关。协议版本不是 2 时保留安装记录，并提示管理员升级服务。
- 退出和授权到期立即使在途与排队操作失效，状态清理、同步、安装和 Loader 操作共用串行队列。在途请求由 Broker 超时限制结束后清理。目录查询最多 100 页、10,000 条，响应必须包含有效总数，空页结束查找。
- 企业包显式声明 Loader、市场安装器和 SemVer 依赖。隔离测试把声明依赖复制到仓库外，子进程使用真实 Loader 验证安装、停用、启用和更新失败回退；另使用打包 Node 24.9.0、全新 DSH_HOME 启动真实 Harness 并验证市场状态路由。

上述测试使用本地发布快照与隔离 Profile。真实企业账号登录、正式安装包、Windows 原生路径及文件占用验收仍为 `NOT_RUN`。Windows 非法路径拒绝用例在 macOS 上运行，可验证校验规则；Windows 文件系统行为需对应环境验证。卸载和更新只改账号安装记录；下次冷启动在 Harness 拉起前，按全部企业账号的 `installed` 回收 `profiles/.enterprise-generations` 与 `.enterprise-staging` 中不再被引用的目录。停用版本、其他账号仍安装的版本、tombstone 和审计日志保留。
