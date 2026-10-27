# 宠溺服务端

Node 原生 HTTP 服务，承载账号、宠物档案、提醒/花销/病例、广场、好友聊天、商城与订单。

## 本地启动

```bash
cd chongni-admin
cp config.example.json config.json   # 若还没有配置
npm start
```

- 管理后台：http://127.0.0.1:8789  
- 默认管理密码见 `config.json`（示例见 `config.example.json`）

## Docker 部署

推荐用 Docker 打包上线：代码进镜像，`config.json` / `data` / `uploads` 用卷挂载，升级不丢数据。

### 本机打包

需已安装 Docker。

```bash
cd chongni-admin
npm run pack
# 默认构建 linux/amd64（适配常见云服务器）。
# Mac Apple Silicon 上也会交叉编译；若服务器是 arm64：DOCKER_PLATFORM=linux/arm64 npm run pack
```

产物在 `dist/`：

| 文件 | 说明 |
|------|------|
| `chongni-admin-image.tar.gz` | 可 `docker load` 的镜像 |
| `chongni-admin-release/` | 含 compose、配置模板、DEPLOY.md |
| `chongni-admin-release.tar.gz` | 上述目录的压缩包，拷到服务器即可 |

### 服务器部署

```bash
tar -xzf chongni-admin-release.tar.gz
cd chongni-admin-release
docker load < chongni-admin-image.tar.gz
cp config.example.json config.json
# 编辑 config.json：密码、publicBase、地图 Key、短信等
mkdir -p data uploads
docker compose up -d
```

管理后台：`http://服务器IP:8789`（或你在 compose / 反向代理里映射的端口）。

升级（保留数据）：

```bash
docker load < chongni-admin-image.tar.gz
docker compose up -d
```

开发机本地直接跑容器：

```bash
cp config.example.json config.json   # 首次
mkdir -p data uploads
npm run docker:build
npm run docker:up
```

更细的说明见发布包内 `DEPLOY.md`。

## 上线前必改

1. **域名与 HTTPS**：把小程序 `utils/config.js` 的 `apiBase` 改成 `https://你的域名`，并在微信公众平台配置 request 合法域名。
2. **短信**：`config.json` → `sms.mode`  
   - `dev`：控制台打印验证码，接口会返回 `debugCode`（仅开发）  
   - `http`：配置 `sms.webhook`，服务端 POST `{phone,code}` 给你的短信网关  
   - 生产务必关掉把验证码回传给客户端的行为（勿用 `dev`）
3. **微信登录**：填写 `wx.appId` / `wx.appSecret` 后，登录时会附带 `wx.login` 的 code 绑定 openid。
4. **微信支付**：`payMode` 设为 `wechat`，并配置 `wx.mchId` / `apiKey` / `notifyUrl`；未配置前请保持 `sandbox`（服务端记账支付，非客户端伪造）。
5. **附近地图**（三选一，`mapProvider`）：
   - `amap`（默认推荐）：[高德](https://console.amap.com/) Web 服务 Key → `amapKey`
   - `qq`：[腾讯位置服务](https://lbs.qq.com/) → `qqMapKey`
   - `baidu`：[百度地图](https://lbsyun.baidu.com/) → `baiduAk`
   小程序只调 `/api/map/nearby`，底图仍用微信原生 `<map>`（腾讯底图），POI 检索走所选供应商。
6. **改管理密码**，勿用默认口令；生产建议仅内网访问管理页。
7. **`publicBase`**：改成对外可访问的 `https://域名`，商品图等相对路径才能被小程序正确拼接。

HTTPS 可由前置 Nginx / 网关终止，不必塞进本 compose。

## 管理后台

浏览器打开服务地址，密码见 `config.json`。

含：运营概览、商城、订单筛选与履约、用户停用/恢复、宠物档案、动态审核、社交关系、系统配置状态。

## 小程序侧

用户登录后拿到 `Bearer` session，档案/社交/订单均走服务端。  
游客可逛广场与附近，不可下单、发帖、聊天。

## 数据

默认落盘 `data/db.json`，上传文件在 `uploads/`。Docker 下二者均为宿主机卷。上线量大时建议迁 SQLite / Postgres，接口层可保持不变。
