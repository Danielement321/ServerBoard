# Server Resource Monitor

这是一个轻量级的服务器资源监控面板，专为 GPU型服务器 设计，重点监控 GPU 性能。

本项目完全基于VibeCoding完成;)

## 安装

1. 确保已安装 Python 3.7+。
2. 安装依赖：

```bash
pip install -r requirements.txt
```

## 运行

### 一键运行

```bash
bash run.sh 8000
```

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
