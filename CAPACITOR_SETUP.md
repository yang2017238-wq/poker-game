# Android 打包准备

当前仓库已经补好了 PWA 基础和 `capacitor.config.json`。

如果你要继续生成安卓安装包，下一步在项目根目录执行：

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap add android
npx cap sync android
npx cap open android
```

说明：

- 网页版仍然继续走当前的 Render 网址访问
- 安卓版会在 Android Studio 里生成原生工程
- 之后可以导出 `APK` 或 `AAB`
- iPhone 仍建议继续走网址打开或“添加到主屏幕”
