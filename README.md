# dsh-pilot-bridge

把 DeepSeek Harness（DSH）上的**审批**与**提问**转发到 iPhone，并接受手机端的决定。

配合 iOS 客户端 [DSH Pilot](https://github.com/) 使用：手机上点「批准」或选定答案，
电脑上正在等待的工具调用会立刻继续。

## 它解决什么

DSH 的工具调用在需要授权时会弹审批，模型也可能用 `ask_user_question` 向你提问 ——
这些交互原本只能在电脑前处理。本插件把这两类请求转成一种可远程应答的通道：

```
DSH 工具调用 → approval/request waterfall ─┐
                                          ├→ WebSocket → iPhone
ask_user_question → user-questions/request ┘
```

手机回答后，插件把结果作为 waterfall 的返回值交回 DSH，工具调用随即继续。

## 协议

- 传输：TLS + WebSocket（P-256 证书，客户端按 SPKI 指纹固定）
- 认证：`s2c.auth.challenge` → `c2s.auth.prove`（ECDSA P-256 / SHA-256）→ `s2c.welcome`
- 配对：`POST /phone/pair`，一次性配对码（5 分钟有效），返回 `201`
- 帧：`{ v:2, type, ts, id?, seq?, payload }`

## 端口

| 端口 | 用途 |
|---|---|
| 3102 | HTTPS + WebSocket（插件本体，供手机连接） |
| 3103 | 仅监听 127.0.0.1 的配对页 `/pair`，显示二维码与配对串 |

配对页只绑回环地址：浏览器无法打开自签名 HTTPS 页面，而安装根证书对配对这一步来说不可接受。

## 安装

```bash
# 1. 放进 profile 的 node_modules
cp -R dsh-pilot-bridge ~/.dsh/profiles/desktop/node_modules/

# 2. 加进 profile 的 package.json
#    dependencies:  "dsh-pilot-bridge": "file:./node_modules/dsh-pilot-bridge"
#    dsh.profile.bundles: 追加 "dsh-pilot-bridge"

# 3. 重启 DSH，浏览器打开
open http://127.0.0.1:3103/pair
```

## 配置

| 环境变量 | 作用 |
|---|---|
| `PILOT_BRIDGE_INTROSPECT=1` | 启动时打印 harness 服务的方法名，用于排查 |

修改后触发热重载：

```bash
printf '\n# reload %s\n' "$(date +%s)" >> ~/.dsh/profiles/desktop/cordis.patch.yml
```

> 热重载会断开手机连接，客户端需要重连。

## 行为约定

- **只有手机连着时才接管**：否则 `next()`，完全不干扰电脑端的审批弹窗
- **手机独占**：发起时手机在线，就只等手机（最长 90 秒）；超时才交给电脑端
- 这样避免出现「电脑端卡片已弹出、手机后来才回答，卡片却撤不掉」的情况

## 已知限制

- **提问卡片的客户端渲染仍不稳定**：桥接侧确认已推送，但 App 端在部分情况下不显示
- 修改第三方插件（如 `dsh-deeppilot`）会随其升级被覆盖，本项目不修改任何其他插件
- 需要 DSH 的 cordis 根上下文注册监听器，见 `index.js` 中的注释

## 许可证

MIT
