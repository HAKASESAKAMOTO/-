# 当前整合范围与接口

`app-catalog.json`是两栋浏览楼与两款海报生成器的唯一目录。浏览内容为classic旧版建筑、ecology灯光建筑；分享只生成和下载PNG。classic-poster支持蓝/黄两种配色及四个固定观看面；ecology-poster导出当前角度和缩放。两种配色不另外算两款生成器。

统一服务使用`/api/v1`，成功`{schemaVersion:"1.0",data}`，失败`{schemaVersion:"1.0",error:{code,message}}`。照片URL、预览、下载返回二进制；SSE每条data也使用上述成功包。

两栋楼均暴露`window.layeredLifeViewer`：`apiVersion`、`buildingId`、`getState()`、`setView({angleDegrees,zoom?})`、`reset()`、`exportPoster(options?)`。状态为`{ready,buildingId,angleDegrees,zoom}`；角度是相对初始视角的度数。classic不支持缩放，zoom固定1。`exportPoster`经统一服务返回海报任务，轮询任务后下载。V2另有内部`renderPosterBlob()`供导出进程使用。

Rodin状态为`pending_module`，没有伪造生成接口；后续模块接收sessionId、photoId、objectId、inputVersion，以及归一化userBox/userPoint和AI结果。现有照片和标注保存于对应session目录的workspace.json，之后可直接读取。原图、processed图与缩略图继续由receiver管理。

AI分析适配已存在，2026-10-17已找回并纳入原有System Prompt V1.0，默认文件为deepseek-image-analysis/system-prompt.txt，当前能力状态为configured。现有测试用例不代表在线分析已重新验收。

调用详见[统一运行接口](../docs/统一运行接口.md)。
