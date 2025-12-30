# Server Resource Monitor

这是一个轻量级的服务器资源监控面板，专为 GPU型服务器 设计，重点监控 GPU 性能。

## 功能

- **实时监控**：CPU、内存、硬盘、网络。
- **GPU 监控**：利用率、显存、功率、温度 (支持 NVIDIA GPU)。
- **可视化**：基于 Web 的仪表盘，包含历史趋势图。
- **轻量化**：基于 FastAPI 和 WebSocket，资源占用极低。

## 安装

1. 确保已安装 Python 3.7+。
2. 安装依赖：

```bash
pip install -r requirements.txt
```

## 运行

### 一键运行

```bash
bash run.sh
```

### 前台运行 (测试用)

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

### 后台运行 (推荐)

使用 `nohup`：

```bash
nohup uvicorn app:app --host 0.0.0.0 --port 8000 > server.log 2>&1 &
```

或者使用 `systemd` (见下文)。

## 访问

### 本地网络

如果服务器和你在同一个局域网，直接访问：`http://<服务器IP>:8000`

### SSH 端口转发 (远程访问)

如果服务器在远程且未开放 8000 端口，可以使用 SSH 隧道将服务器的 8000 端口映射到本地。

在你的**本地电脑**终端执行：

```bash
ssh -L 8000:localhost:8000 username@your_server_ip
```

然后打开本地浏览器访问：[http://localhost:8000](http://localhost:8000)

## Systemd 服务配置 (开机自启)

创建一个服务文件 `/etc/systemd/system/dashboard.service`：

```ini
[Unit]
Description=Server Resource Dashboard
After=network.target

[Service]
User=root
WorkingDirectory=/root/dashboard
ExecStart=/usr/local/bin/uvicorn app:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```

然后启用并启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable dashboard
sudo systemctl start dashboard
```
