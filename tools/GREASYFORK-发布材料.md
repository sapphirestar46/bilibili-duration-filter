# GreasyFork 发布材料

> 供手动填写 GreasyFork「发布脚本」表单使用。逐项复制即可。

---

## 一、脚本文件

**不要**上传整个仓库，只需上传单个 `.user.js`。

- 本地路径：`D:\dsh\bilibili\bilibili-dynamic-duration-filter.user.js`
- 在线地址（可直接粘进 GreasyFork 的「从 URL 导入」）：
  ```
  https://raw.githubusercontent.com/sapphirestar46/bilibili-duration-filter/master/bilibili-dynamic-duration-filter.user.js
  ```

---

## 二、表单字段

**脚本名称**
```
B站动态 · 视频时长筛选
```

**描述（一句话，会显示在列表里）**
```
在 B 站动态页「视频投稿」标签下注入双滑块时长筛选条，按视频时长区间过滤动态卡片，纯前端实现。
```

**语言**：简体中文

**许可证**：MIT

**脚本分类 / 标签**（若表单支持）
```
bilibili, tampermonkey, userscript, duration-filter
```

**支持页面（@match）**：脚本元数据已声明，无需在表单填写
```
https://t.bilibili.com/*
```

**附加信息（Additional info / 说明）**：见下方第三节正文

**源代码地址 / 主页**
```
https://github.com/sapphirestar46/bilibili-duration-filter
```

---

## 三、附加信息正文（可直接粘贴）

```markdown
在 B 站动态页（t.bilibili.com）的「视频投稿」标签下，加入一条双滑块时长筛选条，按视频时长区间过滤动态卡片。

## 为什么需要它

动态页把视频投稿、图文、专栏、追番混排在一起。想找「十分钟以上」或「半小时以内」的内容，只能一条条往下滑。
本脚本读取每条动态封面右下角已有的时长文本，用双滑块设定区间后直接隐藏不匹配的卡片。

## 功能

- **双滑块区间**：0 – 3 小时，可表达「10–30 分钟」这类区间（不是单侧阈值）
- **刻度偏向长视频**：0–10 分钟占左侧 30%，10 分钟–3 小时占右侧 70%，筛长视频时拖动更精细
- **9 个预设**：不限 / ≤1分钟 / 1–5 / 5–10 / 10–30 / 30–60 分钟 / ≥1小时 / ≥10分钟 / ≥30分钟
- **只在视频投稿生效**：切到「全部 / 追番追剧 / 专栏」时整条隐藏，且不隐藏任何内容
- **吸顶自动收紧**：向下滚动后压缩成只有滑条的窄条，并自动避开 B 站固定页头
- **自动加载更多**：可见视频不足 20 条时自动补充，不会把滚动位置拽走（仅视频投稿标签）
- **时长未知不误伤**：视频但拿不到时长时保留显示
- **状态记忆**：区间、开关、选项自动保存

## 快捷键

- `Alt + Shift + D`：启用 / 停用筛选
- `←` `→`：焦点在滑块上时步进 1 分钟
- `PageUp` / `PageDown`：步进 5 分钟
- `Home` / `End`：跳到区间两端
- 双击滑块：单独重置该端

## 使用方法

打开 https://t.bilibili.com/ ，**点击「视频投稿」标签**，筛选条会出现在标签栏下方。

> 在「全部」标签下看不到筛选条是**预期行为**：那里混排了图文、专栏，按时长筛选没有意义。

## 安装前必读

新版 Chrome / Edge 使用 Tampermonkey 时，需要先为它开启一次「允许用户脚本」权限：

- Chrome：地址栏输入 `chrome://extensions` → Tampermonkey「详细信息」→ 开启「允许用户脚本」
- Edge：地址栏输入 `edge://extensions` → 同上

这是浏览器层面的一次性授权，不需要为每个脚本重复开启。若看不到该选项，请按页面提示开启「开发者模式」。

## 已知限制

- 仅支持 `t.bilibili.com`，首页 / 搜索页 / 分区页不适用。
- 依赖 `.bili-dyn-list__item`、`.duration-time` 等页面类名，**B 站前端改版可能导致失效**（典型表现：计数正常但筛选不生效）。
- 统计范围是当前已渲染的动态，被屏蔽、被折叠、尚未加载的不计入。
- 时长未知的视频不会被隐藏（保守策略），所以只看短视频时可能混入少量长视频。

## 隐私

脚本在浏览器本地运行，仅读取页面已渲染的 DOM 并调整显示状态。**不拦截请求、不修改接口、不上传任何数据**，停用脚本即可完全复原。

## 源码

https://github.com/sapphirestar46/bilibili-duration-filter
```

---

## 四、操作步骤

1. 打开 <https://greasyfork.org/zh-CN/users/sign_in>，用 GitHub 账号登录（你没有 GreasyFork 账号的话，直接选「Sign in with GitHub」最快）。
2. 登录后访问 <https://greasyfork.org/zh-CN/script_versions/new>。
3. 选择「从 URL 导入」（Import from URL），粘贴第一节里的 raw 地址，让 GreasyFork 自动读取元数据。
   - 若导入失败，改选「直接输入代码」，把 `.user.js` 全文粘进去。
4. 核对自动读出的名称 / 版本 / 描述，补上第三节正文。
5. 提交。

## 五、以后更新版本

改了脚本后，按顺序执行：

```bash
# 1. 改 @version（例如 1.5.0 -> 1.5.1）
# 2. 提交并推送到 GitHub
git add -A && git commit -m "fix: xxx" && git push
```

然后到 GreasyFork 的脚本页面 →「管理」→「上传新版本」→ 再次用同一个 raw 地址导入。GreasyFork 靠 `@version` 判断更新。

> 提示：git 推送需要代理。当前 git 全局代理已配置为 `http://127.0.0.1:7897`（原先的 17890/7890 已失效）。
