# 冷链换装资料交换服务

铁路转公路的冷链货在换装棚重新拼箱。交接员面对三份互不对齐的资料：车载温控记录、卸货台扫码、新箱封签。本服务接收这三处演练系统的原始资料和收货人的追查请求，按**托盘**交代完整证据链、归属范围和当前处置。

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。

```bash
npm start          # 同时启动演练来源 (3100) 和资料交换服务 (SERVICE_PORT，默认 4100)
npm test           # 来源契约 + 逐托盘证据链测试
node server.mjs    # 只启动交换服务；PORT 默认 3200，SOURCE 指向演练来源
```

- 演练来源：`http://127.0.0.1:3100`（`PORT` 可改）。
- 交换服务：`http://127.0.0.1:4100`（`SERVICE_PORT` 可改）。
- 启动后处于演练阶段 0。可向来源的 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换下一批资料。阶段切换不会清除此前受理的经办号。
- `requests/example.json` 是收货人提交的样例请求，可直接作为 `POST /trace` 的正文。

## 交换服务接口

| 接口 | 用途 |
| --- | --- |
| `POST /collect` | 从演练来源拉取扫码、校时、装箱动作、签收 |
| `POST /collect/logger` | 按 `{key, from, to}` 向来源补领一段箱封/工位记录 |
| `POST /materials/scanner` | 接收扫码事件与站端校时凭证 |
| `POST /materials/dock` | 接收换装动作（含修订号） |
| `POST /materials/logger` | 接收温控记录（单条或 `records` 数组） |
| `POST /materials/receiver` | 接收收货台签收 |
| `POST /trace` | 收货人按到达批追查 |
| `GET /trace/:requestKey` | 回看某次追查结果 |
| `POST /receipts` | 发出暂缓、召回或放行凭据（记录出具时的路段签名） |
| `GET /receipts?requestKey=` | 查询凭据 |
| `GET /health` | 当前已接收的原始资料计数 |

`POST /trace` 的请求体即 `requests/example.json`：`arrival`、`units`、`temperatureBandC`、`receiverPicklists`。可选 `requestKey` 复用原受理号。

## 追查结果怎么读

每件货给出 `state`（越限 / 尚缺覆盖 / 有依据可放行 / 待认定）、`route`（原箱 → 换装台 → 新箱三段）、`evidence`、`custody`（拣货单、实际签收、凭据）、`disposition`（当前处置）和 `inquiries`（应向哪个站补证）。

判定规则：

- **读数归属**：读数只在“传感器安装段 ∩ 箱封/工位归属段 ∩ 货件在箱时段”内才归给托盘。跨边界的越限读数如果大部分不在托盘在场期间，不出结论；落在货件离开之后的箱封读数只记录、不分摊。
- **换装台独立温控**：只在托盘确实经过该工位、且交接时段已明确时适用。演练资料里 K6（+4s ±2s）给出卸空 09:23:02（09:23:00–09:23:04），K8（−8s ±2s）给出装箱 09:24:54（09:24:52–09:24:56），顺序明确；若站端校时误差放大到两次扫码区间重叠，该段改记为“待认定”，只登记工位记录窗口，不出具两份互相矛盾的证明。
- **待归档 ≠ 无记录**：`pending` 段按“棚端待归档”标注，`unverified-window` 表示已取到的记录没覆盖该窗口且没有登记待归档；两者都和 `no-record`（尚未领取）分开，现场班组能看出是在等归档，还是还没取到记录。
- **收货台**：同一到达批可分给不同收货台，各按自己的拣货单领取。`receivers` 列出每台可领、不可领、已被别台接手的货件。签收按件（`claimId`）计算，不代表整单已接手。
- **凭据更正**：凭据记录出具时每件货的路段签名。拼箱修订后（例如 C32 由 T4/D5 改到 T5/D6），`receipts[].actions` 区分：实际持有人已签收 → 通知复验/召回；凭据已发但未签收 → 暂停；实物已由别台接手 → 通知该台并更正原台凭据；两台都记录接手 → 冲突，列出受影响货件和应取证的两台。
- **更正后补领**：`claims.reused` / `invalidated` / `reacquired` 按**路段**粒度给出。路段签名（箱封、工位、时间窗、是否适用）和原始记录都没变的可沿用；路线改到别的工位、或时间窗变了的才作废并按新路径补领。本次没追查的托盘，原领取结果原样保留。

## 来源契约（演练来源，只读）

- `GET /scanner/events`：`origin` 与 `scanId` 共同定位一次扫描；事件时间是设备时刻，`clockProof` 指向站端校时。
- `GET /scanner/clocks`：秒差加到设备时刻，误差范围在结果两侧。
- `GET /dock/packing`：`revision` 为装箱动作修订号；`units` 是实物标签，`bay` 是触发换装时的工位。同一动作可拆托、混拼或将旧封签作废。
- `GET /logger/windows?key=H71&from=09:00&to=09:26`：按箱封或工位、左闭右开时间窗补查。读数附着于安装段，间断不插值。任意窗口均可查询；返回 `covered`（已归档覆盖）、`pending`（待归档）、`unverified`（窗口内既无覆盖也未登记待归档的部分）。
- `GET /receiver/acceptances`：`claimId` 是收货台记录的实际签收，不代表本单其余货件已接手。
- `POST /receiver/receipts`、`GET /receiver/receipts`：暂缓、召回或放行凭据；以 `requestKey` 查询。

## 模块

- `source.mjs`：演练来源（含按窗口切片和待归档语义）。
- `src/time.mjs`：时间区间运算（左闭右开、合并、求交、相减）。
- `src/picture.mjs`：三处原始资料归一化（校时、去重、修订历史、签收）。
- `src/engine.mjs`：逐托盘证据链、处置、凭据影响、补领/沿用。
- `src/service.mjs`：HTTP 接口与到货批追查记录。
- `src/client.mjs`：向演练来源取数。
