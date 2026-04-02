import React, { useMemo, useState } from 'react';
import {
  Activity,
  Database,
  GitBranch,
  Info,
  LayoutDashboard,
  Play,
  Plane,
  Plus,
  Settings,
  TrendingDown,
  Trash2,
  Users,
  Wrench,
  Zap,
  Clock,
  Sigma,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Dashboard } from './components/Dashboard';
import { GanttChart } from './components/GanttChart';
import { GeneticAlgorithm, ResourceMap, SimulatedAnnealing, Task, TaskInfo } from './lib/ga';

const INITIAL_WORKFLOW: TaskInfo[] = [
  { id: 'F1', name: '接收检查', duration: 2, resources: { '机务人员': 2 }, predecessors: [], uncertainty: { enabled: false, mean: 2, stdDev: 0.5 } },
  { id: 'F2', name: '燃油加注', duration: 4, resources: { '加油车': 1, '机务人员': 1 }, predecessors: ['F1'], uncertainty: { enabled: false, mean: 4, stdDev: 0.8 } },
  { id: 'F3', name: '挂弹作业', duration: 2, resources: { '挂弹车': 1, '军械人员': 2 }, predecessors: ['F1'], uncertainty: { enabled: false, mean: 2, stdDev: 0.5 } },
  { id: 'F4', name: '航电检查', duration: 2, resources: { '航电人员': 1, '测试仪': 1 }, predecessors: ['F1'], uncertainty: { enabled: false, mean: 2, stdDev: 0.5 } },
  { id: 'F5', name: '综合测试', duration: 3, resources: { '机务人员': 1, '航电人员': 1 }, predecessors: ['F2', 'F3', 'F4'], uncertainty: { enabled: false, mean: 3, stdDev: 0.6 } },
  { id: 'F6', name: '最终确认', duration: 1, resources: { '特设人员': 1 }, predecessors: ['F5'], uncertainty: { enabled: false, mean: 1, stdDev: 0.3 } },
  { id: 'F7', name: '发动机试车', duration: 2, resources: { '机务人员': 2 }, predecessors: ['F6'], uncertainty: { enabled: false, mean: 2, stdDev: 0.5 } },
  { id: 'F8', name: '放飞指令', duration: 1, resources: {}, predecessors: ['F7'], uncertainty: { enabled: false, mean: 1, stdDev: 0.2 } },
];

const INITIAL_RESOURCES: { name: string; capacity: number }[] = [
  { name: '机务人员', capacity: 10 },
  { name: '军械人员', capacity: 6 },
  { name: '航电人员', capacity: 4 },
  { name: '特设人员', capacity: 2 },
  { name: '加油车', capacity: 2 },
  { name: '挂弹车', capacity: 2 },
  { name: '测试仪', capacity: 2 },
];

type ResultState = {
  scheduled: Record<string, [number, number]>;
  makespan: number;
  tasks: Record<string, Task>;
  history: { gen: number; bestMs: number }[];
  engine?: 'python' | 'local';
  sampleCount: number;
};

function normalizeTask(task: TaskInfo): TaskInfo {
  return {
    ...task,
    duration: Math.max(1, Math.round(task.duration)),
    uncertainty: {
      enabled: task.uncertainty.enabled,
      mean: Math.max(0.1, task.uncertainty.mean),
      stdDev: Math.max(0, task.uncertainty.stdDev),
    },
  };
}

export default function App() {
  const [numPlanes, setNumPlanes] = useState(8);
  const [popSize, setPopSize] = useState(30);
  const [gens, setGens] = useState(50);
  const [sampleCount, setSampleCount] = useState(100);
  const [algorithm, setAlgorithm] = useState<'GA' | 'SA'>('GA');
  const [workflow, setWorkflow] = useState<TaskInfo[]>(INITIAL_WORKFLOW);
  const [resourceConfig, setResourceConfig] = useState(INITIAL_RESOURCES);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ gen: 0, bestMs: 0 });
  const [activeTab, setActiveTab] = useState<'planning' | 'workflow' | 'resources' | 'monitoring'>('planning');
  const [result, setResult] = useState<ResultState | null>(null);

  const resCapMap = useMemo(() => {
    const map: ResourceMap = {};
    resourceConfig.forEach(resource => {
      map[resource.name] = resource.capacity;
    });
    return map;
  }, [resourceConfig]);

  const uncertaintyTaskCount = useMemo(() => workflow.filter(task => task.uncertainty.enabled).length, [workflow]);

  const addTask = () => {
    const newIndex = workflow.length + 1;
    setWorkflow([
      ...workflow,
      {
        id: `F${newIndex}`,
        name: '新流程',
        duration: 1,
        resources: {},
        predecessors: [],
        uncertainty: { enabled: false, mean: 1, stdDev: 0.2 },
      },
    ]);
  };

  const removeTask = (id: string) => {
    setWorkflow(
      workflow
        .filter(task => task.id !== id)
        .map(task => ({
          ...task,
          predecessors: task.predecessors.filter(predecessor => predecessor !== id),
        })),
    );
  };

  const updateTask = (id: string, updates: Partial<TaskInfo>) => {
    setWorkflow(workflow.map(task => (task.id === id ? normalizeTask({ ...task, ...updates }) : task)));
  };

  const updateTaskUncertainty = (id: string, updates: Partial<TaskInfo['uncertainty']>) => {
    setWorkflow(
      workflow.map(task =>
        task.id === id
          ? normalizeTask({
              ...task,
              uncertainty: {
                ...task.uncertainty,
                ...updates,
              },
            })
          : task,
      ),
    );
  };

  const addResource = () => {
    setResourceConfig([...resourceConfig, { name: '新资源', capacity: 1 }]);
  };

  const removeResource = (name: string) => {
    setResourceConfig(resourceConfig.filter(resource => resource.name !== name));
    setWorkflow(
      workflow.map(task => {
        const nextResources = { ...task.resources };
        delete nextResources[name];
        return { ...task, resources: nextResources };
      }),
    );
  };

  const updateResource = (index: number, updates: Partial<{ name: string; capacity: number }>) => {
    const oldName = resourceConfig[index].name;
    const nextConfig = [...resourceConfig];
    nextConfig[index] = { ...nextConfig[index], ...updates };
    setResourceConfig(nextConfig);

    if (updates.name && updates.name !== oldName) {
      setWorkflow(
        workflow.map(task => {
          if (task.resources[oldName] === undefined) return task;
          const nextResources = { ...task.resources };
          nextResources[updates.name!] = nextResources[oldName];
          delete nextResources[oldName];
          return { ...task, resources: nextResources };
        }),
      );
    }
  };

  const buildLocalTasks = () => {
    const tasks: Record<string, Task> = {};
    const allIds: string[] = [];

    for (let planeId = 1; planeId <= numPlanes; planeId++) {
      const planeMap: Record<string, string> = {};
      workflow.forEach(task => {
        const globalId = `A${planeId}_${task.id}`;
        planeMap[task.id] = globalId;
        allIds.push(globalId);
      });

      workflow.forEach(task => {
        const predecessors = task.predecessors.map(predecessor => planeMap[predecessor]);
        const displayDuration = task.uncertainty.enabled ? task.uncertainty.mean : task.duration;
        tasks[planeMap[task.id]] = new Task(
          planeMap[task.id],
          planeId,
          task.id,
          task.name,
          Math.max(1, Math.round(displayDuration)),
          task.resources,
          predecessors,
          task.uncertainty,
        );
      });
    }

    return { tasks, allIds };
  };

  const runOptimization = async () => {
    setIsRunning(true);
    setResult(null);
    setProgress({ gen: 0, bestMs: 0 });
    setActiveTab('planning');

    const normalizedWorkflow = workflow.map(normalizeTask);
    const { tasks, allIds } = buildLocalTasks();

    try {
      const response = await fetch('http://127.0.0.1:15050/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numPlanes,
          popSize,
          gens,
          sampleCount,
          resources: resCapMap,
          workflow: normalizedWorkflow,
          algorithm,
        }),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        throw new Error(errorPayload?.error ?? 'Backend unavailable');
      }

      const data = await response.json();
      setProgress({ gen: gens, bestMs: data.makespan });
      setResult({
        scheduled: data.scheduled,
        makespan: data.makespan,
        tasks: data.tasks,
        history: data.history,
        engine: 'python',
        sampleCount: data.sampleCount ?? sampleCount,
      });
    } catch (error) {
      console.warn('Using local TS fallback...', error);

      let runner: GeneticAlgorithm | SimulatedAnnealing;
      if (algorithm === 'GA') {
        runner = new GeneticAlgorithm(tasks, allIds, resCapMap, popSize, gens, sampleCount);
      } else {
        runner = new SimulatedAnnealing(tasks, allIds, resCapMap, gens, sampleCount);
      }

      try {
        const { scheduled, makespan, history } = await runner.run((gen: number, bestMs: number) => {
          setProgress({ gen, bestMs });
        });
        setResult({ scheduled, makespan, tasks, history, engine: 'local', sampleCount });
      } catch (localError) {
        console.error('Optimization failed:', localError);
        alert('优化计算失败，请检查参数设置。');
      }
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-20 sticky top-0">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg text-white">
            <Plane className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">智能飞机放飞调度系统</h1>
            <p className="text-xs text-slate-500 font-medium">支持正态分布时长与采样评估</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex bg-slate-100 p-1 rounded-lg">
            <button
              onClick={() => setActiveTab('planning')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === 'planning' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-600 hover:text-slate-900'}`}
            >
              <LayoutDashboard className="w-4 h-4" /> 排程看板
            </button>
            <button
              onClick={() => setActiveTab('workflow')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === 'workflow' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-600 hover:text-slate-900'}`}
            >
              <GitBranch className="w-4 h-4" /> 流程编排
            </button>
            <button
              onClick={() => setActiveTab('resources')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === 'resources' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-600 hover:text-slate-900'}`}
            >
              <Database className="w-4 h-4" /> 资源配置
            </button>
            <button
              onClick={() => result && setActiveTab('monitoring')}
              disabled={!result}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === 'monitoring' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-600 hover:text-slate-900'} ${!result ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <Activity className="w-4 h-4" /> 实时监控
            </button>
          </div>

          <button
            onClick={runOptimization}
            disabled={isRunning}
            className={`flex items-center gap-2 py-2 px-6 rounded-lg shadow-sm text-sm font-bold text-white transition-all ${isRunning ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 active:scale-95'}`}
          >
            {isRunning ? <Activity className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {isRunning ? '优化中...' : '开始优化'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 bg-white border-r border-slate-200 overflow-y-auto p-6 space-y-8">
          <section>
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Settings className="w-3.5 h-3.5" /> 核心参数
            </h3>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600">调度算法</label>
                <select
                  value={algorithm}
                  onChange={event => setAlgorithm(event.target.value as 'GA' | 'SA')}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="GA">遗传算法 (GA)</option>
                  <option value="SA">模拟退火 (SA)</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600">飞机总数</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min="1"
                    max="30"
                    value={numPlanes}
                    onChange={event => setNumPlanes(Number(event.target.value))}
                    className="flex-1 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <span className="text-sm font-bold text-slate-800 w-8 text-right">{numPlanes}</span>
                </div>
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Activity className="w-3.5 h-3.5" /> 优化配置
            </h3>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600">种群规模</label>
                <input
                  type="number"
                  min="1"
                  value={popSize}
                  disabled={algorithm !== 'GA'}
                  onChange={event => setPopSize(Math.max(1, Number(event.target.value) || 1))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600">迭代次数</label>
                <input
                  type="number"
                  min="1"
                  value={gens}
                  onChange={event => setGens(Math.max(1, Number(event.target.value) || 1))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600">采样次数</label>
                <input
                  type="number"
                  min="1"
                  value={sampleCount}
                  onChange={event => setSampleCount(Math.max(1, Number(event.target.value) || 1))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
                <p className="text-[11px] text-slate-400">每个候选序列会进行多次正态采样，目标值取平均完工时间。</p>
              </div>
            </div>
          </section>

          <div className="pt-4 space-y-4">
            <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
              <div className="flex items-start gap-3">
                <Info className="w-4 h-4 text-blue-600 mt-0.5" />
                <p className="text-xs text-blue-800 leading-relaxed">
                  当前共有 {uncertaintyTaskCount} 个任务启用了不确定性。启用后，任务时长会按你填写的正态分布参数采样。
                </p>
              </div>
            </div>
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto p-8 bg-slate-50/50">
          <div className="max-w-7xl mx-auto">
            <AnimatePresence mode="wait">
              {activeTab === 'planning' && (
                <motion.div key="planning" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-6">
                  {isRunning && (
                    <div className="bg-white p-6 rounded-2xl shadow-sm border border-blue-100">
                      <div className="flex justify-between text-sm font-bold text-slate-600 mb-3">
                        <span className="flex items-center gap-2">
                          <Activity className="w-4 h-4 animate-pulse text-blue-600" /> 正在计算最优解...
                        </span>
                        <span>
                          第 {progress.gen} / {gens} 轮 | 最优平均完工时间: {progress.bestMs || '-'}
                        </span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
                        <motion.div className="bg-blue-600 h-full" initial={{ width: 0 }} animate={{ width: `${(progress.gen / gens) * 100}%` }} />
                      </div>
                    </div>
                  )}

                  {!isRunning && !result && (
                    <div className="h-[60vh] flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-3xl bg-white/50">
                      <div className="bg-slate-100 p-6 rounded-full mb-6">
                        <LayoutDashboard className="w-12 h-12 text-slate-300" />
                      </div>
                      <h3 className="text-lg font-bold text-slate-600 mb-2">准备就绪</h3>
                      <p className="text-sm text-slate-400 max-w-md text-center">
                        你可以在“流程编排”中为任意任务开启正态分布时长，然后设置采样次数，系统会用平均完工时间来评估排程序列。
                      </p>
                    </div>
                  )}

                  {result && (
                    <div className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
                        {[
                          { label: '平均完工时间', value: `${result.makespan} min`, icon: Clock, color: 'text-blue-600', bg: 'bg-blue-50' },
                          { label: '采样次数', value: result.sampleCount, icon: Sigma, color: 'text-violet-600', bg: 'bg-violet-50' },
                          { label: '不确定任务', value: uncertaintyTaskCount, icon: Activity, color: 'text-rose-600', bg: 'bg-rose-50' },
                          { label: '飞机总数', value: numPlanes, icon: Plane, color: 'text-emerald-600', bg: 'bg-emerald-50' },
                          { label: '计算引擎', value: result.engine === 'python' ? 'Python Core' : 'TS Fallback', icon: Settings, color: 'text-amber-600', bg: 'bg-amber-50' },
                        ].map(stat => (
                          <div key={stat.label} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
                            <div className={`p-3 ${stat.bg} ${stat.color} rounded-xl`}>
                              <stat.icon className="w-6 h-6" />
                            </div>
                            <div>
                              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">{stat.label}</p>
                              <p className="text-xl font-black text-slate-800">{stat.value}</p>
                            </div>
                          </div>
                        ))}
                      </div>

                      {result.history.length > 1 && (
                        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                            <TrendingDown className="w-4 h-4" /> 采样目标收敛过程
                          </h3>
                          <div className="h-64 w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={result.history}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                <XAxis dataKey="gen" hide />
                                <YAxis stroke="#94a3b8" fontSize={10} axisLine={false} tickLine={false} />
                                <RechartsTooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }} />
                                <Line type="monotone" dataKey="bestMs" stroke="#2563eb" strokeWidth={3} dot={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}

                      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">甘特图排程结果</h3>
                        <p className="text-xs text-slate-400 mb-6">甘特图使用确定性基线时长展示任务顺序；优化目标仍然是采样平均完工时间。</p>
                        <GanttChart scheduled={result.scheduled} tasks={result.tasks} makespan={Math.ceil(result.makespan)} numPlanes={numPlanes} />
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {activeTab === 'workflow' && (
                <motion.div key="workflow" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-6">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h2 className="text-2xl font-black text-slate-800">流程编排</h2>
                      <p className="text-sm text-slate-500">为任务设置依赖、资源需求，以及是否使用正态分布时长采样。</p>
                    </div>
                    <button onClick={addTask} className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-800 transition-all">
                      <Plus className="w-4 h-4" /> 添加步骤
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-4">
                    {workflow.map((task, index) => (
                      <div key={task.id} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-start gap-6 group">
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center font-bold text-slate-400 text-xs">{index + 1}</div>
                          {index < workflow.length - 1 && <div className="w-0.5 h-12 bg-slate-100" />}
                        </div>

                        <div className="flex-1 grid grid-cols-1 xl:grid-cols-5 gap-6">
                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase">流程标识 / 名称</label>
                            <div className="flex gap-2">
                              <input value={task.id} disabled className="w-16 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-mono text-slate-400" />
                              <input
                                value={task.name}
                                onChange={event => updateTask(task.id, { name: event.target.value })}
                                className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                              />
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase">确定性时长 (min)</label>
                            <input
                              type="number"
                              min="1"
                              value={task.duration}
                              onChange={event => updateTask(task.id, { duration: Number(event.target.value) })}
                              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase">紧前工序</label>
                            <div className="flex flex-wrap gap-1.5">
                              {workflow.filter(item => item.id !== task.id).map(item => (
                                <button
                                  key={item.id}
                                  onClick={() => {
                                    const nextPredecessors = task.predecessors.includes(item.id)
                                      ? task.predecessors.filter(predecessor => predecessor !== item.id)
                                      : [...task.predecessors, item.id];
                                    updateTask(task.id, { predecessors: nextPredecessors });
                                  }}
                                  className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${task.predecessors.includes(item.id) ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                                >
                                  {item.id}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase">资源需求</label>
                            <div className="space-y-2">
                              {resourceConfig.map(resource => (
                                <div key={resource.name} className="flex items-center justify-between gap-2">
                                  <span className="text-[10px] font-bold text-slate-500 truncate max-w-[80px]">{resource.name}</span>
                                  <input
                                    type="number"
                                    min="0"
                                    max={resource.capacity}
                                    value={task.resources[resource.name] || 0}
                                    onChange={event => {
                                      const value = Number(event.target.value);
                                      const nextResources = { ...task.resources };
                                      if (value === 0) delete nextResources[resource.name];
                                      else nextResources[resource.name] = value;
                                      updateTask(task.id, { resources: nextResources });
                                    }}
                                    className="w-12 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] text-right font-bold"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-3">
                            <label className="text-[10px] font-black text-slate-400 uppercase">不确定性设置</label>
                            <button
                              onClick={() =>
                                updateTaskUncertainty(task.id, {
                                  enabled: !task.uncertainty.enabled,
                                  mean: task.uncertainty.enabled ? task.uncertainty.mean : task.uncertainty.mean || task.duration,
                                })
                              }
                              className={`w-full rounded-lg px-3 py-2 text-xs font-bold transition-all ${task.uncertainty.enabled ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                            >
                              {task.uncertainty.enabled ? '已启用正态分布' : '启用正态分布'}
                            </button>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-[10px] text-slate-400">均值</label>
                                <input
                                  type="number"
                                  min="0.1"
                                  step="0.1"
                                  disabled={!task.uncertainty.enabled}
                                  value={task.uncertainty.mean}
                                  onChange={event => updateTaskUncertainty(task.id, { mean: Number(event.target.value) })}
                                  className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs font-bold disabled:opacity-50"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-slate-400">标准差</label>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.1"
                                  disabled={!task.uncertainty.enabled}
                                  value={task.uncertainty.stdDev}
                                  onChange={event => updateTaskUncertainty(task.id, { stdDev: Number(event.target.value) })}
                                  className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs font-bold disabled:opacity-50"
                                />
                              </div>
                            </div>
                          </div>
                        </div>

                        <button onClick={() => removeTask(task.id)} className="p-2 text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {activeTab === 'resources' && (
                <motion.div key="resources" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-6">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h2 className="text-2xl font-black text-slate-800">资源配置</h2>
                      <p className="text-sm text-slate-500">管理保障人员、车辆与设备的容量限制。</p>
                    </div>
                    <button onClick={addResource} className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-800 transition-all">
                      <Plus className="w-4 h-4" /> 添加资源
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {resourceConfig.map((resource, index) => (
                      <div key={resource.name + index} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4 group relative">
                        <div className="flex items-center gap-4">
                          <div className="bg-slate-100 p-3 rounded-xl text-slate-500">
                            {resource.name.includes('人') ? <Users className="w-6 h-6" /> : resource.name.includes('车') ? <Zap className="w-6 h-6" /> : <Wrench className="w-6 h-6" />}
                          </div>
                          <div className="flex-1">
                            <input
                              value={resource.name}
                              onChange={event => updateResource(index, { name: event.target.value })}
                              className="w-full bg-transparent border-none p-0 text-lg font-bold text-slate-800 focus:ring-0 outline-none"
                            />
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">资源名称</p>
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex justify-between items-end">
                            <label className="text-[10px] font-black text-slate-400 uppercase">最大容量 (单位)</label>
                            <span className="text-2xl font-black text-blue-600">{resource.capacity}</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="50"
                            value={resource.capacity}
                            onChange={event => updateResource(index, { capacity: Number(event.target.value) })}
                            className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                          />
                        </div>

                        <button onClick={() => removeResource(resource.name)} className="absolute top-4 right-4 p-2 text-slate-200 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {activeTab === 'monitoring' && result && (
                <motion.div key="monitoring" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Dashboard scheduled={result.scheduled} tasks={result.tasks} makespan={Math.ceil(result.makespan)} numPlanes={numPlanes} resources={resCapMap} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}
