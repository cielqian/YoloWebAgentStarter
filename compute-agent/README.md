# YWA Compute Agent（算力巡检 Agent）

部署在具备算力资源的服务器上的轻量服务，供 YoloWebAgentStarter 后端远程巡检 CPU / CUDA / MPS / 昇腾 NPU 设备。

**零依赖、可离线启动**：只用 Python 标准库（http.server），无需 pip install 任何包。torch / torch_npu 若存在于当前 Python 环境则自动用于设备探测，否则只上报 CPU。

## 部署（离线内网服务器）

```bash
# 1. 把本目录拷到算力服务器（整个目录只有 agent.py + run.sh + README.md）
scp -r compute-agent/ user@服务器IP:~/compute-agent

# 2. 启动（用服务器上带 torch/torch_npu 的那个 Python；没有 torch 也能跑，只上报 CPU）
cd ~/compute-agent
chmod +x run.sh
./run.sh                          # 0.0.0.0:8010，无鉴权（仅限内网可信环境）
TOKEN=你的共享密钥 ./run.sh        # 推荐带 token
PYTHON=/opt/venv/bin/python3 ./run.sh   # 指定解释器（或先 conda activate）

# 常驻后台
TOKEN=xxx nohup ./run.sh > agent.log 2>&1 &
```

服务器自测：

```bash
curl -H "X-Agent-Token: xxx" http://127.0.0.1:8010/health    # {"ok":true,...}
curl -H "X-Agent-Token: xxx" http://127.0.0.1:8010/devices   # NPU 服务器应看到 "npu:0"
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查：版本、主机名、是否启用鉴权 |
| GET | `/devices` | 设备巡检：`devices: [{id,type,name,index,memory_total_mb,memory_free_mb,status}]`，type 含 `cpu/cuda/mps/npu` |

两个接口均支持 `X-Agent-Token: <token>` 或 `Authorization: Bearer <token>` 鉴权（启动未设置 token 时不鉴权）。设备探测结果带 10 秒缓存；首次访问 `/devices` 会触发 torch/torch_npu 初始化，NPU 上可能需要数秒。

## 在后端注册

Web 界面 →「设置」→「训练节点」：填入名称、`http://<服务器IP>:8010`、token，测试连接后保存。「训练」页的算力栏即会展示远程设备。

## 安全提示

- 务必在内网或 VPN 环境下使用；如需暴露公网，请自行加反向代理 TLS 与访问控制。
- 设置 token 后，后端注册节点时填写同一 token。
