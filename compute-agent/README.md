# YWA Compute Agent（算力巡检 + 远程训练 Agent）

部署在具备算力资源的服务器上的轻量服务，供 YoloWebAgentStarter 后端远程巡检 CPU / CUDA / MPS / 昇腾 NPU 设备，并接收下发的 YOLO 训练任务。

**零依赖、可离线启动**：只用 Python 标准库（http.server），无需 pip install 任何包。torch / torch_npu 若存在于当前 Python 环境则自动用于设备探测，否则只上报 CPU。训练通过 ultralytics 子进程执行：要求启动本 Agent 的 Python 环境已安装 ultralytics（或通过 `YWA_YOLO_EXECUTABLE` 指定 yolo 可执行文件）。

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

所有接口均支持 `X-Agent-Token: <token>` 或 `Authorization: Bearer <token>` 鉴权（启动未设置 token 时不鉴权）。设备探测结果带 10 秒缓存；首次访问 `/devices` 会触发 torch/torch_npu 初始化，NPU 上可能需要数秒。

### 巡检

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查：版本、主机名、是否启用鉴权、`training_supported: true` |
| GET | `/devices` | 设备巡检：`devices: [{id,type,name,index,memory_total_mb,memory_free_mb,status}]`，type 含 `cpu/cuda/mps/npu` |

### 远程训练

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/tasks` | 创建任务（status=pending），body 为任务 spec：`{task_id, task_type(detect/segment/obb/classify), model, epochs, img_size, batch_size, device, workers, seed, optimizer?, lr0?, patience?}` |
| PUT | `/tasks/{task_id}/dataset` | 上传 YOLO 格式数据集 zip（Content-Type: application/zip），解压到任务工作区并改写 data.yaml 的 path |
| PUT | `/tasks/{task_id}/weights?name=xxx.pt` | 可选：上传基础权重（如 best.pt 断点续训），仅 pending 状态可传 |
| POST | `/tasks/{task_id}/start` | 启动训练子进程（ultralytics / yolo），状态转 running |
| GET | `/tasks/{task_id}` | 任务状态：status/progress(epoch、percent、speed_it_per_sec)/metrics/artifacts/error |
| GET | `/tasks/{task_id}/logs?after=N&tail=N` | 训练日志（增量拉取用 after） |
| GET | `/tasks/{task_id}/artifacts/best.pt` / `last.pt` | 下载训练产物 |
| POST | `/tasks/{task_id}/stop` | 停止任务（终止进程组） |
| DELETE | `/tasks/{task_id}` | 删除任务及其工作区（running 状态需先 stop） |

后端会每 5 秒轮询一次运行中任务的状态并同步回数据库；任务状态落在每个任务目录的 task.json，Agent 重启后未完成任务会标记为 failed（不会静默续跑）。

## 在后端注册

Web 界面 →「设置」→「训练节点」：填入名称、`http://<服务器IP>:8010`、token，测试连接后保存。「训练」页的算力栏即会展示远程设备；创建训练任务时选择远程设备即会把数据集打包下发到该节点执行。智能体（Agent 页）也可以先查询训练节点算力，再经人工确认后把训练任务下发到指定节点。

## 安全提示

- 务必在内网或 VPN 环境下使用；如需暴露公网，请自行加反向代理 TLS 与访问控制。
- 设置 token 后，后端注册节点时填写同一 token。
