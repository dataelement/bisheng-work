# 设置入口与账号兼容

Desktop 当前基于 Harness `0.2.0-rc.2`，普通模式和 Safe Mode 均禁用上游 `@deepseek-ai/dsh-client-ui-settings-account`（`ui-settings-account`）。这同时停用该插件的侧栏账号菜单、模型 onboarding 登录入口及账号设置页；不删除账号凭据或用户 Profile。

设置按钮、快捷键和外框继续由 `settings-general` 提供。普通模式沿用 DSH 默认的平级导航、通用设置行、标题区操作和插件标签页，不再覆盖四个布局 slot 或添加高级折叠层。`dsh-desktop-settings` 和 `dsh-desktop-enterprise` 通过既有 section / tab / account 扩展点补入 Bisheng 内容。企业认证继续由主进程维护；网页账号资料、用量及审批只以内容模式嵌入。Safe Mode 保留原有核心设置，不加载这项可选整合。

`settings.launcher` 的声明、出口和其他插件贡献保持原样。普通模式由 `dsh-desktop-settings` 提供企业账号入口，展示账号名称与头像缩写，菜单依次为设置、消息、连接手机、退出登录。它消费现有主进程企业服务的状态与退出端点，不恢复上游账号服务。消息打开独立 Modal，不再注册为 settings.section；连接手机复用受信任主窗口限定的原生配对入口。未登录时仍可进入本机设置和手机配对；企业操作禁用。Safe Mode 或卸载该可选插件时，原设置按钮及旧手机按钮继续可用。将来恢复上游账号功能时，需先解决单一账号入口与企业身份归属，再撤销组合层覆盖，避免同时出现两套账号设置。

整合边界及验收范围见 [统一设置](settings-integration.zh.md)。`test/settings-account-launcher.test.js` 验证两套组合层的禁用结果；`test/desktop-settings-view.test.mjs` 和 `test/desktop-settings-runtime.test.ts` 覆盖 DSH 默认布局与 Bisheng 贡献的组合及真实 Harness 脚本发现。上述测试不能替代已安装客户端、企业认证后的原生网页视图和 Windows 验收。
