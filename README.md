# Aircraft Launch Planning System

飞机放飞规划管理系统，一个基于 React、Electron 和 Python 的排程优化项目。前端负责流程编排、资源配置和结果展示，后端负责执行遗传算法、模拟退火和贪心调度。

## 项目结构

- `src/`：React 前端界面
- `electron/`：Electron 桌面端入口
- `python_backend/`：Flask 后端与调度算法

## 环境要求

- Node.js 22.x
- Python 3.9+

## 本地运行

### 1. 安装前端依赖

```bash
npm install
```

### 2. 安装后端依赖

```bash
python3 -m venv .venv
./.venv/bin/pip install -r python_backend/requirements.txt
```

### 3. 启动 Web 模式

先启动 Python 后端：

```bash
./.venv/bin/python python_backend/app.py
```

再启动前端：

```bash
npm run dev
```

默认前端地址：

- [http://127.0.0.1:3000](http://127.0.0.1:3000)

默认后端地址：

- [http://127.0.0.1:15050/api/health](http://127.0.0.1:15050/api/health)

### 4. 启动 Electron 桌面模式

```bash
npm run electron:dev
```

开发环境下，Electron 会优先使用项目内的 `.venv/bin/python` 来启动后端。

## 构建

前端生产构建：

```bash
npm run build
```

桌面应用构建：

```bash
npm run electron:build
```

## 测试与检查

TypeScript 检查：

```bash
npm run lint
```

后端可用性检查：

```bash
curl http://127.0.0.1:15050/api/health
```



## 其他设备使用

在其他设备上：

```bash
git clone https://github.com/<your-name>/aircraft-launch-planning-system.git
cd aircraft-launch-planning-system
npm install
python3 -m venv .venv
./.venv/bin/pip install -r python_backend/requirements.txt
```

然后按上面的“本地运行”步骤启动即可。
