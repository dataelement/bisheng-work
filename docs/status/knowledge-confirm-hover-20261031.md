# Work 知识空间确认按钮悬停修复

## 基线与实现

本次修复属于 BISHENG Desktop 1.2.0 的原生 Work 知识空间选择器。2026-10-31 在线核对目标 `dataelement/bisheng-desktop:V1.2.0` 为 `e928c8c3bd5d2f188f17b7d93e0fbd7bc13eaf90`，从该版本创建 `codex/v120-knowledge-confirm-hover`。工作目录为 `bisheng-work-v120-knowledge-confirm-hover`，干净安装的 Harness 为 `0.2.1-rc.2`，Electron 为 `43.0.0`。

确认按钮使用的 `--dsw-alias-state-business-secondary` 在当前发行版的深浅主题中均无定义。鼠标悬停后，CSS 背景声明在计算时失效，背景变为透明，露出弹窗底色。修复直接修改宿主插件 `packages/dsh-desktop-client-ui/client.js` 的原有悬停声明，使用现有业务主色与主文字色混合生成悬停色。浅色主题加深蓝色，深色主题提亮蓝色，保留原有正常态、字号、边框及选择提交逻辑。

## 验证范围

`node scripts/verify-knowledge-confirm-hover.mjs` 加载发行版完整前端入口中的 React、Button、Modal 和原有主题样式，运行知识空间组件与样式注册逻辑。目录接口及编辑器存储采用隔离 fixture，用户 Profile 使用临时目录。

检查覆盖深浅主题、中英文、1100/560 像素窗口及 Windows/macOS 页面标记，共 16 组；通过原生鼠标输入检查正常、悬停、按下状态，验证透明度与文字对比度、键盘焦点、加载/错误禁用态、勾选与确认提交。页面标记只控制样式，实际宿主平台由结果单独记录。

支持 `KNOWLEDGE_SOURCE` 指定基线插件源码，用同一脚本验证修复前后的表现；`KNOWLEDGE_VERIFY_OUTPUT` 可指定证据输出目录。默认输出在 `artifacts/knowledge-confirm-hover/`。

- 干净依赖安装及全部既有兼容变更重放完成，类型检查和生产构建通过。Office 构建资源复用同版本内容寻址缓存，构建入口继续执行完整性校验。
- 同一脚本读取基线源码时，在首组浅色主题鼠标悬停检查失败：背景 alpha 为 0，预期为 255。修复后的 16 组检查通过。
- 修复后浅色主题悬停背景为 RGB(59,106,205)，文字对比度从约 4.23 提升到 5.09；深色主题为 RGB(137,180,255)，文字对比度从约 8.12 提升到 9.03。深浅主题截图已检查。
- 原生验证宿主为 macOS arm64 / Electron 43.0.0。Windows 页面标记纳入渲染检查；Windows 安装包、真实企业账号及原机验收待执行。
- 完整串行回归 `npm test -- --maxWorkers=1` 通过：321 个文件 / 3,179 项通过，4 个文件 / 5 项按环境条件跳过，耗时约 465 秒。JS 语法与差异检查通过。
