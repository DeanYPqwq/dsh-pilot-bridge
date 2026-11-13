# dsh-pilot-bridge

把 DeepSeek Harness（DSH）的**审批**与**提问**转发到 iPhone，并接受手机端的决定。

配合 iOS 客户端 **DSH Pilot** 使用：手机上点「批准」或选定答案，电脑上正在等待的工具调用会立刻继续。

---

## 快速开始（可复制）

把下面整段交给你的 DSH，它能据此完成安装：

```
请在 DeepSeek Harness 中安装 dsh-pilot-bridge 插件，步骤如下：

1. 克隆或下载本仓库到任意目录：
   git clone https://github.com/deanyp2013/dsh-pilot-bridge.git

2. 复制插件到 DSH 的 desktop profile：
   cp -R dsh-pilot-bridge ~/.dsh/profiles/desktop/node_modules/dsh-pilot-bridge

3. 编辑 ~/.dsh/profiles/desktop/package.json，做两处修改：
   a) 在 dependencies 中加入：
      "dsh-pilot-bridge": "file:./node_modules/dsh-pilot-bridge"
   b) 在 dsh.profile.bundles 数组末尾加入：
      "dsh-pilot-bridge"

4. 重启 DSH。确认插件已加载：
   - 浏览器打开 http://127.0.0.1:3103/pair 能看到配对页
   - 控制台日志出现 listening on https://0.0.0.0:3102

5. 在 iPhone 上打开 DSH Pilot：
   - 第一个输入框填 DeepPilot 的配对码（对话用）
   - 第二个输入框填 3103 页面上的配对码（审批用）
   - 点「开始配对」

完成后，电脑上出现审批或提问时，手机和电脑会同时显示卡片，
在任意一端作答都会立即生效，且不会超时消失。
```

---

## 它解决什么问题

DSH 的工具调用在需要授权时会弹审批；模型也可能用 `ask_user_question` 向你提问。
这些交互原本只能在电脑前处理。本插件把它们变成可远程应答的通道：

```
DSH 工具调用 → approval/request waterfall ─┐
                                           ├→ WebSocket → iPhone
ask_user_question → user-questions/request ┘
```

手机回答后，插件把结果作为 waterfall 的返回值交回 DSH，工具调用随即继续。

**它不转发对话内容。** 对话由 `dsh-deeppilot` 负责；两者分工明确，互不干扰。

---

## 前置条件

| 项目 | 要求 |
|---|---|
| DeepSeek Harness | 已安装并能正常运行 |
| dsh-deeppilot | 已安装（负责对话，必须） |
| iOS 客户端 | DSH Pilot，与电脑处于同一局域网 |
| Node.js | 随 DSH 提供，无需单独安装 |

---

## 安装

### 方式一：命令行

```bash
# 1. 取代码
git clone https://github.com/deanyp2013/dsh-pilot-bridge.git
cd dsh-pilot-bridge

# 2. 放进 profile 的 node_modules
cp -R . ~/.dsh/profiles/desktop/node_modules/dsh-pilot-bridge

# 3. 改 profile 的 package.json（见下）
```

`~/.dsh/profiles/desktop/package.json` 需要两处修改：

```json
{
  "dependencies": {
    "dsh-deeppilot": "^0.9.1",
    "dsh-pilot-bridge": "file:./node_modules/dsh-pilot-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-deeppilot",
        "dsh-pilot-bridge"
      ]
    }
  }
}
```

```bash
# 4. 重启 DSH
```

### 方式二：把「快速开始」里的那段文字交给 DSH

DSH 会自己完成复制文件与修改配置。

### 验证安装

```bash
# 服务在监听
curl -sk https://127.0.0.1:3102/phone/health
# → {"ok":true,"server":"dsh-pilot-bridge","version":"0.1.0","devices":0}

# 配对页可打开
open http://127.0.0.1:3103/pair
```

同时在 DSH 的「插件」页应当能看到 **dsh-pilot-bridge**（`Pilot Bridge`）。

---

## 配对（在 iPhone 上）

配对分两步：**先配对话主机，再配审批桥接**。DSH Pilot 的配对页有两个输入框。

```
① DSH Pilot 配对码（必填）
   [                              ]

② 审批桥接配对码（选填）
   [                              ]
```

### ① 取得对话主机的配对码

在电脑上打开 DeepPilot 的设置页，点「显示配对二维码」。
它给出二维码和一条可复制的配对串。

### ② 取得审批桥接的配对码

在**电脑本机**的浏览器打开：

```
http://127.0.0.1:3103/pair
```

页面上有二维码和「复制配对串」按钮。

> 必须是 `127.0.0.1`、`http`、`3103` 端口。它只监听回环地址，局域网内其他设备访问不到 —— 这是刻意的：浏览器无法打开自签名 HTTPS 页面，而为了配对去安装根证书并不划算。

### ③ 在手机上填写

- ① 填 DeepPilot 的配对码（**必填**，只填 ② 无法配对）
- ② 填 3103 页面上的配对码（选填）

两个配对码都是**一次性**的，**5 分钟**内有效。

也可以直接**扫码**：扫到的码会自动识别类型并填入对应输入框。

### ④ 点「开始配对」

- 成功：弹窗自动关闭，主机页出现**一台**主机
- 失败：弹窗保持打开，并用红字说明原因（例如"这一串是审批桥接的配对码，请填在下面的输入框"）
- 配对过程中按钮显示「配对中…」并禁用，避免重复提交

### 重新配对

在「主机」页点进已配对的主机 →「重新配对」，同样有**两个输入框**：

- 只改 ①：更换主机地址，其余设置保持不变
- 只改 ②：补配或更新审批桥接，**主机完全不动**
- 两个都改：先重配主机，成功后再配桥接

两个输入框会**预填上次使用的配对码**。由于配对码已过期，必须粘贴或扫描一串新的才能提交（没改动时按钮禁用）。

---

## 使用

### 审批

电脑上出现审批时，**手机和电脑同时**显示卡片：

- 手机：出现在**发起该审批的那个对话**里，固定在输入框上方
- 电脑：常规审批弹窗

在任意一端批准/拒绝，另一端随之消失，工具调用立即继续。

### 提问

模型调用 `ask_user_question` 时同理：

- 卡片出现在对应对话的输入框上方
- 手机可直接选择选项或自行填写
- 提交后卡片立即消失，答案回传给模型

### 行为约定

| 约定 | 说明 |
|---|---|
| **双端同时显示** | 电脑和手机都能看到、都能作答 |
| **无超时** | 卡片不会自动消失，放着多久都在 |
| **任意一端作答即生效** | 不会出现"两边都要点" |
| **手机离线不影响电脑** | 桥接未连接时完全不干预，电脑端照常弹审批 |
| **不切换主机** | 桥接是当前主机的附属连接，不会作为第二台主机出现 |

---

## 远程推送（APNs）

App 在后台或被系统挂起时，socket 已经断开，卡片无法送达。此时桥接会改用系统推送。

**触发条件**：审批或提问发起时，桥接判定手机**不在线**（没有活跃的已认证连接，
或连接超过 90 秒没有任何帧）。App 在前台时不发推送 —— 避免同一件事既弹卡片又弹通知。

**配置**（三样缺一不可）：

| 项目 | 说明 |
|---|---|
| `.p8` 私钥 | 在 Apple Developer → Keys 创建，勾选 *Apple Push Notifications service (APNs)* |
| Key ID | `.p8` 文件名里的 10 位，例如 `BQ6Z7897DJ` |
| Team ID | 开发者账号的 Team ID |

默认从 `~/Documents/keys/AuthKey_<KeyID>.p8` 读取，可用环境变量覆盖：

| 环境变量 | 默认值 |
|---|---|
| `PILOT_APNS_KEY` | `~/Documents/keys/AuthKey_BQ6Z7897DJ.p8` |
| `PILOT_APNS_KEY_ID` | `BQ6Z7897DJ` |
| `PILOT_APNS_TEAM_ID` | `7PG83J22AP` |
| `PILOT_APNS_TOPIC` | `com.dshpilot.app` |
| `PILOT_APNS_ENV` | `sandbox`（Debug 构建）；上架版本改为 `production` |

> JWT 用 ES256 签名，缓存 50 分钟。签名必须是 `ieee-p1363`（裸 R‖S），
> 用 DER 编码会被 Apple 拒绝。

**设备 token**：App 连上桥接后通过 `c2s.push.register` 上报，桥接持久化到
`~/.dsh/pilot-bridge/devices.json`。

---

## 端口

| 端口 | 用途 | 监听范围 |
|---|---|---|
| 3102 | HTTPS + WebSocket（插件本体） | 0.0.0.0（局域网可达） |
| 3103 | 配对页 `/pair` | 仅 127.0.0.1 |

---

## 协议

- **传输**：TLS + WebSocket，P-256 证书，客户端按 SPKI 指纹固定
- **认证**：`s2c.auth.challenge` → `c2s.auth.prove`（ECDSA P-256 / SHA-256）→ `s2c.welcome`
- **配对**：`POST /phone/pair`，一次性配对码，返回 `201` + `{ok, deviceId, audience, scopes, tlsFingerprint}`
- **帧**：`{ v: 2, type, ts, id?, seq?, payload }`

关键帧：

| 方向 | 类型 | 说明 |
|---|---|---|
| s2c | `pending.approval` | 新审批 |
| s2c | `pending.question` | 新提问 |
| s2c | `pending.cleared` | 该项已处理，撤销卡片 |
| c2s | `approval.respond` | `{requestId, decision}` |
| c2s | `question.respond` | `{requestId, answers}` |

---

## 配置

| 环境变量 | 作用 |
|---|---|
| `PILOT_BRIDGE_INTROSPECT=1` | 启动时打印 harness 服务的方法名，用于排查 |

修改插件后触发热重载：

```bash
printf '\n# reload %s\n' "$(date +%s)" >> ~/.dsh/profiles/desktop/cordis.patch.yml
```

> 热重载会断开手机连接，客户端会在退避后重连。

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 配对页打不开 | 插件未加载。检查 `package.json` 的两处修改，重启 DSH |
| 手机连不上 3102 | 不在同一局域网，或防火墙拦截。确认手机与电脑同一网段 |
| 手机收不到卡片 | 桥接未连接。在 App 首页展开「连接状态」点「测试连接」 |
| 卡片点了没反应 | 检查桥接日志 `~/.dsh/pilot-bridge.log` 是否有 `answered from phone` |
| 卡片不消失 | 已处理项会广播 `pending.cleared`；下拉刷新可强制同步 |
| DSH 无法退出 | 旧版本缺陷，已在 `unref()` + dispose 中修复 |

日志位置：`~/.dsh/pilot-bridge.log`

---

## 已知限制

- **不支持公网**：依赖局域网直连，公网需要额外的证书与安全加固
- **不转发对话**：对话走 `dsh-deeppilot`，本插件只处理审批与提问
- **灵动岛暂不支持交互**：Live Activity 无法直接发起网络请求，需要额外设计
- **推送环境区分**：Debug 构建的 token 只能推沙盒网关（`api.sandbox.push.apple.com`），
  上架版本需另建 Production 密钥并改 `PILOT_APNS_ENV`
- **需要 DSH 的 cordis 根上下文**：监听器必须注册在 `ctx.root` 上，详见源码注释

---

## 许可证

MIT
