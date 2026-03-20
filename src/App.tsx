import React, { useState, useMemo } from 'react';
import { 
  Settings, Play, Activity, Plane, Users, Wrench, Zap, 
  TrendingDown, Clock, Plus, Trash2, ChevronRight, 
  LayoutDashboard, GitBranch, Database, Info
} from 'lucide-react';
import { 
  GeneticAlgorithm, GreedyAlgorithm, SimulatedAnnealing, 
  Task, TaskInfo, ResourceMap 
} from './lib/ga';
import { GanttChart } from './components/GanttChart';
import { Dashboard } from './components/Dashboard';
import { motion, AnimatePresence } from 'motion/react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, 
  Tooltip as RechartsTooltip, ResponsiveContainer 
} from 'recharts';

// Initial Default Workflow
const INITIAL_WORKFLOW: TaskInfo[] = [
  { id: 'F1', name: '接收检查', duration: 2, resources: { '机务人员': 2 }, predecessors: [] },
  { id: 'F2', name: '燃油加注', duration: 4, resources: { '加油车': 1, '机务人员': 1 }, predecessors: ['F1'] },
  { id: 'F3', name: '挂弹作业', duration: 2, resources: { '挂弹车': 1, '军械人员': 2 }, predecessors: ['F1'] },
  { id: 'F4', name: '航电检查', duration: 2, resources: { '航电人员': 1, '测试仪': 1 }, predecessors: ['F1'] },
  { id: 'F5', name: '综合测试', duration: 3, resources: { '机务人员': 1, '航电人员': 1 }, predecessors: ['F2', 'F3', 'F4'] },
  { id: 'F6', name: '最终确认', duration: 1, resources: { '特设人员': 1 }, predecessors: ['F5'] },
  { id: 'F7', name: '发动机试车', duration: 2, resources: { '机务人员': 2 }, predecessors: ['F6'] },
  { id: 'F8', name: '放飞指令', duration: 1, resources: {}, predecessors: ['F7'] },
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

export default function App() {
  const [numPlanes, setNumPlanes] = useState(8);
  const [popSize, setPopSize] = useState(30);
  const [gens, setGens] = useState(50);
  const [algorithm, setAlgorithm] = useState<'GA' | 'SA' | 'Greedy'>('GA');
  
  const [workflow, setWorkflow] = useState<TaskInfo[]>(INITIAL_WORKFLOW);
  const [resourceConfig, setResourceConfig] = useState(INITIAL_RESOURCES);
  
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ gen: 0, bestMs: 0 });
  const [activeTab, setActiveTab] = useState<'planning' | 'workflow' | 'resources' | 'monitoring'>('planning');
  
  const [result, setResult] = useState<{
    scheduled: Record<string, [number, number]>;
    makespan: number;
    tasks: Record<string, Task>;
    history: { gen: number; bestMs: number }[];
    engine?: 'python' | 'local';
  } | null>(null);

  // Derived resource map for the algorithm
  const resCapMap = useMemo(() => {
    const map: ResourceMap = {};
    resourceConfig.forEach(r => {
      map[r.name] = r.capacity;
    });
    return map;
  }, [resourceConfig]);

  const addTask = () => {
    const newId = `F${workflow.length + 1}`;
    setWorkflow([...workflow, { 
      id: newId, 
      name: '新流程', 
      duration: 1, 
      resources: {}, 
      predecessors: [] 
    }]);
  };

  const removeTask = (id: string) => {
    setWorkflow(workflow.filter(t => t.id !== id).map(t => ({
      ...t,
      predecessors: t.predecessors.filter(p => p !== id)
    })));
  };

  const updateTask = (id: string, updates: Partial<TaskInfo>) => {
    setWorkflow(workflow.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  const addResource = () => {
    setResourceConfig([...resourceConfig, { name: '新资源', capacity: 1 }]);
  };

  const removeResource = (name: string) => {
    setResourceConfig(resourceConfig.filter(r => r.name !== name));
    // Also remove from workflow tasks
    setWorkflow(workflow.map(t => {
      const newRes = { ...t.resources };
      delete newRes[name];
      return { ...t, resources: newRes };
    }));
  };

  const updateResource = (index: number, updates: Partial<{ name: string; capacity: number }>) => {
    const oldName = resourceConfig[index].name;
    const newConfig = [...resourceConfig];
    newConfig[index] = { ...newConfig[index], ...updates };
    setResourceConfig(newConfig);

    if (updates.name && updates.name !== oldName) {
      // Update resource names in workflow
      setWorkflow(workflow.map(t => {
        if (t.resources[oldName] !== undefined) {
          const newRes = { ...t.resources };
          newRes[updates.name!] = newRes[oldName];
          delete newRes[oldName];
          return { ...t, resources: newRes };
        }
        return t;
      }));
    }
  };

  const runOptimization = async () => {
    setIsRunning(true);
    setResult(null);
    setProgress({ gen: 0, bestMs: 0 });
    setActiveTab('planning');

    // Initialize tasks dynamically based on workflow and numPlanes
    const tasks: Record<string, Task> = {};
    const all_ids: string[] = [];
    
    for (let p = 1; p <= numPlanes; p++) {
      const plane_map: Record<string, string> = {};
      workflow.forEach(t => {
        const gid = `A${p}_${t.id}`;
        plane_map[t.id] = gid;
        all_ids.push(gid);
      });
      
      workflow.forEach(t => {
        const preds = t.predecessors.map(pid => plane_map[pid]);
        tasks[plane_map[t.id]] = new Task(
          plane_map[t.id], p, t.id, t.name, t.duration, t.resources, preds
        );
      });
    }

    try {
      // Attempt Python backend first
      const response = await fetch('http://127.0.0.1:15050/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numPlanes,
          popSize,
          gens,
          resources: resCapMap,
          workflow,
          algorithm
        }),
      });

      if (!response.ok) throw new Error('Backend unavailable');

      const data = await response.json();
      setProgress({ gen: gens, bestMs: data.makespan });
      setResult({ 
        scheduled: data.scheduled, 
        makespan: data.makespan, 
        tasks: data.tasks, 
        history: data.history,
        engine: 'python'
      });
    } catch (error) {
      console.warn("Using local TS fallback...", error);
      
      let runner: any;
      if (algorithm === 'GA') {
        runner = new GeneticAlgorithm(tasks, all_ids, resCapMap, popSize, gens);
      } else if (algorithm === 'SA') {
        runner = new SimulatedAnnealing(tasks, all_ids, resCapMap, gens);
      } else {
        runner = new GreedyAlgorithm(tasks, all_ids, resCapMap);
      }
      
      try {
        const { scheduled, makespan, history } = await runner.run((gen: number, bestMs: number) => {
          setProgress({ gen, bestMs });
        });
        setResult({ scheduled, makespan, tasks, history, engine: 'local' });
      } catch (tsError) {
        console.error("Optimization failed:", tsError);
        alert("优化计算失败，请检查参数设置。");
      }
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-20 sticky top-0">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg text-white">
            <Plane className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">智能飞机放飞调度系统</h1>
            <p className="text-xs text-slate-500 font-medium">Enterprise Resource Planning & Optimization</p>
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
            className={`flex items-center gap-2 py-2 px-6 rounded-lg shadow-sm text-sm font-bold text-white transition-all ${
              isRunning ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 active:scale-95'
            }`}
          >
            {isRunning ? <Activity className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {isRunning ? '优化中...' : '开始优化'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar - Global Settings */}
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
                  onChange={e => setAlgorithm(e.target.value as any)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="GA">遗传算法 (GA)</option>
                  <option value="SA">模拟退火 (SA)</option>
                  <option value="Greedy">贪心算法 (Greedy)</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600">飞机总数</label>
                <div className="flex items-center gap-3">
                  <input 
                    type="range" min="1" max="30" value={numPlanes}
                    onChange={e => setNumPlanes(Number(e.target.value))}
                    className="flex-1 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <span className="text-sm font-bold text-slate-800 w-6">{numPlanes}</span>
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
                  type="number" value={popSize} disabled={algorithm !== 'GA'}
                  onChange={e => setPopSize(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-600">迭代次数</label>
                <input 
                  type="number" value={gens} disabled={algorithm === 'Greedy'}
                  onChange={e => setGens(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
                />
              </div>
            </div>
          </section>

          <div className="pt-4">
            <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
              <div className="flex items-start gap-3">
                <Info className="w-4 h-4 text-blue-600 mt-0.5" />
                <p className="text-xs text-blue-800 leading-relaxed">
                  系统将根据定义的流程依赖与资源限制，自动计算最优的放飞顺序与资源分配方案。
                </p>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-8 bg-slate-50/50">
          <div className="max-w-6xl mx-auto">
            <AnimatePresence mode="wait">
              {activeTab === 'planning' && (
                <motion.div 
                  key="planning"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-6"
                >
                  {isRunning && (
                    <div className="bg-white p-6 rounded-2xl shadow-sm border border-blue-100">
                      <div className="flex justify-between text-sm font-bold text-slate-600 mb-3">
                        <span className="flex items-center gap-2"><Activity className="w-4 h-4 animate-pulse text-blue-600" /> 正在计算最优解...</span>
                        <span>第 {progress.gen} / {gens} 代 | 最优完工时间: {progress.bestMs || '-'}</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
                        <motion.div 
                          className="bg-blue-600 h-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${(progress.gen / gens) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {!isRunning && !result && (
                    <div className="h-[60vh] flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-3xl bg-white/50">
                      <div className="bg-slate-100 p-6 rounded-full mb-6">
                        <LayoutDashboard className="w-12 h-12 text-slate-300" />
                      </div>
                      <h3 className="text-lg font-bold text-slate-600 mb-2">准备就绪</h3>
                      <p className="text-sm text-slate-400 max-w-xs text-center">
                        请在左侧配置参数，或在“流程编排”中自定义您的业务流程，然后点击“开始优化”。
                      </p>
                    </div>
                  )}

                  {result && (
                    <div className="space-y-6">
                      {/* Stats Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        {[
                          { label: '总完工时间', value: `${result.makespan} min`, icon: Clock, color: 'text-blue-600', bg: 'bg-blue-50' },
                          { label: '飞机总数', value: numPlanes, icon: Plane, color: 'text-emerald-600', bg: 'bg-emerald-50' },
                          { label: '总任务数', value: numPlanes * workflow.length, icon: Zap, color: 'text-amber-600', bg: 'bg-amber-50' },
                          { label: '计算引擎', value: result.engine === 'python' ? 'Python Core' : 'TS Fallback', icon: Settings, color: 'text-purple-600', bg: 'bg-purple-50' },
                        ].map((stat, i) => (
                          <div key={i} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-center gap-4">
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

                      {/* Convergence Chart */}
                      {result.history && result.history.length > 1 && (
                        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                            <TrendingDown className="w-4 h-4" /> 算法收敛过程
                          </h3>
                          <div className="h-64 w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={result.history}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                <XAxis dataKey="gen" hide />
                                <YAxis stroke="#94a3b8" fontSize={10} axisLine={false} tickLine={false} />
                                <RechartsTooltip 
                                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                                />
                                <Line type="monotone" dataKey="bestMs" stroke="#2563eb" strokeWidth={3} dot={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        </div>
                      )}

                      {/* Gantt Chart */}
                      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">甘特图排程结果</h3>
                        <GanttChart 
                          scheduled={result.scheduled} 
                          tasks={result.tasks} 
                          makespan={result.makespan} 
                          numPlanes={numPlanes} 
                        />
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {activeTab === 'workflow' && (
                <motion.div 
                  key="workflow"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h2 className="text-2xl font-black text-slate-800">流程编排</h2>
                      <p className="text-sm text-slate-500">定义单架飞机的标准保障流程与依赖关系</p>
                    </div>
                    <button 
                      onClick={addTask}
                      className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-800 transition-all"
                    >
                      <Plus className="w-4 h-4" /> 添加步骤
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-4">
                    {workflow.map((task, idx) => (
                      <div key={task.id} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex items-start gap-6 group">
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center font-bold text-slate-400 text-xs">
                            {idx + 1}
                          </div>
                          {idx < workflow.length - 1 && <div className="w-0.5 h-12 bg-slate-100" />}
                        </div>
                        
                        <div className="flex-1 grid grid-cols-1 md:grid-cols-4 gap-6">
                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase">流程标识 / 名称</label>
                            <div className="flex gap-2">
                              <input 
                                value={task.id} disabled
                                className="w-16 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-mono text-slate-400"
                              />
                              <input 
                                value={task.name}
                                onChange={e => updateTask(task.id, { name: e.target.value })}
                                className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                              />
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase">持续时间 (min)</label>
                            <input 
                              type="number" value={task.duration}
                              onChange={e => updateTask(task.id, { duration: Number(e.target.value) })}
                              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase">紧前工序</label>
                            <div className="flex flex-wrap gap-1.5">
                              {workflow.filter(t => t.id !== task.id).map(t => (
                                <button
                                  key={t.id}
                                  onClick={() => {
                                    const newPreds = task.predecessors.includes(t.id)
                                      ? task.predecessors.filter(p => p !== t.id)
                                      : [...task.predecessors, t.id];
                                    updateTask(task.id, { predecessors: newPreds });
                                  }}
                                  className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${task.predecessors.includes(t.id) ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                                >
                                  {t.id}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase">资源需求</label>
                            <div className="space-y-2">
                              {resourceConfig.map(res => (
                                <div key={res.name} className="flex items-center justify-between gap-2">
                                  <span className="text-[10px] font-bold text-slate-500 truncate max-w-[80px]">{res.name}</span>
                                  <input 
                                    type="number" min="0" max={res.capacity}
                                    value={task.resources[res.name] || 0}
                                    onChange={e => {
                                      const val = Number(e.target.value);
                                      const newRes = { ...task.resources };
                                      if (val === 0) delete newRes[res.name];
                                      else newRes[res.name] = val;
                                      updateTask(task.id, { resources: newRes });
                                    }}
                                    className="w-12 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] text-right font-bold"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        <button 
                          onClick={() => removeTask(task.id)}
                          className="p-2 text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {activeTab === 'resources' && (
                <motion.div 
                  key="resources"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-6"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h2 className="text-2xl font-black text-slate-800">资源配置</h2>
                      <p className="text-sm text-slate-500">管理可用的保障人员、车辆与设备及其容量限制</p>
                    </div>
                    <button 
                      onClick={addResource}
                      className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-800 transition-all"
                    >
                      <Plus className="w-4 h-4" /> 添加资源
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {resourceConfig.map((res, idx) => (
                      <div key={idx} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4 group relative">
                        <div className="flex items-center gap-4">
                          <div className="bg-slate-100 p-3 rounded-xl text-slate-500">
                            {res.name.includes('人') ? <Users className="w-6 h-6" /> : (res.name.includes('车') ? <Zap className="w-6 h-6" /> : <Wrench className="w-6 h-6" />)}
                          </div>
                          <div className="flex-1">
                            <input 
                              value={res.name}
                              onChange={e => updateResource(idx, { name: e.target.value })}
                              className="w-full bg-transparent border-none p-0 text-lg font-bold text-slate-800 focus:ring-0 outline-none"
                            />
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">资源名称</p>
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex justify-between items-end">
                            <label className="text-[10px] font-black text-slate-400 uppercase">最大容量 (单位)</label>
                            <span className="text-2xl font-black text-blue-600">{res.capacity}</span>
                          </div>
                          <input 
                            type="range" min="1" max="50" value={res.capacity}
                            onChange={e => updateResource(idx, { capacity: Number(e.target.value) })}
                            className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                          />
                        </div>

                        <button 
                          onClick={() => removeResource(res.name)}
                          className="absolute top-4 right-4 p-2 text-slate-200 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {activeTab === 'monitoring' && result && (
                <motion.div
                  key="monitoring"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <Dashboard 
                    scheduled={result.scheduled} 
                    tasks={result.tasks} 
                    makespan={result.makespan} 
                    numPlanes={numPlanes} 
                    resources={resCapMap}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}
