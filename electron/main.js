import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let backendProcess = null;

function startPythonBackend() {
  let backendPath = '';
  let command = '';
  let args = [];

  if (process.env.NODE_ENV === 'development') {
    // In development, prefer the project's virtualenv Python to avoid relying on a global install.
    const venvPython = path.join(__dirname, '../.venv/bin/python');
    command = venvPython;
    args = [path.join(__dirname, '../python_backend/app.py')];
    backendProcess = spawn(command, args);
  } else {
    // In production, run the packaged executable from extraResources
    const executableName = process.platform === 'win32' ? 'backend.exe' : 'backend';
    backendPath = path.join(process.resourcesPath, 'backend', executableName);
    command = backendPath;
    backendProcess = spawn(command);
  }

  let pythonOutput = '';
  let pythonError = '';

  backendProcess.stdout.on('data', (data) => {
    const text = data.toString();
    console.log(`[Python] ${text}`);
    pythonOutput += text;
  });

  backendProcess.stderr.on('data', (data) => {
    const text = data.toString();
    console.error(`[Python Error] ${text}`);
    pythonError += text;
  });

  backendProcess.on('error', (err) => {
    console.error(`[Python Spawn Error] Failed to start backend: ${err.message}`);
    dialog.showErrorBox(
      '后端启动失败', 
      `无法启动 Python 后端服务。\n\n错误信息: ${err.message}\n\n尝试运行的路径: ${command}\n\n可能的原因：\n1. 杀毒软件（如360、Windows Defender）拦截了该程序，请将其加入白名单。\n2. (开发环境) 电脑未安装 Python 或未配置环境变量。`
    );
  });

  backendProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      // Truncate output if it's too long
      const outStr = pythonOutput.length > 500 ? pythonOutput.substring(pythonOutput.length - 500) : pythonOutput;
      const errStr = pythonError.length > 500 ? pythonError.substring(pythonError.length - 500) : pythonError;
      
      // If the error is just that the port is already in use, it means a previous instance
      // of the backend is still running (e.g., from a previous crash or hot reload).
      // In this case, we don't need to show an error because the backend is actually available!
      if (errStr.includes('Address already in use') || errStr.includes('WinError 10048')) {
        console.log('[Python] Backend port is already in use. Assuming backend is already running.');
        return;
      }

      dialog.showErrorBox(
        '后端意外退出', 
        `Python 后端服务意外崩溃 (退出码: ${code})。\n\n【Python 错误日志】:\n${errStr || '无错误日志'}\n\n【Python 输出日志】:\n${outStr || '无输出日志'}\n\n可能的原因：\n1. Python 代码内部报错（如缺少依赖包）。\n2. 端口 15050 被占用。\n3. 杀毒软件强制杀死了进程。`
      );
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Load the index.html from a url
  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  startPythonBackend();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Ensure the python backend is killed when the electron app closes
  if (backendProcess) {
    backendProcess.kill();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
