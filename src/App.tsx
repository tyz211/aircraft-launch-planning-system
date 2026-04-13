import React, { useEffect, useMemo, useState } from 'react';
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
import {
  FailureCandidate,
  FailureRule,
  GeneticAlgorithm,
  ResourceMap,
  RescheduleSimulationResult,
  SimulatedAnnealing,
  Task,
  TaskInfo,
  simulateReschedule,
} from './lib/ga';

const INITIAL_WORKFLOW: TaskInfo[] = [
  { id: 'F1', name: '接收检查', duration: 3, resources: { '机务人员': 2 }, predecessors: [], uncertainty: { enabled: false, mean: 3, stdDev: 0.5 } },
  { id: 'F2', name: '燃油加注', duration: 6, resources: { '加油车': 1, '机务人员': 1 }, predecessors: ['F1'], uncertainty: { enabled: false, mean: 6.3, stdDev: 1.0 } },
  { id: 'F3', name: '挂弹作业', duration: 5, resources: { '挂弹车': 1, '军械人员': 2 }, predecessors: ['F1'], uncertainty: { enabled: false, mean: 5, stdDev: 0.6 } },
  { id: 'F4', name: '航电检查', duration: 4, resources: { '航电人员': 1, '测试仪': 1 }, predecessors: ['F1'], uncertainty: { enabled: false, mean: 4.2, stdDev: 0.8 } },
  { id: 'F5', name: '综合测试', duration: 5, resources: { '机务人员': 1, '航电人员': 1, '测试仪': 1 }, predecessors: ['F2', 'F3', 'F4'], uncertainty: { enabled: false, mean: 5.5, stdDev: 1.0 } },
  { id: 'F6', name: '最终确认', duration: 2, resources: { '特设人员': 1 }, predecessors: ['F5'], uncertainty: { enabled: false, mean: 2, stdDev: 0.4 } },
  { id: 'F7', name: '发动机试车', duration: 4, resources: { '机务人员': 2, '测试仪': 1 }, predecessors: ['F6'], uncertainty: { enabled: false, mean: 4.4, stdDev: 0.9 } },
  { id: 'F8', name: '放飞指令', duration: 1, resources: {}, predecessors: ['F7'], uncertainty: { enabled: false, mean: 1, stdDev: 0.2 } },
];

const INITIAL_RESOURCES: { name: string; capacity: number }[] = [
  { name: '机务人员', capacity: 8 },
  { name: '军械人员', capacity: 4 },
  { name: '航电人员', capacity: 3 },
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

type RescheduleResultState = RescheduleSimulationResult & {
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

function calculateActualMakespan(scheduled: Record<string, [number, number]>) {
  const windows = Object.values(scheduled);
  return windows.length > 0 ? Math.max(...windows.map(([, end]) => end)) : 0;
}

function formatPlaneLabels(planeIds: number[]) {
  return planeIds.map(planeId => `A${planeId}`).join(', ');
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
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [progress, setProgress] = useState({ gen: 0, bestMs: 0 });
  const [rescheduleProgress, setRescheduleProgress] = useState({ gen: 0, bestMs: 0 });
  const [activeTab, setActiveTab] = useState<'planning' | 'workflow' | 'resources' | 'monitoring'>('planning');
  const [planningView, setPlanningView] = useState<'base' | 'reschedule'>('base');
  const [result, setResult] = useState<ResultState | null>(null);
  const [rescheduleResult, setRescheduleResult] = useState<RescheduleResultState | null>(null);
  const [rescheduleTargetPlanes, setRescheduleTargetPlanes] = useState<number[]>([1, 2]);
  const [failureRules, setFailureRules] = useState<Record<string, { enabled: boolean; probability: number }>>(
    () =>
      Object.fromEntries(
        INITIAL_WORKFLOW.map(task => [
          task.id,
          {
            enabled: false,
            probability: 0.2,
          },
        ]),
      ),
  );

  const resCapMap = useMemo(() => {
    const map: ResourceMap = {};
    resourceConfig.forEach(resource => {
      map[resource.name] = resource.capacity;
    });
    return map;
  }, [resourceConfig]);

  const uncertaintyTaskCount = useMemo(() => workflow.filter(task => task.uncertainty.enabled).length, [workflow]);
  const activeFailureRuleCount = useMemo(
    () => workflow.filter(task => failureRules[task.id]?.enabled).length,
    [failureRules, workflow],
  );
  const rescheduleProgressTotal = Math.max(gens, gens * Math.max(1, rescheduleTargetPlanes.length));

  useEffect(() => {
    setRescheduleTargetPlanes(current => {
      const next = current.filter(planeId => planeId >= 1 && planeId <= numPlanes);
      if (next.length > 0) return next;
      return Array.from({ length: Math.min(2, numPlanes) }, (_, index) => index + 1);
    });
  }, [numPlanes]);

  useEffect(() => {
    setFailureRules(current => {
      const nextRules: Record<string, { enabled: boolean; probability: number }> = {};
      workflow.forEach(task => {
        nextRules[task.id] = current[task.id] ?? { enabled: false, probability: 0.2 };
      });
      return nextRules;
    });
  }, [workflow]);

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

  const updateFailureRule = (taskId: string, updates: Partial<{ enabled: boolean; probability: number }>) => {
    setFailureRules(current => ({
      ...current,
      [taskId]: {
        enabled: current[taskId]?.enabled ?? false,
        probability: current[taskId]?.probability ?? 0.2,
        ...updates,
      },
    }));
  };

  const toggleReschedulePlane = (planeId: number) => {
    setRescheduleTargetPlanes(current =>
      current.includes(planeId) ? current.filter(item => item !== planeId) : [...current, planeId].sort((left, right) => left - right),
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
    setRescheduleResult(null);
    setProgress({ gen: 0, bestMs: 0 });
    setPlanningView('base');
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

  const runReschedule = async () => {
    if (!result) {
      alert('请先生成基础排程结果。');
      return;
    }

    const normalizedWorkflow = workflow.map(normalizeTask);
    const normalizedTargetPlanes: number[] = Array.from(new Set<number>(rescheduleTargetPlanes))
      .filter(planeId => planeId >= 1 && planeId <= numPlanes)
      .sort((left, right) => left - right);
    const selectedFailureRules: FailureRule[] = normalizedWorkflow.map(task => ({
      taskId: task.id,
      enabled: failureRules[task.id]?.enabled ?? false,
      probability: Math.min(1, Math.max(0, failureRules[task.id]?.probability ?? 0)),
    }));

    if (normalizedTargetPlanes.length === 0) {
      alert('请至少选择一架目标飞机。');
      return;
    }

    if (!selectedFailureRules.some(rule => rule.enabled)) {
      alert('请至少选择一个会触发换机的活动。');
      return;
    }

    setIsRescheduling(true);
    setRescheduleResult(null);
    setRescheduleProgress({ gen: 0, bestMs: 0 });
    setPlanningView('reschedule');
    setActiveTab('planning');

    try {
      const response = await fetch('http://127.0.0.1:15050/api/reschedule', {
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
          baseScheduled: result.scheduled,
          baseMakespan: result.makespan,
          targetPlanes: normalizedTargetPlanes,
          targetPlane: normalizedTargetPlanes[0],
          failureRules: selectedFailureRules,
        }),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        throw new Error(errorPayload?.error ?? 'Backend unavailable');
      }

      const data = await response.json();
      const failureEvents = data.failureEvents ?? (data.failureEvent ? [data.failureEvent] : []);
      const replacementPlaneIds = data.replacementPlaneIds ?? (data.replacementPlaneId ? [data.replacementPlaneId] : []);
      const scheduled = data.scheduled ?? {};
      const completedGen = Array.isArray(data.history) && data.history.length > 0 ? data.history[data.history.length - 1].gen : gens;
      setRescheduleProgress({ gen: completedGen, bestMs: data.makespan });
      setRescheduleResult({
        scheduled,
        makespan: data.makespan,
        actualMakespan: data.actualMakespan ?? calculateActualMakespan(scheduled),
        tasks: data.tasks,
        history: data.history,
        triggered: data.triggered,
        failureEvent: data.failureEvent ?? failureEvents[0] ?? null,
        failureEvents,
        candidateFailures: data.candidateFailures ?? [],
        replacementPlaneId: data.replacementPlaneId ?? replacementPlaneIds[0] ?? undefined,
        replacementPlaneIds,
        targetPlanes: data.targetPlanes ?? normalizedTargetPlanes,
        frozenTaskIds: data.frozenTaskIds ?? [],
        removedTaskIds: data.removedTaskIds ?? [],
        engine: 'python',
        sampleCount: data.sampleCount ?? sampleCount,
      });
    } catch (error) {
      console.warn('Using local TS reschedule fallback...', error);

      try {
        const localResult = await simulateReschedule(
          {
            tasks: result.tasks,
            workflow: normalizedWorkflow,
            numPlanes,
            resources: resCapMap,
            algorithm,
            popSize,
            gens,
            sampleCount,
            baseScheduled: result.scheduled,
            baseMakespan: result.makespan,
            targetPlanes: normalizedTargetPlanes,
            failureRules: selectedFailureRules,
          },
          (gen, bestMs) => setRescheduleProgress({ gen, bestMs }),
        );

        setRescheduleResult({
          ...localResult,
          engine: 'local',
          sampleCount,
        });
      } catch (localError) {
        console.error('Reschedule failed:', localError);
        alert('重调度仿真失败，请检查换机规则设置。');
      }
    } finally {
      setIsRescheduling(false);
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
            <p className="text-xs text-slate-500 font-medium">支持正态分布时长采样与换机重调度仿真</p>
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
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h2 className="text-2xl font-black text-slate-800">{planningView === 'base' ? '基础排程' : '重调度仿真'}</h2>
                      <p className="text-sm text-slate-500">
                        {planningView === 'base'
                          ? '先生成考虑不确定任务时长的基础排程结果。'
                          : '在基础排程上模拟检测失败、换机加入和剩余任务重调度。'}
                      </p>
                    </div>
                    <div className="flex bg-slate-100 p-1 rounded-xl">
                      <button
                        onClick={() => setPlanningView('base')}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${planningView === 'base' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        基础排程
                      </button>
                      <button
                        onClick={() => setPlanningView('reschedule')}
                        disabled={!result}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${planningView === 'reschedule' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'} ${!result ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        重调度仿真
                      </button>
                    </div>
                  </div>

                  {planningView === 'base' ? (
                    <>
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
                            <GanttChart scheduled={result.scheduled} tasks={result.tasks} makespan={Math.ceil(result.makespan)} />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      {!result ? (
                        <div className="h-[50vh] flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-3xl bg-white/50">
                          <div className="bg-slate-100 p-6 rounded-full mb-6">
                            <Plane className="w-12 h-12 text-slate-300" />
                          </div>
                          <h3 className="text-lg font-bold text-slate-600 mb-2">先生成基础排程</h3>
                          <p className="text-sm text-slate-400 max-w-md text-center">重调度仿真依赖当前的基础排程结果，请先执行一次“开始优化”。</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 xl:grid-cols-[360px,1fr] gap-6">
                          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-6">
                            <div>
                              <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-2">仿真配置</h3>
                              <p className="text-sm text-slate-500">选择一个或多个目标飞机，并为它们配置可能导致换机的活动。若活动在本次仿真中触发失败，系统会按事件先后顺序冻结已开始任务、移除故障飞机后续任务，并加入对应数量的替换飞机重新排程。</p>
                            </div>

                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <label className="text-xs font-bold text-slate-600">目标飞机集合</label>
                                <span className="text-[11px] text-slate-400">已选 {rescheduleTargetPlanes.length} 架</span>
                              </div>
                              <div className="grid grid-cols-4 gap-2">
                                {Array.from({ length: numPlanes }).map((_, index) => {
                                  const planeId = index + 1;
                                  const isSelected = rescheduleTargetPlanes.includes(planeId);
                                  return (
                                    <button
                                      key={planeId}
                                      onClick={() => toggleReschedulePlane(planeId)}
                                      className={`rounded-lg border px-3 py-2 text-sm font-bold transition-all ${isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'}`}
                                    >
                                      A{planeId}
                                    </button>
                                  );
                                })}
                              </div>
                              <p className="text-[11px] text-slate-400">当前设置会对所有已选目标飞机应用相同的故障活动规则，适合模拟两架及以上飞机连续触发重调度的复杂场景。</p>
                            </div>

                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <label className="text-xs font-bold text-slate-600">换机触发活动</label>
                                <span className="text-[11px] text-slate-400">已选 {activeFailureRuleCount} 项</span>
                              </div>
                              <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                                {workflow.map(task => (
                                  <div key={task.id} className="rounded-xl border border-slate-200 p-4 bg-slate-50">
                                    <div className="flex items-start justify-between gap-3">
                                      <div>
                                        <div className="text-sm font-bold text-slate-800">
                                          {task.id} {task.name}
                                        </div>
                                        <div className="text-[11px] text-slate-400">所有已选目标飞机上的该活动都会参与失败判定。</div>
                                      </div>
                                      <button
                                        onClick={() => updateFailureRule(task.id, { enabled: !(failureRules[task.id]?.enabled ?? false) })}
                                        className={`px-2.5 py-1 rounded text-[11px] font-bold transition-all ${(failureRules[task.id]?.enabled ?? false) ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-100'}`}
                                      >
                                        {(failureRules[task.id]?.enabled ?? false) ? '已启用' : '启用'}
                                      </button>
                                    </div>
                                    <div className="mt-3">
                                      <label className="text-[11px] text-slate-400">失败概率 (0-1)</label>
                                      <input
                                        type="number"
                                        min="0"
                                        max="1"
                                        step="0.05"
                                        value={failureRules[task.id]?.probability ?? 0.2}
                                        disabled={!(failureRules[task.id]?.enabled ?? false)}
                                        onChange={event => updateFailureRule(task.id, { probability: Number(event.target.value) })}
                                        className="mt-1 w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-50"
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-xs text-blue-800 leading-relaxed">
                              系统会按触发时刻先后依次处理故障事件。每次重调度都从对应故障任务结束时刻开始，该时刻之前已经开始的活动保持不变，未开始的剩余任务和新加入的替换飞机一起重新优化。
                            </div>

                            <button
                              onClick={runReschedule}
                              disabled={isRescheduling}
                              className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg shadow-sm text-sm font-bold text-white transition-all ${isRescheduling ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 active:scale-[0.99]'}`}
                            >
                              {isRescheduling ? <Activity className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                              {isRescheduling ? '仿真中...' : '执行重调度仿真'}
                            </button>
                          </div>

                          <div className="space-y-6">
                            {isRescheduling && (
                              <div className="bg-white p-6 rounded-2xl shadow-sm border border-blue-100">
                                <div className="flex justify-between text-sm font-bold text-slate-600 mb-3">
                                  <span className="flex items-center gap-2">
                                    <Activity className="w-4 h-4 animate-pulse text-blue-600" /> 正在重调度...
                                  </span>
                                  <span>
                                    第 {rescheduleProgress.gen} / {rescheduleProgressTotal} 轮 | 当前最优平均完工时间: {rescheduleProgress.bestMs || '-'}
                                  </span>
                                </div>
                                <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
                                  <motion.div className="bg-blue-600 h-full" initial={{ width: 0 }} animate={{ width: `${Math.min(100, (rescheduleProgress.gen / rescheduleProgressTotal) * 100)}%` }} />
                                </div>
                              </div>
                            )}

                            {!isRescheduling && !rescheduleResult && (
                              <div className="bg-white p-10 rounded-2xl shadow-sm border border-slate-200 text-center text-slate-400">
                                <Plane className="w-10 h-10 mx-auto mb-4 text-slate-300" />
                                <h3 className="text-lg font-bold text-slate-600 mb-2">等待执行重调度</h3>
                                <p className="text-sm max-w-lg mx-auto">配置好目标飞机和触发活动后，系统会基于当前基础排程模拟故障并输出新的甘特图。</p>
                              </div>
                            )}

                            {rescheduleResult && (
                              <div className="space-y-6">
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4">
                                  {[
                                    {
                                      label: '仿真状态',
                                      value: rescheduleResult.triggered ? `${rescheduleResult.failureEvents.length} 架触发换机` : '未触发',
                                      icon: Activity,
                                      color: rescheduleResult.triggered ? 'text-red-600' : 'text-emerald-600',
                                      bg: rescheduleResult.triggered ? 'bg-red-50' : 'bg-emerald-50',
                                    },
                                    {
                                      label: '目标飞机',
                                      value: formatPlaneLabels(rescheduleResult.targetPlanes),
                                      icon: Plane,
                                      color: 'text-blue-600',
                                      bg: 'bg-blue-50',
                                    },
                                    {
                                      label: '故障活动',
                                      value: rescheduleResult.failureEvents.length > 0 ? Array.from(new Set(rescheduleResult.failureEvents.map(event => event.taskId))).join(', ') : '未触发',
                                      icon: GitBranch,
                                      color: 'text-amber-600',
                                      bg: 'bg-amber-50',
                                    },
                                    {
                                      label: '替换飞机',
                                      value: rescheduleResult.replacementPlaneIds.length > 0 ? formatPlaneLabels(rescheduleResult.replacementPlaneIds) : '-',
                                      icon: Plane,
                                      color: 'text-violet-600',
                                      bg: 'bg-violet-50',
                                    },
                                    {
                                      label: '实际完工时间',
                                      value: `${rescheduleResult.actualMakespan} min`,
                                      icon: Sigma,
                                      color: 'text-rose-600',
                                      bg: 'bg-rose-50',
                                    },
                                    {
                                      label: '平均完工时间',
                                      value: `${rescheduleResult.makespan} min`,
                                      icon: Clock,
                                      color: 'text-slate-700',
                                      bg: 'bg-slate-100',
                                    },
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

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                  <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-3">
                                    <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest">事件摘要</h3>
                                    <div className="text-sm text-slate-600 leading-7">
                                      {rescheduleResult.failureEvents.length > 0 ? (
                                        <>
                                          <p>
                                            本次共对 <span className="font-bold text-slate-800">{formatPlaneLabels(rescheduleResult.targetPlanes)}</span> 进行故障判定，其中{' '}
                                            <span className="font-bold text-slate-800">{rescheduleResult.failureEvents.length}</span> 架飞机触发换机。
                                          </p>
                                          {rescheduleResult.failureEvents.map((event, index) => (
                                            <p key={event.globalTaskId}>
                                              第 {event.iteration ?? index + 1} 次：A{event.planeId} 在活动 {event.taskId}（{event.taskName}）结束时触发失败，触发时刻为{' '}
                                              <span className="font-bold text-slate-800">{event.end}</span> 分钟，对应替换飞机为{' '}
                                              <span className="font-bold text-slate-800">A{rescheduleResult.replacementPlaneIds[index]}</span>。
                                            </p>
                                          ))}
                                          <p>
                                            累计冻结任务 <span className="font-bold text-slate-800">{rescheduleResult.frozenTaskIds.length}</span> 个，移除故障飞机未执行任务{' '}
                                            <span className="font-bold text-slate-800">{rescheduleResult.removedTaskIds.length}</span> 个，并加入替换飞机{' '}
                                            <span className="font-bold text-slate-800">{formatPlaneLabels(rescheduleResult.replacementPlaneIds)}</span> 参与后续调度。
                                          </p>
                                        </>
                                      ) : (
                                        <p>本次仿真中未触发检测失败，排程保持原方案不变。</p>
                                      )}
                                    </div>
                                  </div>

                                  <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                                    <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">候选活动判定</h3>
                                    <div className="space-y-3">
                                      {rescheduleResult.candidateFailures.map(candidate => (
                                        <div key={candidate.globalTaskId} className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3">
                                          <div>
                                            <div className="text-sm font-bold text-slate-800">
                                              A{candidate.planeId} {candidate.taskId} {candidate.taskName}
                                            </div>
                                            <div className="text-[11px] text-slate-400">
                                              第 {candidate.iteration ?? 1} 轮 | 概率 {candidate.probability} | 随机值 {candidate.roll} | 时刻 {candidate.end}
                                            </div>
                                          </div>
                                          <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${candidate.triggered ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'}`}>
                                            {candidate.triggered ? '已触发' : '未触发'}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </div>

                                {rescheduleResult.history.length > 1 && (
                                  <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                                    <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                                      <TrendingDown className="w-4 h-4" /> 重调度收敛过程
                                    </h3>
                                    <div className="h-64 w-full">
                                      <ResponsiveContainer width="100%" height="100%">
                                        <LineChart data={rescheduleResult.history}>
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
                                  <div className="flex items-center justify-between gap-4 mb-2">
                                    <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest">重调度后甘特图</h3>
                                    <span className="text-xs text-slate-400">引擎: {rescheduleResult.engine === 'python' ? 'Python Core' : 'TS Fallback'}</span>
                                  </div>
                                  <p className="text-xs text-slate-400 mb-6">红框表示触发失败的活动，带 * 的行为新增替换飞机。</p>
                                  <GanttChart
                                    scheduled={rescheduleResult.scheduled}
                                    tasks={rescheduleResult.tasks}
                                    makespan={Math.max(1, Math.ceil(rescheduleResult.actualMakespan))}
                                    replacementPlaneIds={rescheduleResult.replacementPlaneIds}
                                    failureTaskIds={rescheduleResult.failureEvents.map(event => event.globalTaskId)}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
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
