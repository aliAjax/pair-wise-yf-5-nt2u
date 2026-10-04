# 充电运营台

充电站运营系统：晚高峰两台车同时抢同一个充电位、变压器容量到顶时排队；
站控断网时留住未结算会话、恢复后接着计费且重复上报不重复计费；
电价时段一变，未结算会话费用立即重算、已出账账单冻结；
每月与支付渠道对账，把**少收**、**多收**的会话分别列出。

## 运行

```bash
npm install
npm start        # http://localhost:3000 （运营台页面 + API）
npm test         # 场景测试（排队/断网幂等/电价重算/月度对账）
```

数据落在 `data/charging.db`（SQLite，WAL 模式）；测试用内存库。

## 核心规则

- **一位一会话**：每个充电位同一时刻至多一个 `active` 计费会话。
- **排队补位**：启动请求先入等待队列；当「目标位空闲 + 当前负载 + 申请功率 ≤ 变压器容量」时，
  按提交时间先后（全局 FIFO）补位。停止结算释放容量后再触发一轮补位。
- **断网续计**：所有会话/队列/上报均持久化，断网不丢；恢复后会话仍在、继续计费。
- **幂等**：启动带 `requestId`、停止带上报 `reportId`（事件 ID），经 `inbox` 去重，
  重复上报返回同一结果，不产生第二次计费/第二张账单。
- **电价重算**：电费按尖/峰/平/谷分时积分（`src/pricing.js`）。调价即重算所有未结算会话；
  已出账账单金额冻结、不再变动。
- **月度对账**：上传支付渠道流水（`sessionCode` + `channelAmount`），与本站应收比对：
  实收 < 应收 → **少收**，实收 > 应收 → **多收**，并列出缺账单 / 渠道漏结。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/stations` | 站点列表 / 新建站点 |
| PATCH | `/api/stations/:id/online` | 断网 / 恢复联网 |
| GET/POST | `/api/stations/:id/spots` | 充电位列表 / 新增 |
| POST | `/api/stations/:id/start` | 启动（`spotId`、`powerKw`、`requestId`） |
| POST | `/api/stations/:id/stop` | 停止结算（`sessionId` 或 `spotId`、`reportId`） |
| GET | `/api/stations/:id/sessions?status=` | 会话（active 费用实时预估） |
| GET | `/api/stations/:id/queue` | 等待队列 |
| GET | `/api/stations/:id/bills` | 已出账账单 |
| GET/POST | `/api/stations/:id/prices` | 电价表 / 调价（未结算立即重算） |
| POST | `/api/stations/:id/reconciliation` | 上传渠道流水并对账 |
| GET | `/api/stations/:id/reconciliation/:period` | 对账结果 |
| GET | `/api/stations/:id/overview` | 仪表盘聚合数据 |

## 目录

```
src/
  index.js        Express 服务与路由
  domain.js       核心领域逻辑（排队/幂等/电价/对账）
  pricing.js      分时电价积分计算
  db.js           SQLite schema 与初始化
  public/index.html  运营台单页
test/scenario.js  场景测试
```
