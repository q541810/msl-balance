# 大肥鱼余额显示

<p align="center">
  <strong>Marcel SSH 右下角常驻 DeepSeek 余额挂件 · 本地小鲸鱼气泡 + 余额实时掌握</strong>
</p>

---

小鲸鱼娘住在 Marcel SSH 右下角，帮你盯着 DeepSeek 账户余额。支持拖拽吸附、镜像翻转、Q 弹挤压、梁文峰/文谷双档计价，随界面自动启用。

![cover](https://img.cdn1.vip/i/6a868da31766f_1787202979.webp)

## 特性

- 🐋 **常驻自启**：随 Marcel SSH 界面每次打开自动出现
- 💰 **余额**：60 秒自动刷新 + 点击气泡手动刷新；余额变化时数字**滚动动画**；网络抖动自动沿用最近余额
- 🖱️ **拖拽 + 四边吸附**：靠近任意边自动吸附（可组合成角，阈值偏严格避免误吸）
- 🔄 **镜像翻转**：吸附到左半边时整体水平翻转（文字同步反向、带动画）；吸附到上边时垂直翻转
- 🧸 **Q 弹挤压**：按压/按 Q 键时底部坐标不变的果冻挤压（`scaleY(0.88) scaleX(1.05)` + 过冲回弹）
- 🎚️ **尺寸调节**：在 **设置 → 插件 → 大肥鱼余额显示** 中滑块调节 0.6–1.4×，所见即所得（基准 196px）
- 💹 **梁文峰 / 梁文谷**：按北京时间高峰 9-12/14-18 与空闲双档计价，`hint` 高峰显示“文峰当班” ，空闲“文谷摸鱼”，悬浮可见完整价目（输入命中/未命中/输出 空闲/高峰两档）
- 📐 **视口钳制**：自由位置自动钳制到视口内，重启/窗口缩放不再跑丢

> 高峰为北京时间 9:00-12:00、14:00-18:00，其余为空闲。

## 安装

### 方式一：插件市场（推荐）

Marcel SSH → 设置 → 插件市场 → 搜索“大肥鱼余额显示” → 安装 → 重启应用

### 方式二：手动

1. 下载本仓库 ZIP / `git clone`
2. 将 `msl-balance` 文件夹放入 `<app-config-dir>/plugins/`  
   - Windows: `%APPDATA%\com.marcel.ssh\plugins\`
   - macOS: `~/Library/Application Support/com.marcel.ssh/plugins/`
   - Linux: `~/.config/com.marcel.ssh/plugins/`
3. 重启 Marcel SSH
4. 设置 → 插件 → 大肥鱼余额显示 → 填入 `DeepSeek API Key`（`sk-` 开头）与 `Base URL`（默认 `https://api.deepseek.com/v1`，需包含 `/v1`）

> Key 仅保存在插件目录的 `config.json`，不会上传。

## 配置

- **API Key / Base URL**：在插件设置页填写，Key 为空时气泡显示“未配置 Key”
- **挂件尺寸**：设置页滑块 0.6–1.4×，预览与真实 1:1
- **梁文峰/文谷**：设置页开关控制是否显示人格化提示，关闭则回落为“点击刷新”

## 使用

- **刷新**：点击气泡
- **拖拽**：长按鲸鱼区拖动，靠近边缘自动吸附
- **挤压**：按压挂件任意位置或按 `Q` 键
- **镜像**：拖到左半边自动翻转，文字保持可读

## 隐私

插件仅本地读取 `config.json` 与调用 `api.deepseek.com/user/balance`，不含埋点与上传。

## 致谢

- 视觉/交互参考 [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
- 桌宠配置交互参考 **蕾米埃尔小桌宠**（`marcel-pet`）
- 封面图：`DSniang02.png` 自制 + `cover.webp`

## 协议

MIT
