# ERNIE Harness 公开仓库与展示站

用户已授权公开 GitHub 仓库、使用 MIT 并建设参考 DeepSeek Harness 的展示网站。直接执行，部署到项目自带的 GitHub Pages，无额外付费服务。

## 设计

独立深蓝视觉；主色为 ERNIE 蓝，字色接近白，细边框与宽留白。首页依次为导航、双栏主视觉、可切换工作台预览、三端共核能力、持久 Super-Agent 流程、真实模型边界与带日期的评测状态、安装入口、FAQ、页脚。复用自绘 SVG 标识，制作独立矢量社交预览。中文优先，支持移动导航、键盘、减少动画偏好、命令复制；交互演示明确不连接模型。

## 技术与授权

使用 docs/index.html、docs/site.css、docs/site.js 和 docs/site-assets/ 的纯静态文件；docs/.nojekyll；GitHub Pages 从 main:/docs 发布，无新增运行时依赖、模型请求或统计跟踪。现有设计文档与工作台独立。MIT 覆盖项目原创源码，第三方材料和 ERNIE 商标依原许可及权利声明处理。

## 验收

MIT 正文、package license 与 README 一致；公开前检查实际提交与历史无凭据。桌面和移动端浏览器无页面错误、溢出或缺失资源；预览切换、流程切换、复制、移动导航和键盘可用。pnpm check 通过。远端仓库 public 且识别 MIT；Pages 公开地址可访问，发布提交与本地一致。
