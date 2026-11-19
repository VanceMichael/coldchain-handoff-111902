# 冷链转运资料交换服务

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 来源接口

- `GET /scanner/events` origin 和 scanId 共同定位一次扫描。事件时间为设备时刻，clockProof 给出修正秒数和误差界。
- `GET /scanner/clocks` 秒差加到设备时刻，误差范围在结果两侧。
- `GET /dock/packing` revision 为装箱动作修订号。units 是实物标签，bay 指触发换装时所在工位。
- `GET /logger/windows?key=H71&from=09:00&to=09:26` 按箱封与左闭右开时间窗补查。读数附着于安装段，间断不插值。
- `GET /logger/windows?key=H72&from=09:24&to=10:10` 换入箱的观测可早于实际换装，安装和货件归属同时成立才可用。
- `GET /logger/windows?key=D5&from=09:20&to=09:28` 棚东的换装台记录独立于箱封记录。
- `GET /logger/windows?key=D6&from=09:23&to=09:29` D6 有待归档段。待归档与已确认无记录含义不同。
- `GET /receiver/acceptances` claimId 是收货台记录的实际签收，不代表本单的其余货件已接手。
- `POST /receiver/receipts` 暂缓、召回或放行凭据提供 requestKey、desk、sheet、units、arrival、finding。修订条目带原交接编号。
- `GET /receiver/receipts` 以 requestKey 查询。
