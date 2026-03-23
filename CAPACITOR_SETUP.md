# Android 打包状态

当前仓库已经完成这些内容：

- 已接入 PWA，可继续通过 Render 网址访问
- 已安装 Capacitor 依赖
- 已生成 `android/` 原生工程
- 已执行 `npx cap sync android`

## 继续生成安卓安装包

在项目根目录执行：

```bash
npm run android:open
```

这会打开 Android Studio 工程。之后可以：

- 调试运行到安卓真机
- 导出 `APK`
- 导出 `AAB` 上传到应用市场

## 后续同步网页改动

每次你修改网页前端后，执行：

```bash
npm run android:sync
```

这样会把最新网页资源同步进 `android/` 原生壳。

## 说明

- 网页版继续走当前 Render 网址访问
- 安卓版现在已经具备原生工程基础
- iPhone 仍建议走网址打开或“添加到主屏幕”
