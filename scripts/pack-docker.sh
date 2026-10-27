#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
RELEASE="$DIST/chongni-admin-release"
IMAGE_NAME="${IMAGE_NAME:-chongni-admin}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
FULL_IMAGE="$IMAGE_NAME:$IMAGE_TAG"
# 默认打 Linux 服务器常用的 amd64，避免 Mac arm64 镜像在云主机上无法运行
PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

cd "$ROOT"

echo "==> 同步种子数据 seed/catalog.js"
mkdir -p "$ROOT/seed"
if [[ -f "$ROOT/../chongni/data/catalog.js" ]]; then
  cp "$ROOT/../chongni/data/catalog.js" "$ROOT/seed/catalog.js"
elif [[ ! -f "$ROOT/seed/catalog.js" ]]; then
  echo "缺少 seed/catalog.js，且未找到 ../chongni/data/catalog.js" >&2
  exit 1
fi

echo "==> 构建镜像 $FULL_IMAGE ($PLATFORM)"
docker build --platform "$PLATFORM" -t "$FULL_IMAGE" .

mkdir -p "$DIST"
TAR_GZ="$DIST/chongni-admin-image.tar.gz"
echo "==> 导出镜像 -> $TAR_GZ"
docker save "$FULL_IMAGE" | gzip > "$TAR_GZ"

echo "==> 组装发布目录"
rm -rf "$RELEASE"
mkdir -p "$RELEASE"
cp "$ROOT/config.example.json" "$RELEASE/"
cp "$TAR_GZ" "$RELEASE/"

# 发布包仅加载镜像，不含构建上下文
cat > "$RELEASE/docker-compose.yml" <<EOF
services:
  chongni-admin:
    image: ${FULL_IMAGE}
    platform: ${PLATFORM}
    container_name: chongni-admin
    restart: unless-stopped
    ports:
      - "\${PORT:-8789}:8789"
    environment:
      NODE_ENV: production
    volumes:
      - ./config.json:/app/config.json:ro
      - ./data:/app/data
      - ./uploads:/app/uploads
EOF

cat > "$RELEASE/DEPLOY.md" <<'EOF'
# 宠溺管理端 Docker 部署

## 环境要求

- Docker 20+（含 `docker compose`）
- 开放端口 8789（或修改 compose 中的 PORT）

## 首次部署

```bash
# 1. 加载镜像
docker load < chongni-admin-image.tar.gz

# 2. 准备配置（务必修改密码、publicBase、地图 Key、短信模式）
cp config.example.json config.json
# 编辑 config.json

# 3. 创建数据目录
mkdir -p data uploads

# 4. 启动
docker compose up -d

# 5. 查看日志
docker compose logs -f
```

管理后台：`http://服务器IP:8789`

## 升级（保留数据）

```bash
docker load < chongni-admin-image.tar.gz
docker compose up -d
```

`data/`、`uploads/`、`config.json` 通过卷挂载，升级不会丢失。

## 常用命令

```bash
docker compose ps
docker compose restart
docker compose down
```
EOF

BUNDLE="$DIST/chongni-admin-release.tar.gz"
echo "==> 打包发布附件 -> $BUNDLE"
tar -czf "$BUNDLE" -C "$DIST" chongni-admin-release

echo
echo "完成。"
echo "  镜像:     $FULL_IMAGE"
echo "  镜像包:   $TAR_GZ"
echo "  发布包:   $BUNDLE"
echo "  发布目录: $RELEASE"
